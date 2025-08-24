// lib/ollama.js — ensure Ollama is running locally; spawn if needed
const { spawn } = require("child_process");
const http = require("http");
const { URL } = require("url");

function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function isUp(hostUrl) {
  try {
    const url = new URL(hostUrl);
    const opts = { method: "GET", hostname: url.hostname, port: url.port, path: "/api/version", timeout: 1000 };
    return await new Promise((resolve) => {
      const req = http.request(opts, (res) => resolve(res.statusCode === 200));
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.end();
    });
  } catch { return false; }
}

let spawned = null;

async function ensureOllamaRunning(hostUrl = process.env.OLLAMA_HOST || "http://127.0.0.1:11434") {
  if (await isUp(hostUrl)) return { ok: true, spawned: false };

  // Try to spawn: `ollama serve`
  spawned = spawn("ollama", ["serve"], {
    stdio: "ignore", // keep background quiet
    detached: true
  });
  spawned.unref();

  // Wait until it's up (retry a few times)
  for (let i = 0; i < 30; i++) {
    if (await isUp(hostUrl)) return { ok: true, spawned: true };
    await wait(500);
  }
  throw new Error("Failed to start ollama serve (timed out). Is Ollama installed?");
}

module.exports = { ensureOllamaRunning };