// build.js — Build DB(s) from data/<name>/ (txt/md/pdf) with BLOB embeddings + FTS5
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const glob = require('glob');
const crypto = require('crypto');
const { resetDb } = require('./lib/db');
const { parseBlocks, packBlocks, readDoc } = require('./lib/chunking');
const { embedBatch } = require('./lib/llm');
const { ensureModels } = require('./lib/models');

const DATA_ROOT  = 'data';
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE || 1100);
const OVERLAP    = Number(process.env.OVERLAP || 120);
const EMB_MODEL  = process.env.EMB_MODEL || 'nomic-embed-text';

const IGNORE_FILES = [/^license/i];
const shouldIgnore = base => IGNORE_FILES.some(rx => rx.test(base));
const f32buf = (arr) => { const f = new Float32Array(arr); return Buffer.from(f.buffer, f.byteOffset, f.byteLength); };
const sha1 = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');

async function buildOne(name){
  const dataDir = path.join(DATA_ROOT, name);
  const files = glob.sync(`${dataDir}/**/*.{txt,md,pdf}`, { nocase: true });
  if (!files.length) { console.warn(`(skip) No docs in ${dataDir}`); return; }

  const db = resetDb(name);

  const meta = [];
  const texts = [];

  for (const file of files){
    const base = path.basename(file);
    if (shouldIgnore(base)) continue;
    const raw = await readDoc(file);
    if (!raw || !raw.trim()) continue;
    const parts = packBlocks(parseBlocks(raw), CHUNK_SIZE, OVERLAP);
    parts.forEach((text, idx) => {
      meta.push({ doc: base, chunk_id: idx, text, file_hash: sha1(file) });
      texts.push(text);
    });
    console.log(`• ${base}: ${parts.length} chunk(s)`);
  }

  if (!texts.length) { console.warn(`(skip) Nothing to embed for ${name}`); return; }

  console.log(`Embedding ${texts.length} chunk(s)…`);
  const vectors = await embedBatch(EMB_MODEL, texts);

  const insChunk = db.prepare(`INSERT INTO chunks (id, doc, chunk_id, text, emb) VALUES (?, ?, ?, ?, ?)`);
  const insFile  = db.prepare(`INSERT INTO ingested_files(doc,file_hash,updated_at) VALUES (?,?,datetime('now'))`);

  const tx = db.transaction(() => {
    for (let i = 0; i < meta.length; i++) {
      insChunk.run(i+1, meta[i].doc, meta[i].chunk_id, meta[i].text, f32buf(vectors[i]));
    }
    const last = new Map();
    for (const m of meta) last.set(m.doc, m.file_hash);
    for (const [doc, hash] of last.entries()) insFile.run(doc, hash);
  });
  tx();

  console.log(`✅ Built db/${name}.db with ${meta.length} chunks.`);
}

(async function main(){
  ensureModels([process.env.EMB_MODEL || 'nomic-embed-text', process.env.GEN_MODEL || 'qwen2.5:1.5b']);
  if (!fs.existsSync(DATA_ROOT)) { console.error('No ./data folder'); process.exit(1); }
  const arg = process.argv[2];
  if (arg) {
    const dir = path.join(DATA_ROOT, arg);
    if (!fs.existsSync(dir)) { console.error(`Folder not found: ${dir}`); process.exit(1); }
    await buildOne(arg);
  } else {
    const subs = fs.readdirSync(DATA_ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    if (!subs.length) { console.error('No subfolders in ./data'); process.exit(1); }
    for (const name of subs) await buildOne(name);
  }
})().catch(e => { console.error(e?.stack || e?.message || e); process.exit(1); });
