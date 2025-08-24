// lib/hybridRunner.js — LLM first, fallback to RAG if uncertain
const llm = require("./llmRunner");
const retriever = require("./retriever");

const MIN_SIM = Number(process.env.MIN_SIM || 0.35);

/**
 * Decide if the LLM answer is “uncertain” and should fall back to RAG.
 * Heuristics are intentionally simple & cheap.
 */
function isUncertainLLM(text = "") {
  const t = text.trim().toLowerCase();
  if (!t) return true;
  if (t.length < 8) return true;
  if (/\bi don'?t know\b/.test(t)) return true;
  if (/not enough info/i.test(t)) return true;
  return false;
}

async function init() {
  // Warm up LLM; RAG does not require init
  await llm.init();
}

async function answerOnce(question) {
  // 1) Ask LLM first
  const llmRes = await llm.answerOnce(question);

  if (!isUncertainLLM(llmRes.text)) {
    return llmRes; // confident enough
  }

  // 2) Fall back to RAG
  const ragRes = await retriever.answerOnce(question);

  // If RAG found something with reasonable similarity, prefer it.
  const topScore = (ragRes.hits && ragRes.hits[0]?.score) || 0;
  if (ragRes.hits && ragRes.hits.length && topScore >= MIN_SIM) {
    return ragRes;
  }

  // Otherwise return the LLM’s reply (even if tentative).
  return llmRes;
}

// Re-export discovery helper so the server can show loaded DBs
const discoverDbNames = retriever.discoverDbNames || (() => []);

module.exports = { init, answerOnce, discoverDbNames };