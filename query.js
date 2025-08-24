// query.js — CLI chat (now conversational) across all DBs or a specific one (arg)
require("dotenv").config();
const readline = require("readline");
const path = require("path");

const { ensureModels } = require("./lib/models");
const retriever = require("./lib/retriever");
const convo = require("./lib/conversation");     // NEW
const llm = require("./lib/llmRunner");          // optional fallback

(async function main(){
  await ensureModels([process.env.EMB_MODEL || "nomic-embed-text", process.env.GEN_MODEL || "qwen2.5:1.5b"]);

  const argDb = process.argv[2] || null;
  // discoverDbNames may be in retriever; if not, just show arg or "all"
  const list = (typeof retriever.discoverDbNames === "function") ? retriever.discoverDbNames() : [];
  console.log(`Loaded DBs: ${argDb ? argDb : (list.length ? list.join(", ") : "all")}`);
  console.log("Type 'exit' to quit.");

  // adapter for conversation.js
  const retrieverAdapter = {
    async search(query, opts) {
      if (typeof retriever.search === "function") {
        return retriever.search(query, opts);
      }
      const res = await retriever.answerOnce(query, argDb);
      return (res.hits || []).map(h => ({
        text: h.text || h.doc || "",
        score: typeof h.score === "number" ? h.score : (h.sim || 0),
        meta: { source: h.source, title: h.title, chunk: h.chunk_id }
      }));
    }
  };

  // optional LLM init
  if (llm && typeof llm.init === "function") {
    try { await llm.init(); } catch {/* ignore */}
  }

  const state = convo.initState();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const askOnce = () => rl.question("\nAsk: ", async (qt)=>{
    try {
      if (!qt) return askOnce();
      if (qt.toLowerCase() === "exit") { rl.close(); process.exit(0); }

      const res = await convo.answerTurn(
        state,
        qt,
        retrieverAdapter,
        llm,                          // used only if retrieval returns nothing
        { topK: 5, threshold: 0.38 }  // tune as desired
      );

      console.log("\n--- Answer ---\n" + res.text);
      console.log("\n--- Sources ---");
      (res.hits || []).forEach(h => {
        const src = (h.meta?.title || h.meta?.source || "doc");
        const s = typeof h.score === "number" ? h.score.toFixed(3) : "n/a";
        console.log(`• ${src} (sim≈${s})`);
      });
    } catch (e) {
      console.error("Error:", e?.message || e);
    }
    askOnce();
  });

  askOnce();
})();