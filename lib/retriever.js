// lib/retriever.js
// Retrieval layer for both CLI and HTTP API.
// - Reads from db/*.db (each built via build.js)
// - Fast prune with SQLite FTS5 MATCH
// - Cosine re-rank with BLOB embeddings (Float32) stored in SQLite
// - Optional direct Q/A extraction (for "Q:\nA:" chunks) before asking the LLM

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { Ollama } = require("ollama");

// ---------------------- Config ----------------------
const DB_DIR      = process.env.DB_DIR || "db";
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const GEN_MODEL   = process.env.GEN_MODEL   || "qwen2.5:1.5b";
const EMB_MODEL   = process.env.EMB_MODEL   || "nomic-embed-text";

const TOP_K    = Number(process.env.TOP_K || 3);     // final re-ranked hits per DB
const FTS_CAND = Number(process.env.FTS_CAND || 30); // FTS shortlist size per DB
const MIN_SIM  = Number(process.env.MIN_SIM || 0.35);
const FAST     = process.env.FAST === "1";

const ollama = new Ollama({ host: OLLAMA_HOST });

// ---------------------- Small helpers ----------------------

/**
 * Normalize a natural-language question so small punctuation quirks
 * don’t fragment tokens. This is NOT the FTS sanitizer.
 */
function normalizeQuery(q) {
  return (q || "")
    .replace(/\r\n/g, "\n")
    .trim()
    .replace(/[?!。，、。！？…\s]+$/u, "") // strip trailing punctuation
    .replace(/\s+/g, " ");               // collapse whitespace
}

/**
 * Convert free text to a SAFE FTS5 string for MATCH.
 * Why needed: MATCH treats quotes, parens, +-*~^: etc. as syntax.
 * We strip those, keep only a–z/0–9/space, drop 1-char noise, and cap length.
 * Returns null if nothing useful remains.
 */
function toFtsQuery(text) {
  const terms = String(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/['"()[\]{}\\/|:,^~*+\-]/g, " ") // kill FTS operators/quotes
    .replace(/[^a-z0-9 ]+/g, " ")              // keep alphanumerics + space
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 1)                 // drop 1-char noise
    .slice(0, 12);                              // keep it short & fast
  if (!terms.length) return null;
  // Spaces already imply AND in FTS. (You could do: terms.map(t=>`"${t}"`).join(" AND "))
  return terms.join(" ");
}

/** Cosine similarity for Float32 vectors. */
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    dot += x*y; na += x*x; nb += y*y;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}

/** Convert SQLite BLOB → Float32Array (no copy). */
function bufToF32(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** Embed a question using your Ollama embedding model. */
async function embed(text) {
  const { embedding } = await ollama.embeddings({ model: EMB_MODEL, prompt: text });
  return Float32Array.from(embedding);
}

// ---------------------- DB helpers ----------------------

/** List DB names (without .db) from db/ */
function discoverDbNames() {
  if (!fs.existsSync(DB_DIR)) return [];
  return fs.readdirSync(DB_DIR)
    .filter(f => f.endsWith(".db"))
    .map(f => path.basename(f, ".db"));
}

/** Open a DB by short name (without .db). Returns better-sqlite3 handle or null. */
function openDbByName(name) {
  const p = path.join(DB_DIR, `${name}.db`);
  if (!fs.existsSync(p)) return null;
  return new Database(p);
}

// ---------------------- Retrieval core ----------------------

/**
 * FTS prune with SAFE query. If the FTS engine still raises (it can),
 * we swallow and return [] so callers can fall back to a dumb scan.
 */
function ftsSearchSafe(db, naturalQuery, limit = FTS_CAND) {
  const safe = toFtsQuery(naturalQuery);
  if (!safe) return [];
  const stmt = db.prepare(`
    SELECT c.id, c.doc, c.chunk_id, c.text, bm25(chunks_fts) AS rank
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.rowid
    WHERE chunks_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `);
  try {
    return stmt.all(safe, limit);
  } catch {
    return [];
  }
}

/** Basic fallback when FTS yields nothing. */
function scanSome(db, limit = FTS_CAND) {
  const stmt = db.prepare(`SELECT id, doc, chunk_id, text FROM chunks LIMIT ?`);
  return stmt.all(limit);
}

/**
 * Retrieve candidates from *all DBs*: FTS → cosine re-rank.
 * Returns an array of top hits across DBs, each with:
 * { source, doc, chunk_id, text, score }
 */
async function retrieveAndRerank(question, qEmb) {
  const results = [];
  const dbs = discoverDbNames();

  for (const name of dbs) {
    const db = openDbByName(name);
    if (!db) continue;

    let cands = ftsSearchSafe(db, question, FTS_CAND);
    if (!cands.length) cands = scanSome(db, FTS_CAND);

    const getEmb = db.prepare(`SELECT emb FROM chunks WHERE id = ?`);
    const scored = cands.map(row => {
      const buf = getEmb.get(row.id).emb;
      const emb = bufToF32(buf);
      return { ...row, source: name, score: cosine(qEmb, emb) };
    });

    scored.sort((a,b)=>b.score-a.score);
    results.push(...scored.slice(0, TOP_K));
    db.close();
  }

  results.sort((a,b)=>b.score-a.score);
  return results.slice(0, TOP_K);
}

/**
 * If a chunk is in “Q: ...\nA: ...” format, try to answer deterministically
 * without the LLM. We compare token overlap between the user question and
 * each chunk’s Q:. If overlap ≥ 0.35 we trust the A:.
 */
function tryDirectQA(question, hits) {
  const qNorm = normalizeQuery(question).toLowerCase();
  const tokenize = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
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
  return best && best.score >= 0.35 ? best : null;
}

/** Tiny prompt builder for the LLM fallback. */
function buildPrompt(q, ctxs) {
  const ctx = ctxs.map((t,i)=>`[Context ${i+1}]\n${t}`).join("\n\n");
  return `Use ONLY the provided CONTEXT. If the answer isn't present, say "I don't know based on the provided documents."

CONTEXT:
${ctx}

QUESTION: ${q}

Answer in 1–2 short sentences:`;
}

// ---------------------- Public API ----------------------

/**
 * Single-shot answer used by both CLI and HTTP API.
 * Returns { text, hits } where hits are top-k contexts with scores.
 */
async function answerOnce(userQuestion) {
  const q = normalizeQuery(userQuestion);
  const qEmb = await embed(q);
  const hits = await retrieveAndRerank(q, qEmb);

  if (!hits.length || hits[0].score < MIN_SIM) {
    return { text: "Not enough info in the knowledge base to answer confidently.", hits: [] };
  }

  // Try deterministic Q/A first (fast & exact when your docs are Q:\nA: style)
  const qa = tryDirectQA(q, hits);
  if (qa) return { text: qa.answer, hits };

  // Fall back to a tiny generation using the selected contexts
  const prompt = buildPrompt(q, hits.map(h => h.text));
  const { response } = await ollama.generate({
    model: GEN_MODEL,
    prompt,
    options: {
      temperature: 0.0,
      num_predict: FAST ? 48 : 64,
      keep_alive: "5m",
    },
  });
  return { text: String(response || "").trim(), hits };
}

module.exports = {
  answerOnce,
  discoverDbNames,
};