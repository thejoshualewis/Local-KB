// lib/models.js
// Ensure required Ollama models exist; pull if missing.
const { execSync } = require('child_process');

function listLocalModels(){
  try {
    const out = execSync('ollama list', { stdio: ['ignore','pipe','ignore'] }).toString();
    // crude parse: first column is the name
    const names = out.split('\n').slice(1).map(l => l.split(/[\s\t]+/)[0]).filter(Boolean);
    return new Set(names);
  } catch {
    return new Set();
  }
}

function ensureModels(models = []){
  const have = listLocalModels();
  for (const m of models) {
    if (!have.has(m)) {
      console.log(`▶ pulling model: ${m} …`);
      execSync(`ollama pull ${m}`, { stdio: 'inherit' });
    }
  }
}

module.exports = { ensureModels };
