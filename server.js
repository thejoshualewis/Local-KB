// server.js — HTTP API for your local KB
// POST /query { "question": "..."} → { status, answer, sources[] }

const express = require("express");
const bodyParser = require("body-parser");
require("dotenv").config();

// --- Retrieval (supports CJS/ESM default)
const retrieverMod = require("./lib/retriever");
const answerOnce = retrieverMod.answerOnce || retrieverMod.default?.answerOnce;
const discoverDbNames = retrieverMod.discoverDbNames || retrieverMod.default?.discoverDbNames;
if (typeof answerOnce !== "function") {
  console.error("retriever export shape:", Object.keys(retrieverMod));
  throw new TypeError("answerOnce() not found on ./lib/retriever");
}

// --- Models helper
const { ensureModels } = require("./lib/models");

// --- Watcher (self‑contained inside lib/watcher.js)
const { startWatcher } = require("./lib/watcher");

// --- Config
const PORT = Number(process.env.PORT || 3001);

async function boot() {
  // 1) Make sure Ollama models exist and are warm
  await ensureModels();

  // 2) Log which DBs we’ll be searching (from ./db/*.db)
  let dbs = [];
  try { dbs = (await (discoverDbNames?.() ?? [])).map(String); } catch {}
  if (dbs.length) console.log("Loaded DBs:", dbs.join(", "));

  // 3) Start HTTP server
  const app = express();
  app.use(bodyParser.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => res.json({ ok: true, dbs }));

  app.get("/", (_req, res) => {
    res.type("text/plain").send('LocalKB API\nPOST /query {"question":"..."}');
  });

  // Accepts {question} or {q}
  app.post("/query", async (req, res) => {
    try {
      const q = (req.body?.question || req.body?.q || "").trim();
      if (!q) {
        return res.status(400).json({ status: "error", error: "Missing 'question' (or 'q') in JSON body." });
      }
      const result = await answerOnce(q);
      const sources = (result.hits || []).map(h => ({
        db: h.source,
        doc: h.doc,
        chunk_id: h.chunk_id,
        score: Number(h.score?.toFixed?.(4) ?? h.score ?? 0),
      }));
      res.json({ status: "ok", answer: result.text, sources });
    } catch (err) {
      console.error("Query error:", err);
      res.status(500).json({ status: "error", error: String(err.message || err) });
    }
  });

  app.listen(PORT, () => {
    console.log(`API listening on http://localhost:${PORT}`);
  });

  // 4) Start watcher INSIDE the same process (always on during dev)
  //    To suppress watching, set WATCH=0 in the environment.
  await startWatcher({ enabled: process.env.WATCH !== "0" });
}

boot().catch((e) => {
  console.error("Server boot error:", e);
  process.exit(1);
});