import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const dataDir = join(homedir(), '.enterprise');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

const dbPath = join(dataDir, 'messages.db');

let db: SqlJsDatabase;

export async function initDb() {
  const SQL = await initSqlJs();

  if (existsSync(dbPath)) {
    const buffer = readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      title TEXT,
      soul TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status)');

  save();
  return db;
}

export function save() {
  const data = db.export();
  writeFileSync(dbPath, Buffer.from(data));
}

function queryAll(sql: string, params: any[] = []): any[] {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const results: any[] = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function queryOne(sql: string, params: any[] = []): any | null {
  const rows = queryAll(sql, params);
  return rows[0] || null;
}

function run(sql: string, params: any[] = []) {
  db.run(sql, params);
  save();
}

// Thread operations
export const listThreads = () => queryAll('SELECT * FROM threads ORDER BY updated_at DESC');
export const getThread = (id: string) => queryOne('SELECT * FROM threads WHERE id = ?', [id]);
export const createThread = (id: string, title: string, soul: string | null, now: number) => {
  run('INSERT INTO threads (id, title, soul, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [id, title, soul, now, now]);
};
export const updateThread = (title: string, now: number, id: string) => {
  run('UPDATE threads SET title = ?, updated_at = ? WHERE id = ?', [title, now, id]);
};
export const deleteThread = (id: string) => {
  run('DELETE FROM messages WHERE thread_id = ?', [id]);
  run('DELETE FROM threads WHERE id = ?', [id]);
};

// Message operations
export const listMessages = (threadId: string) =>
  queryAll('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC', [threadId]);
export const createMessage = (id: string, threadId: string, role: string, content: string, status: string, metadata: string | null, now: number) => {
  run('INSERT INTO messages (id, thread_id, role, content, status, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, threadId, role, content, status, metadata, now, now]);
};
export const getPendingMessages = () =>
  queryOne("SELECT * FROM messages WHERE status = 'pending' AND role = 'user' ORDER BY created_at ASC LIMIT 1");
export const updateMessageStatus = (status: string, now: number, id: string) => {
  run('UPDATE messages SET status = ?, updated_at = ? WHERE id = ?', [status, now, id]);
};
export const getPendingCount = () =>
  queryOne("SELECT COUNT(*) as count FROM messages WHERE status = 'pending'")?.count || 0;
export const getLastHeartbeat = () =>
  queryOne("SELECT MAX(updated_at) as last_heartbeat FROM messages WHERE role = 'assistant'")?.last_heartbeat || null;

export function getDb() { return db; }
