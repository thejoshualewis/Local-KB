# LocalKB: Self‑Hosted Knowledge Base with RAG + LLM

LocalKB is a small, self‑hosted AI system for querying your documents locally.  
It supports two modes of operation:

- **RAG (Retrieval‑Augmented Generation)**: chunks your `.txt`/`.md`/`.pdf`, embeds with Ollama, stores embeddings as BLOBs in SQLite, and retrieves answers via SQLite FTS5 + cosine re‑ranking.
- **LLM Few‑Shot**: uses `.jsonl` training/example files to answer questions directly from examples, with optional fallback to RAG.

It can run as a **CLI tool** for personal use on a workstation, or as an **API server** for intranet/web integrations.  

DB files live in `db/`, and watcher support means dropping new files into `data/` or `llm/` triggers automatic updates.

---

## Project Structure

- **build.js**  
  Creates SQLite databases from raw documents in `data/<kb>/`.  
  Splits files into chunks, generates embeddings, and saves them with FTS indexes.  
  - Run without arguments → rebuilds all knowledge bases.  
  - Run with `node build.js <kb>` → rebuilds only the specified KB.

- **update.js**  
  Updates existing KB databases when raw data files change.  
  Supports "replace‑on‑change" (replaces changed docs) or appends new chunks.  
  - Run without arguments → updates all KBs.  
  - Run with `node update.js <kb>` → updates only the specified KB.

- **query.js**  
  CLI chat interface for RAG.  
  Lets you interactively ask questions, see the answer, and view which chunks were used as context.  
  Useful for **local exploration and debugging**.

- **start.js**  
  CLI runner for **LLM, RAG, or hybrid** mode.  
  Ensures Ollama models are installed, loads knowledge bases, and starts an interactive Q&A loop.  
  Default is `MODE=hybrid` (LLM first, RAG fallback).  

- **server.js**  
  API server (Express) exposing endpoints:  
  - `POST /query { "question": "..." }` → JSON with `{ status, answer, mode, sources }`.  
  - `GET /healthz` → check mode and loaded DBs.  
  Used for **intranet/web integrations**.  

- **lib/retriever.js**  
  Core of RAG mode. Handles:  
  - Chunk retrieval from SQLite with FTS.  
  - Cosine re‑ranking.  
  - Direct Q/A extraction (`Q: ... A: ...`) if available.  
  - LLM generation fallback for short answers.  

- **lib/llmRunner.js**  
  Core of LLM few‑shot mode. Handles:  
  - Loading `.jsonl` files in `llm/<kb>/`.  
  - Building semantic indexes for selecting examples.  
  - Constructing few‑shot prompts.  
  - Running Ollama generations.

- **lib/engine.js**  
  Unified routing layer. Selects which engine (rag, llm, or hybrid) to use based on `MODE`.  

- **lib/watcher.js**  
  Watches the `data/` and `llm/` folders.  
  Automatically runs `build` or `update` when new or changed files are detected.  
  Keeps KBs in sync without manual rebuilds.  

- **lib/models.js**  
  Ensures required Ollama models are available.  
  - Starts `ollama serve` if not running.  
  - Downloads missing models automatically.

---

## Installing

1. Install **Node.js 20.19.4 or higher**.
2. Install **Ollama** and ensure it runs with `ollama serve`.
3. Clone the repo and install dependencies:

   ```
   npm install
   ```

4. Configure `.env` (see `.env.example`) with:
5. 
   ```
   OLLAMA_HOST=http://127.0.0.1:11434
   GEN_MODEL=qwen2.5:1.5b
   GEN_MODEL_LLM=llama3
   EMB_MODEL=nomic-embed-text
   MODE=hybrid
   WATCH=1
   ```

---

## Usage Examples

### CLI (personal use)
Start in **interactive Q&A** mode:
```
npm start
```

- Default: `MODE=hybrid` (LLM first, fallback to RAG).
- Type questions directly, `exit` to quit.

Force RAG only:
```
MODE=rag npm start
```

Force LLM only:
```
MODE=llm npm start
```

### API (intranet use)
Start API server:
```
npm run dev
```
- Default port: `http://localhost:3001`
- Example POST:
- 
  ```
  curl -X POST http://localhost:3001/query     -H "Content-Type: application/json"     -d '{"question":"When was Acme founded?"}'
  ```

Response:

```
{
  "status": "ok",
  "answer": "Acme Corp was founded in 1998.",
  "mode": "llm",
  "sources": [
    { "db": "example", "doc": "qa.txt", "chunk_id": 0, "score": 0.87 }
  ]
}
```

### Building Knowledge Bases
Rebuild all KBs:
```
npm run rag:build
npm run llm:build
```

Rebuild specific KB:
```
node build.js example
node llm-build.js acme
```

### Updating Knowledge Bases
Update all KBs:
```
npm run rag:update
npm run llm:update
```

Update specific KB:
```
node update.js example
node llm-update.js acme
```

### Automatic Updates
If `WATCH=1` in `.env`, any time you add or change files in `data/` (RAG) or `llm/` (LLM), the watcher will automatically trigger `update` (or `build` if no DB exists yet).

---

## Typical Use Cases

- **CLI mode**:  
  For developers, researchers, or hobbyists running queries on their personal computer.  

- **API mode**:  
  For teams or organizations that want an intranet endpoint where colleagues can query the same knowledge base.  

- **Hybrid mode**:  
  Default setup. Uses few‑shot LLM if examples match, and falls back to RAG if not.

---

## License

MIT License — free to use, modify, and distribute.
