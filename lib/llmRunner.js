// lib/llmRunner.js — LLM few-shot runner with SEMANTIC example selection
// - Loads *.jsonl examples from llm/<kb>/
// - Builds/loads an embedding index per-KB in .cache/llm_index/<kb>.json
// - Selects top-K few-shots for a query via cosine similarity
// - Generates with GEN_MODEL_LLM
//
// Exports:
//   - init(): Promise<Map<kbName, { model, examples[], embs[] }>>  // builds/loads indices
//   - answerOnceLLM(q, store): Promise<{ text, hits:[], confidence, mode:'llm' }>
//   - discoverKbNamesLLM(): string[]
//   - CONF_THRESH: number  // env LLM_CONF_THRESH || 0.35

const fs = require("fs");
const path = require("path");
const glob = require("glob");
const { Ollama } = require("ollama");
const { OLLAMA_HOST, GEN_MODEL_LLM, EMB_MODEL } = require("./models");

// confidence threshold for hybrid fallback (0..1)
const CONF_THRESH = Number(process.env.LLM_CONF_THRESH || 0.35);
module.exports.CONF_THRESH = CONF_THRESH;

// ---------- small utils ----------
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}
function writeJsonSafe(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj), "utf8");
}
function cosine(a, b) {
  // a, b are Float32Array or number[]
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { const x = a[i], y = b[i]; dot += x*y; na += x*x; nb += y*y; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}
function toF32(arr) { return Float32Array.from(arr); }

// What we embed/compare for example selection
function exText(ex) {
  return String(ex.input || ex.instruction || ex.prompt || "").trim();
}

// lexical overlap to estimate confidence (0..1)
function overlapScore(q, ex) {
  const tokenize = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(Boolean);
  const qset = new Set(tokenize(q));
  const text = exText(ex);
  const toks = tokenize(text);
  let overlap = 0;
  for (const t of toks) if (qset.has(t)) overlap++;
  return overlap / Math.max(1, toks.length);
}

// ---------- JSONL loader ----------
function loadJsonlFiles(dir) {
  // Ignore system/junk files like .DS_Store, Thumbs.db, .gitkeep
  const files = glob.sync(path.join(dir, "**/*.jsonl"), {
    ignore: ["**/.DS_Store", "**/Thumbs.db", "**/.gitkeep", "**/.gitignore"],
  });
  const rows = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean);
    for (const ln of lines) {
      try {
        rows.push(JSON.parse(ln));
      } catch {
        // skip bad JSON lines safely
      }
    }
  }
  return rows;
}

// ---------- KB discovery ----------
function discoverKbNamesLLM() {
  if (!fs.existsSync("llm")) return [];
  return fs
    .readdirSync("llm", { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() &&
        ![".DS_Store", "Thumbs.db", ".gitkeep", ".gitignore"].includes(d.name)
    )
    .map((d) => d.name);
}

// ---------- Embedding helpers ----------
async function embed(client, text) {
  const { embedding } = await client.embeddings({ model: EMB_MODEL, prompt: text });
  return Float32Array.from(embedding);
}

async function embedBatch(client, texts) {
  const out = [];
  for (const t of texts) {
    const { embedding } = await client.embeddings({ model: EMB_MODEL, prompt: t });
    out.push(Float32Array.from(embedding));
  }
  return out;
}

// ---------- Build / load per-KB semantic index ----------
const CACHE_ROOT = path.join(".cache", "llm_index");

function cachePathFor(kb) {
  return path.join(CACHE_ROOT, `${kb}.json`);
}

/**
 * Build an index:
 * {
 *   model: "<embed-model>",
 *   examples: [{ obj }, { obj }, ...],   // original JSONL rows
 *   embs: [ [..], [..], ... ]            // float arrays stored as plain JS arrays
 * }
 */
async function buildIndexForKb(client, kbName) {
  const dir = path.join("llm", kbName);
  const rows = loadJsonlFiles(dir).filter(r => exText(r));
  if (!rows.length) return null;

  const texts = rows.map(exText);
  const embs = await embedBatch(client, texts);

  const index = {
    model: EMB_MODEL,
    examples: rows,
    embs: embs.map(v => Array.from(v)) // store as arrays in JSON
  };
  writeJsonSafe(cachePathFor(kbName), index);
  return index;
}

function loadIndexForKb(kbName) {
  const p = cachePathFor(kbName);
  const obj = readJsonSafe(p);
  if (!obj || !obj.examples || !obj.embs) return null;
  return obj;
}

async function ensureIndexForKb(client, kbName) {
  const cached = loadIndexForKb(kbName);
  if (cached && cached.model === EMB_MODEL) {
    return cached;
  }
  // no cache or model changed → rebuild
  return await buildIndexForKb(client, kbName);
}

// ---------- Public init ----------
/**
 * init()
 * Loads or builds semantic indices for all llm/<kb>/ folders.
 * Returns a Map<kbName, { model, examples[], embs[] }>
 */
async function init() {
  const client = new Ollama({ host: OLLAMA_HOST });
  const names = discoverKbNamesLLM();
  const store = new Map();
  for (const n of names) {
    const idx = await ensureIndexForKb(client, n);
    if (idx) store.set(n, idx);
  }
  return store;
}

// ---------- Few-shot prompt + answering ----------
function pickTopKExamplesForIndex(qEmb, index, k) {
  // index = { examples[], embs[] }
  const scores = index.embs.map((arr, i) => ({
    i,
    score: cosine(qEmb, toF32(arr))
  }));
  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, k).map(s => index.examples[s.i]);
}

function buildFewShotPrompt(q, examples) {
  const shots = examples.map((ex, i) => {
    const inp = exText(ex);
    const out = String(ex.output || ex.response || ex.completion || "").trim();
    return `### Example ${i+1}\nUser: ${inp}\nAssistant: ${out}`;
  }).join("\n\n");

  return `${shots}\n\n### Task\nUser: ${q}\nAssistant:`;
}

/**
 * answerOnceLLM(q, store)
 * - store: Map<kbName, { model, examples[], embs[] }>
 * Returns:
 *   { text, hits:[], confidence, mode:'llm' }
 * Where low confidence or empty text is a signal for hybrid fallback.
 */
async function answerOnceLLM(q, store) {
  const client = new Ollama({ host: OLLAMA_HOST });

  // If no KB indices yet, ask model with strict guard.
  if (!store || store.size === 0) {
    const { response } = await client.generate({
      model: GEN_MODEL_LLM,
      prompt: `You are a careful assistant.
If the answer is not clearly implied by your prior knowledge, reply exactly: "I don't know".
User: ${q}
Assistant:`,
      options: { temperature: 0.1, num_predict: 128, keep_alive: "5m" }
    });
    const text = String(response || "").trim();
    const conf = /i don't know/i.test(text) ? 0 : 0.25;
    return { text, hits: [], confidence: conf, mode: "llm" };
  }

  // 1) Embed query
  const qEmb = await embed(client, q);

  // 2) Pick top-K from EACH KB
  const K_PER_KB = Number(process.env.LLM_K || 6);
  const picked = [];
  for (const idx of store.values()) {
    const exs = pickTopKExamplesForIndex(qEmb, idx, K_PER_KB);
    picked.push(...exs);
  }
  if (!picked.length) {
    return { text: "", hits: [], confidence: 0, mode: "llm" };
  }

  // 3) Estimate confidence via lexical overlap w/ picked examples
  let maxOverlap = 0;
  for (const ex of picked) {
    const sc = overlapScore(q, ex);
    if (sc > maxOverlap) maxOverlap = sc;
  }
  if (maxOverlap < CONF_THRESH) {
    return { text: "", hits: [], confidence: maxOverlap, mode: "llm" };
  }

  // 4) Build few-shot prompt from the picks
  const prompt = buildFewShotPrompt(q, picked);

  // 5) Generate
  const { response } = await client.generate({
    model: GEN_MODEL_LLM,
    prompt,
    options: { temperature: 0.1, num_predict: 128, keep_alive: "5m" }
  });

  const text = String(response || "").trim();

  // Heuristic: “hedgy” answers → treat as low confidence so RAG can take over
  const hedgy = /(not.*public(ly)? (disclosed|available)|check (their|the) official website|contact (them|support)|cannot (determine|confirm))/i;
  if (hedgy.test(text)) {
    return { text: "", hits: [], confidence: Math.min(maxOverlap, 0.25), mode: "llm" };
  }

  return { text, hits: [], confidence: maxOverlap || 0, mode: "llm" };
}

module.exports = { init, answerOnceLLM, discoverKbNamesLLM, CONF_THRESH };