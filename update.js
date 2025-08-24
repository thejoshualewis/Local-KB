// update.js — Update RAG SQLite DB(s) from data/<kb>/; ensures Ollama+embed model
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
const REPLACE_ON_CHANGE = process.env.REPLACE_ON_CHANGE === "1";

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const ollama = new Ollama({ host: OLLAMA_HOST });

const f32buf    = (arr) => Buffer.from(new Float32Array(arr).buffer);
const normalize = (s) => (s || "").replace(/\s+/g, " ").trim();
const hashFile  = (file) => crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");

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

async function updateOne(name) {
  const dataDir = path.join(DATA_ROOT, name);
  const dbPath  = path.join(DB_DIR, `${name}.db`);
  if (!fs.existsSync(dbPath)) { console.error(`No ${dbPath}. Run 'npm run rag:build -- ${name}' first.`); return; }

  const files = glob.sync(`${dataDir}/**/*.{txt,md,pdf}`, { nocase: true });
  if (!files.length) { console.warn(`(skip) No docs in ${dataDir}`); return; }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  const getLastId   = db.prepare("SELECT COALESCE(MAX(id),0) AS maxid FROM chunks");
  const getFileHash = db.prepare("SELECT file_hash FROM ingested_files WHERE doc=?");
  const upsertFile  = db.prepare(`INSERT INTO ingested_files(doc,file_hash,updated_at)
    VALUES (?,?,datetime('now'))
    ON CONFLICT(doc) DO UPDATE SET file_hash=excluded.file_hash, updated_at=datetime('now')`);
  const delByDoc    = db.prepare("DELETE FROM chunks WHERE doc=?");
  const insChunk    = db.prepare(`INSERT INTO chunks (id, doc, chunk_id, text, emb) VALUES (?, ?, ?, ?, ?)`);

  let nextId   = getLastId.get().maxid;
  let appended = 0;

  for (const file of files) {
    const base = path.basename(file);
    const fh   = hashFile(file);
    const prev = getFileHash.get(base);
    if (prev && prev.file_hash === fh) continue;

    const raw = await readDoc(file);
    if (!raw || !raw.trim()) { upsertFile.run(base, fh); continue; }
    const parts = packBlocks(parseBlocks(raw));
    const vecs  = await embedBatch(parts);

    const tx = db.transaction(() => {
      if (REPLACE_ON_CHANGE && prev) delByDoc.run(base);
      for (let i = 0; i < parts.length; i++) {
        nextId += 1;
        insChunk.run(nextId, base, i, parts[i], f32buf(vecs[i]));
        appended++;
      }
      upsertFile.run(base, fh);
    });
    tx();

    console.log(`• ${base}: ${(REPLACE_ON_CHANGE && prev) ? "(replaced) " : "(added) "}+${parts.length} chunk(s)`);
  }
  console.log(`✅ Update ${dbPath} complete. Appended ${appended} chunk(s).`);
}

(async function main() {
  // ⬅️ make sure ollama is up and embedding model is present
  await ensureModels("rag");

  if (!fs.existsSync(DATA_ROOT)) { console.error("No ./data folder"); process.exit(1); }
  const arg = process.argv[2];
  if (arg) {
    const dir = path.join(DATA_ROOT, arg);
    if (!fs.existsSync(dir)) { console.error(`Folder not found: ${dir}`); process.exit(1); }
    await updateOne(arg);
  } else {
    const subs = fs.readdirSync(DATA_ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    if (!subs.length) { console.error("No subfolders in ./data"); process.exit(1); }
    for (const name of subs) await updateOne(name);
  }
})().catch(e => { console.error(e?.stack || e?.message || e); process.exit(1); });