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

### Story-game

```bash
cd Story-game
cp .env.example .env
npm install
npm start
```

Default URL: `http://localhost:3002`

## Notes

- Do not commit `.env`, uploaded novels, generated indexes, or generated story bibles.
- `Story-game/config.js` is a browser placeholder. For production, proxy LLM calls through the server instead of exposing API keys in the browser.

