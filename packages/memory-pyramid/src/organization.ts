/**
 * Organization Layer
 *
 * Assigns unassigned observations to mental models using LLM classification.
 * Port of finereli/pyramid's summarize.py assign_models_to_observations.
 */

import type { PyramidDb, Model, Observation } from './db.js';
import type { LLMToolCallFn } from './extraction.js';

const STEP = 10;

const ASSIGN_TOOL = {
  name: 'assign_model',
  description: 'Assign an observation to a mental model',
  parameters: {
    type: 'object',
    properties: {
      observation_id: { type: 'number', description: 'The observation ID' },
      model_name: {
        type: 'string',
        description: 'Model name: assistant, user, or a new topic name (lowercase, hyphenated)',
      },
    },
    required: ['observation_id', 'model_name'],
  },
};

function buildModelsContext(db: PyramidDb): string {
  const models = db.getModels();
  const lines = ['Available models:'];

  for (const m of models) {
    lines.push(`\n### ${m.name}`);
    lines.push(`Purpose: ${m.description || '(auto-discovered)'}`);

    const samples = db.getObservationsByModel(m.id).slice(-5);
    if (samples.length) {
      lines.push('Recent examples:');
      for (const s of samples) {
        lines.push(`  - ${s.text}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Assign all unassigned observations to models.
 * Creates new models on-demand when the LLM discovers distinct topics.
 */
export async function assignObservations(
  db: PyramidDb,
  llmFn: LLMToolCallFn,
  onProgress?: (msg: string) => void,
): Promise<number> {
  const unassigned = db.getUnassignedObservations();
  if (!unassigned.length) return 0;

  let assigned = 0;

  for (let i = 0; i < unassigned.length; i += STEP) {
    const batch = unassigned.slice(i, i + STEP);
    const modelsContext = buildModelsContext(db);
    const obsText = batch.map((o) => `[${o.id}] ${o.text}`).join('\n');

    const system = `You assign observations to mental models. Call assign_model for each observation.

Base models:
- assistant: AI assistant experience, reflections, and self-understanding
- user: Primary user identity, preferences, projects, and life events

Create new models for distinct entities (specific people, projects, topics) only when you see
multiple observations about them. Use lowercase-hyphenated names.`;

    const toolCalls = await llmFn({
      system,
      prompt: `${modelsContext}\n\nAssign each observation:\n${obsText}`,
      tools: [ASSIGN_TOOL],
    });

    for (const tc of toolCalls) {
      if (tc.name !== 'assign_model') continue;
      const obsId = tc.args.observation_id as number;
      const modelName = (tc.args.model_name as string).toLowerCase().trim().replace(/\s+/g, '-');

      let model = db.getModel(modelName);
      if (!model) {
        db.createModel(modelName);
        model = db.getModel(modelName)!;
      }

      const obs = unassigned.find((o) => o.id === obsId);
      if (obs) {
        db.assignObservation(obsId, model.id);
        assigned++;
      }
    }

    onProgress?.(`Assigned batch ${Math.floor(i / STEP) + 1}/${Math.ceil(unassigned.length / STEP)}`);
  }

  return assigned;
}
