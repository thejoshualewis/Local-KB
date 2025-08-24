// lib/db.js
// SQLite helpers: create/reuse DB in ./db, schema with BLOB embeddings + FTS5.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_DIR = path.resolve('db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

function dbPathFor(name){
  return path.join(DB_DIR, `${name}.db`);
}

function openDb(name){
  const p = dbPathFor(name);
  const db = new Database(p);
  db.pragma('journal_mode = WAL');
  return db;
}

function resetDb(name){
  const p = dbPathFor(name);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  const db = openDb(name);
  createSchema(db);
  return db;
}

function createSchema(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id        INTEGER PRIMARY KEY,
      doc       TEXT NOT NULL,
      chunk_id  INTEGER NOT NULL,
      text      TEXT NOT NULL,
      emb       BLOB NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text, content='chunks', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
    END;

    CREATE TABLE IF NOT EXISTS ingested_files (
      doc        TEXT PRIMARY KEY,
      file_hash  TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc);
  `);
}

module.exports = { DB_DIR, dbPathFor, openDb, resetDb, createSchema };
