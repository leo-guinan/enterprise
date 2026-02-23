/**
 * Sync — the main entry point.
 *
 * Orchestrates: extract → organize → compress → synthesize → export.
 * Port of finereli/pyramid's sync.py.
 */

import type { PyramidDb } from './db.js';
import type { LLMToolCallFn } from './extraction.js';
import type { LLMCompletionFn } from './compression.js';
import { extractObservations, type Message } from './extraction.js';
import { assignObservations } from './organization.js';
import { summarizeTier0, summarizeHigherTiers } from './compression.js';
import { synthesizeDirtyModels } from './synthesis.js';
import { exportModels } from './export.js';

export interface SyncOptions {
  /** New messages to extract observations from */
  messages?: Message[];
  /** Workspace path for file export */
  workspacePath?: string;
  /** LLM function for tool-call operations (extraction, assignment) */
  llmToolCallFn: LLMToolCallFn;
  /** LLM function for completion operations (summarization, synthesis) */
  llmCompleteFn: LLMCompletionFn;
  /** Progress callback */
  onProgress?: (step: string, detail: string) => void;
  /** Skip export step */
  skipExport?: boolean;
}

export interface SyncResult {
  observationsExtracted: number;
  observationsAssigned: number;
  tier0Created: number;
  higherTiersCreated: number;
  modelsSynthesized: number;
  filesExported: string[];
}

/**
 * Full sync pipeline.
 */
export async function sync(db: PyramidDb, options: SyncOptions): Promise<SyncResult> {
  const { messages, workspacePath, llmToolCallFn, llmCompleteFn, onProgress, skipExport } = options;
  const result: SyncResult = {
    observationsExtracted: 0,
    observationsAssigned: 0,
    tier0Created: 0,
    higherTiersCreated: 0,
    modelsSynthesized: 0,
    filesExported: [],
  };

  // 1. Extract observations from new messages
  if (messages?.length) {
    onProgress?.('extract', `Processing ${messages.length} messages`);
    const observations = await extractObservations(messages, llmToolCallFn);
    db.addObservations(observations);
    result.observationsExtracted = observations.length;
    onProgress?.('extract', `Extracted ${observations.length} observations`);
  }

  // 2. Assign unassigned observations to models
  onProgress?.('organize', 'Assigning observations to models');
  result.observationsAssigned = await assignObservations(
    db,
    llmToolCallFn,
    (msg) => onProgress?.('organize', msg),
  );

  // 3. Compress: tier-0 and higher tiers for each model
  const models = db.getModels();
  for (const model of models) {
    const t0 = await summarizeTier0(db, model.id, llmCompleteFn, (msg) =>
      onProgress?.('compress', `${model.name}: ${msg}`),
    );
    result.tier0Created += t0;

    const higher = await summarizeHigherTiers(db, model.id, llmCompleteFn, (msg) =>
      onProgress?.('compress', `${model.name}: ${msg}`),
    );
    result.higherTiersCreated += higher;
  }

  // 4. Synthesize dirty models
  onProgress?.('synthesize', 'Synthesizing dirty models');
  result.modelsSynthesized = await synthesizeDirtyModels(
    db,
    llmCompleteFn,
    (msg) => onProgress?.('synthesize', msg),
  );

  // 5. Export to markdown
  if (workspacePath && !skipExport) {
    onProgress?.('export', 'Writing markdown files');
    result.filesExported = exportModels(db, workspacePath);
  }

  return result;
}
