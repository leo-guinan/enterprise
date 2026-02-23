#!/usr/bin/env node
/**
 * Enterprise Daemon Poll
 *
 * Picks up pending user messages from the SQLite queue,
 * gathers thread context, sends to Claude Code CLI,
 * and writes the response back.
 *
 * Run once: node daemon/poll.mjs
 * Run loop: node daemon/poll.mjs --loop
 */

import initSqlJs from 'sql.js';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

const dbPath = join(homedir(), '.enterprise', 'messages.db');
if (!existsSync(dbPath)) {
  console.error('Database not found. Start the server first: npm run server');
  process.exit(1);
}

const SQL = await initSqlJs();
const buffer = readFileSync(dbPath);
const db = new SQL.Database(buffer);

function save() {
  writeFileSync(dbPath, Buffer.from(db.export()));
}

function queryOne(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const result = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return result;
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function run(sql, params = []) {
  db.run(sql, params);
  save();
}

async function processPending() {
  // Re-read DB to pick up new messages from server
  const freshBuffer = readFileSync(dbPath);
  const freshDb = new SQL.Database(freshBuffer);

  const stmt = freshDb.prepare("SELECT * FROM messages WHERE status = 'pending' AND role = 'user' ORDER BY created_at ASC LIMIT 1");
  const msg = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();

  if (!msg) { freshDb.close(); return false; }

  console.log(`Processing message ${msg.id}: "${String(msg.content).slice(0, 60)}..."`);

  // Mark as processing
  freshDb.run('UPDATE messages SET status = ?, updated_at = ? WHERE id = ?', ['processing', Date.now(), msg.id]);
  writeFileSync(dbPath, Buffer.from(freshDb.export()));

  try {
    // Build context from thread history
    const histStmt = freshDb.prepare("SELECT role, content FROM messages WHERE thread_id = ? AND status = 'complete' ORDER BY created_at ASC");
    histStmt.bind([msg.thread_id]);
    const history = [];
    while (histStmt.step()) history.push(histStmt.getAsObject());
    histStmt.free();

    let prompt = '';
    if (history.length > 0) {
      prompt += 'Previous conversation:\n';
      for (const m of history) {
        prompt += `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}\n\n`;
      }
      prompt += '---\n\n';
    }
    prompt += `Human: ${msg.content}`;

    // Call Claude Code CLI (uses Max plan auth)
    const escaped = prompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const response = execSync(`claude --print -p "${escaped}"`, {
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 10,
    }).trim();

    // Insert assistant response
    const now = Date.now();
    freshDb.run(
      'INSERT INTO messages (id, thread_id, role, content, status, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [randomUUID(), msg.thread_id, 'assistant', response, 'complete',
       JSON.stringify({ model: 'claude-max', latency: Date.now() - Number(msg.created_at) }), now, now]
    );

    // Mark original as complete
    freshDb.run('UPDATE messages SET status = ?, updated_at = ? WHERE id = ?', ['complete', now, msg.id]);
    writeFileSync(dbPath, Buffer.from(freshDb.export()));
    freshDb.close();

    console.log(`✓ Response written (${response.length} chars)`);
    return true;
  } catch (err) {
    console.error(`✗ Error:`, err.message);
    const now = Date.now();
    freshDb.run('UPDATE messages SET status = ?, updated_at = ? WHERE id = ?', ['error', now, msg.id]);
    freshDb.run(
      'INSERT INTO messages (id, thread_id, role, content, status, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [randomUUID(), msg.thread_id, 'assistant', `Error: ${err.message}`, 'complete', null, now, now]
    );
    writeFileSync(dbPath, Buffer.from(freshDb.export()));
    freshDb.close();
    return true;
  }
}

// Main
const loop = process.argv.includes('--loop');
const interval = parseInt(process.argv.find(a => a.startsWith('--interval='))?.split('=')[1] || '5') * 1000;

if (loop) {
  console.log(`Enterprise daemon running (poll every ${interval / 1000}s)...`);
  const tick = async () => {
    try { await processPending(); } catch (e) { console.error(e); }
    setTimeout(tick, interval);
  };
  tick();
} else {
  const found = await processPending();
  if (!found) console.log('No pending messages.');
}
