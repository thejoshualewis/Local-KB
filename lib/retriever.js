// lib/retriever.js
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { Ollama } = require("ollama");
const { EMB_MODEL, OLLAMA_HOST } = require("./models");

// Config
const DATA_ROOT = "data";
const DB_DIR = "db";
const TOP_K = Number(process.env.TOP_K || 6);
const FTS_CAND = Number(process.env.FTS_CAND || 40);
const MIN_SIM = Number(process.env.MIN_SIM || 0.35);
const FAST = process.env.FAST === "1";

// cosine similarity between two Float32 arrays
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) { const x = a[i], y = b[i]; dot += x*y; na += x*x; nb += y*y; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}
// Convert SQLite BLOB to Float32Array view
function bufToF32(buf) { return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4); }

// Normalize questions (strip trailing punctuation, collapse whitespace)
function normalizeQuery(q) {
  return (q || "").replace(/\r\n/g, "\n").trim().replace(/[?!。，、。！？…\s]+$/u, "").replace(/\s+/g, " ");
}

function discoverDbNames() {
  if (!fs.existsSync(DATA_ROOT)) return [];
  const subs = fs.readdirSync(DATA_ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  // only keep those that have an existing DB file
  return subs.filter(name => fs.existsSync(path.join(DB_DIR, `${name}.db`)));
}

function openDbs(names) {
  return names.map(n => ({
    name: n,
    db: new Database(path.join(DB_DIR, `${n}.db`), {})
  }));
}

function ftsSearch(db, query, limit = FTS_CAND) {
  // quick FTS prune by bm25; returns candidate rows
  const stmt = db.prepare(`
    SELECT c.id, c.doc, c.chunk_id, c.text, bm25(chunks_fts) AS rank
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.rowid
    WHERE chunks_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `);
  return stmt.all(query, limit);
}
function allIds(db, limit = FTS_CAND) {
  // fallback if FTS returns 0
  const stmt = db.prepare(`SELECT id, doc, chunk_id, text FROM chunks LIMIT ?`);
  return stmt.all(limit);
}

async function embed(client, text) {
  const { embedding } = await client.embeddings({ model: EMB_MODEL, prompt: text });
  return Float32Array.from(embedding);
}

// Try deterministic Q/A extraction: if a chunk has
//  Q: <question>   A: <answer>
// we use token overlap to short-circuit generation.
function tryDirectQA(question, hits) {
  const qNorm = normalizeQuery(question).toLowerCase();
  const tokenize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const qTokens = new Set(tokenize(qNorm));

  let best = null;
  for (const h of hits) {
    const m = h.text.match(/Q:\s*([\s\S]*?)\nA:\s*([\s\S]*?)$/i);
    if (!m) continue;
    const qText = normalizeQuery(m[1]);
    const aText = m[2].trim();
    const t = tokenize(qText);
    const overlap = t.filter(w => qTokens.has(w)).length;
    const score = overlap / Math.max(1, t.length);
    if (!best || score > best.score) best = { score, answer: aText };
  }
  if (best && best.score >= Number(process.env.MIN_SIM || 0.35)) return best;
  return null;
}

// Public: answerOnce (RAG)
async function answerOnce(question) {
  const qNorm = normalizeQuery(question);
  const names = discoverDbNames();
  if (!names.length) return { text: "No RAG databases found. Build first.", hits: [] };

  const client = new Ollama({ host: OLLAMA_HOST });
  const qEmb = await embed(client, qNorm);

  const dbs = openDbs(names);
  const results = [];
  for (const { name, db } of dbs) {
    let cands = ftsSearch(db, qNorm, FTS_CAND);
    if (!cands.length) cands = allIds(db, FTS_CAND);

    const getEmb = db.prepare(`SELECT emb FROM chunks WHERE id=?`);
    const scored = cands.map(row => {
      const emb = bufToF32(getEmb.get(row.id).emb);
      return { ...row, source: name, score: cosine(qEmb, emb) };
    });
    scored.sort((a,b)=>b.score-a.score);
    results.push(...scored.slice(0, TOP_K));
  }
  results.sort((a,b)=>b.score-a.score);
  const hits = results.slice(0, TOP_K);
  if (!hits.length || hits[0].score < MIN_SIM) {
return { text: "Not enough info in the knowledge base to answer confidently.", hits: [], mode: "rag" };
  }

  const qa = tryDirectQA(qNorm, hits);
if (qa) return { text: qa.answer, hits, mode: "rag" };

  const ctx = hits.map((t,i)=>`[Context ${i+1}]\n${t.text}`).join("\n\n");
  const prompt = `Use ONLY the provided CONTEXT. If the answer isn't present, say "I don't know based on the provided documents."

CONTEXT:
${ctx}

QUESTION: ${qNorm}

Answer in 1–2 short sentences:`;

  const GEN_MODEL = process.env.GEN_MODEL || "qwen2.5:1.5b";
  const { response } = await client.generate({
    model: GEN_MODEL,
    prompt,
    options: { temperature: 0.0, num_predict: FAST ? 48 : 64, keep_alive: "5m" }
  });

return { text: String(response || "").trim(), hits, mode: "rag" };
}

module.exports = { answerOnce, discoverDbNames };