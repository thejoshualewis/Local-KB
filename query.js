// query.js — CLI chat across all DBs or a specific one (argument)
require('dotenv').config();
const readline = require('readline');
const path = require('path');
const { answerOnce, discoverDbNames } = require('./lib/retriever');
const { ensureModels } = require('./lib/models');

(async function main(){
  ensureModels([process.env.EMB_MODEL || 'nomic-embed-text', process.env.GEN_MODEL || 'qwen2.5:1.5b']);
  const argDb = process.argv[2] || null;
  const list = discoverDbNames();
  console.log(`Loaded DBs: ${argDb ? argDb : list.join(', ')}`);
  console.log("Type 'exit' to quit.");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const askOnce = () => rl.question("\nAsk: ", async (q)=>{
    const qt=(q||'').trim();
    if(!qt) return askOnce();
    if(qt.toLowerCase()==='exit'){ rl.close(); process.exit(0); }
    try{
      const res = await answerOnce(qt, argDb);
      console.log("\n--- Answer ---\n"+res.text);
      console.log("\n--- Sources ---");
      (res.hits||[]).forEach(h=>console.log(`• [${h.source}] ${h.doc} [chunk ${h.chunk_id}] (sim≈${h.score.toFixed(3)})`));
    } catch(e){
      console.error('Error:', e?.message || e);
    }
    askOnce();
  });
  askOnce();
})();
