// lib/watcher.js — watch ./data for new files and run build/update for that dataset.
// Design goals:
// - Keep server.js clean: only call startWatcher().
// - Trigger update when a new file is added inside an existing dataset (data/<name>/…).
// - If dataset has no DB yet (./db/<name>.db missing), run build once files exist.
// - Debounce per-dataset so multiple quick adds coalesce into one update.
// - Only act on supported content files (.txt, .md, .pdf). Ignore temp/hidden files.

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const chokidar = require("chokidar");
require("dotenv").config();

const DATA_ROOT = process.env.DATA_ROOT || "data";
const DB_DIR    = process.env.DB_DIR || "db";
const VERBOSE   = process.env.WATCH_VERBOSE === "1";

// Supported file extensions we index
const SUPPORTED = new Set([".txt", ".md", ".pdf"]);

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function log(...args) {
  console.log(new Date().toISOString(), "-", ...args);
}
function vlog(...args) {
  if (VERBOSE) log(...args);
}

/**
 * Given an absolute or relative file path under data/<dataset>/...,
 * return the dataset name ("example", "master", ...).
 */
function datasetFromFile(filePath) {
  const rel = path.relative(DATA_ROOT, filePath);
  if (rel.startsWith("..")) return null;            // not within DATA_ROOT
  const [dataset] = rel.split(path.sep);
  return dataset || null;
}

/**
 * Returns true if ./db/<dataset>.db exists.
 */
function dbExists(dataset) {
  const dbPath = path.join(DB_DIR, `${dataset}.db`);
  return fs.existsSync(dbPath);
}

/**
 * Spawn a node script (build or update) for a dataset.
 * Ensures proper stdio, logs success/failure, returns a promise.
 */
function runScript(script, dataset) {
  return new Promise((resolve, reject) => {
    const cmd = process.execPath; // 'node'
    const args = [path.resolve(`${script}.js`), dataset];
    const child = spawn(cmd, args, { stdio: "inherit" });

    child.on("error", (err) => reject(err));
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${code}`));
    });
  });
}

/**
 * Decide whether to run build or update for the dataset,
 * then run it. If no DB exists -> build; else -> update.
 */
async function buildOrUpdate(dataset) {
  if (!dataset) return;
  try {
    if (dbExists(dataset)) {
      log(`Updating dataset '${dataset}' …`);
      await runScript("update", dataset);
      log(`✅ Update complete for '${dataset}'.`);
    } else {
      log(`Building dataset '${dataset}' (no DB yet) …`);
      await runScript("build", dataset);
      log(`✅ Build complete for '${dataset}'.`);
    }
  } catch (e) {
    console.error(`Watcher error for '${dataset}':`, e?.message || e);
  }
}

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

/**
 * Start the watcher. Intended to be called once from server.js.
 * Options:
 *  - enabled: boolean (default true). If false, no watcher starts.
 *  - debounceMs: number (default 800).
 */
async function startWatcher({ enabled = true, debounceMs = 800 } = {}) {
  if (!enabled) {
    log("Watcher disabled (WATCH=0).");
    return;
  }

  // Ensure base folders exist
  if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

  // Per-dataset debounce timers and in‑flight promises
  const timers = new Map();
  const inflight = new Map();

  const watcher = chokidar.watch(DATA_ROOT, {
    persistent: true,
    ignoreInitial: true,     // we only act on NEW things
    ignored: (p) => {
      const base = path.basename(p);
      // Ignore hidden files (., .DS_Store), tmp, WAL/SHM, etc.
      if (base.startsWith(".")) return true;
      if (/\.(db|db-wal|db-shm|lock|tmp|swp|part)$/i.test(base)) return true;
      return false;
    },
    depth: 5,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  function scheduleDataset(dataset) {
    if (!dataset) return;
    // If a run is in flight, just schedule a follow-up after debounce.
    if (timers.has(dataset)) clearTimeout(timers.get(dataset));
    timers.set(dataset, setTimeout(async () => {
      timers.delete(dataset);
      // Avoid concurrent runs per dataset
      if (inflight.get(dataset)) {
        vlog(`Skip (in-flight) '${dataset}', will run after it finishes.`);
        // Chain another run after the current one
        inflight.set(dataset, inflight.get(dataset).then(() => buildOrUpdate(dataset)));
        return;
      }
      const p = buildOrUpdate(dataset).finally(() => inflight.delete(dataset));
      inflight.set(dataset, p);
      await p;
    }, debounceMs));
  }

  watcher
    .on("add", (file) => {
      const ext = path.extname(file).toLowerCase();
      if (!SUPPORTED.has(ext)) return vlog("add (ignored)", file);
      const ds = datasetFromFile(file);
      log("add", file, "→", ds);
      scheduleDataset(ds);
    })
    .on("change", (file) => {
      // Optional: if you also want on-change to trigger update, uncomment.
      // const ext = path.extname(file).toLowerCase();
      // if (!SUPPORTED.has(ext)) return vlog("change (ignored)", file);
      // const ds = datasetFromFile(file);
      // log("change", file, "→", ds);
      // scheduleDataset(ds);
      vlog("change (ignored)", file);
    })
    .on("addDir", (dir) => {
      // New dataset folder: DO NOT build yet; wait until a supported file is added
      vlog("addDir", dir);
    })
    .on("error", (err) => {
      console.error("Watcher error:", err);
    })
    .on("ready", () => {
      log(`Watcher ready. Monitoring '${DATA_ROOT}' for new files (.txt, .md, .pdf).`);
    });

  return watcher;
}

module.exports = { startWatcher };