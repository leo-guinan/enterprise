/**
 * Export Layer
 *
 * Generates markdown files from synthesized models.
 * Port of finereli/pyramid's generate.py export_models.
 */

import type { PyramidDb } from './db.js';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Export all models to markdown files in the workspace.
 *
 * - MEMORY.md: combined narrative of all models
 * - models/<name>.md: individual model files
 * - SOUL.md and USER.md are NOT overwritten (hand-crafted)
 */
export function exportModels(db: PyramidDb, workspacePath: string): string[] {
  const modelsDir = join(workspacePath, 'models');
  if (!existsSync(modelsDir)) mkdirSync(modelsDir, { recursive: true });

  const models = db.getModels();
  const exported: string[] = [];
  const memoryParts: string[] = [];

  memoryParts.push('# MEMORY.md — Pyramid Memory\n');
  memoryParts.push(`*Auto-generated. ${models.length} mental models, ${db.getObservationCount()} observations.*\n`);

  for (const model of models) {
    if (!model.synthesized_content) continue;

    // Individual model file
    const filename = `${model.name}.md`;
    const filepath = join(modelsDir, filename);
    const content = `# ${model.name}\n\n${model.description ? `*${model.description}*\n\n` : ''}${model.synthesized_content}\n`;
    writeFileSync(filepath, content);
    exported.push(filepath);

    // Add to combined MEMORY.md
    memoryParts.push(`## ${model.name}\n`);
    if (model.description) memoryParts.push(`*${model.description}*\n`);
    memoryParts.push(model.synthesized_content);
    memoryParts.push('');
  }

  // Write MEMORY.md
  const memoryPath = join(workspacePath, 'MEMORY.md');
  writeFileSync(memoryPath, memoryParts.join('\n'));
  exported.push(memoryPath);

  return exported;
}

/**
 * Get all synthesized models as a single context string.
 * Useful for injecting into agent system prompts.
 */
export function getMemoryContext(db: PyramidDb): string {
  const models = db.getModels();
  const parts: string[] = [];

  for (const model of models) {
    if (!model.synthesized_content) continue;
    parts.push(`## ${model.name}\n${model.synthesized_content}`);
  }

  return parts.join('\n\n');
}
