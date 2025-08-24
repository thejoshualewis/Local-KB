// lib/models.js — start ollama serve, ensure/pull models with fallbacks
const { spawn } = require("node:child_process");
const http = require("node:http");
const { Ollama } = require("ollama");

const OLLAMA_HOST   = process.env.OLLAMA_HOST   || "http://127.0.0.1:11434";
const GEN_MODEL_RAG = process.env.GEN_MODEL     || "qwen2.5:1.5b";
const GEN_MODEL_LLM = process.env.GEN_MODEL_LLM || "qwen2.5:1.5b"; // safer default than llama3.2:3b-instruct
const EMB_MODEL     = process.env.EMB_MODEL     || "nomic-embed-text";

// Fallback candidates if the requested tag isn't available
const FALLBACKS = {
  gen_rag: [GEN_MODEL_RAG, "qwen2.5:1.5b", "phi3:mini"],
  gen_llm: [GEN_MODEL_LLM, "qwen2.5:1.5b", "phi3:mini", "llama3.1:8b-instruct"],
  emb:     [EMB_MODEL, "nomic-embed-text"]
};

const NEEDS_BY_MODE = {
  rag:     ["gen_rag", "emb"],
  llm:     ["gen_llm"],
  hybrid:  ["gen_llm", "gen_rag", "emb"]
};

function pingOllama() {
  return new Promise((resolve) => {
    const req = http.get(OLLAMA_HOST + "/api/tags", { timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

async function ensureServe() {
  if (await pingOllama()) return;
  const proc = spawn("ollama", ["serve"], { stdio: "ignore", detached: true });
  proc.unref();
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (await pingOllama()) return;
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error("ollama serve did not start within 15s");
}

async function hasModel(client, name) {
  try {
    const tags = await client.list();
    return (tags?.models || []).some(m => m.name === name);
  } catch {
    return false;
  }
}

async function pullOne(client, tag) {
  process.stdout.write(`Pulling Ollama model: ${tag} …\n`);
  await client.pull({ model: tag, stream: false });
  return true;
}

async function pullWithFallbacks(key) {
  const client = new Ollama({ host: OLLAMA_HOST });
  const candidates = (FALLBACKS[key] || []).filter(Boolean);

  for (const tag of candidates) {
    try {
      if (await hasModel(client, tag)) return tag;
      await pullOne(client, tag);
      return tag;
    } catch (e) {
      // try next candidate
      if (e?.error) console.warn(`  ↪︎ ${tag} failed: ${e.error}`);
      else console.warn(`  ↪︎ ${tag} failed: ${e?.message || e}`);
    }
  }
  throw new Error(`No available model from candidates: [${candidates.join(", ")}]`);
}

async function ensureModels(mode = "hybrid") {
  await ensureServe();
  const needKeys = NEEDS_BY_MODE[mode] || NEEDS_BY_MODE.hybrid;

  const resolved = {};
  for (const key of needKeys) {
    resolved[key] = await pullWithFallbacks(key);
  }

  // Reflect the resolved choices back into process.env so other modules use them
  if (resolved.gen_rag) process.env.GEN_MODEL     = resolved.gen_rag;
  if (resolved.gen_llm) process.env.GEN_MODEL_LLM = resolved.gen_llm;
  if (resolved.emb)     process.env.EMB_MODEL     = resolved.emb;

  console.log("Models ready.");
  return resolved;
}

module.exports = {
  ensureServe,
  ensureModels,
  OLLAMA_HOST,
  GEN_MODEL_RAG,
  GEN_MODEL_LLM,
  EMB_MODEL
};