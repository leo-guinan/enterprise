/**
 * Synthesis Layer
 *
 * Synthesizes tiered summaries into coherent mental model narratives.
 * Port of finereli/pyramid's pyramid.py synthesize_model.
 */

import type { PyramidDb, Summary } from './db.js';
import type { LLMCompletionFn } from './compression.js';

const TIME_BUCKETS: Array<[string, number | null]> = [
  ['Last 3 Days', 3],
  ['This Week', 7],
  ['This Month', 30],
  ['This Quarter', 90],
  ['This Year', 365],
  ['Earlier', null],
];

interface TimedItem {
  text: string;
  end_timestamp: string;
  start_timestamp?: string;
  tier: number;
}

function bucketByTime(items: TimedItem[], refDate: Date): Map<string, TimedItem[]> {
  const buckets = new Map<string, TimedItem[]>();
  for (const [label] of TIME_BUCKETS) buckets.set(label, []);

  for (const item of items) {
    const itemDate = new Date(item.end_timestamp);
    const diffDays = (refDate.getTime() - itemDate.getTime()) / (1000 * 60 * 60 * 24);

    for (const [label, days] of TIME_BUCKETS) {
      if (days === null || diffDays <= days) {
        buckets.get(label)!.push(item);
        break;
      }
    }
  }

  return buckets;
}

/**
 * Get non-overlapping summaries across tiers (highest tier preferred).
 */
function getNonOverlapping(summaries: Summary[]): TimedItem[] {
  const byTier = new Map<number, Summary[]>();
  for (const s of summaries) {
    if (!byTier.has(s.tier)) byTier.set(s.tier, []);
    byTier.get(s.tier)!.push(s);
  }

  const result: TimedItem[] = [];
  let maxCoveredTs = '';

  for (const tier of [...byTier.keys()].sort((a, b) => b - a)) {
    const tierSummaries = byTier.get(tier)!.sort(
      (a, b) => (b.end_timestamp || '').localeCompare(a.end_timestamp || '')
    );

    for (const s of tierSummaries) {
      if (!maxCoveredTs || (s.end_timestamp || '') > maxCoveredTs) {
        result.push({
          text: s.text,
          end_timestamp: s.end_timestamp || '',
          start_timestamp: s.start_timestamp || undefined,
          tier,
        });
      }
    }

    const tierMax = tierSummaries[0]?.end_timestamp || '';
    if (tierMax > maxCoveredTs) maxCoveredTs = tierMax;
  }

  return result;
}

/**
 * Synthesize a single model's pyramid into a coherent narrative.
 */
export async function synthesizeModel(
  db: PyramidDb,
  modelId: number,
  llmComplete: LLMCompletionFn,
): Promise<string | null> {
  const model = db.getModelById(modelId);
  if (!model) return null;

  const summaries = db.getSummariesByModel(modelId);
  const items = getNonOverlapping(summaries);

  // Also include recent unsummarized observations
  const observations = db.getObservationsByModel(modelId);
  const lastSummaryTs = summaries.length
    ? summaries.reduce((max, s) => ((s.end_timestamp || '') > max ? (s.end_timestamp || '') : max), '')
    : '';

  const unsummarized = lastSummaryTs
    ? observations.filter((o) => o.timestamp > lastSummaryTs)
    : observations.slice(-20); // cap for models with no summaries yet

  for (const obs of unsummarized) {
    items.push({ text: obs.text, end_timestamp: obs.timestamp, tier: -1 });
  }

  if (!items.length) return null;

  const refDate = new Date(
    items.reduce((max, i) => (i.end_timestamp > max ? i.end_timestamp : max), '')
  );

  const buckets = bucketByTime(items, refDate);

  const sections: string[] = [];
  for (const [label] of TIME_BUCKETS) {
    const bucketItems = buckets.get(label)!;
    if (!bucketItems.length) continue;

    const sorted = bucketItems.sort((a, b) => b.end_timestamp.localeCompare(a.end_timestamp));
    const content = sorted
      .map((i) => `[${i.end_timestamp.slice(0, 10)}] ${i.text}`)
      .join('\n');
    sections.push(`### ${label}\n${content}`);
  }

  if (!sections.length) return null;

  const voice =
    model.name === 'assistant'
      ? 'first person (I, me, my) as the AI assistant reflecting on my own experience'
      : 'third person narrative prose';

  const synthesized = await llmComplete({
    system: `You synthesize memory pyramids into coherent mental model narratives. Write in ${voice}. Be specific and factual.`,
    prompt: `Synthesize this information about "${model.name}" (${model.description || 'auto-discovered topic'}) into a coherent narrative organized by recency:\n\n${sections.join('\n\n')}`,
  });

  db.updateSynthesis(modelId, synthesized);
  return synthesized;
}

/**
 * Synthesize all dirty models.
 */
export async function synthesizeDirtyModels(
  db: PyramidDb,
  llmComplete: LLMCompletionFn,
  onProgress?: (msg: string) => void,
): Promise<number> {
  const dirty = db.getDirtyModels();
  let synthesized = 0;

  for (const model of dirty) {
    onProgress?.(`Synthesizing: ${model.name}`);
    const result = await synthesizeModel(db, model.id, llmComplete);
    if (result) synthesized++;
  }

  return synthesized;
}
