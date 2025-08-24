# LocalKB

LocalKB is a lightweight, self-hosted knowledge base. It takes your `.txt, .md, and .pdf` files, breaks them into chunks, generates embeddings with Ollama, and stores them as binary vectors (BLOBs) in SQLite. 

Retrieval uses SQLite’s FTS5 search for speed, then cosine similarity re-ranking for accuracy.

* **CLI mode** is designed for quick, personal use on your own machine — a fast way to test or query your notes and documents.

* **HTTP API mode** is ideal for sharing across a small team or intranet, so others can query the same knowledge base without touching the command line.

* **All databases** are stored locally under db/, keeping the setup portable and self-contained.

## Install
First, download [ollama](https://ollama.com/), based on your platform

Next, install modules, and copy the env file

```
npm i
cp .env.example .env
```

Pull models (first run will also do this):

```
# ensure Ollama is running in another terminal
ollama serve

# good defaults
ollama pull nomic-embed-text
ollama pull qwen2.5:1.5b
```

## Add data

```
data/<kb-name>/*.txt|md|pdf
```
Example:

```
mkdir -p data/example
cat > data/example/qa.txt <<'TXT'
Q: What year was Acme Corp founded?
A: 1999.
TXT
```

## Build

```
# builds all subfolders under data/ into ./db/*.db
npm run build

# only data/example -> db/example.db
npm run build example
```

## Update

```
# updates all DBs (append or replace-on-change)
npm run update

# only data/example -> db/example.db
npm run update example
```

## CLI chat
The CLI version is mainly for testing, but can be used locally, by creating subfolders under the `data` folder and rebuilding/updating

```
# interactive chat across all DBs
npm start

# restrict to a single DB
npm start -- example
```

## HTTP API

The API will monitor the data subfolders, new folders with data will trigger a build for that data, folders with existing data will trigger an update.  Both will restart the server.


```
# starts server on PORT (default 3001)
npm run dev 

# POST /query  
{ "question": "What year was Acme Corp founded" }
```

```
response

{
    "status": "ok",
    "answer": "Acme Corp was founded in 1999.",
    "sources": [
        {
            "db": "example",
            "doc": "qa.txt",
            "chunk_id": 0,
            "score": 0.6997
        }
    ]
}
```

## Project layout
- `build.js`, `update.js`, `query.js`, `start.js`, `server.js` – entry points
- `lib/chunking.js` – text parsing + chunking
- `lib/watcher` – monitors data folder to build or update
- `lib/db.js`       – SQLite helpers (create schema, open, FTS)
- `lib/llm.js`      – Ollama calls (embeddings + generation)
- `lib/models.js`   – ensure required models are pulled
- `lib/retriever.js`– retrieval + answer orchestration
- `db/`             – SQLite databases (`.db`) (tracked, empty via `.gitkeep`)
- `data/`           – your source files (ignored except `.gitkeep`)

## License
MIT License

**Copyright (c) 2025 Joshua Lewis**

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
