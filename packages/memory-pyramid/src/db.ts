/**
 * Pyramid Memory Database Layer
 *
 * SQLite schema matching finereli/pyramid's Python implementation.
 * Observations → Models → Tiered Summaries → Synthesis
 */

import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    is_base BOOLEAN DEFAULT 0,
    synthesized_content TEXT,
    content_dirty BOOLEAN DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    model_id INTEGER REFERENCES models(id),
    source_type TEXT,
    source_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id INTEGER NOT NULL REFERENCES models(id),
    tier INTEGER NOT NULL,
    text TEXT NOT NULL,
    start_timestamp TEXT,
    end_timestamp TEXT,
    is_dirty BOOLEAN DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS summary_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    summary_id INTEGER NOT NULL REFERENCES summaries(id),
    source_type TEXT NOT NULL,
    source_id INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS imported_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT UNIQUE NOT NULL,
    message_count INTEGER,
    imported_at TEXT DEFAULT (datetime('now'))
  );

  -- Base models
  INSERT OR IGNORE INTO models (name, description, is_base) VALUES ('assistant', 'AI assistant experience, reflections, and self-understanding', 1);
  INSERT OR IGNORE INTO models (name, description, is_base) VALUES ('user', 'Primary user identity, preferences, projects, and life events', 1);
`;

export interface Observation {
  id: number;
  text: string;
  timestamp: string;
  model_id: number | null;
  source_type: string | null;
  source_id: string | null;
}

export interface Model {
  id: number;
  name: string;
  description: string | null;
  is_base: boolean;
  synthesized_content: string | null;
  content_dirty: boolean;
}

export interface Summary {
  id: number;
  model_id: number;
  tier: number;
  text: string;
  start_timestamp: string | null;
  end_timestamp: string | null;
  is_dirty: boolean;
}

export class PyramidDb {
  private db!: SqlJsDatabase;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async init(): Promise<void> {
    const SQL = await initSqlJs();
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    if (existsSync(this.dbPath)) {
      const buffer = readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }

    this.db.run(SCHEMA);
    this.save();
  }

  save(): void {
    writeFileSync(this.dbPath, Buffer.from(this.db.export()));
  }

  private queryAll<T = any>(sql: string, params: any[] = []): T[] {
    const stmt = this.db.prepare(sql);
    if (params.length) stmt.bind(params);
    const results: T[] = [];
    while (stmt.step()) results.push(stmt.getAsObject() as T);
    stmt.free();
    return results;
  }

  private queryOne<T = any>(sql: string, params: any[] = []): T | null {
    const rows = this.queryAll<T>(sql, params);
    return rows[0] || null;
  }

  private run(sql: string, params: any[] = []): void {
    this.db.run(sql, params);
  }

  // ─── Models ───

  getModels(): Model[] {
    return this.queryAll<Model>('SELECT * FROM models ORDER BY is_base DESC, name');
  }

  getModel(name: string): Model | null {
    return this.queryOne<Model>('SELECT * FROM models WHERE name = ?', [name]);
  }

  getModelById(id: number): Model | null {
    return this.queryOne<Model>('SELECT * FROM models WHERE id = ?', [id]);
  }

  createModel(name: string, description?: string, isBase = false): number {
    this.run(
      'INSERT OR IGNORE INTO models (name, description, is_base, content_dirty) VALUES (?, ?, ?, 1)',
      [name, description || null, isBase ? 1 : 0]
    );
    this.save();
    return this.queryOne<{ id: number }>('SELECT id FROM models WHERE name = ?', [name])!.id;
  }

  markModelDirty(modelId: number): void {
    this.run('UPDATE models SET content_dirty = 1 WHERE id = ?', [modelId]);
    this.save();
  }

  updateSynthesis(modelId: number, content: string): void {
    this.run(
      "UPDATE models SET synthesized_content = ?, content_dirty = 0, updated_at = datetime('now') WHERE id = ?",
      [content, modelId]
    );
    this.save();
  }

  getDirtyModels(): Model[] {
    return this.queryAll<Model>('SELECT * FROM models WHERE content_dirty = 1');
  }

  // ─── Observations ───

  addObservation(text: string, timestamp: string, sourceType?: string, sourceId?: string): number {
    this.run(
      'INSERT INTO observations (text, timestamp, source_type, source_id) VALUES (?, ?, ?, ?)',
      [text, timestamp, sourceType || null, sourceId || null]
    );
    this.save();
    return this.queryOne<{ id: number }>('SELECT last_insert_rowid() as id')!.id;
  }

  addObservations(observations: Array<{ text: string; timestamp: string; sourceType?: string; sourceId?: string }>): void {
    for (const obs of observations) {
      this.run(
        'INSERT INTO observations (text, timestamp, source_type, source_id) VALUES (?, ?, ?, ?)',
        [obs.text, obs.timestamp, obs.sourceType || null, obs.sourceId || null]
      );
    }
    this.save();
  }

  getUnassignedObservations(): Observation[] {
    return this.queryAll<Observation>(
      'SELECT * FROM observations WHERE model_id IS NULL ORDER BY timestamp'
    );
  }

  assignObservation(observationId: number, modelId: number): void {
    this.run('UPDATE observations SET model_id = ? WHERE id = ?', [modelId, observationId]);
    this.markModelDirty(modelId);
  }

  getObservationsByModel(modelId: number): Observation[] {
    return this.queryAll<Observation>(
      'SELECT * FROM observations WHERE model_id = ? ORDER BY timestamp',
      [modelId]
    );
  }

  getObservationCount(): number {
    return this.queryOne<{ count: number }>('SELECT COUNT(*) as count FROM observations')?.count || 0;
  }

  // ─── Summaries ───

  addSummary(modelId: number, tier: number, text: string, startTs: string, endTs: string): number {
    this.run(
      'INSERT INTO summaries (model_id, tier, text, start_timestamp, end_timestamp) VALUES (?, ?, ?, ?, ?)',
      [modelId, tier, text, startTs, endTs]
    );
    this.save();
    return this.queryOne<{ id: number }>('SELECT last_insert_rowid() as id')!.id;
  }

  getSummariesByModel(modelId: number, tier?: number): Summary[] {
    if (tier !== undefined) {
      return this.queryAll<Summary>(
        'SELECT * FROM summaries WHERE model_id = ? AND tier = ? ORDER BY end_timestamp DESC',
        [modelId, tier]
      );
    }
    return this.queryAll<Summary>(
      'SELECT * FROM summaries WHERE model_id = ? ORDER BY tier DESC, end_timestamp DESC',
      [modelId]
    );
  }

  getDirtySummaries(modelId: number): Summary[] {
    return this.queryAll<Summary>(
      'SELECT * FROM summaries WHERE model_id = ? AND is_dirty = 1',
      [modelId]
    );
  }

  markSummaryDirty(summaryId: number): void {
    this.run('UPDATE summaries SET is_dirty = 1 WHERE id = ?', [summaryId]);
  }

  updateSummary(summaryId: number, text: string): void {
    this.run("UPDATE summaries SET text = ?, is_dirty = 0, created_at = datetime('now') WHERE id = ?", [text, summaryId]);
    this.save();
  }

  addSummarySource(summaryId: number, sourceType: 'observation' | 'summary', sourceId: number): void {
    this.run(
      'INSERT INTO summary_sources (summary_id, source_type, source_id) VALUES (?, ?, ?)',
      [summaryId, sourceType, sourceId]
    );
  }

  // ─── Import tracking ───

  isSessionImported(sessionId: string): boolean {
    return !!this.queryOne('SELECT 1 FROM imported_sessions WHERE session_id = ?', [sessionId]);
  }

  markSessionImported(sessionId: string, messageCount: number): void {
    this.run(
      'INSERT OR IGNORE INTO imported_sessions (session_id, message_count) VALUES (?, ?)',
      [sessionId, messageCount]
    );
    this.save();
  }

  // ─── Stats ───

  getStats(): { models: number; observations: number; summaries: number; dirty: number } {
    return {
      models: this.queryOne<{ c: number }>('SELECT COUNT(*) as c FROM models')!.c,
      observations: this.queryOne<{ c: number }>('SELECT COUNT(*) as c FROM observations')!.c,
      summaries: this.queryOne<{ c: number }>('SELECT COUNT(*) as c FROM summaries')!.c,
      dirty: this.queryOne<{ c: number }>('SELECT COUNT(*) as c FROM models WHERE content_dirty = 1')!.c,
    };
  }

  close(): void {
    this.save();
    this.db.close();
  }
}
