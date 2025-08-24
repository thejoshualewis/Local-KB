// lib/engine.js
// Unified engine with MODE routing: rag | llm | hybrid (LLM→RAG fallback).
const retriever = require("./retriever");            // your existing RAG module
const llm       = require("./llmRunner");            // few-shot LLM
const { CONF_THRESH } = llm;

const MODE = (process.env.MODE || "rag").toLowerCase();

async function init() {
  if (MODE === "rag")   { await (retriever.initRetrieval?.() || Promise.resolve()); return; }
  if (MODE === "llm")   { await llm.init(); return; }
  if (MODE === "hybrid"){ await llm.init(); await (retriever.initRetrieval?.() || Promise.resolve()); return; }
  // unknown → default to rag
  await (retriever.initRetrieval?.() || Promise.resolve());
}

async function answerOnce(q) {
  if (MODE === "llm") return llm.answerOnce(q);
  if (MODE === "rag") return retriever.answerOnce(q);

  // hybrid: try LLM first, fallback to RAG if low confidence
  const first = await llm.answerOnce(q);
  if ((first.confidence || 0) >= CONF_THRESH && first.text) return first;

  const second = await retriever.answerOnce(q);
  // merge sources (optional): mark fallback
  return {
    text: second.text,
    hits: [...(first.hits||[]), ...(second.hits||[])],
    fallback: "rag"
  };
}

async function discoverDbNames() {
  if (MODE === "llm") return [];
  return (retriever.discoverDbNames?.() || []);
}

module.exports = { init, answerOnce, discoverDbNames, MODE };