# SmartExports

AI-powered fertilizer EU compliance risk checker for Kenyan smallholder farmers.

![CI](https://github.com/mauyaa/smart-export/actions/workflows/ci.yml/badge.svg)

## Live API
- **Base URL:** https://smartexports-api.onrender.com
- **Docs:** https://smartexports-api.onrender.com/docs

## What it does
A farmer photographs a fertilizer label → the system extracts the product name →
checks it against EU regulations and real rejection cases → returns a plain-language
Safe / Risky / Unclear verdict with a grounded explanation.

## Stack
- **Graph DB:** Neo4j AuraDB (GDS: Node Similarity + Degree Centrality)
- **Backend:** FastAPI + Python on Render
- **LLM:** Featherless (Qwen3-VL for vision OCR, Llama 3.1 for explanation)
- **Frontend:** TanStack Start + React in `front-end/` (canonical product UI)
- **CI/CD:** GitHub Actions (13 smoke tests on every push)

## API Endpoints
| Endpoint | Purpose |
|---|---|
| `POST /check` | Risk verdict for a fertilizer + crop |
| `POST /extract-label` | Extract product name from label photo |
| `POST /escalate` | Log unknown products for expert review |
| `GET /health` | Service liveness check |

## Frontend folders

There are two frontend folders in this checkout:

- `front-end/` is the production-ready SmartExports app. It includes the camera flow, OCR confirmation, crop selection, retries, recent checks, Swahili toggle, result sharing, and escalation receipts.
- `frontend/` is a smaller Next.js prototype kept for reference.

Use `front-end/` for development and Vercel deployment.

## Local full-stack run

The API now supports a local demo mode so the product can run without production secrets:

```bash
# terminal 1
cd api
python -m pip install -r requirements.txt
$env:SMARTEXPORTS_DEMO_MODE="true"
python -m uvicorn main:app --reload --port 8000

# terminal 2
cd front-end
npm install --no-package-lock
npm run dev
```

Open the frontend dev URL and check a sample product such as `Orthene 75SP` or `Muriate of Potash`. In development, `front-end/src/lib/api.ts` defaults to `http://localhost:8000`. In production, it defaults to `https://smartexports-api.onrender.com` unless `VITE_SMARTEXPORTS_API` is explicitly set.

For production GraphRAG behavior, copy `api/.env.example` to `api/.env`, set the real Neo4j and Featherless values, and set `SMARTEXPORTS_DEMO_MODE=false`.
