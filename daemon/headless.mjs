#!/usr/bin/env node
/**
 * Enterprise Headless Runtime
 *
 * Single process that runs everything for production:
 * - API server (no UI, auth required)
 * - Message queue processor (daemon)
 * - Pyramid memory sync
 * - Familiard escalation receiver
 * - Cost tracking + budget enforcement
 * - Reliability: retries, circuit breaker, fallback chain
 *
 * Usage:
 *   node daemon/headless.mjs                           # default config
 *   node daemon/headless.mjs --config ./prod.json      # custom config
 *   node daemon/headless.mjs --port 4111 --budget 10   # CLI overrides
 *   ENTERPRISE_AUTH_TOKEN=xxx node daemon/headless.mjs  # auth via env
 */

import initSqlJs from 'sql.js';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { createServer } from 'http';

// ─── Config ───

const args = process.argv.slice(2);
function getArg(flag, fallback) {
  const idx = args.indexOf(flag);
  if (idx === -1) return fallback;
  return args[idx + 1] || fallback;
}

const CONFIG = {
  port: parseInt(getArg('--port', '4111')),
  bind: getArg('--bind', '0.0.0.0'),
  authToken: getArg('--auth', process.env.ENTERPRISE_AUTH_TOKEN || ''),
  dailyBudget: parseFloat(getArg('--budget', '10')),
  maxRequestsPerHour: parseInt(getArg('--rate-limit', '60')),
  maxRetries: parseInt(getArg('--retries', '3')),
  retryBackoffMs: 2000,
  requestTimeoutMs: 120000,
  circuitBreakerThreshold: 5,
  circuitBreakerResetMs: 300000,
  pollInterval: parseInt(getArg('--poll', '5')) * 1000,
  pyramidSyncInterval: parseInt(getArg('--pyramid-interval', '3600')) * 1000,
  provider: getArg('--provider', 'claude-max'),
  model: getArg('--model', ''),
  apiKey: getArg('--api-key', process.env.ENTERPRISE_API_KEY || ''),
  memoryPath: getArg('--memory', join(homedir(), '.enterprise', 'memory')),
  costLogPath: join(homedir(), '.enterprise', 'cost.log'),
  soulPath: getArg('--soul', ''),
};

const DATA_DIR = join(homedir(), '.enterprise');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ─── Cost Tracking ───

let dailyCost = 0;
let dailyCostDate = new Date().toISOString().slice(0, 10);
let requestsThisHour = 0;
let hourStart = Date.now();

function resetHourlyIfNeeded() {
  if (Date.now() - hourStart > 3600000) {
    requestsThisHour = 0;
    hourStart = Date.now();
  }
}

function resetDailyIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dailyCostDate) {
    dailyCost = 0;
    dailyCostDate = today;
  }
}

function trackCost(tokens, latencyMs) {
  // Rough estimate: Claude Opus ~$15/1M input, ~$75/1M output
  // For Max plan: $0 actual, but we track "equivalent cost" for budgeting
  const estimatedCost = (tokens / 1000000) * 45; // average in/out
  dailyCost += estimatedCost;

  const entry = `${new Date().toISOString()}\t${tokens}\t${latencyMs}ms\t$${estimatedCost.toFixed(4)}\t$${dailyCost.toFixed(4)}\n`;
  try { appendFileSync(CONFIG.costLogPath, entry); } catch {}

  return estimatedCost;
}

function canProcess() {
  resetDailyIfNeeded();
  resetHourlyIfNeeded();

  if (CONFIG.dailyBudget > 0 && dailyCost >= CONFIG.dailyBudget) {
    return { ok: false, reason: `Daily budget exceeded ($${dailyCost.toFixed(2)}/$${CONFIG.dailyBudget})` };
  }
  if (CONFIG.maxRequestsPerHour > 0 && requestsThisHour >= CONFIG.maxRequestsPerHour) {
    return { ok: false, reason: `Rate limit exceeded (${requestsThisHour}/${CONFIG.maxRequestsPerHour}/hr)` };
  }
  return { ok: true, reason: '' };
}

// ─── Circuit Breaker ───

let consecutiveFailures = 0;
let circuitOpen = false;
let circuitOpenedAt = 0;

function checkCircuit() {
  if (!circuitOpen) return true;
  if (Date.now() - circuitOpenedAt > CONFIG.circuitBreakerResetMs) {
    circuitOpen = false;
    consecutiveFailures = 0;
    console.log('[circuit] Half-open, trying again');
    return true;
  }
  return false;
}

function recordSuccess() { consecutiveFailures = 0; circuitOpen = false; }
function recordFailure() {
  consecutiveFailures++;
  if (CONFIG.circuitBreakerThreshold > 0 && consecutiveFailures >= CONFIG.circuitBreakerThreshold) {
    circuitOpen = true;
    circuitOpenedAt = Date.now();
    console.log(`[circuit] OPEN after ${consecutiveFailures} failures. Reset in ${CONFIG.circuitBreakerResetMs / 1000}s`);
  }
}

// ─── LLM Call with retries + fallback ───

function callLLM(prompt, retryCount = 0) {
  if (!checkCircuit()) {
    return { ok: false, error: 'Circuit breaker open', response: null };
  }

  const check = canProcess();
  if (!check.ok) {
    return { ok: false, error: check.reason, response: null };
  }

  const escaped = prompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const start = Date.now();

  try {
    let response;

    if (CONFIG.provider === 'claude-max') {
      response = execSync(`claude --print -p "${escaped}"`, {
        encoding: 'utf8',
        timeout: CONFIG.requestTimeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      }).trim();
    } else if (CONFIG.provider === 'ollama') {
      const body = JSON.stringify({
        model: CONFIG.model || 'llama3.1',
        prompt,
        stream: false,
      });
      response = execSync(`curl -s ${CONFIG.apiKey ? '' : ''} -X POST ${CONFIG.apiKey || 'http://localhost:11434'}/api/generate -d '${body.replace(/'/g, "'\\''")}'`, {
        encoding: 'utf8',
        timeout: CONFIG.requestTimeoutMs,
      });
      response = JSON.parse(response).response || '';
    } else {
      // OpenAI-compatible API (openai, anthropic, openrouter)
      const baseUrl = CONFIG.provider === 'openrouter' ? 'https://openrouter.ai/api/v1'
        : CONFIG.provider === 'anthropic' ? 'https://api.anthropic.com/v1'
        : 'https://api.openai.com/v1';

      const body = JSON.stringify({
        model: CONFIG.model || 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4096,
      });

      const headers = CONFIG.provider === 'anthropic'
        ? `-H "x-api-key: ${CONFIG.apiKey}" -H "anthropic-version: 2023-06-01"`
        : `-H "Authorization: Bearer ${CONFIG.apiKey}"`;

      response = execSync(
        `curl -s ${headers} -H "Content-Type: application/json" -X POST ${baseUrl}/chat/completions -d '${body.replace(/'/g, "'\\''")}'`,
        { encoding: 'utf8', timeout: CONFIG.requestTimeoutMs }
      );
      const parsed = JSON.parse(response);
      response = parsed.choices?.[0]?.message?.content || parsed.content?.[0]?.text || '';
    }

    const latency = Date.now() - start;
    const tokens = Math.ceil(response.length / 4); // rough estimate
    trackCost(tokens, latency);
    requestsThisHour++;
    recordSuccess();

    return { ok: true, error: null, response };
  } catch (err) {
    recordFailure();
    console.error(`[llm] Attempt ${retryCount + 1} failed:`, err.message);

    if (retryCount < CONFIG.maxRetries) {
      const backoff = CONFIG.retryBackoffMs * Math.pow(2, retryCount);
      console.log(`[llm] Retrying in ${backoff}ms...`);
      // Sync sleep (acceptable in daemon context)
      execSync(`sleep ${backoff / 1000}`);
      return callLLM(prompt, retryCount + 1);
    }

    return { ok: false, error: err.message, response: null };
  }
}

// ─── Database ───

const SQL_PROMISE = initSqlJs();
const DB_PATH = join(DATA_DIR, 'messages.db');

let db;

async function initDb() {
  const SQL = await SQL_PROMISE;
  if (existsSync(DB_PATH)) {
    db = new SQL.Database(readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT, soul TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, status TEXT DEFAULT 'pending', metadata TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
  `);
  saveDb();
}

function saveDb() { writeFileSync(DB_PATH, Buffer.from(db.export())); }

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const r = []; while (stmt.step()) r.push(stmt.getAsObject()); stmt.free(); return r;
}
function queryOne(sql, params = []) { return queryAll(sql, params)[0] || null; }

// ─── Message Processor ───

function processPending() {
  // Re-read DB (other processes may have written)
  if (existsSync(DB_PATH)) {
    const SQL = db.constructor;
    const fresh = new SQL(readFileSync(DB_PATH));
    // Swap
    db.close();
    db = fresh;
  }

  const msg = queryOne("SELECT * FROM messages WHERE status = 'pending' AND role = 'user' ORDER BY created_at ASC LIMIT 1");
  if (!msg) return false;

  console.log(`[daemon] Processing: "${String(msg.content).slice(0, 60)}..."`);
  db.run('UPDATE messages SET status = ?, updated_at = ? WHERE id = ?', ['processing', Date.now(), msg.id]);
  saveDb();

  // Build prompt with context
  const history = queryAll("SELECT role, content FROM messages WHERE thread_id = ? AND status = 'complete' ORDER BY created_at ASC", [msg.thread_id]);
  let prompt = '';

  // Soul injection
  if (CONFIG.soulPath && existsSync(CONFIG.soulPath)) {
    prompt += readFileSync(CONFIG.soulPath, 'utf8') + '\n\n---\n\n';
  }

  // Pyramid memory
  const memoryPath = join(CONFIG.memoryPath, 'MEMORY.md');
  if (existsSync(memoryPath)) {
    const memory = readFileSync(memoryPath, 'utf8');
    if (memory.length > 50) prompt += `[Memory]\n${memory}\n\n---\n\n`;
  }

  // History
  if (history.length) {
    prompt += 'Previous conversation:\n';
    for (const m of history) prompt += `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}\n\n`;
    prompt += '---\n\n';
  }

  prompt += `Human: ${msg.content}`;

  const result = callLLM(prompt);
  const now = Date.now();

  if (result.ok) {
    db.run('INSERT INTO messages (id, thread_id, role, content, status, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [randomUUID(), msg.thread_id, 'assistant', result.response, 'complete',
       JSON.stringify({ provider: CONFIG.provider, model: CONFIG.model }), now, now]);
    db.run('UPDATE messages SET status = ?, updated_at = ? WHERE id = ?', ['complete', now, msg.id]);
    console.log(`[daemon] ✓ Response (${result.response.length} chars)`);
  } else {
    // Mark as error — fallback bridge will pick these up
    db.run('UPDATE messages SET status = ?, updated_at = ? WHERE id = ?', ['error', now, msg.id]);
    console.error(`[daemon] ✗ ${result.error} — queued for fallback`);
  }

  saveDb();
  return true;
}

// ─── HTTP Server (no UI, API only) ───

function startServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${CONFIG.port}`);
    const method = req.method;

    // Auth check (skip health endpoint)
    if (CONFIG.authToken && url.pathname !== '/api/health') {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${CONFIG.authToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const json = (data, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    const readBody = () => new Promise((resolve) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    });

    try {
      // Health (no auth)
      if (url.pathname === '/api/health') {
        return json({
          status: 'ok',
          mode: 'headless',
          uptime: process.uptime(),
          provider: CONFIG.provider,
          circuit: circuitOpen ? 'open' : 'closed',
          dailyCost: `$${dailyCost.toFixed(4)}`,
          dailyBudget: CONFIG.dailyBudget > 0 ? `$${CONFIG.dailyBudget}` : 'unlimited',
          requestsThisHour,
          pending: queryOne("SELECT COUNT(*) as c FROM messages WHERE status = 'pending'")?.c || 0,
        });
      }

      // Status
      if (url.pathname === '/api/status' && method === 'GET') {
        return json({
          pending: queryOne("SELECT COUNT(*) as c FROM messages WHERE status = 'pending'")?.c || 0,
          lastHeartbeat: queryOne("SELECT MAX(updated_at) as t FROM messages WHERE role = 'assistant'")?.t || null,
          uptime: process.uptime(),
          mode: 'headless',
          circuit: circuitOpen ? 'open' : 'closed',
          dailyCost: dailyCost.toFixed(4),
        });
      }

      // Threads
      if (url.pathname === '/api/threads' && method === 'GET') {
        return json(queryAll('SELECT * FROM threads ORDER BY updated_at DESC'));
      }
      if (url.pathname === '/api/threads' && method === 'POST') {
        const body = await readBody();
        const id = randomUUID(), now = Date.now(), title = body.title || 'New conversation';
        db.run('INSERT INTO threads (id, title, soul, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          [id, title, body.soul || null, now, now]);
        saveDb();
        return json({ id, title, created_at: now, updated_at: now }, 201);
      }

      // Thread messages
      const threadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/messages$/);
      if (threadMatch && method === 'GET') {
        return json(queryAll('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC', [threadMatch[1]]));
      }
      if (threadMatch && method === 'POST') {
        const threadId = threadMatch[1];
        const body = await readBody();
        const id = randomUUID(), now = Date.now();
        const role = body.role || 'user';
        const status = role === 'user' ? 'pending' : 'complete';
        db.run('INSERT INTO messages (id, thread_id, role, content, status, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [id, threadId, role, body.content, status, body.metadata || null, now, now]);
        saveDb();
        return json({ id, thread_id: threadId, role, content: body.content, status }, 201);
      }

      // Familiard escalation
      if (url.pathname === '/api/familiard/escalate' && method === 'POST') {
        const payload = await readBody();
        const threadId = 'familiard-escalations';
        if (!queryOne('SELECT 1 FROM threads WHERE id = ?', [threadId])) {
          db.run('INSERT INTO threads (id, title, soul, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
            [threadId, '🔴 Familiard', null, Date.now(), Date.now()]);
        }
        const summaries = (payload.events || []).map(e => `• ${e.summary || e.reason}`).join('\n');
        const content = `🔴 Familiard Escalation\n\n${summaries}${payload.context ? `\n\n${payload.context}` : ''}`;
        const now = Date.now();
        db.run('INSERT INTO messages (id, thread_id, role, content, status, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [randomUUID(), threadId, 'user', content, 'pending', JSON.stringify({ source: 'familiard', priority: 'high' }), now, now]);
        saveDb();
        return json({ ok: true });
      }

      // Pyramid status
      if (url.pathname === '/api/pyramid/status' && method === 'GET') {
        const pyPath = join(CONFIG.memoryPath, 'pyramid.db');
        if (!existsSync(pyPath)) return json({ initialized: false });
        try {
          const SQL = await SQL_PROMISE;
          const pyDb = new SQL.Database(readFileSync(pyPath));
          const stats = {
            initialized: true,
            models: pyDb.exec('SELECT COUNT(*) FROM models')[0]?.values[0]?.[0] || 0,
            observations: pyDb.exec('SELECT COUNT(*) FROM observations')[0]?.values[0]?.[0] || 0,
            summaries: pyDb.exec('SELECT COUNT(*) FROM summaries')[0]?.values[0]?.[0] || 0,
          };
          pyDb.close();
          return json(stats);
        } catch { return json({ initialized: false }); }
      }

      // ─── Fallback Bridge Endpoints ───

      // Get messages that need fallback processing
      if (url.pathname === '/api/fallback/pending' && method === 'GET') {
        // Messages that errored OR are pending while circuit is open
        const errorMsgs = queryAll(
          "SELECT * FROM messages WHERE status = 'error' AND role = 'user' ORDER BY created_at ASC LIMIT 5"
        );
        const pendingWhileOpen = circuitOpen
          ? queryAll("SELECT * FROM messages WHERE status = 'pending' AND role = 'user' ORDER BY created_at ASC LIMIT 5")
          : [];

        const allMsgs = [...errorMsgs, ...pendingWhileOpen];
        const result = allMsgs.map(msg => {
          const history = queryAll(
            "SELECT role, content FROM messages WHERE thread_id = ? AND status = 'complete' ORDER BY created_at ASC",
            [msg.thread_id]
          );
          // Mark as processing so we don't double-send
          db.run('UPDATE messages SET status = ?, updated_at = ? WHERE id = ?', ['processing', Date.now(), msg.id]);
          saveDb();
          return { message: msg, history };
        });

        return json({ messages: result, circuitOpen, dailyCost: dailyCost.toFixed(4) });
      }

      // Receive processed response from local fallback
      if (url.pathname === '/api/fallback/respond' && method === 'POST') {
        const body = await readBody();
        const { messageId, threadId, content, metadata } = body;
        const now = Date.now();

        // Insert assistant response
        db.run('INSERT INTO messages (id, thread_id, role, content, status, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [randomUUID(), threadId, 'assistant', content, 'complete',
           JSON.stringify(metadata || { provider: 'fallback' }), now, now]);

        // Mark original as complete
        db.run('UPDATE messages SET status = ?, updated_at = ? WHERE id = ?', ['complete', now, messageId]);
        saveDb();

        return json({ ok: true });
      }

      // Cost log
      if (url.pathname === '/api/cost' && method === 'GET') {
        return json({
          dailyCost: dailyCost.toFixed(4),
          dailyBudget: CONFIG.dailyBudget,
          requestsThisHour,
          maxRequestsPerHour: CONFIG.maxRequestsPerHour,
          circuit: circuitOpen ? 'open' : 'closed',
          consecutiveFailures,
        });
      }

      // Telemetry + Optimizations
      if (url.pathname === '/api/telemetry' && method === 'GET') {
        const tPath = join(DATA_DIR, 'telemetry.json');
        if (existsSync(tPath)) return json(JSON.parse(readFileSync(tPath, 'utf8')));
        return json({ error: 'No telemetry yet. Run: node daemon/telemetry.mjs' }, 404);
      }

      if (url.pathname === '/api/optimizations' && method === 'GET') {
        const oPath = join(DATA_DIR, 'optimizations.json');
        if (existsSync(oPath)) return json(JSON.parse(readFileSync(oPath, 'utf8')));
        return json({ error: 'No optimizations yet. Run: node daemon/telemetry.mjs' }, 404);
      }

      // Trigger telemetry analysis
      if (url.pathname === '/api/telemetry/run' && method === 'POST') {
        try {
          execSync(`node ${join(dirname(new URL(import.meta.url).pathname), 'telemetry.mjs')}`, {
            encoding: 'utf8', timeout: 30000, stdio: 'pipe',
          });
          const oPath = join(DATA_DIR, 'optimizations.json');
          if (existsSync(oPath)) return json(JSON.parse(readFileSync(oPath, 'utf8')));
          return json({ ok: true });
        } catch (e) { return json({ error: e.message }, 500); }
      }

      // 404
      json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error('[server]', err);
      json({ error: 'Internal error' }, 500);
    }
  });

  server.listen(CONFIG.port, CONFIG.bind, () => {
    console.log(`[server] Headless API on http://${CONFIG.bind}:${CONFIG.port}`);
  });
}

// ─── Pyramid Sync (inline, simplified) ───

let lastPyramidSync = 0;

function maybePyramidSync() {
  if (Date.now() - lastPyramidSync < CONFIG.pyramidSyncInterval) return;
  try {
    console.log('[pyramid] Running sync...');
    execSync(`node ${join(dirname(new URL(import.meta.url).pathname), 'pyramid-sync.mjs')} --workspace ${CONFIG.memoryPath}`, {
      encoding: 'utf8',
      timeout: 300000,
      stdio: 'inherit',
    });
    lastPyramidSync = Date.now();
  } catch (e) {
    console.error('[pyramid] Sync failed:', e.message);
  }
}

// ─── Main Loop ───

async function main() {
  console.log(`
╔══════════════════════════════════════╗
║   THE ENTERPRISE — Headless Mode    ║
╠══════════════════════════════════════╣
║  Provider: ${CONFIG.provider.padEnd(24)}║
║  Budget:   $${String(CONFIG.dailyBudget).padEnd(23)}║
║  Rate:     ${String(CONFIG.maxRequestsPerHour)}/hr${' '.repeat(20 - String(CONFIG.maxRequestsPerHour).length)}║
║  Retries:  ${String(CONFIG.maxRetries).padEnd(24)}║
║  Circuit:  ${String(CONFIG.circuitBreakerThreshold)} failures${' '.repeat(16 - String(CONFIG.circuitBreakerThreshold).length)}║
║  Memory:   ${CONFIG.memoryPath.slice(-24).padEnd(24)}║
╚══════════════════════════════════════╝
`);

  await initDb();
  startServer();

  // Daemon loop
  console.log(`[daemon] Polling every ${CONFIG.pollInterval / 1000}s`);

  const tick = () => {
    try {
      processPending();
      maybePyramidSync();
    } catch (e) {
      console.error('[daemon]', e.message);
    }
    setTimeout(tick, CONFIG.pollInterval);
  };

  tick();
}

main().catch(console.error);
