// server.js — HTTP API (conversational RAG by default)
// POST /query { "question": "...", "session_id": "optional" } → { status, answer, mode, sources[] }

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");

const { ensureModels } = require("./lib/models");
const retriever = require("./lib/retriever");      // existing RAG
const llm       = require("./lib/llmRunner");      // few-shot LLM (optional)
const { startWatcher } = require("./lib/watcher");

// NEW: conversation layer
const convo = require("./lib/conversation");

// crude per-client session store (memory)
const sessionStates = new Map();
function getState(id = "default") {
  if (!sessionStates.has(id)) sessionStates.set(id, convo.initState());
  return sessionStates.get(id);
}

// adapter to give conversation.js a search() using your retriever
const retrieverAdapter = {
  async search(query, opts) {
    // if you later add retriever.search, we'll use it
    if (typeof retriever.search === "function") {
      return retriever.search(query, opts);
    }
    // otherwise call answerOnce and map hits → docs
    const res = await retriever.answerOnce(query);
    return (res.hits || []).map(h => ({
      text: h.text || h.doc || "",
      score: typeof h.score === "number" ? h.score : (h.sim || 0),
      meta: { source: h.source, title: h.title, chunk: h.chunk_id }
    }));
  }
};

const MODE = (process.env.MODE || "hybrid").toLowerCase();
const PORT = Number(process.env.PORT || 3001);

async function boot() {
  console.log(`Booting API in mode=${MODE} …`);

  // ensure models (ollama serve + pulls) using your existing helper
  await ensureModels([
    process.env.EMB_MODEL || "nomic-embed-text",
    process.env.GEN_MODEL || "qwen2.5:1.5b"
  ]);

  // init optional LLM runner
  if (llm && typeof llm.init === "function") {
    try { await llm.init(); } catch (e) {
      console.warn("LLM init warning:", e?.message || e);
    }
  }

  // start watcher (your existing behavior)
  try { startWatcher(); } catch { /* ignore */ }

  const app = express();
  app.use(bodyParser.json({ limit: "2mb" }));

  app.get("/", (_req, res) => {
    res
      .type("text/plain")
      .send('LocalKB API\nPOST /query {"question":"..."}');
  });

  // conversational /query
  app.post("/query", async (req, res) => {
    try {
      const { question, session_id } = req.body || {};
      if (!question || !String(question).trim()) {
        return res.status(400).json({ status: "error", error: "Missing 'question'." });
      }

      const state = getState(session_id || req.ip);

      const result = await convo.answerTurn(
        state,
        String(question),
        retrieverAdapter,
        llm,                            // used only if retrieval returns nothing
        { topK: 5, threshold: 0.38 }    // tune 0.35–0.45 if needed
      );

      return res.json({
        status: "success",
        answer: result.text,
        mode: result.mode,
        sources: (result.hits || []).map(h => ({
          source: h.meta?.title || h.meta?.source || "doc",
          score: typeof h.score === "number" ? h.score : null
        }))
      });
    } catch (e) {
      console.error("Query error:", e);
      return res.status(500).json({ status: "error", error: e?.message || String(e) });
    }
  });

  app.listen(PORT, () => {
    console.log(`API listening on http://localhost:${PORT} (mode=${MODE})`);
  });
}

boot().catch((e) => {
  console.error("Server boot error:", e);
  process.exit(1);
});