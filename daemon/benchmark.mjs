#!/usr/bin/env node
/**
 * Enterprise Intelligence Benchmark
 *
 * Tests each pyramid layer against multiple models to find the cheapest
 * intelligence that works at each level.
 *
 * Layers tested:
 *   1. Extraction (observations from conversations)
 *   2. Organization (assign observations to models)
 *   3. Compression (tier-0 summaries)
 *   4. Synthesis (coherent narratives from summaries)
 *   5. Chat (conversational response)
 *
 * Models tested:
 *   - Local Ollama (free): llama3.2, llama3.1, codellama
 *   - OpenRouter free tier: qwen3, nemotron, gpt-oss, glm, etc.
 *   - Claude Max (baseline, via CLI)
 *
 * Usage:
 *   node daemon/benchmark.mjs                         # run all benchmarks
 *   node daemon/benchmark.mjs --layer extraction      # single layer
 *   node daemon/benchmark.mjs --model ollama/llama3.2 # single model
 *   node daemon/benchmark.mjs --quick                 # fewer samples
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const DATA_DIR = join(homedir(), '.enterprise');
const RESULTS_PATH = join(DATA_DIR, 'benchmark-results.json');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const args = process.argv.slice(2);
const getArg = (f, d) => { const i = args.indexOf(f); return i !== -1 ? (args[i+1] || d) : d; };
const hasFlag = f => args.includes(f);
const QUICK = hasFlag('--quick');
const ONLY_LAYER = getArg('--layer', null);
const ONLY_MODEL = getArg('--model', null);

// ─── Model Providers ───

const OLLAMA_URL = 'http://localhost:11434';

const MODELS = [
  // Local Ollama (free, private)
  { id: 'ollama/llama3.2', provider: 'ollama', model: 'llama3.2', cost: 0, label: 'Llama 3.2 3B (local)' },
  { id: 'ollama/llama3.1', provider: 'ollama', model: 'llama3.1:8b', cost: 0, label: 'Llama 3.1 8B (local)' },
  { id: 'ollama/codellama', provider: 'ollama', model: 'codellama:7b', cost: 0, label: 'CodeLlama 7B (local)' },

  // OpenRouter free tier
  { id: 'or/qwen3-next-80b', provider: 'openrouter', model: 'qwen/qwen3-next-80b-a3b-instruct:free', cost: 0, label: 'Qwen3 80B MoE (free)' },
  { id: 'or/nemotron-nano-9b', provider: 'openrouter', model: 'nvidia/nemotron-nano-9b-v2:free', cost: 0, label: 'Nemotron 9B (free)' },
  { id: 'or/gpt-oss-20b', provider: 'openrouter', model: 'openai/gpt-oss-20b:free', cost: 0, label: 'GPT-OSS 20B (free)' },
  { id: 'or/glm-4.5-air', provider: 'openrouter', model: 'z-ai/glm-4.5-air:free', cost: 0, label: 'GLM 4.5 Air (free)' },
  { id: 'or/solar-pro-3', provider: 'openrouter', model: 'upstage/solar-pro-3:free', cost: 0, label: 'Solar Pro 3 (free)' },
  { id: 'or/stepfun-flash', provider: 'openrouter', model: 'stepfun/step-3.5-flash:free', cost: 0, label: 'Step 3.5 Flash (free)' },

  // Claude Max (baseline - expensive in time, free in cost)
  { id: 'claude-max', provider: 'claude', model: 'claude-max', cost: 0, label: 'Claude Max (baseline)' },
];

// ─── LLM Callers ───

function callOllama(model, prompt, timeout = 60000) {
  const body = JSON.stringify({ model, prompt, stream: false, options: { num_predict: 2048 } });
  try {
    const start = Date.now();
    const raw = execSync(
      `curl -s --max-time ${timeout/1000} -X POST ${OLLAMA_URL}/api/generate -d '${body.replace(/'/g, "'\\''")}'`,
      { encoding: 'utf8', timeout: timeout + 5000, maxBuffer: 10 * 1024 * 1024 }
    );
    const parsed = JSON.parse(raw);
    return { ok: true, response: parsed.response || '', latencyMs: Date.now() - start, tokens: parsed.eval_count || 0 };
  } catch (e) {
    return { ok: false, response: '', error: e.message, latencyMs: 0, tokens: 0 };
  }
}

function callOpenRouter(model, prompt, timeout = 30000) {
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 2048,
  });
  try {
    const start = Date.now();
    const raw = execSync(
      `curl -s --max-time ${timeout/1000} -X POST https://openrouter.ai/api/v1/chat/completions -H "Content-Type: application/json" -d '${body.replace(/'/g, "'\\''")}'`,
      { encoding: 'utf8', timeout: timeout + 5000 }
    );
    const parsed = JSON.parse(raw);
    const content = parsed.choices?.[0]?.message?.content || '';
    const tokens = parsed.usage?.total_tokens || Math.ceil(content.length / 4);
    return { ok: !!content, response: content, latencyMs: Date.now() - start, tokens };
  } catch (e) {
    return { ok: false, response: '', error: e.message, latencyMs: 0, tokens: 0 };
  }
}

function callClaude(prompt, timeout = 120000) {
  const escaped = prompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  try {
    const start = Date.now();
    const response = execSync(`claude --print -p "${escaped}"`, {
      encoding: 'utf8', timeout, maxBuffer: 10 * 1024 * 1024,
    }).trim();
    return { ok: true, response, latencyMs: Date.now() - start, tokens: Math.ceil(response.length / 4) };
  } catch (e) {
    return { ok: false, response: '', error: e.message, latencyMs: 0, tokens: 0 };
  }
}

function callModel(modelConfig, prompt) {
  switch (modelConfig.provider) {
    case 'ollama': return callOllama(modelConfig.model, prompt);
    case 'openrouter': return callOpenRouter(modelConfig.model, prompt);
    case 'claude': return callClaude(prompt);
    default: return { ok: false, response: '', error: 'Unknown provider', latencyMs: 0, tokens: 0 };
  }
}

// ─── Test Data ───

const SAMPLE_CONVERSATION = `[2026-02-23T12:00:00Z] user: I'm building an agent system where local machines handle expensive LLM calls and remote servers just route messages. The key insight is that Claude Max gives unlimited tokens locally, so the cloud should be a cheap router, not the brain.

[2026-02-23T12:01:00Z] assistant: That's an interesting architecture inversion. Typically cloud is the compute and local is the client. You're flipping it — cloud as message bus, local as intelligence layer. The cost model works because Max is flat-rate while API calls scale linearly.

[2026-02-23T12:02:00Z] user: Exactly. And I want pyramidal memory — observations extracted from conversations get compressed into tiered summaries. Each tier compresses 10 items from below. So 1000 observations become ~10 tier-2 summaries.

[2026-02-23T12:03:00Z] assistant: The compression ratio is elegant. At tier 2, you have about 0.1% of the original tokens but arguably the most important information. The dirty-tracking ensures you only regenerate what changed.`;

const SAMPLE_OBSERVATIONS = [
  { id: 1, text: 'User is building an agent system with local-remote architecture split' },
  { id: 2, text: 'Claude Max provides unlimited tokens for local processing' },
  { id: 3, text: 'Cloud server acts as message router, not compute brain' },
  { id: 4, text: 'System uses pyramidal memory with tiered compression' },
  { id: 5, text: 'Compression ratio is 10:1 per tier (1000 obs → 10 tier-2 summaries)' },
  { id: 6, text: 'Dirty tracking ensures only changed models regenerate' },
  { id: 7, text: 'Architecture inverts typical cloud=compute, local=client pattern' },
  { id: 8, text: 'Cost model works because Max is flat-rate vs linear API costs' },
];

const SAMPLE_SUMMARIES = [
  'The user is developing a novel agent architecture that inverts the traditional cloud-local relationship. Instead of expensive cloud compute with thin local clients, their system uses local machines with Claude Max (flat-rate unlimited tokens) as the intelligence layer, while remote servers act as cheap message routers.',
  'The memory system uses pyramidal compression: raw observations from conversations are extracted, then compressed in tiers of 10. A thousand observations become approximately 10 high-level summaries at tier 2, preserving roughly 0.1% of original tokens while retaining the most important information.',
];

// ─── Layer Tests ───

const LAYERS = {
  extraction: {
    name: 'Extraction',
    description: 'Extract factual observations from conversations',
    prompt: `Extract specific factual observations from this conversation. Return a JSON array of objects with "text" (single factual sentence) and "timestamp" fields. Only output the JSON array.

${SAMPLE_CONVERSATION}`,
    evaluate: (response) => {
      try {
        const match = response.match(/\[[\s\S]*\]/);
        if (!match) return { score: 0, reason: 'No JSON array found' };
        const arr = JSON.parse(match[0]);
        if (!Array.isArray(arr)) return { score: 0, reason: 'Not an array' };
        const valid = arr.filter(o => o.text && typeof o.text === 'string' && o.text.length > 10);
        if (valid.length === 0) return { score: 0, reason: 'No valid observations' };
        if (valid.length < 3) return { score: 0.3, reason: `Only ${valid.length} observations (expected 5+)` };
        if (valid.length < 5) return { score: 0.6, reason: `${valid.length} observations (good but incomplete)` };
        // Check for specificity
        const specific = valid.filter(o => /\d|Claude|Max|pyramid|tier|local|remote|router/i.test(o.text));
        const specificity = specific.length / valid.length;
        return { score: Math.min(1, 0.5 + specificity * 0.5), reason: `${valid.length} observations, ${(specificity * 100).toFixed(0)}% specific` };
      } catch (e) {
        return { score: 0.1, reason: `Parse error: ${e.message}` };
      }
    },
  },

  organization: {
    name: 'Organization',
    description: 'Classify observations into mental models',
    prompt: `Assign each observation to a mental model category. Available models: "user" (user identity/projects), "assistant" (AI experience), "architecture" (system design), "memory" (memory systems).

Return a JSON array of {"observation_id": <number>, "model_name": "<string>"} for each.

Observations:
${SAMPLE_OBSERVATIONS.map(o => `[${o.id}] ${o.text}`).join('\n')}`,
    evaluate: (response) => {
      try {
        const match = response.match(/\[[\s\S]*\]/);
        if (!match) return { score: 0, reason: 'No JSON array' };
        const arr = JSON.parse(match[0]);
        if (!Array.isArray(arr)) return { score: 0, reason: 'Not an array' };
        const valid = arr.filter(a => a.observation_id && a.model_name);
        if (valid.length < 4) return { score: 0.3, reason: `Only ${valid.length}/8 assigned` };
        // Check reasonable assignments
        const archObs = valid.filter(a => ['architecture', 'system'].some(k => a.model_name.toLowerCase().includes(k)));
        const memObs = valid.filter(a => a.model_name.toLowerCase().includes('memory'));
        const reasonable = archObs.length > 0 && memObs.length > 0;
        return {
          score: reasonable ? Math.min(1, valid.length / 8 + 0.2) : valid.length / 8 * 0.7,
          reason: `${valid.length}/8 assigned, ${reasonable ? 'reasonable categories' : 'questionable categories'}`,
        };
      } catch (e) {
        return { score: 0.1, reason: `Parse error: ${e.message}` };
      }
    },
  },

  compression: {
    name: 'Compression',
    description: 'Summarize observations into coherent paragraphs',
    prompt: `Summarize these observations into a single coherent paragraph. Preserve specific facts: names, numbers, technical terms. Write in clear narrative prose.

${SAMPLE_OBSERVATIONS.map(o => `- ${o.text}`).join('\n')}`,
    evaluate: (response) => {
      if (response.length < 50) return { score: 0, reason: 'Too short' };
      if (response.length > 2000) return { score: 0.3, reason: 'Too long for a summary' };
      // Check key facts preserved
      const keyTerms = ['Claude Max', 'pyramid', 'tier', '10:1', 'router', 'local', 'remote', 'flat-rate'];
      const preserved = keyTerms.filter(t => response.toLowerCase().includes(t.toLowerCase()));
      const ratio = preserved.length / keyTerms.length;
      if (ratio < 0.2) return { score: 0.2, reason: `Only ${preserved.length}/${keyTerms.length} key terms preserved` };
      // Check it's prose (not bullet points)
      const isProse = !response.includes('- ') && response.includes('. ');
      return {
        score: ratio * (isProse ? 1 : 0.7),
        reason: `${preserved.length}/${keyTerms.length} terms, ${isProse ? 'prose' : 'not prose'}`,
      };
    },
  },

  synthesis: {
    name: 'Synthesis',
    description: 'Synthesize summaries into coherent narrative',
    prompt: `Synthesize these summaries about "architecture" into a coherent narrative. Write in third person. Organize by importance, not chronology. Be specific and factual.

### Recent
${SAMPLE_SUMMARIES[0]}

### This Week
${SAMPLE_SUMMARIES[1]}`,
    evaluate: (response) => {
      if (response.length < 100) return { score: 0, reason: 'Too short' };
      // Check coherence: should flow as one narrative, not repeat headers
      const hasHeaders = (response.match(/###/g) || []).length > 0;
      const keyIdeas = ['local', 'remote', 'pyramid', 'compress', 'Claude'];
      const covered = keyIdeas.filter(k => response.toLowerCase().includes(k.toLowerCase()));
      const coherence = !hasHeaders && response.includes('. ') && covered.length >= 3;
      return {
        score: coherence ? Math.min(1, covered.length / keyIdeas.length + 0.2) : 0.4,
        reason: `${covered.length}/${keyIdeas.length} ideas, ${coherence ? 'coherent' : 'fragmented'}`,
      };
    },
  },

  chat: {
    name: 'Chat',
    description: 'Conversational response quality',
    prompt: `You are a helpful AI assistant. The user has been building an agent system.

Previous context: The user built an architecture where local machines handle LLM calls (Claude Max, free) and remote servers route messages. They use pyramidal memory for long-term context.
User: What should I work on next to make this production-ready?`,
    evaluate: (response) => {
      if (response.length < 50) return { score: 0, reason: 'Too short' };
      if (response.length > 5000) return { score: 0.5, reason: 'Verbose' };
      // Check it's actually helpful (mentions specific things)
      const actionable = ['monitor', 'test', 'log', 'auth', 'scale', 'backup', 'retry', 'error', 'deploy', 'cache', 'security', 'rate limit'].filter(
        k => response.toLowerCase().includes(k)
      );
      const onTopic = ['local', 'remote', 'memory', 'pyramid', 'agent', 'fallback'].filter(
        k => response.toLowerCase().includes(k)
      );
      const score = Math.min(1, (actionable.length * 0.15) + (onTopic.length * 0.1) + (response.length > 200 ? 0.2 : 0));
      return { score, reason: `${actionable.length} actionable items, ${onTopic.length} on-topic references` };
    },
  },
};

// ─── Runner ───

async function runBenchmark() {
  const results = { timestamp: new Date().toISOString(), layers: {}, rankings: {} };
  const layerKeys = ONLY_LAYER ? [ONLY_LAYER] : Object.keys(LAYERS);
  const modelList = ONLY_MODEL ? MODELS.filter(m => m.id === ONLY_MODEL) : (QUICK ? MODELS.slice(0, 5) : MODELS);

  console.log(`Enterprise Intelligence Benchmark`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`Layers: ${layerKeys.join(', ')}`);
  console.log(`Models: ${modelList.length} (${modelList.map(m => m.id).join(', ')})`);
  console.log(`${'─'.repeat(60)}\n`);

  for (const layerKey of layerKeys) {
    const layer = LAYERS[layerKey];
    if (!layer) { console.error(`Unknown layer: ${layerKey}`); continue; }

    console.log(`\n▶ ${layer.name}: ${layer.description}`);
    results.layers[layerKey] = [];

    for (const model of modelList) {
      process.stdout.write(`  ${model.label.padEnd(30)}`);

      const result = callModel(model, layer.prompt);

      if (!result.ok) {
        console.log(`  ✗ ${result.error?.slice(0, 50) || 'failed'}`);
        results.layers[layerKey].push({
          model: model.id, label: model.label, cost: model.cost,
          ok: false, error: result.error, score: 0, latencyMs: result.latencyMs,
        });
        continue;
      }

      const evaluation = layer.evaluate(result.response);
      const bar = '█'.repeat(Math.round(evaluation.score * 20)).padEnd(20, '░');
      console.log(`  ${bar} ${(evaluation.score * 100).toFixed(0).padStart(3)}%  ${result.latencyMs}ms  ${evaluation.reason}`);

      results.layers[layerKey].push({
        model: model.id, label: model.label, cost: model.cost,
        ok: true, score: evaluation.score, latencyMs: result.latencyMs,
        tokens: result.tokens, reason: evaluation.reason,
        responseLength: result.response.length,
      });
    }
  }

  // ─── Rankings: cheapest viable model per layer ───

  console.log(`\n${'═'.repeat(60)}`);
  console.log('OPTIMAL MODEL PER LAYER (cheapest that scores ≥ 60%)');
  console.log('═'.repeat(60));

  for (const layerKey of layerKeys) {
    const layerResults = results.layers[layerKey] || [];
    const viable = layerResults
      .filter(r => r.ok && r.score >= 0.6)
      .sort((a, b) => {
        // Sort by: cost (ascending), then latency (ascending)
        if (a.cost !== b.cost) return a.cost - b.cost;
        return a.latencyMs - b.latencyMs;
      });

    const best = viable[0];
    const baseline = layerResults.find(r => r.model === 'claude-max');

    if (best) {
      const savings = baseline && baseline.latencyMs > 0
        ? `${((1 - best.latencyMs / baseline.latencyMs) * 100).toFixed(0)}% faster`
        : '';
      results.rankings[layerKey] = { model: best.model, label: best.label, score: best.score, latencyMs: best.latencyMs, cost: best.cost };
      console.log(`\n  ${LAYERS[layerKey].name.padEnd(15)} → ${best.label}`);
      console.log(`    Score: ${(best.score * 100).toFixed(0)}%  Latency: ${best.latencyMs}ms  Cost: $${best.cost}  ${savings}`);
    } else {
      results.rankings[layerKey] = { model: 'claude-max', label: 'Claude Max (no viable cheaper option)', score: baseline?.score || 0 };
      console.log(`\n  ${LAYERS[layerKey].name.padEnd(15)} → Claude Max (no viable cheaper option)`);
    }
  }

  // ─── Generate config ───

  console.log(`\n${'═'.repeat(60)}`);
  console.log('GENERATED CONFIG');
  console.log('═'.repeat(60));

  const config = {};
  for (const [layer, ranking] of Object.entries(results.rankings)) {
    const model = MODELS.find(m => m.id === ranking.model);
    if (model) {
      config[layer] = { provider: model.provider, model: model.model, cost: model.cost };
    }
  }

  console.log(JSON.stringify(config, null, 2));

  // Save
  writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  const configPath = join(DATA_DIR, 'model-config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  console.log(`\nResults: ${RESULTS_PATH}`);
  console.log(`Config:  ${configPath}`);
  console.log(`\nUse this config in headless.mjs or pyramid-sync.mjs to route each layer to its optimal model.`);
}

runBenchmark().catch(console.error);
