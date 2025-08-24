// lib/llm.js
// Ollama wrappers for embeddings + short text generation.
const { Ollama } = require('ollama');

function client(){
  const host = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
  return new Ollama({ host });
}

async function embedText(model, text){
  const ollama = client();
  const { embedding } = await ollama.embeddings({ model, prompt: text });
  return Float32Array.from(embedding);
}

async function embedBatch(model, texts){
  const out = [];
  for (const t of texts) out.push(await embedText(model, t));
  return out;
}

async function generateShort(model, prompt, opts = {}){
  const ollama = client();
  const { response } = await ollama.generate({
    model,
    prompt,
    options: {
      temperature: 0.0,
      num_predict: opts.num_predict ?? 64,
      keep_alive: opts.keep_alive ?? '5m'
    }
  });
  return response.trim();
}

module.exports = { embedText, embedBatch, generateShort };
