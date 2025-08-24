// lib/watcher.js
const chokidar = require("chokidar");
const path = require("path");
const { spawn } = require("node:child_process");

function run(cmd, args, cwd = process.cwd()) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: "inherit" });
    p.on("exit", (code) => resolve(code === 0));
  });
}

function debounce(fn, ms = 300) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

function watchRag() {
  const w = chokidar.watch("data", {
    ignoreInitial: true,
    persistent: true,
    ignored: [
      "**/.DS_Store",
      "**/Thumbs.db",
      "**/.gitkeep",
      "**/.gitignore",
    ],
  });

  const onChange = debounce(async (filePath) => {
    const parts = filePath.split(path.sep);
    const idx = parts.indexOf("data");
    const kb = parts[idx + 1];
    if (!kb) return;
    const isDbPresent = require("fs").existsSync(path.join("db", `${kb}.db`));
    const script = isDbPresent ? "update.js" : "build.js";
    console.log(`[watch] ${filePath} → ${script} ${kb}`);
    await run("node", [script, kb]);
  }, 500);

  w.on("add", onChange).on("change", onChange);
  return w;
}

function watchLlm() {
  const w = chokidar.watch("llm", {
    ignoreInitial: true,
    persistent: true,
    ignored: [
      "**/.DS_Store",
      "**/Thumbs.db",
      "**/.gitkeep",
      "**/.gitignore",
    ],
  });

  const onChange = debounce(async (filePath) => {
    const parts = filePath.split(path.sep);
    const idx = parts.indexOf("llm");
    const kb = parts[idx + 1];
    if (!kb) return;
    console.log(`[watch] ${filePath} → llm-update.js ${kb}`);
    await run("node", ["llm-update.js", kb]);
  }, 500);

  w.on("add", onChange).on("change", onChange);
  return w;
}

function startWatcher({ rag = true, llm = true } = {}) {
  const enabled = [];
  if (rag) enabled.push(watchRag());
  if (llm) enabled.push(watchLlm());
  if (enabled.length) console.log("Watcher enabled.");
  return () => enabled.forEach((w) => w.close());
}

module.exports = { startWatcher };