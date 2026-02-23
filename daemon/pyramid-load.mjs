#!/usr/bin/env node
/**
 * Pyramid Bootloader
 *
 * Bootstrap a pyramid memory from external sources.
 *
 * Usage:
 *   node daemon/pyramid-load.mjs --github https://github.com/user/repo
 *   node daemon/pyramid-load.mjs --github ~/local/repo
 *   node daemon/pyramid-load.mjs --openclaw                              # default sessions
 *   node daemon/pyramid-load.mjs --openclaw ~/.openclaw/agents/main/sessions
 *   node daemon/pyramid-load.mjs --claude ~/Downloads/conversations.json
 *   node daemon/pyramid-load.mjs --markdown ~/clawd/memory
 *   node daemon/pyramid-load.mjs --text "User prefers dark mode"
 *   node daemon/pyramid-load.mjs --workspace ~/custom/memory             # custom workspace
 */

import initSqlJs from 'sql.js';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, mkdtempSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, extname, basename, dirname } from 'path';
import { randomUUID } from 'crypto';

// ─── Args ───

const args = process.argv.slice(2);
const WORKSPACE = getArg('--workspace') || join(homedir(), '.enterprise', 'memory');
const PYRAMID_DB_PATH = join(WORKSPACE, 'pyramid.db');

function getArg(flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  const next = args[idx + 1];
  return next && !next.startsWith('--') ? next : '';
}

function hasFlag(flag) {
  return args.includes(flag);
}

if (!existsSync(WORKSPACE)) mkdirSync(WORKSPACE, { recursive: true });

// ─── DB Setup ───

const SQL_PROMISE = initSqlJs();

const PYRAMID_SCHEMA = `
  CREATE TABLE IF NOT EXISTS models (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, description TEXT, is_base BOOLEAN DEFAULT 0, synthesized_content TEXT, content_dirty BOOLEAN DEFAULT 1);
  CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, timestamp TEXT NOT NULL, model_id INTEGER REFERENCES models(id), source_type TEXT, source_id TEXT);
  CREATE TABLE IF NOT EXISTS summaries (id INTEGER PRIMARY KEY AUTOINCREMENT, model_id INTEGER NOT NULL REFERENCES models(id), tier INTEGER NOT NULL, text TEXT NOT NULL, start_timestamp TEXT, end_timestamp TEXT, is_dirty BOOLEAN DEFAULT 0);
  CREATE TABLE IF NOT EXISTS summary_sources (id INTEGER PRIMARY KEY AUTOINCREMENT, summary_id INTEGER NOT NULL REFERENCES summaries(id), source_type TEXT NOT NULL, source_id INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS synced_threads (thread_id TEXT PRIMARY KEY, last_message_at INTEGER, synced_at INTEGER);
  INSERT OR IGNORE INTO models (name, description, is_base) VALUES ('assistant', 'AI assistant experience and reflections', 1);
  INSERT OR IGNORE INTO models (name, description, is_base) VALUES ('user', 'Primary user identity, preferences, and projects', 1);
`;

async function openDb() {
  const SQL = await SQL_PROMISE;
  let db;
  if (existsSync(PYRAMID_DB_PATH)) {
    db = new SQL.Database(readFileSync(PYRAMID_DB_PATH));
  } else {
    db = new SQL.Database();
  }
  db.run(PYRAMID_SCHEMA);
  saveDb(db);
  return db;
}

function saveDb(db) {
  const dir = dirname(PYRAMID_DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(PYRAMID_DB_PATH, Buffer.from(db.export()));
}

function queryOne(db, sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const result = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return result;
}

// ─── LLM ───

function claudeToolCall(system, prompt, tools) {
  const toolDescs = tools.map(t => `Tool: ${t.name}\n${t.description}\nParams: ${JSON.stringify(t.parameters)}`).join('\n\n');
  const full = `${system}\n\nTools:\n${toolDescs}\n\nRespond with JSON array of tool calls: [{"name":"...","args":{...}}]\nOnly JSON, no other text.\n\n---\n\n${prompt}`;
  const escaped = full.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  try {
    const raw = execSync(`claude --print -p "${escaped}"`, { encoding: 'utf8', timeout: 120000, maxBuffer: 10 * 1024 * 1024 }).trim();
    const match = raw.match(/\[[\s\S]*\]/);
    return match ? JSON.parse(match[0]) : [];
  } catch (e) {
    console.error('LLM error:', e.message);
    return [];
  }
}

function claudeComplete(system, prompt) {
  const full = `${system}\n\n---\n\n${prompt}`;
  const escaped = full.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  try {
    return execSync(`claude --print -p "${escaped}"`, { encoding: 'utf8', timeout: 120000, maxBuffer: 10 * 1024 * 1024 }).trim();
  } catch (e) {
    console.error('LLM error:', e.message);
    return null;
  }
}

// ─── Loaders ───

function findMarkdownFiles(dir, maxDepth = 3, depth = 0) {
  if (depth > maxDepth || !existsSync(dir)) return [];
  const results = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || ['node_modules', 'dist', '.git'].includes(entry)) continue;
    const full = join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) results.push(...findMarkdownFiles(full, maxDepth, depth + 1));
      else if (extname(entry) === '.md') results.push(full);
    } catch {}
  }
  return results;
}

function loadGitHubRepo(repoPath) {
  const messages = [];
  // README
  for (const name of ['README.md', 'readme.md', 'Readme.md']) {
    const p = join(repoPath, name);
    if (existsSync(p)) {
      messages.push({ role: 'assistant', content: `README:\n\n${readFileSync(p, 'utf8')}`, ts: new Date().toISOString() });
      break;
    }
  }
  // package.json
  const pkg = join(repoPath, 'package.json');
  if (existsSync(pkg)) {
    try {
      const p = JSON.parse(readFileSync(pkg, 'utf8'));
      messages.push({ role: 'assistant', content: `Package: ${p.name} — ${p.description || ''}`, ts: new Date().toISOString() });
    } catch {}
  }
  // Markdown files
  for (const f of findMarkdownFiles(repoPath).slice(0, 40)) {
    if (basename(f).toLowerCase().startsWith('readme')) continue;
    const content = readFileSync(f, 'utf8');
    if (content.length < 50 || content.length > 50000) continue;
    messages.push({ role: 'assistant', content: `${f.replace(repoPath + '/', '')}:\n\n${content.slice(0, 10000)}`, ts: new Date().toISOString() });
  }
  return messages;
}

function loadOpenClawSessions(dir) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort().slice(-50);
  const messages = [];
  for (const file of files) {
    for (const line of readFileSync(join(dir, file), 'utf8').trim().split('\n')) {
      try {
        const e = JSON.parse(line);
        if (e.role && e.content) {
          messages.push({
            role: e.role === 'user' ? 'user' : 'assistant',
            content: typeof e.content === 'string' ? e.content : JSON.stringify(e.content),
            ts: e.timestamp || new Date().toISOString(),
          });
        }
      } catch {}
    }
  }
  return messages;
}

function loadClaudeExport(filePath) {
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  const convos = Array.isArray(raw) ? raw : raw.conversations || [raw];
  const messages = [];
  for (const c of convos) {
    for (const m of c.messages || c.chat_messages || []) {
      const role = m.sender === 'human' || m.role === 'user' ? 'user' : 'assistant';
      const content = m.text || m.content || '';
      if (content) messages.push({ role, content: String(content), ts: m.created_at || new Date().toISOString() });
    }
  }
  return messages;
}

// ─── Extract + Assign ───

const STEP = 10;

function extractObservations(messages) {
  const text = messages.map(m => `[${m.ts}] ${m.role}: ${String(m.content).slice(0, 2000)}`).join('\n\n');

  // Chunk if too large
  if (text.length > 15000) {
    const chunks = [];
    for (let i = 0; i < messages.length; i += 20) {
      chunks.push(messages.slice(i, i + 20));
    }
    return chunks.flatMap(chunk => extractObservations(chunk));
  }

  const calls = claudeToolCall(
    `Extract specific factual observations. Each: single sentence, concrete facts (names, dates, numbers). NOT meta-observations.`,
    `Extract observations:\n\n${text}`,
    [{ name: 'add_observation', description: 'Record a fact', parameters: { type: 'object', properties: { text: { type: 'string' }, timestamp: { type: 'string' } }, required: ['text'] } }]
  );
  return calls.filter(c => c.name === 'add_observation').map(c => ({ text: c.args.text, ts: c.args.timestamp || new Date().toISOString() }));
}

function assignObservations(db, obsIds) {
  if (!obsIds.length) return;

  const stmt = db.prepare('SELECT * FROM models ORDER BY is_base DESC, name');
  const models = [];
  while (stmt.step()) models.push(stmt.getAsObject());
  stmt.free();

  for (let i = 0; i < obsIds.length; i += STEP) {
    const batch = obsIds.slice(i, i + STEP);
    const batchObs = batch.map(id => {
      const o = queryOne(db, 'SELECT * FROM observations WHERE id = ?', [id]);
      return o ? `[${o.id}] ${o.text}` : null;
    }).filter(Boolean).join('\n');

    const modelsCtx = models.map(m => `- ${m.name}: ${m.description || '(auto)'}`).join('\n');

    const calls = claudeToolCall(
      `Assign observations to models. Base: assistant, user. Create new ones for distinct entities.`,
      `Models:\n${modelsCtx}\n\nAssign:\n${batchObs}`,
      [{ name: 'assign_model', description: 'Assign', parameters: { type: 'object', properties: { observation_id: { type: 'number' }, model_name: { type: 'string' } }, required: ['observation_id', 'model_name'] } }]
    );

    for (const c of calls) {
      if (c.name !== 'assign_model') continue;
      const name = String(c.args.model_name).toLowerCase().trim().replace(/\s+/g, '-');
      let model = queryOne(db, 'SELECT * FROM models WHERE name = ?', [name]);
      if (!model) {
        db.run('INSERT INTO models (name, content_dirty) VALUES (?, 1)', [name]);
        model = queryOne(db, 'SELECT * FROM models WHERE name = ?', [name]);
      }
      if (model) {
        db.run('UPDATE observations SET model_id = ? WHERE id = ?', [model.id, c.args.observation_id]);
        db.run('UPDATE models SET content_dirty = 1 WHERE id = ?', [model.id]);
      }
    }
    saveDb(db);
    console.log(`  Assigned batch ${Math.floor(i / STEP) + 1}/${Math.ceil(obsIds.length / STEP)}`);
  }
}

// ─── Main ───

async function main() {
  const db = await openDb();
  let messages = [];
  let source = 'unknown';

  // Determine source
  if (hasFlag('--github')) {
    const target = getArg('--github');
    if (target.startsWith('http') || target.startsWith('git@')) {
      console.log(`Cloning ${target}...`);
      const dir = mkdtempSync(join(tmpdir(), 'pyramid-'));
      execSync(`git clone --depth 1 ${target} ${dir}`, { stdio: 'pipe', timeout: 60000 });
      messages = loadGitHubRepo(dir);
      source = `github:${target}`;
    } else {
      messages = loadGitHubRepo(target);
      source = `github:${basename(target)}`;
    }
  } else if (hasFlag('--openclaw')) {
    const dir = getArg('--openclaw') || join(homedir(), '.openclaw', 'agents', 'main', 'sessions');
    messages = loadOpenClawSessions(dir);
    source = 'openclaw';
  } else if (hasFlag('--claude')) {
    const file = getArg('--claude');
    if (!file) { console.error('--claude requires a file path'); process.exit(1); }
    messages = loadClaudeExport(file);
    source = `claude:${basename(file)}`;
  } else if (hasFlag('--markdown')) {
    const dir = getArg('--markdown');
    if (!dir) { console.error('--markdown requires a directory'); process.exit(1); }
    for (const f of findMarkdownFiles(dir)) {
      const content = readFileSync(f, 'utf8');
      if (content.length > 50) messages.push({ role: 'assistant', content: `${basename(f)}:\n\n${content.slice(0, 15000)}`, ts: statSync(f).mtime.toISOString() });
    }
    source = `markdown:${basename(dir)}`;
  } else if (hasFlag('--text')) {
    const text = getArg('--text');
    if (!text) { console.error('--text requires content'); process.exit(1); }
    messages = [{ role: 'user', content: text, ts: new Date().toISOString() }];
    source = 'text';
  } else {
    console.log(`Pyramid Bootloader

Usage:
  pyramid-load --github https://github.com/user/repo
  pyramid-load --github ~/local/repo
  pyramid-load --openclaw [sessions-dir]
  pyramid-load --claude ~/conversations.json
  pyramid-load --markdown ~/docs
  pyramid-load --text "Some fact to remember"
  
Options:
  --workspace ~/custom/path   (default: ~/.enterprise/memory)`);
    db.close();
    return;
  }

  console.log(`\nLoaded ${messages.length} messages from ${source}`);
  if (!messages.length) { console.log('Nothing to process.'); db.close(); return; }

  // Extract observations
  console.log('\nExtracting observations...');
  const observations = extractObservations(messages);
  console.log(`Extracted ${observations.length} observations`);

  // Insert into DB
  const insertedIds = [];
  for (const obs of observations) {
    db.run('INSERT INTO observations (text, timestamp, source_type, source_id) VALUES (?, ?, ?, ?)',
      [obs.text, obs.ts, source.split(':')[0], source]);
    const row = queryOne(db, 'SELECT last_insert_rowid() as id');
    if (row) insertedIds.push(row.id);
  }
  saveDb(db);

  // Assign to models
  console.log('\nAssigning to models...');
  assignObservations(db, insertedIds);

  // Stats
  const stats = {
    models: queryOne(db, 'SELECT COUNT(*) as c FROM models')?.c || 0,
    observations: queryOne(db, 'SELECT COUNT(*) as c FROM observations')?.c || 0,
    unassigned: queryOne(db, 'SELECT COUNT(*) as c FROM observations WHERE model_id IS NULL')?.c || 0,
  };

  console.log(`\n✓ Bootloaded: ${observations.length} observations into ${stats.models} models (${stats.unassigned} unassigned)`);
  console.log(`  Total in pyramid: ${stats.observations} observations`);
  console.log(`\nRun 'npm run pyramid' to compress + synthesize + export MEMORY.md`);

  db.close();
}

main().catch(console.error);
