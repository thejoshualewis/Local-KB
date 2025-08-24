// start.js — CLI runner (hybrid by default)
// Prints which mode produced the final answer

require("dotenv").config();
const readline = require("readline");
const { ensureModels } = require("./lib/models");
const retriever = require("./lib/retriever");   // RAG
const llm = require("./lib/llmRunner");         // Few-shot LLM
const { startWatcher } = require("./lib/watcher");

const MODE = (process.env.MODE || "hybrid").toLowerCase();

async function main() {
  await ensureModels(MODE);

  let llmStore = null;
  if (MODE !== "rag") {
    llmStore = await llm.init();
  }

  if (process.env.WATCH === "1") {
    startWatcher({ rag: MODE !== "llm", llm: MODE !== "rag" });
  }

  console.log(`Loaded DBs: ${(retriever.discoverDbNames() || []).join(", ") || "(none)"}`);
  console.log(`Type 'exit' to quit. (mode=${MODE})`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => rl.question("\nAsk: ", async (q) => {
    if (!q) return ask();
    if (q.toLowerCase() === "exit") { rl.close(); return; }
    try {
      let res;
      if (MODE === "rag") {
        res = await retriever.answerOnce(q);
        res.mode = "rag";
      } else if (MODE === "llm") {
        res = await llm.answerOnceLLM(q, llmStore);
        res.mode = "llm";
      } else {
        // HYBRID: LLM first → fallback to RAG on low confidence
        const first = await llm.answerOnceLLM(q, llmStore);
        if (first.text && (first.confidence || 0) >= llm.CONF_THRESH) {
          res = first; // confident LLM
          res.mode = "llm";
        } else {
          const fb = await retriever.answerOnce(q);
          res = fb.text ? { ...fb, mode: "rag" } : { ...first, mode: "llm" };
        }
      }

      console.log("\n--- Answer ---\n" + (res.text || "(no answer)"));
      console.log("\nMode:", res.mode || MODE);
      console.log("\n--- Sources ---");
      (res.hits || []).forEach(h =>
        console.log(`• [${h.source}] ${h.doc} [chunk ${h.chunk_id}] (sim≈${h.score?.toFixed?.(3) ?? h.score})`)
      );
    } catch (e) {
      console.error("Error:", e?.message || e);
    }
    ask();
  });
  ask();
}

main().catch(e => { console.error(e); process.exit(1); });