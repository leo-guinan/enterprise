/**
 * Compression Layer
 *
 * Tiered summarization: 10 observations → tier 0, 10 tier-0 → tier 1, etc.
 * Port of finereli/pyramid's summarize.py run_*_summarization.
 */

import type { PyramidDb, Observation, Summary } from './db.js';
import type { LLMToolCallFn } from './extraction.js';

const STEP = 10;

/** Simple LLM call (no tools needed for summarization) */
export type LLMCompletionFn = (opts: { system: string; prompt: string }) => Promise<string>;

const SUMMARIZE_SYSTEM = `You are a memory agent creating summaries.

Write in clear, readable narrative prose. Convey importance through word choice
(e.g., "significantly", "notably", "critically") rather than markers or scores.

Preserve specific facts: names, dates, numbers, places.
Organize related information into coherent paragraphs.`;

/**
 * Run tier-0 summarization: group STEP observations into summaries.
 */
export async function summarizeTier0(
  db: PyramidDb,
  modelId: number,
  llmComplete: LLMCompletionFn,
  onProgress?: (msg: string) => void,
): Promise<number> {
  const observations = db.getObservationsByModel(modelId);
  const existingT0 = db.getSummariesByModel(modelId, 0);

  // Find observations not yet covered by any tier-0 summary
  const lastSummarizedTs = existingT0.length
    ? existingT0.reduce((max, s) => (s.end_timestamp! > max ? s.end_timestamp! : max), '')
    : '';

  const unsummarized = lastSummarizedTs
    ? observations.filter((o) => o.timestamp > lastSummarizedTs)
    : observations;

  if (unsummarized.length < STEP) return 0;

  let created = 0;

  for (let i = 0; i + STEP <= unsummarized.length; i += STEP) {
    const batch = unsummarized.slice(i, i + STEP);
    const obsText = batch.map((o) => `[${o.timestamp}] ${o.text}`).join('\n');

    const summary = await llmComplete({
      system: SUMMARIZE_SYSTEM,
      prompt: `Summarize these ${batch.length} observations into a coherent paragraph:\n\n${obsText}`,
    });

    const startTs = batch[0]!.timestamp;
    const endTs = batch[batch.length - 1]!.timestamp;

    const summaryId = db.addSummary(modelId, 0, summary, startTs, endTs);

    // Track sources
    for (const obs of batch) {
      db.addSummarySource(summaryId, 'observation', obs.id);
    }

    created++;
    onProgress?.(`Tier 0: created summary ${created} (${startTs} → ${endTs})`);
  }

  if (created > 0) db.markModelDirty(modelId);
  return created;
}

/**
 * Run higher-tier summarization: group STEP tier-N summaries into tier-(N+1).
 */
export async function summarizeHigherTiers(
  db: PyramidDb,
  modelId: number,
  llmComplete: LLMCompletionFn,
  onProgress?: (msg: string) => void,
): Promise<number> {
  let created = 0;
  let tier = 0;

  while (true) {
    const currentTier = db.getSummariesByModel(modelId, tier);
    const nextTier = db.getSummariesByModel(modelId, tier + 1);

    // How many current-tier summaries aren't covered by next tier
    const lastNextTs = nextTier.length
      ? nextTier.reduce((max, s) => (s.end_timestamp! > max ? s.end_timestamp! : max), '')
      : '';

    const uncovered = lastNextTs
      ? currentTier.filter((s) => s.end_timestamp! > lastNextTs)
      : currentTier;

    if (uncovered.length < STEP) break;

    for (let i = 0; i + STEP <= uncovered.length; i += STEP) {
      const batch = uncovered.slice(i, i + STEP);
      const text = batch.map((s) => `[${s.start_timestamp} → ${s.end_timestamp}]\n${s.text}`).join('\n\n');

      const summary = await llmComplete({
        system: SUMMARIZE_SYSTEM,
        prompt: `Synthesize these ${batch.length} tier-${tier} summaries into a higher-level summary:\n\n${text}`,
      });

      const startTs = batch[0]!.start_timestamp!;
      const endTs = batch[batch.length - 1]!.end_timestamp!;

      const summaryId = db.addSummary(modelId, tier + 1, summary, startTs, endTs);

      for (const s of batch) {
        db.addSummarySource(summaryId, 'summary', s.id);
      }

      created++;
      onProgress?.(`Tier ${tier + 1}: created summary ${created}`);
    }

    tier++;
  }

  if (created > 0) db.markModelDirty(modelId);
  return created;
}
