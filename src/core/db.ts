import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

let db: DatabaseSync | undefined
let currentPath = ''

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS person (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(platform, external_id)
);

CREATE TABLE IF NOT EXISTS chat_session (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  title TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  extracted_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS message (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES chat_session(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  injected_memory_ids TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  kind TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  text TEXT NOT NULL,
  occurred_at TEXT,
  valid_from TEXT,
  valid_to TEXT,
  valence REAL NOT NULL DEFAULT 0,
  arousal REAL NOT NULL DEFAULT 0,
  salience REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.8,
  status TEXT NOT NULL DEFAULT 'active',
  supersedes TEXT,
  superseded_by TEXT,
  source_session_id TEXT,
  source_message_ids TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_access TEXT,
  created_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  text,
  content='memory',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE OF text ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE IF NOT EXISTS open_loop (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'plan',
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  source_memory_id TEXT,
  source_message_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS relationship (
  person_id TEXT NOT NULL REFERENCES person(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(person_id, key)
);

CREATE TABLE IF NOT EXISTS recall_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  query TEXT,
  score REAL,
  injected INTEGER NOT NULL DEFAULT 1,
  used INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_person_status ON memory(person_id, status);
CREATE INDEX IF NOT EXISTS idx_memory_kind ON memory(kind);
CREATE INDEX IF NOT EXISTS idx_memory_pinned ON memory(pinned);
CREATE INDEX IF NOT EXISTS idx_message_session ON message(session_id, id);
CREATE INDEX IF NOT EXISTS idx_open_loop_person_status ON open_loop(person_id, status);
`

function seed(database: DatabaseSync): void {
  const now = new Date().toISOString()
  database
    .prepare(
      `INSERT OR IGNORE INTO person(id, platform, external_id, name, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run('p-0001', 'web', 'local', '我', now)
}

export function initDb(path = process.env.DB_PATH ?? './data/companion.db'): DatabaseSync {
  if (db !== undefined) return db
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true })
  db = new DatabaseSync(path)
  db.exec(SCHEMA)
  seed(db)
  currentPath = path
  return db
}

export function getDb(): DatabaseSync {
  return db ?? initDb()
}

export function getDbPath(): string {
  getDb()
  return currentPath
}

export function resetDbForTests(path = ':memory:'): DatabaseSync {
  if (db !== undefined) {
    db.close()
    db = undefined
  }
  return initDb(path)
}

export function transaction<T>(fn: () => T): T {
  const database = getDb()
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    database.exec('COMMIT')
    return result
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}
