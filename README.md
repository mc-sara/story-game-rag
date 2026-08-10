# Story Game RAG

English | [中文](README.zh-CN.md)

Story Game RAG is an interactive fan-fiction story game powered by novel ingestion, character profile extraction, and retrieval-augmented story context. Users can upload or select a source novel, choose original characters, transform the setting, and play through branching story chapters.

## Screenshots

### Novel Library

![Novel library and source novel selection](docs/screenshots/novel-library.png)

### Interactive Story Chapter

![Interactive story chapter with branching choices](docs/screenshots/story-chapter.png)

### Manual Story Setup

![Manual character and background setup](docs/screenshots/manual-setup.png)

## Highlights

- Upload or select a source novel from one Story-game page.
- Extract reusable character profiles, relationships, chapter summaries, and relevant scenes.
- Generate a story bible before writing to keep the story direction coherent.
- Inject original-novel context into each story node for stronger character consistency.
- Continue gracefully when RAG context is unavailable, so the story UI does not break.
- Save generated story bibles and test story runs locally for debugging.

## Architecture

This repository contains two cooperating local apps:

- `rag-agent/`: novel ingestion, indexing, character profile extraction, chapter summaries, and RAG retrieval.
- `Story-game/`: interactive fan-fiction story UI, story bible generation, prompt orchestration, and upload proxy.

Users open `Story-game` in the browser. `rag-agent` still runs as the internal analysis service.

## Local Setup

### rag-agent

```bash
cd rag-agent
cp .env.example .env
npm install
npm start
```

Default URL: `http://localhost:3000`

After copying `.env.example`, edit `rag-agent/.env`:

```bash
API_KEY=your_real_api_key
BASE_URL=https://your-openai-compatible-api.example.com/v1
MODEL=your_model_name
MAX_TOKENS=2048
TEMPERATURE=0.7
TOP_K_CHUNKS=3
CHUNK_SIZE=500
CHUNK_OVERLAP=50
PORT=3000
TIMEOUT=60000
INDEX_FILE=./index.json
```

### Story-game

```bash
cd Story-game
cp .env.example .env
npm install
npm start
```

Default URL: `http://localhost:3002`

After copying `.env.example`, edit `Story-game/.env`:

```bash
API_KEY=your_real_api_key
BASE_URL=https://your-openai-compatible-api.example.com/v1
MODEL=your_model_name
MAX_TOKENS=2048
TEMPERATURE=0.8
PORT=3002
RAG_AGENT_URL=http://localhost:3000
```

Important: the current `Story-game` frontend also loads `Story-game/config.js` in the browser. For local testing, keep it as a placeholder or replace it only with a temporary test key. Do not put production API keys in browser code.

## Run Order

Start `rag-agent` first, then start `Story-game`.

```bash
cd rag-agent
npm start
```

In a second terminal:

```bash
cd Story-game
npm start
```

Open `http://localhost:3002` for the story UI. The RAG service should remain running at `http://localhost:3000`.

## Generated Files

- `Story-game/story_bible/`: generated story bible JSON files.
- `Story-game/story_runs/`: generated story run JSON files for testing and review.
- `rag-agent/uploads/`: uploaded source documents and cleaned text versions.
- `rag-agent/chapters/`: extracted character profile files.
- `rag-agent/index.json`: generated local index.

## Notes

- Do not commit `.env`, uploaded novels, generated indexes, generated story bibles, or generated story runs.
- `rag-agent/.env.example` and `Story-game/.env.example` are templates. Copy them to `.env` and replace placeholders locally.
- For production, proxy LLM calls through the server instead of exposing API keys in browser code.
