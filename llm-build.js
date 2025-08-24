// llm-build.js — Validate & merge llm/<kb>/*.jsonl → llm/<kb>/merged.jsonl
const fs = require("fs");
const path = require("path");
const glob = require("glob");

const LLM_ROOT = "llm";

function mergeOne(kb) {
  const dir = path.join(LLM_ROOT, kb);
  const files = glob.sync(path.join(dir, "**/*.jsonl"));
  if (!files.length) { console.warn(`(skip) No JSONL in ${dir}`); return; }
  const out = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean);
    for (const ln of lines) {
      try { JSON.parse(ln); out.push(ln); } catch { console.warn(`(skip bad) ${f}`); }
    }
  }
  const outPath = path.join(dir, "merged.jsonl");
  fs.writeFileSync(outPath, out.join("\n") + "\n", "utf8");
  console.log(`✅ Built ${outPath} (${out.length} examples).`);
}

(function main() {
  if (!fs.existsSync(LLM_ROOT)) { console.error("No ./llm folder"); process.exit(1); }
  const arg = process.argv[2];
  if (arg) {
    if (!fs.existsSync(path.join(LLM_ROOT, arg))) { console.error(`Folder not found: llm/${arg}`); process.exit(1); }
    mergeOne(arg);
  } else {
    const subs = fs.readdirSync(LLM_ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    if (!subs.length) { console.error("No subfolders in ./llm"); process.exit(1); }
    for (const name of subs) mergeOne(name);
  }
})();