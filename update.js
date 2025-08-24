// update.js — Update DB(s) with new/changed files (BLOB embeddings + FTS5)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const glob = require('glob');
const crypto = require('crypto');
const { openDb } = require('./lib/db');
const { parseBlocks, packBlocks, readDoc } = require('./lib/chunking');
const { embedBatch } = require('./lib/llm');
const { ensureModels } = require('./lib/models');

const DATA_ROOT  = 'data';
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE || 1100);
const OVERLAP    = Number(process.env.OVERLAP || 120);
const EMB_MODEL  = process.env.EMB_MODEL || 'nomic-embed-text';
const REPLACE_ON_CHANGE = process.env.REPLACE_ON_CHANGE === '1';

const IGNORE_FILES = [/^license/i];
const shouldIgnore = base => IGNORE_FILES.some(rx => rx.test(base));
const f32buf = (arr) => { const f = new Float32Array(arr); return Buffer.from(f.buffer, f.byteOffset, f.byteLength); };
const sha1 = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');

async function updateOne(name){
  const dataDir = path.join(DATA_ROOT, name);
  const files = glob.sync(`${dataDir}/**/*.{txt,md,pdf}`, { nocase: true });
  if (!files.length) { console.warn(`(skip) No docs in ${dataDir}`); return; }

  const db = openDb(name);

  const getLastId   = db.prepare('SELECT COALESCE(MAX(id),0) AS maxid FROM chunks');
  const getFileHash = db.prepare('SELECT file_hash FROM ingested_files WHERE doc=?');
  const upsertFile  = db.prepare(`INSERT INTO ingested_files(doc,file_hash,updated_at)
                                  VALUES (?,?,datetime('now'))
                                  ON CONFLICT(doc) DO UPDATE SET file_hash=excluded.file_hash, updated_at=datetime('now')`);
  const delByDoc    = db.prepare('DELETE FROM chunks WHERE doc=?');
  const insChunk    = db.prepare('INSERT INTO chunks (id, doc, chunk_id, text, emb) VALUES (?, ?, ?, ?, ?)');

  let nextId = getLastId.get().maxid;
  let appended = 0;

  for (const file of files) {
    const base = path.basename(file);
    if (shouldIgnore(base)) continue;

    const fh = sha1(file);
    const prev = getFileHash.get(base);

    if (prev && prev.file_hash === fh) continue;

    const raw = await readDoc(file);
    if (!raw || !raw.trim()) { upsertFile.run(base, fh); continue; }
    const parts = packBlocks(parseBlocks(raw), CHUNK_SIZE, OVERLAP);
    const vecs  = await embedBatch(EMB_MODEL, parts);

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

    console.log(`• ${base}: ${(REPLACE_ON_CHANGE && prev) ? '(replaced) ' : '(added) '}+${parts.length} chunk(s)`);
  }

  console.log(`✅ Update db/${name}.db complete. Appended ${appended} chunk(s).`);
}

(async function main(){
  ensureModels([process.env.EMB_MODEL || 'nomic-embed-text', process.env.GEN_MODEL || 'qwen2.5:1.5b']);
  if (!fs.existsSync(DATA_ROOT)) { console.error('No ./data folder'); process.exit(1); }
  const arg = process.argv[2];
  if (arg) {
    const dir = path.join(DATA_ROOT, arg);
    if (!fs.existsSync(dir)) { console.error(`Folder not found: ${dir}`); process.exit(1); }
    await updateOne(arg);
  } else {
    const subs = fs.readdirSync(DATA_ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    if (!subs.length) { console.error('No subfolders in ./data'); process.exit(1); }
    for (const name of subs) await updateOne(name);
  }
})().catch(e => { console.error(e?.stack || e?.message || e); process.exit(1); });
