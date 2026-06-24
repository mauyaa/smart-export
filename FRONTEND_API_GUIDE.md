# SmartExports — Frontend ↔ API Integration Guide

Quick reference for frontend developers wiring the TanStack Start app (`front-end/`) to the FastAPI backend.

## Base URL

The API client in `front-end/src/lib/api.ts` auto-selects the backend:

| Environment | Default URL | Override |
|---|---|---|
| `npm run dev` | `http://localhost:8000` | `VITE_SMARTEXPORTS_API` in `.env.local` |
| Production build | `https://smartexports-api.onrender.com` | `VITE_SMARTEXPORTS_API` env var at build time |

## Endpoints

### `POST /check`

Risk-check a fertilizer × crop pair.

**Request:**
```json
{
  "fertilizer_name": "Orthene 75SP",
  "crop_name": "French beans"
}
```

**Response (200):**
```json
{
  "fertilizer": "Orthene 75SP",
  "crop": "French beans",
  "risk_level": "Risky",
  "explanation": "Plain-language explanation grounded in evidence…",
  "next_step": "Avoid this product for export-bound crops…",
  "alternative_product": "Muriate of Potash",
  "evidence": {
    "regulatoryHits": [...],
    "rejectionHits": [...],
    "organicHits": [...]
  },
  "matched_via": "exact"
}
```

**Error (404):** Product not found → route user to `/escalate`.
**Error (503):** Backend temporarily unavailable (Neo4j or LLM down).

### `POST /extract-label`

Upload a fertilizer label photo for OCR extraction.

**Request:** `multipart/form-data` with field `file` (JPEG, PNG, or WEBP, max 20 MB).

**Response (200):**
```json
{
  "product_name": "Orthene 75SP",
  "possible_ingredients": ["Acephate"],
  "confidence": "medium",
  "raw_model_output": "..."
}
```

`product_name` may be `null` if OCR fails → prompt the user to type it manually.

### `POST /escalate`

Log an unknown product for expert review.

**Request:**
```json
{
  "fertilizer_name": "UnknownProduct",
  "crop_name": "Avocado",
  "farmer_contact": "+254…",
  "notes": "Optional context"
}
```

**Response (200):**
```json
{
  "status": "received",
  "message": "Your request has been logged for expert review…"
}
```

### `GET /health`

Liveness check. Returns `{"status": "ok"}`.

## Error Handling

The frontend API client (`api.ts`) provides two typed error classes:

- **`ApiError`** — server returned a non-OK status. Has `.status` (number) and `.detail` (string from the API error body).
- **`NetworkError`** — fetch failed entirely (offline, timeout, DNS). Has `.cause`.

The client also:
- **Retries once** on 502/503/504 and network errors (handles Render cold starts).
- **Calls `onSlow()`** when a request exceeds 6 seconds (lets UI show "server is waking up").
- **Supports `signal`** for `AbortController` cancellation.

## CORS

The backend allows these origins by default:
- `localhost:3000`, `localhost:5173`, `localhost:8080` (and `127.0.0.1` variants)
- `https://smart-export.vercel.app`, `https://smartexports.vercel.app`

Override with the `CORS_ORIGINS` environment variable on Render (comma-separated list).

## Rate Limits

| Endpoint | Limit |
|---|---|
| `/check` | 10/min per IP |
| `/extract-label` | 10/min per IP |
| `/escalate` | 5/min per IP |
| Global default | 30/min per IP |

## Demo Mode

Set `SMARTEXPORTS_DEMO_MODE=true` on the backend to run without Neo4j/Featherless credentials. The API returns canned results from 9 built-in products (Orthene 75SP, Thunder 145SC, Muriate of Potash, etc.). Frontend auto-connects to `localhost:8000` in dev mode.
