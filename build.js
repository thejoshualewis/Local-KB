// build.js — Build RAG SQLite DB(s) from data/<kb>/ → db/<kb>.db (ensures Ollama+models)
const fs = require("fs");
const path = require("path");
const glob = require("glob");
const pdfParse = require("pdf-parse");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { Ollama } = require("ollama");
require("dotenv").config();

const { ensureModels, OLLAMA_HOST } = require("./lib/models");

const DATA_ROOT  = "data";
const DB_DIR     = "db";
const EMB_MODEL  = process.env.EMB_MODEL || "nomic-embed-text";
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE || 1100);
const OVERLAP    = Number(process.env.OVERLAP || 120);

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const ollama = new Ollama({ host: OLLAMA_HOST });

const f32buf    = (arr) => Buffer.from(new Float32Array(arr).buffer);
const normalize = (s) => (s || "").replace(/\s+/g, " ").trim();

function parseBlocks(raw) {
  const lines = (raw || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  const blank = (s) => !s || /^\s*$/.test(s);
  const qline = (s) => /^(q(uestion)?\s*[:\-]?)\s*/i.test(s || "");
  const endsQ = (s) => /\?\s*$/.test((s || "").trim());

  while (i < lines.length) {
    let line = (lines[i] || "").trim();
    if (blank(line)) { i++; continue; }
    if (qline(line)) {
      const q = line.replace(/^(q(uestion)?\s*[:\-]?)\s*/i, "").trim();
      i++;
      const a = [];
      while (i < lines.length) {
        const ln = (lines[i] || "").trim();
        if (blank(ln) || qline(ln)) break;
        a.push(/^a\s*[:\-]?\s*/i.test(ln) ? ln.replace(/^a\s*[:\-]?\s*/i, "").trim() : ln);
        i++;
      }
      blocks.push(normalize(`Q: ${q}\nA: ${a.join(" ")}`));
      continue;
    }
    if (endsQ(line)) {
      const q = line;
      const a = [];
      let j = i + 1;
      while (j < lines.length) {
        const ln = (lines[j] || "").trim();
        if (blank(ln) || qline(ln) || endsQ(ln)) break;
        a.push(ln);
        j++;
      }
      if (a.length) { blocks.push(normalize(`Q: ${q}\nA: ${a.join(" ")}`)); i = j; continue; }
    }
    const paras = [line];
    i++;
    while (i < lines.length) {
      const ln = (lines[i] || "").trim();
      if (blank(ln) || qline(ln)) break;
      paras.push(ln);
      i++;
    }
    blocks.push(normalize(paras.join(" ")));
  }
  return blocks.filter(Boolean);
}

function packBlocks(blocks, size = CHUNK_SIZE, overlap = OVERLAP) {
  const chunks = [];
  let cur = "";
  const push = () => { if (cur.trim()) { chunks.push(cur.trim()); cur = ""; } };
  for (const b of blocks) {
    if (b.length > size) {
      const sents = b.split(/(?<=[.!?])\s+(?=[A-Z0-9‘“"(\[])/).map(s => s.trim()).filter(Boolean);
      let buf = "";
      for (const s of sents) {
        if ((buf ? buf.length + 1 : 0) + s.length <= size) buf += (buf ? " " : "") + s;
        else { if (buf) chunks.push(buf); if (s.length > size) { for (let i=0;i<s.length;i+=size) chunks.push(s.slice(i,i+size)); buf=""; } else buf=s; }
      }
      if (buf) chunks.push(buf);
      continue;
    }
    if ((cur ? cur.length + 2 : 0) + b.length <= size) cur += (cur ? "\n\n" : "") + b;
    else { push(); cur = b; }
  }
  push();
  return chunks;
}

async function readDoc(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".txt" || ext === ".md") return fs.readFileSync(p, "utf8");
  if (ext === ".pdf") {
    const buf = fs.readFileSync(p);
    const pdf = await pdfParse(buf);
    return pdf.text || "";
  }
  return "";
}

async function embedBatch(texts) {
  const out = [];
  for (const t of texts) {
    const r = await ollama.embeddings({ model: EMB_MODEL, prompt: t });
    out.push(r.embedding);
  }
  return out;
}

const hashFile = (file) => crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");

function initDb(dbPath) {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE chunks (
      id        INTEGER PRIMARY KEY,
      doc       TEXT NOT NULL,
      chunk_id  INTEGER NOT NULL,
      text      TEXT NOT NULL,
      emb       BLOB NOT NULL
    );
    CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id');
    CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
    END;
    CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TABLE ingested_files (doc TEXT PRIMARY KEY, file_hash TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX idx_chunks_doc ON chunks(doc);
  `);
  return db;
}

async function buildOne(name) {
  const dataDir = path.join(DATA_ROOT, name);
  const dbPath  = path.join(DB_DIR, `${name}.db`);
  const files   = glob.sync(`${dataDir}/**/*.{txt,md,pdf}`, { nocase: true });
  if (!files.length) { console.warn(`(skip) No docs in ${dataDir}`); return; }

  const meta = [];
  const texts = [];
  for (const file of files) {
    const raw = await readDoc(file);
    if (!raw || !raw.trim()) continue;
    const parts = packBlocks(parseBlocks(raw), CHUNK_SIZE, OVERLAP);
    const base = path.basename(file);
    parts.forEach((text, idx) => meta.push({ doc: base, chunk_id: idx, text, file_hash: hashFile(file) }));
    texts.push(...parts);
    console.log(`• ${base}: ${parts.length} chunk(s)`);
  }
  if (!texts.length) { console.warn(`(skip) Nothing to embed for ${name}`); return; }

  console.log(`Embedding ${texts.length} chunk(s)…`);
  const vectors = await embedBatch(texts);

  const db = initDb(dbPath);
  const insChunk = db.prepare(`INSERT INTO chunks (id, doc, chunk_id, text, emb) VALUES (?, ?, ?, ?, ?)`);
  const insFile  = db.prepare(`INSERT INTO ingested_files(doc,file_hash,updated_at) VALUES (?,?,datetime('now'))`);

  const tx = db.transaction(() => {
    for (let i = 0; i < meta.length; i++) insChunk.run(i + 1, meta[i].doc, meta[i].chunk_id, meta[i].text, f32buf(vectors[i]));
    const last = new Map();
    for (const m of meta) last.set(m.doc, m.file_hash);
    for (const [doc, hash] of last.entries()) insFile.run(doc, hash);
  });
  tx();
  console.log(`✅ Built ${dbPath} with ${meta.length} chunks.`);
}

(async function main() {
  // ⬅️ make sure ollama is up and embedding model is present
  await ensureModels("rag");

  if (!fs.existsSync(DATA_ROOT)) { console.error("No ./data folder"); process.exit(1); }
  const arg = process.argv[2];
  if (arg) {
    const dir = path.join(DATA_ROOT, arg);
    if (!fs.existsSync(dir)) { console.error(`Folder not found: ${dir}`); process.exit(1); }
    await buildOne(arg);
  } else {
    const subs = fs.readdirSync(DATA_ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    if (!subs.length) { console.error("No subfolders in ./data"); process.exit(1); }
    for (const name of subs) await buildOne(name);
  }
})().catch(e => { console.error(e?.stack || e?.message || e); process.exit(1); });