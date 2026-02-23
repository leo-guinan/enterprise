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

// Init DB then start server
initDb().then(() => {
  const port = 4111;
  console.log(`Enterprise API server running on http://localhost:${port}`);
  serve({ fetch: app.fetch, port });
});
