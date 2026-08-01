# Story Game RAG

This repository contains two cooperating local apps:

- `rag-agent/`: novel ingestion, indexing, character profile extraction, chapter summaries, and RAG retrieval.
- `Story-game/`: interactive fan-fiction story UI, story bible generation, and prompt orchestration.

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

Required fields:

- `API_KEY`: your LLM provider API key.
- `BASE_URL`: OpenAI-compatible API base URL, ending with `/v1`.
- `MODEL`: chat model used for chapter summaries, character extraction, and RAG answers.

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

Required fields:

- `API_KEY`: your LLM provider API key for local Story-game generation.
- `BASE_URL`: OpenAI-compatible API base URL, ending with `/v1`.
- `MODEL`: chat model used by the interactive story generator.
- `RAG_AGENT_URL`: internal URL of the local `rag-agent` service.

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

## Notes

- Do not commit `.env`, uploaded novels, generated indexes, generated story bibles, or generated story runs.
- `rag-agent/.env.example` and `Story-game/.env.example` are templates. Copy them to `.env` and replace placeholders locally.
- `Story-game/config.js` is a browser placeholder. Do not put production API keys in browser code; for production, proxy LLM calls through the server.
