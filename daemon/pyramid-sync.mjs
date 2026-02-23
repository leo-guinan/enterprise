#!/usr/bin/env node
/**
 * Pyramid Memory Sync for Enterprise Daemon
 *
 * After conversations complete, extracts observations, compresses into
 * tiered summaries, synthesizes mental models, and exports to markdown.
 *
 * LLM calls go through Claude Code CLI (Max plan) by default.
 *
 * Usage:
 *   node daemon/pyramid-sync.mjs                    # sync once
 *   node daemon/pyramid-sync.mjs --loop              # continuous (every 5min)
 *   node daemon/pyramid-sync.mjs --workspace ~/clawd # custom workspace
 */

import initSqlJs from 'sql.js';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

// ─── Config ───

const WORKSPACE = process.argv.find(a => a.startsWith('--workspace='))?.split('=')[1]
  || join(homedir(), '.enterprise', 'memory');
const PYRAMID_DB_PATH = join(WORKSPACE, 'pyramid.db');
const ENTERPRISE_DB_PATH = join(homedir(), '.enterprise', 'messages.db');
const STEP = 10;

if (!existsSync(WORKSPACE)) mkdirSync(WORKSPACE, { recursive: true });
const modelsDir = join(WORKSPACE, 'models');
if (!existsSync(modelsDir)) mkdirSync(modelsDir, { recursive: true });

// ─── SQLite helpers ───

const SQL_PROMISE = initSqlJs();

async function openDb(path) {
  const SQL = await SQL_PROMISE;
  if (existsSync(path)) {
    return new SQL.Database(readFileSync(path));
  }
  return new SQL.Database();
}

function saveDb(db, path) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, Buffer.from(db.export()));
}

function queryAll(db, sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function queryOne(db, sql, params = []) {
  return queryAll(db, sql, params)[0] || null;
}

// ─── LLM via Claude CLI ───

function claudeComplete(system, prompt) {
  const input = JSON.stringify({ system, prompt });
  const fullPrompt = `${system}\n\n---\n\n${prompt}`;
  const escaped = fullPrompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  try {
    return execSync(`claude --print -p "${escaped}"`, {
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 10,
    }).trim();
  } catch (err) {
    console.error('Claude CLI error:', err.message);
    return null;
  }
}

function claudeToolCall(system, prompt, tools) {
  // For tool calls, we instruct Claude to respond in JSON
  const toolDescs = tools.map(t =>
    `Tool: ${t.name}\nDescription: ${t.description}\nParameters: ${JSON.stringify(t.parameters)}`
  ).join('\n\n');

  const fullPrompt = `${system}

Available tools:
${toolDescs}

Respond with a JSON array of tool calls. Each element: {"name": "<tool_name>", "args": {<parameters>}}
Respond ONLY with the JSON array, no other text.

---

${prompt}`;

  const escaped = fullPrompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  try {
    const raw = execSync(`claude --print -p "${escaped}"`, {
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 10,
    }).trim();

    // Extract JSON array from response
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    return JSON.parse(match[0]);
  } catch (err) {
    console.error('Claude tool call error:', err.message);
    return [];
  }
}

// ─── Pyramid Schema ───

const PYRAMID_SCHEMA = `
  CREATE TABLE IF NOT EXISTS models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    is_base BOOLEAN DEFAULT 0,
    synthesized_content TEXT,
    content_dirty BOOLEAN DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    model_id INTEGER REFERENCES models(id),
    source_type TEXT,
    source_id TEXT
  );
  CREATE TABLE IF NOT EXISTS summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id INTEGER NOT NULL REFERENCES models(id),
    tier INTEGER NOT NULL,
    text TEXT NOT NULL,
    start_timestamp TEXT,
    end_timestamp TEXT,
    is_dirty BOOLEAN DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS summary_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    summary_id INTEGER NOT NULL REFERENCES summaries(id),
    source_type TEXT NOT NULL,
    source_id INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS synced_threads (
    thread_id TEXT PRIMARY KEY,
    last_message_at INTEGER,
    synced_at INTEGER
  );
  INSERT OR IGNORE INTO models (name, description, is_base) VALUES ('assistant', 'AI assistant experience and reflections', 1);
  INSERT OR IGNORE INTO models (name, description, is_base) VALUES ('user', 'Primary user identity, preferences, and projects', 1);
`;

// ─── Core Pipeline ───

async function getNewConversations(enterpriseDb, pyramidDb) {
  // Find threads with messages newer than last sync
  const threads = queryAll(enterpriseDb, 'SELECT * FROM threads ORDER BY updated_at DESC');
  const newConvos = [];

  for (const thread of threads) {
    const synced = queryOne(pyramidDb, 'SELECT * FROM synced_threads WHERE thread_id = ?', [thread.id]);
    const lastMessageAt = synced ? synced.last_message_at : 0;

    const messages = queryAll(enterpriseDb,
      "SELECT * FROM messages WHERE thread_id = ? AND status = 'complete' AND created_at > ? ORDER BY created_at ASC",
      [thread.id, lastMessageAt]
    );

    if (messages.length >= 2) { // Need at least a user+assistant pair
      newConvos.push({ thread, messages });
    }
  }

  return newConvos;
}

function extractObservations(messages) {
  const conversationText = messages
    .map(m => `[${new Date(Number(m.created_at)).toISOString()}] ${m.role}: ${m.content}`)
    .join('\n\n');

  const system = `You are a memory extraction agent. Extract specific, factual observations from the conversation.
Each observation should be a single factual sentence with specific names, dates, numbers, places, preferences.
NOT meta-observations ("user discussed X") — capture the actual fact ("User lives in Austin").
Call add_observation for each distinct fact.`;

  const toolCalls = claudeToolCall(system,
    `Extract factual observations from this conversation:\n\n${conversationText}`,
    [{
      name: 'add_observation',
      description: 'Record a factual observation',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Single factual sentence' },
          timestamp: { type: 'string', description: 'ISO timestamp' },
        },
        required: ['text'],
      },
    }]
  );

  return toolCalls
    .filter(tc => tc.name === 'add_observation')
    .map(tc => ({
      text: tc.args.text,
      timestamp: tc.args.timestamp || new Date().toISOString(),
    }));
}

function assignToModels(pyramidDb, observations) {
  if (!observations.length) return;

  const models = queryAll(pyramidDb, 'SELECT * FROM models ORDER BY is_base DESC, name');
  const modelsContext = models.map(m => {
    const samples = queryAll(pyramidDb,
      'SELECT text FROM observations WHERE model_id = ? ORDER BY rowid DESC LIMIT 3',
      [m.id]
    );
    return `### ${m.name}\n${m.description || '(auto)'}\n${samples.map(s => `  - ${s.text}`).join('\n')}`;
  }).join('\n\n');

  for (let i = 0; i < observations.length; i += STEP) {
    const batch = observations.slice(i, i + STEP);
    const obsText = batch.map((o, idx) => `[${o.id}] ${o.text}`).join('\n');

    const toolCalls = claudeToolCall(
      `You assign observations to mental models. Call assign_model for each.
Base: assistant (AI self), user (human). Create new models for distinct entities only when needed.`,
      `${modelsContext}\n\nAssign:\n${obsText}`,
      [{
        name: 'assign_model',
        description: 'Assign observation to model',
        parameters: {
          type: 'object',
          properties: {
            observation_id: { type: 'number' },
            model_name: { type: 'string' },
          },
          required: ['observation_id', 'model_name'],
        },
      }]
    );

    for (const tc of toolCalls) {
      if (tc.name !== 'assign_model') continue;
      const modelName = String(tc.args.model_name).toLowerCase().trim().replace(/\s+/g, '-');
      let model = queryOne(pyramidDb, 'SELECT * FROM models WHERE name = ?', [modelName]);
      if (!model) {
        pyramidDb.run('INSERT INTO models (name, content_dirty) VALUES (?, 1)', [modelName]);
        model = queryOne(pyramidDb, 'SELECT * FROM models WHERE name = ?', [modelName]);
      }
      if (model) {
        pyramidDb.run('UPDATE observations SET model_id = ? WHERE id = ?', [model.id, tc.args.observation_id]);
        pyramidDb.run('UPDATE models SET content_dirty = 1 WHERE id = ?', [model.id]);
      }
    }
  }
}

function compressTier0(pyramidDb, modelId) {
  const lastT0 = queryOne(pyramidDb,
    'SELECT MAX(end_timestamp) as ts FROM summaries WHERE model_id = ? AND tier = 0',
    [modelId]
  );
  const cutoff = lastT0?.ts || '';

  const obs = cutoff
    ? queryAll(pyramidDb,
        'SELECT * FROM observations WHERE model_id = ? AND timestamp > ? ORDER BY timestamp',
        [modelId, cutoff])
    : queryAll(pyramidDb,
        'SELECT * FROM observations WHERE model_id = ? ORDER BY timestamp',
        [modelId]);

  let created = 0;
  for (let i = 0; i + STEP <= obs.length; i += STEP) {
    const batch = obs.slice(i, i + STEP);
    const text = batch.map(o => `[${o.timestamp}] ${o.text}`).join('\n');

    const summary = claudeComplete(
      'You create concise summaries. Preserve names, dates, numbers. Write narrative prose.',
      `Summarize these ${batch.length} observations:\n\n${text}`
    );
    if (!summary) continue;

    pyramidDb.run(
      'INSERT INTO summaries (model_id, tier, text, start_timestamp, end_timestamp) VALUES (?, 0, ?, ?, ?)',
      [modelId, summary, batch[0].timestamp, batch[batch.length - 1].timestamp]
    );
    created++;
  }
  if (created) pyramidDb.run('UPDATE models SET content_dirty = 1 WHERE id = ?', [modelId]);
  return created;
}

function compressHigherTiers(pyramidDb, modelId) {
  let created = 0;
  let tier = 0;

  while (true) {
    const lastNext = queryOne(pyramidDb,
      'SELECT MAX(end_timestamp) as ts FROM summaries WHERE model_id = ? AND tier = ?',
      [modelId, tier + 1]
    );
    const cutoff = lastNext?.ts || '';

    const current = cutoff
      ? queryAll(pyramidDb,
          'SELECT * FROM summaries WHERE model_id = ? AND tier = ? AND end_timestamp > ? ORDER BY end_timestamp',
          [modelId, tier, cutoff])
      : queryAll(pyramidDb,
          'SELECT * FROM summaries WHERE model_id = ? AND tier = ? ORDER BY end_timestamp',
          [modelId, tier]);

    if (current.length < STEP) break;

    for (let i = 0; i + STEP <= current.length; i += STEP) {
      const batch = current.slice(i, i + STEP);
      const text = batch.map(s => `[${s.start_timestamp} → ${s.end_timestamp}]\n${s.text}`).join('\n\n');

      const summary = claudeComplete(
        'You create higher-level summaries from existing summaries. Preserve key facts.',
        `Synthesize these tier-${tier} summaries:\n\n${text}`
      );
      if (!summary) continue;

      pyramidDb.run(
        'INSERT INTO summaries (model_id, tier, text, start_timestamp, end_timestamp) VALUES (?, ?, ?, ?, ?)',
        [modelId, tier + 1, summary, batch[0].start_timestamp, batch[batch.length - 1].end_timestamp]
      );
      created++;
    }
    tier++;
  }

  if (created) pyramidDb.run('UPDATE models SET content_dirty = 1 WHERE id = ?', [modelId]);
  return created;
}

const TIME_BUCKETS = [
  ['Last 3 Days', 3], ['This Week', 7], ['This Month', 30],
  ['This Quarter', 90], ['This Year', 365], ['Earlier', null],
];

function synthesizeModel(pyramidDb, model) {
  const summaries = queryAll(pyramidDb,
    'SELECT * FROM summaries WHERE model_id = ? ORDER BY tier DESC, end_timestamp DESC',
    [model.id]
  );

  // Get unsummarized recent observations
  const lastTs = summaries.length
    ? summaries.reduce((m, s) => s.end_timestamp > m ? s.end_timestamp : m, '')
    : '';
  const recentObs = lastTs
    ? queryAll(pyramidDb, 'SELECT * FROM observations WHERE model_id = ? AND timestamp > ? ORDER BY timestamp', [model.id, lastTs])
    : queryAll(pyramidDb, 'SELECT * FROM observations WHERE model_id = ? ORDER BY timestamp DESC LIMIT 20', [model.id]);

  const items = [];
  for (const s of summaries) items.push({ text: s.text, end_timestamp: s.end_timestamp, tier: s.tier });
  for (const o of recentObs) items.push({ text: o.text, end_timestamp: o.timestamp, tier: -1 });

  if (!items.length) return null;

  const refDate = new Date(items.reduce((m, i) => i.end_timestamp > m ? i.end_timestamp : m, ''));

  // Bucket by time
  const sections = [];
  for (const [label, days] of TIME_BUCKETS) {
    const bucket = items.filter(i => {
      const diff = (refDate - new Date(i.end_timestamp)) / (1000 * 60 * 60 * 24);
      if (days === null) return true; // "Earlier" catches all remaining
      return diff <= days;
    });
    // Remove items already captured by tighter buckets
    const filtered = bucket.filter(i => {
      const diff = (refDate - new Date(i.end_timestamp)) / (1000 * 60 * 60 * 24);
      const prevBucket = TIME_BUCKETS.find(([, d]) => d !== null && d < days && diff <= d);
      return !prevBucket || days === null;
    });
    if (!filtered.length) continue;
    const content = filtered
      .sort((a, b) => b.end_timestamp.localeCompare(a.end_timestamp))
      .map(i => `[${i.end_timestamp.slice(0, 10)}] ${i.text}`)
      .join('\n');
    sections.push(`### ${label}\n${content}`);
  }

  if (!sections.length) return null;

  const voice = model.name === 'assistant'
    ? 'first person (I, me, my) as the AI assistant'
    : 'third person narrative prose';

  return claudeComplete(
    `Synthesize memory into a coherent narrative. Write in ${voice}. Be specific and factual.`,
    `About "${model.name}" (${model.description || 'auto-discovered'}):\n\n${sections.join('\n\n')}`
  );
}

function exportToMarkdown(pyramidDb) {
  const models = queryAll(pyramidDb, 'SELECT * FROM models ORDER BY is_base DESC, name');
  const stats = queryOne(pyramidDb, 'SELECT COUNT(*) as c FROM observations');

  const parts = [
    `# MEMORY.md — Pyramid Memory\n`,
    `*Auto-generated. ${models.length} mental models, ${stats?.c || 0} observations.*\n`,
  ];

  for (const model of models) {
    if (!model.synthesized_content) continue;

    // Individual file
    const content = `# ${model.name}\n\n${model.description ? `*${model.description}*\n\n` : ''}${model.synthesized_content}\n`;
    writeFileSync(join(modelsDir, `${model.name}.md`), content);

    // Combined
    parts.push(`## ${model.name}\n`);
    if (model.description) parts.push(`*${model.description}*\n`);
    parts.push(model.synthesized_content);
    parts.push('');
  }

  writeFileSync(join(WORKSPACE, 'MEMORY.md'), parts.join('\n'));
}

// ─── Main ───

async function run() {
  console.log(`Pyramid sync starting (workspace: ${WORKSPACE})`);

  // Open databases
  const pyramidDb = await openDb(PYRAMID_DB_PATH);
  pyramidDb.run(PYRAMID_SCHEMA);
  saveDb(pyramidDb, PYRAMID_DB_PATH);

  // Check for Enterprise messages DB
  if (!existsSync(ENTERPRISE_DB_PATH)) {
    console.log('No Enterprise messages database found. Nothing to sync.');
    pyramidDb.close();
    return;
  }

  const enterpriseDb = await openDb(ENTERPRISE_DB_PATH);

  // 1. Find new conversations
  const convos = await getNewConversations(enterpriseDb, pyramidDb);
  console.log(`Found ${convos.length} conversations with new messages`);

  if (!convos.length) {
    console.log('Nothing new to process.');
    enterpriseDb.close();
    pyramidDb.close();
    return;
  }

  let totalObs = 0;

  for (const { thread, messages } of convos) {
    console.log(`\nThread "${thread.title}" — ${messages.length} new messages`);

    // Extract observations
    const observations = extractObservations(messages);
    console.log(`  Extracted ${observations.length} observations`);

    // Insert into pyramid DB
    for (const obs of observations) {
      pyramidDb.run(
        'INSERT INTO observations (text, timestamp, source_type, source_id) VALUES (?, ?, ?, ?)',
        [obs.text, obs.timestamp, 'enterprise', thread.id]
      );
    }
    totalObs += observations.length;

    // Get newly inserted observations (with IDs)
    const inserted = queryAll(pyramidDb,
      'SELECT * FROM observations WHERE source_id = ? AND model_id IS NULL ORDER BY rowid DESC LIMIT ?',
      [thread.id, observations.length]
    );

    // Assign to models
    assignToModels(pyramidDb, inserted);
    console.log(`  Assigned to models`);

    // Mark thread as synced
    const lastMsg = messages[messages.length - 1];
    pyramidDb.run(
      'INSERT OR REPLACE INTO synced_threads (thread_id, last_message_at, synced_at) VALUES (?, ?, ?)',
      [thread.id, Number(lastMsg.created_at), Date.now()]
    );

    saveDb(pyramidDb, PYRAMID_DB_PATH);
  }

  enterpriseDb.close();

  // 2. Compress all models
  console.log('\nCompressing...');
  const models = queryAll(pyramidDb, 'SELECT * FROM models');
  let t0Total = 0, htTotal = 0;

  for (const model of models) {
    const t0 = compressTier0(pyramidDb, model.id);
    const ht = compressHigherTiers(pyramidDb, model.id);
    if (t0 || ht) console.log(`  ${model.name}: ${t0} tier-0, ${ht} higher`);
    t0Total += t0;
    htTotal += ht;
  }
  saveDb(pyramidDb, PYRAMID_DB_PATH);

  // 3. Synthesize dirty models
  console.log('\nSynthesizing...');
  const dirty = queryAll(pyramidDb, 'SELECT * FROM models WHERE content_dirty = 1');
  let synthCount = 0;

  for (const model of dirty) {
    console.log(`  ${model.name}...`);
    const content = synthesizeModel(pyramidDb, model);
    if (content) {
      pyramidDb.run('UPDATE models SET synthesized_content = ?, content_dirty = 0 WHERE id = ?', [content, model.id]);
      synthCount++;
    }
  }
  saveDb(pyramidDb, PYRAMID_DB_PATH);

  // 4. Export
  console.log('\nExporting markdown...');
  exportToMarkdown(pyramidDb);

  pyramidDb.close();

  console.log(`\n✓ Sync complete: ${totalObs} observations, ${t0Total} tier-0, ${htTotal} higher, ${synthCount} synthesized`);
  console.log(`  Files: ${WORKSPACE}/MEMORY.md + ${WORKSPACE}/models/`);
}

// ─── Loop or once ───

const loop = process.argv.includes('--loop');
const interval = parseInt(process.argv.find(a => a.startsWith('--interval='))?.split('=')[1] || '300') * 1000;

if (loop) {
  console.log(`Pyramid sync daemon (every ${interval / 1000}s)...`);
  const tick = async () => {
    try { await run(); } catch (e) { console.error('Sync error:', e); }
    setTimeout(tick, interval);
  };
  tick();
} else {
  run().catch(console.error);
}
