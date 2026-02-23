/**
 * @enterprise/memory-pyramid
 *
 * Pyramidal memory system for AI agents.
 * TypeScript port of finereli/pyramid.
 *
 * Architecture:
 *   Extraction → Organization → Compression → Synthesis → Export
 *
 * Usage:
 *   const db = new PyramidDb('~/.enterprise/pyramid.db');
 *   await db.init();
 *   const result = await sync(db, { messages, llmToolCallFn, llmCompleteFn, workspacePath });
 */

export { PyramidDb } from './db.js';
export type { Observation, Model, Summary } from './db.js';

export { extractObservations } from './extraction.js';
export type { Message, ExtractedObservation, LLMToolCallFn } from './extraction.js';

export { assignObservations } from './organization.js';

export { summarizeTier0, summarizeHigherTiers } from './compression.js';
export type { LLMCompletionFn } from './compression.js';

export { synthesizeModel, synthesizeDirtyModels } from './synthesis.js';

export { exportModels, getMemoryContext } from './export.js';

export { sync } from './sync.js';
export type { SyncOptions, SyncResult } from './sync.js';
