#!/usr/bin/env node
/**
 * Enterprise Fallback Bridge
 *
 * Runs LOCALLY. Polls a remote Enterprise headless instance for messages
 * that failed processing (status='error' or circuit breaker open).
 * Processes them locally (Claude Max) and pushes responses back.
 *
 * The remote server is the router. The local machine is the brain.
 *
 * Usage:
 *   node daemon/fallback-bridge.mjs --remote https://your-vps:4111 --token xxx
 *   node daemon/fallback-bridge.mjs --remote https://your-vps:4111 --token xxx --poll 10
 *
 * Flow:
 *   1. Poll remote /api/fallback/pending (messages remote couldn't process)
 *   2. Process locally via Claude Max (claude --print)
 *   3. Push response back to remote /api/fallback/respond
 *   4. Remote inserts response, marks original complete
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const args = process.argv.slice(2);
function getArg(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? (args[idx + 1] || fallback) : fallback;
}

const REMOTE_URL = getArg('--remote', '').replace(/\/$/, '');
const AUTH_TOKEN = getArg('--token', process.env.ENTERPRISE_AUTH_TOKEN || '');
const POLL_INTERVAL = parseInt(getArg('--poll', '10')) * 1000;
const MEMORY_PATH = getArg('--memory', join(homedir(), '.enterprise', 'memory', 'MEMORY.md'));
const SOUL_PATH = getArg('--soul', '');

if (!REMOTE_URL) {
  console.log(`Enterprise Fallback Bridge

Runs locally. Processes messages that the remote headless instance couldn't handle.

Usage:
  node daemon/fallback-bridge.mjs --remote https://your-vps:4111 --token xxx

Options:
  --remote URL     Remote Enterprise API URL (required)
  --token TOKEN    Auth token for remote API
  --poll 10        Poll interval in seconds (default: 10)
  --memory PATH    Local MEMORY.md path for context injection
  --soul PATH      Local SOUL.md path for personality injection
`);
  process.exit(0);
}

const headers = {
  'Content-Type': 'application/json',
  ...(AUTH_TOKEN ? { 'Authorization': `Bearer ${AUTH_TOKEN}` } : {}),
};

// ─── Remote API calls ───

async function fetchRemote(path, options = {}) {
  try {
    const res = await fetch(`${REMOTE_URL}${path}`, {
      headers,
      ...options,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[remote] ${res.status} ${path}: ${text}`);
      return null;
    }
    return res.json();
  } catch (e) {
    console.error(`[remote] ${path} failed:`, e.message);
    return null;
  }
}

async function getPendingFallbacks() {
  return fetchRemote('/api/fallback/pending');
}

async function pushResponse(messageId, threadId, content, metadata) {
  return fetchRemote('/api/fallback/respond', {
    method: 'POST',
    body: JSON.stringify({ messageId, threadId, content, metadata }),
  });
}

// ─── Local LLM (Claude Max) ───

function processLocally(prompt) {
  const escaped = prompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const start = Date.now();
  try {
    const response = execSync(`claude --print -p "${escaped}"`, {
      encoding: 'utf8',
      timeout: 180000, // 3 min for complex prompts
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
    return { ok: true, response, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, response: null, error: e.message, latencyMs: Date.now() - start };
  }
}

// ─── Build prompt with local context ───

function buildPrompt(message, history) {
  let prompt = '';

  // Soul
  if (SOUL_PATH && existsSync(SOUL_PATH)) {
    prompt += readFileSync(SOUL_PATH, 'utf8') + '\n\n---\n\n';
  }

  // Pyramid memory (local copy)
  if (existsSync(MEMORY_PATH)) {
    const memory = readFileSync(MEMORY_PATH, 'utf8');
    if (memory.length > 50) prompt += `[Memory]\n${memory}\n\n---\n\n`;
  }

  // Conversation history
  if (history?.length) {
    prompt += 'Previous conversation:\n';
    for (const m of history) {
      prompt += `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}\n\n`;
    }
    prompt += '---\n\n';
  }

  prompt += `Human: ${message.content}`;
  return prompt;
}

// ─── Main Loop ───

let processed = 0;
let errors = 0;

async function tick() {
  try {
    const data = await getPendingFallbacks();
    if (!data?.messages?.length) return;

    for (const item of data.messages) {
      const { message, history } = item;
      console.log(`[fallback] Processing ${message.id}: "${String(message.content).slice(0, 50)}..."`);

      const prompt = buildPrompt(message, history);
      const result = processLocally(prompt);

      if (result.ok) {
        await pushResponse(message.id, message.thread_id, result.response, {
          provider: 'claude-max-fallback',
          processedBy: 'local',
          latencyMs: result.latencyMs,
        });
        processed++;
        console.log(`[fallback] ✓ Response pushed (${result.response.length} chars, ${result.latencyMs}ms)`);
      } else {
        await pushResponse(message.id, message.thread_id, `Fallback error: ${result.error}`, {
          provider: 'fallback-error',
          processedBy: 'local',
        });
        errors++;
        console.error(`[fallback] ✗ ${result.error}`);
      }
    }
  } catch (e) {
    console.error('[fallback]', e.message);
  }
}

// ─── Start ───

console.log(`
╔═══════════════════════════════════════════╗
║   Enterprise Fallback Bridge (Local)      ║
╠═══════════════════════════════════════════╣
║  Remote:  ${REMOTE_URL.slice(0, 33).padEnd(33)}║
║  Poll:    ${String(POLL_INTERVAL / 1000) + 's'}${' '.repeat(30 - String(POLL_INTERVAL / 1000).length)}║
║  Memory:  ${existsSync(MEMORY_PATH) ? 'loaded' : 'none'}${' '.repeat(28)}║
║  Soul:    ${SOUL_PATH ? 'loaded' : 'none'}${' '.repeat(28)}║
╚═══════════════════════════════════════════╝
`);

// Verify remote is reachable
const health = await fetchRemote('/api/health');
if (health) {
  console.log(`[bridge] Remote is ${health.status}. Circuit: ${health.circuit}. Pending: ${health.pending}`);
} else {
  console.error('[bridge] WARNING: Remote unreachable. Will retry on each poll.');
}

// ─── Optimization Pull ───

let lastOptimizationCheck = 0;
const OPT_CHECK_INTERVAL = 3600000; // hourly

async function checkOptimizations() {
  if (Date.now() - lastOptimizationCheck < OPT_CHECK_INTERVAL) return;
  lastOptimizationCheck = Date.now();

  // Trigger remote telemetry analysis
  await fetchRemote('/api/telemetry/run', { method: 'POST' });

  // Pull optimizations
  const data = await fetchRemote('/api/optimizations');
  if (!data?.optimizations?.length) return;

  const critical = data.optimizations.filter(o => o.severity === 'critical');
  const warnings = data.optimizations.filter(o => o.severity === 'warning');
  const info = data.optimizations.filter(o => o.severity === 'info');

  if (critical.length || warnings.length) {
    console.log(`\n[optimize] ${critical.length} critical, ${warnings.length} warnings, ${info.length} info`);
    for (const opt of [...critical, ...warnings]) {
      console.log(`  ${opt.severity === 'critical' ? '🔴' : '🟡'} ${opt.title}`);
      console.log(`    ${opt.recommendation}`);
      if (opt.script) console.log(`    Script:\n${opt.script.split('\n').map(l => '      ' + l).join('\n')}`);
    }
  }

  // Save locally for reference
  writeFileSync(
    join(homedir(), '.enterprise', 'local-optimizations.json'),
    JSON.stringify(data, null, 2)
  );
}

const loop = () => {
  tick().then(async () => {
    try { await checkOptimizations(); } catch (e) { console.error('[optimize]', e.message); }
    if (processed + errors > 0 && (processed + errors) % 10 === 0) {
      console.log(`[bridge] Stats: ${processed} processed, ${errors} errors`);
    }
    setTimeout(loop, POLL_INTERVAL);
  });
};

loop();
