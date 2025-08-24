// llm-update.js — rebuild llm_index/<kb>.jsonl from llm/<kb>/**/*.jsonl
// (same behavior as build, we just overwrite atomically)
const fs = require("fs");
const path = require("path");
const glob = require("glob");
require("./llm-build.js");

function ensureDir(p){ if(!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

async function updateOne(kb) {
  const kbDir = path.join("llm", kb);
  if (!fs.existsSync(kbDir)) { console.error(`No llm/${kb} folder`); process.exit(1); }

  const files = glob.sync(`${kbDir}/**/*.jsonl`, { nocase: true });
  if (!files.length) { console.warn(`(skip) No .jsonl in llm/${kb}`); return; }

  ensureDir("llm_index");
  const out = path.join("llm_index", `${kb}.jsonl`);
  const tmp = `${out}.tmp`;

  const ws = fs.createWriteStream(tmp, { flags: "w" });

  for (const f of files) {
    const rs = fs.createReadStream(f);
    await new Promise((res, rej) => {
      rs.pipe(ws, { end: false });
      rs.on("end", res);
      rs.on("error", rej);
    });
  }
  ws.end();
  fs.renameSync(tmp, out);
  console.log(`✅ Updated ${out} from ${files.length} file(s).`);
}

(async function main(){
  const kb = process.argv[2];
  if(!kb) { console.error("Usage: node llm-update.js <kbName>"); process.exit(1); }
  await updateOne(kb);
})();