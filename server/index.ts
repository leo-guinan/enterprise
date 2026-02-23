import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { v4 as uuid } from 'uuid';
import {
  initDb,
  listThreads,
  getThread,
  createThread,
  deleteThread,
  updateThread,
  listMessages,
  createMessage,
  getPendingCount,
  getLastHeartbeat,
} from './db.js';

const app = new Hono();
app.use('/*', cors());

app.get('/api/threads', (c) => c.json(listThreads()));

app.post('/api/threads', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = uuid();
  const now = Date.now();
  const title = body.title || 'New conversation';
  createThread(id, title, body.soul || null, now);
  return c.json({ id, title, soul: body.soul || null, created_at: now, updated_at: now }, 201);
});

app.delete('/api/threads/:id', (c) => {
  deleteThread(c.req.param('id'));
  return c.json({ ok: true });
});

app.patch('/api/threads/:id', async (c) => {
  const body = await c.req.json();
  updateThread(body.title, Date.now(), c.req.param('id'));
  return c.json({ ok: true });
});

app.get('/api/threads/:id/messages', (c) => {
  return c.json(listMessages(c.req.param('id')));
});

app.post('/api/threads/:id/messages', async (c) => {
  const threadId = c.req.param('id');
  const body = await c.req.json();
  const thread = getThread(threadId);
  if (!thread) return c.json({ error: 'Thread not found' }, 404);

  const id = uuid();
  const now = Date.now();
  const role = body.role || 'user';
  const status = role === 'user' ? 'pending' : 'complete';

  createMessage(id, threadId, role, body.content, status, body.metadata || null, now);
  updateThread(thread.title, now, threadId);

  return c.json({ id, thread_id: threadId, role, content: body.content, status, created_at: now, updated_at: now }, 201);
});

app.get('/api/status', (c) => {
  return c.json({
    pending: getPendingCount(),
    lastHeartbeat: getLastHeartbeat(),
    uptime: process.uptime(),
  });
});

// ─── Familiard Integration ───

let familiardEscalationCount = 0;
let familiardLastEscalation: number | null = null;

// Receive escalations from Familiard
app.post('/api/familiard/escalate', async (c) => {
  const payload = await c.req.json();

  // Ensure escalation thread exists
  const threadId = 'familiard-escalations';
  const existing = getThread(threadId);
  if (!existing) {
    createThread(threadId, '🔴 Familiard Escalations', null, Date.now());
  }

  // Build message from escalation
  const summaries = (payload.events || [])
    .map((e: any) => `• ${e.summary || e.reason}`)
    .join('\n');
  const content = `🔴 Familiard Escalation\n\n${summaries}${
    payload.context ? `\n\nRecent activity:\n${payload.context}` : ''
  }\n\nPlease analyze and respond.`;

  const now = Date.now();
  createMessage(uuid(), threadId, 'user', content, 'pending',
    JSON.stringify({ source: 'familiard', priority: 'high', events: payload.events }), now);
  updateThread('🔴 Familiard Escalations', now, threadId);

  familiardEscalationCount++;
  familiardLastEscalation = now;

  return c.json({ ok: true, escalationCount: familiardEscalationCount });
});

// Familiard status
app.get('/api/familiard/status', (c) => {
  return c.json({
    lastEscalation: familiardLastEscalation,
    escalationCount: familiardEscalationCount,
  });
});

// Pyramid memory status (reads separate pyramid DB)
app.get('/api/pyramid/status', async (c) => {
  const { homedir } = await import('os');
  const { join } = await import('path');
  const { existsSync, readFileSync } = await import('fs');
  const pyramidPath = join(homedir(), '.enterprise', 'memory', 'pyramid.db');
  if (!existsSync(pyramidPath)) return c.json({ initialized: false });

  try {
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    const db = new SQL.Database(readFileSync(pyramidPath));
    const models = db.exec('SELECT COUNT(*) FROM models')[0]?.values[0]?.[0] || 0;
    const observations = db.exec('SELECT COUNT(*) FROM observations')[0]?.values[0]?.[0] || 0;
    const summaries = db.exec('SELECT COUNT(*) FROM summaries')[0]?.values[0]?.[0] || 0;
    const dirty = db.exec('SELECT COUNT(*) FROM models WHERE content_dirty = 1')[0]?.values[0]?.[0] || 0;
    db.close();
    return c.json({ initialized: true, models, observations, summaries, dirty });
  } catch (e) {
    return c.json({ initialized: false, error: (e as Error).message });
  }
});

// Pyramid memory context (for injecting into prompts)
app.get('/api/pyramid/context', async (c) => {
  const { homedir } = await import('os');
  const { join } = await import('path');
  const { existsSync, readFileSync } = await import('fs');
  const memoryPath = join(homedir(), '.enterprise', 'memory', 'MEMORY.md');
  if (!existsSync(memoryPath)) return c.text('No memory yet.');
  return c.text(readFileSync(memoryPath, 'utf8'));
});

// Init DB then start server
initDb().then(() => {
  const port = 4111;
  console.log(`Enterprise API server running on http://localhost:${port}`);
  serve({ fetch: app.fetch, port });
});
