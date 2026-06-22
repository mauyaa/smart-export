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
- **CI/CD:** GitHub Actions (13 smoke tests on every push)

## API Endpoints
| Endpoint | Purpose |
|---|---|
| `POST /check` | Risk verdict for a fertilizer + crop |
| `POST /extract-label` | Extract product name from label photo |
| `POST /escalate` | Log unknown products for expert review |
| `GET /health` | Service liveness check |

## Team
- Byorder Mochache — Neo4j + Backend
- Bevan Mauya — Product Design
- Bernice Wakarindi — Backend
- Michael Maina — Frontend
- Lilian Kwamboka — Research
