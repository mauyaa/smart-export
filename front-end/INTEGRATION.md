# SmartExports — Frontend ↔ Backend Integration Guide

This is the operational handbook for the SmartExports frontend. It explains exactly how the UI joins the FastAPI service, which contract each screen depends on, and the design intent behind every visible element so anyone on the team can change it without breaking the system.

**Backend repo:** [`mauyaa/smart-export`](https://github.com/mauyaa/smart-export) — FastAPI in `api/`, Cypher in `cypher/`, pytest smoke suite in `tests/`, CI in `.github/workflows/`. Live at <https://smartexports-api.onrender.com> · OpenAPI: <https://smartexports-api.onrender.com/docs>.

---

## 1. Architecture at a glance

```
┌──────────────────────────────┐                     ┌─────────────────────────────┐
│  SmartExports Frontend       │   HTTPS / JSON      │  smartexports-api.onrender  │
│  TanStack Start · React 19   │ ──────────────────▶ │  FastAPI · Python           │
│  Tailwind v4 · Inter+Serif   │ ◀────────────────── │  Rate-limited (30/min)      │
│  PWA-installable             │                     │  CORS-restricted            │
└──────────────────────────────┘                     └───────────────┬─────────────┘
                                                                     │
                                            ┌────────────────────────┴────────────────────────┐
                                            │ Neo4j AuraDB (GraphRAG: substances, rules,      │
                                            │ rejections) + Featherless LLMs (Qwen3-VL OCR,   │
                                            │ Llama 3.1 grounded explanation).                │
                                            └─────────────────────────────────────────────────┘
```

Single source of truth for the API base URL:

```ts
// src/lib/api.ts
export const API_BASE =
  cleanBaseUrl(import.meta.env.VITE_SMARTEXPORTS_API) ??
  (import.meta.env.DEV ? "http://localhost:8000" : "https://smartexports-api.onrender.com");
```

Override by setting `VITE_SMARTEXPORTS_API` when a non-default API host is needed.

---

## 2. Endpoint map — exactly what the UI calls

All requests live in `src/lib/api.ts`. Each is typed against the live OpenAPI schema and throws a typed `ApiError(status, detail)` on non-2xx.

| Screen      | Function            | Method · Path         | Request                                                       | Response                                  | Server rate limit |
| ----------- | ------------------- | --------------------- | ------------------------------------------------------------- | ----------------------------------------- | ----------------- |
| Capture     | `extractLabel(f)`   | `POST /extract-label` | `multipart/form-data { file: image }` (JPEG/PNG/WEBP, ≤20 MB) | `ExtractLabelResponse`                    | 10 / min / IP     |
| Confirm/Run | `checkFertilizer`   | `POST /check`         | `{ fertilizer_name, crop_name }`                              | `ResultCard` (server-cached 30 min)       | 10 / min / IP     |
| Escalate    | `escalate(payload)` | `POST /escalate`      | `{ fertilizer_name, crop_name, farmer_contact?, notes? }`     | `{ status: "received", message: string }` | 5 / min / IP      |
| (boot)      | `checkHealth()`     | `GET /health`         | —                                                             | `{ status: "ok" }` → `true`               | global 30 / min   |

Global cap is `30/minute/IP` (slowapi). Server also caches `/check` responses for 30 min keyed on `(resolved_fertilizer, crop)` — back-to-back identical checks skip Neo4j + LLM.

### Response shapes used by the UI

```ts
type RiskLevel = "Safe" | "Risky" | "Unclear";

interface ResultCard {
  fertilizer: string;
  crop: string;
  risk_level: RiskLevel;
  explanation: string; // LLM-grounded plain-language paragraph (Llama 3.1)
  next_step: string; // server-mapped from risk_level
  alternative_product: string | null; // only set when risk_level === "Risky"
  evidence: Record<string, unknown>; // graph path (debug/audit, not shown)
  matched_via: "exact" | string; // "fuzzy:<typed>" if name was corrected
}

interface ExtractLabelResponse {
  product_name: string | null; // null when vision model can't read the label
  possible_ingredients?: string[]; // surfaced as muted chips on the Confirm screen
  confidence: "high" | "medium" | "low";
  raw_model_output: string; // kept for debugging — not rendered
}

interface EscalateResponse {
  status: "received";
  message: string;
}
```

The vision model is configurable on the backend via `FEATHERLESS_VISION_MODEL` (default `google/gemma-3-27b-it`); the explanation model via `FEATHERLESS_MODEL` (default `meta-llama/Meta-Llama-3.1-8B-Instruct`). Swapping either does not change the wire contract above.

### Error contract

| Status          | UI behavior                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 200             | happy path                                                                                                                                                   |
| 400             | `/extract-label` only → unsupported MIME or >20 MB; client-side compression keeps real users under both caps                                                 |
| 404             | `/check` only → app auto-routes to the **Escalate** screen with the same product+crop pre-filled                                                             |
| 429             | rate-limited (`/check` 10/min, `/escalate` 5/min, `/extract-label` 10/min, global 30/min); the server's `detail` is shown inline in red on the source screen |
| 502/503/504     | gateway / Neo4j / Featherless unavailable; client **auto-retries once** with the "waking up" copy surfaced                                                   |
| timeout/offline | `NetworkError` thrown; localized "Could not reach the server" banner with retry                                                                              |
| other           | localized generic error ("Something went wrong. Please retry.")                                                                                              |

### Resilience layer (`src/lib/api.ts`)

Every API call goes through a single `request()` helper that adds:

- **AbortSignal piping** — every call accepts a `signal` from the screen so the in-flight fetch is cancelled when the user hits Back, Retake, or Start over. The UI keeps a `Set<AbortController>` of in-flight requests and aborts them all on transition.
- **Per-call timeout** — `/check` and `/escalate` cap at 45s, `/extract-label` at 60s (OCR is slower). A timeout becomes a `DOMException("TimeoutError")` and triggers the same retry path as a network failure.
- **One automatic retry** on transient failure (5xx gateway codes or network/timeout). A second failure is wrapped in `NetworkError` so the UI can show a friendly message instead of "Failed to fetch".
- **`onSlow` callback** — fires after 6s (8s for OCR). The UI uses this to surface "Server is waking up — first check of the day takes a bit longer." on Render free-tier cold starts.

### Image compression (`src/lib/image.ts`)

Phone photos are 3–8 MB raw. Before `extractLabel()` is called, `compressImage()` runs client-side:

- Skips files under 500 KB and non-images (returned untouched).
- Downscales the long edge to **1600 px**, re-encodes as JPEG at **quality 0.85** using `OffscreenCanvas` when available, falling back to a `<canvas>` element.
- Returns the original file if compression would make it larger or fails for any reason — never blocks the user.

Net effect on a 3G connection: ~20s upload → ~2s upload, and the preview thumbnail matches exactly what the server sees.

### Live camera + torch (`src/lib/camera.ts`)

The Capture screen runs a live `getUserMedia` preview when the browser allows it. Frame is grabbed straight from the `<video>` element to a JPEG via `<canvas>` (quality 0.92) and handed to the same `compressImage()` → `extractLabel()` pipeline as a file upload.

- **Rear camera** is requested with `facingMode: { ideal: "environment" }`.
- **Torch toggle** is shown only when `track.getCapabilities().torch === true` (Chrome on Android, most modern phones). Toggling calls `applyConstraints({ advanced: [{ torch }] })`. iOS Safari hides the torch API entirely — the button just won't render there.
- If permission is denied or the API is missing, the screen falls back to the native file-input flow (`<input type="file" capture="environment">`) without breaking.
- The stream is stopped on Back, Close, Capture, and unmount. No camera light is ever left on.

### Recent checks (`src/lib/history.ts`)

Each successful `/check` writes a `{ product, crop, risk, ts }` record to `localStorage.smartexports.history.v1`, deduped on `(product, crop)`, capped to 10 entries. The Intro screen lists them under a "Recently checked" divider; tapping one skips Capture/Confirm and re-runs the check (useful when a farmer wants to verify the same product against a different batch). Cleared with one tap; no PII.

### Telemetry (`src/lib/telemetry.ts`)

A single `trackEvent(name, data?)` chokepoint:

- **Always** appends to a ring buffer in `localStorage.smartexports.events` (capped at 200). Field teams can `JSON.parse(localStorage.smartexports.events)` on a farmer's phone to reconstruct exactly what happened.
- **Optionally** POSTs each event via `navigator.sendBeacon` to `VITE_SMARTEXPORTS_ANALYTICS` if it's set (any endpoint that accepts `application/json`).
- Payloads are a strict whitelist — `crop`, `risk`, `matched_via`, `status`, `reason`, `lang`, `ok`. **Never** raw product names, contact details, or photos.
- Events covered: `app_open`, `lang_switch`, `capture_open_camera`, `capture_torch_toggle`, `capture_upload_file`, `ocr_success`/`ocr_empty`/`ocr_error`, `check_submit`/`check_result`/`check_not_found`/`check_error`, `escalate_submit`/`escalate_done`, `share_whatsapp`, `history_open`.

### Escalation receipts

`escalate()` generates a client-side ticket reference (`SX-XXXXXX`, Crockford base32, ~1 in a billion collision) and prepends it to `notes` so it's stored alongside the case in the backend. The Done screen shows the ticket in a bordered card with a copy button — the user has something concrete to quote when they follow up. When the backend adds a server-side ticket field, swap `makeTicket()` for the server value with no UI change.

---

## 3. UI state machine

One screen at a time, mobile-first (≤440px column). Transitions and the API calls that drive them:

```
        ┌──────────┐  Start  ┌──────────┐  photo    ┌──────────┐  /check 200  ┌──────────┐
        │  intro   │ ──────▶ │ capture  │ ────────▶ │ confirm  │ ───────────▶ │  result  │
        └──────────┘         └──────────┘  /extract │          │              └────┬─────┘
              ▲                    │       -label   │          │  /check 404       │ flag
              │                    │ back           │          │ ──────────┐       │
              │ start over         └────────────────┘          │           ▼       │
              │                                                │      ┌──────────┐ │
              └────────────────────────────────────────────────┴────▶ │ escalate │◀┘
                                                                      └──────────┘
                                                                            │ /escalate 200
                                                                            ▼
                                                                       "Sent." → Done → intro
```

All state lives in `SmartExportsApp` in `src/routes/index.tsx`. There is no global store — every transition is a single `setStep()` and the data needed by the next screen is already in component state.

---

## 4. Screen-by-screen intent

Every screen follows the principles in the design brief: **isolation** (one focus), **one accent** (clay-orange `--primary`), **golden-ratio tension** (off-balance serif headline + grotesk body), **denoise** (no decorative chrome).

### 01 · Intro

- **Goal:** answer "what does this thing do?" in one glance.
- **Composition:** single large serif headline with `EU-safe` italicized in the accent color (the page's one accent). Three numbered bullets (①②③) replace the usual three-card grid — fewer borders, more focus.
- **CTA:** single black pill, no secondary CTA (deliberate).

### 02 · Capture

- **Goal:** make the camera the only thing on screen.
- **Composition:** a 4:5 dashed frame at golden-ratio height, with `frameHint` centered. Hidden `<input type="file" accept="image/*" capture="environment">` opens the native rear camera on phones; a discreet gallery fallback lives under the primary CTA.

### 03 · Confirm

- **Goal:** verify the OCR result before spending a `/check` call.
- **Composition:** thumbnail of the photo + an editable serif text field for `product_name`. Below it, `possible_ingredients` from the OCR appear as muted chips (no action — they are evidence, not selectors). Crop is picked from `COMMON_CROPS` chips that snap to ink-on-paper when selected. The primary CTA is disabled until both are present.

### Loading

- **Goal:** keep the user oriented during a 2–6s round trip.
- **Composition:** a single pulsing dot (the one accent) and four sequential progress lines reflecting the actual server pipeline (resolve name → match → search rejections → compose verdict).

### 04 · Verdict

- **Goal:** make the risk level legible in 0.5s.
- **Composition:** a color-coded card (`Safe` moss / `Risky` clay-red / `Unclear` mustard) with the verdict word set in 64px serif. The explanation (LLM, grounded on `evidence_path`) sits directly under it. Then `next_step`, optional `alternative_product`, and a `matched_via` badge (so users know if their spelling was auto-corrected).
- **Actions:** check another · share on WhatsApp (deep link `https://wa.me/?text=...` so the verdict spreads farmer-to-farmer) · flag for expert review.

### Escalate

- **Goal:** never dead-end on a `/check` 404.
- **Composition:** product+crop are carried over from the previous step; contact and notes are optional. Success state replaces the form with a single moss check mark and a thank-you sentence.

---

## 5. Design system

All tokens live in `src/styles.css`. Components reference semantic Tailwind classes only (`bg-background`, `text-foreground`, `bg-primary`, `text-[color:var(--safe)]`); there are **no** hardcoded hex values in components, so dark mode and theming work for free.

| Token       | Light value (oklch) | Role                            |
| ----------- | ------------------- | ------------------------------- |
| `--paper`   | `0.972 0.012 85`    | App background (warm off-white) |
| `--ink`     | `0.18 0.012 70`     | Foreground text                 |
| `--primary` | `0.55 0.16 38`      | The one accent — clay-orange    |
| `--safe`    | `0.42 0.10 150`     | Safe verdict                    |
| `--risky`   | `0.50 0.20 28`      | Risky verdict                   |
| `--unclear` | `0.62 0.14 70`      | Unclear verdict                 |

Type pairing: **Instrument Serif** (italics carry every emphasis) + **Inter** (everything else). Loaded once in `src/routes/__root.tsx` via Google Fonts with `preconnect`. Both have a matching dark-mode triplet defined under `.dark`.

Reserved utilities (`paper-grain`, `hairline`, `animate-fade-up`, `animate-pulse-ring`) live at the bottom of `styles.css` and are used sparingly — denoise discipline.

---

## 6. Internationalization

`src/lib/i18n.tsx` exposes a typed `LanguageProvider` + `useI18n()` hook with English and Swahili dictionaries. The selected language is persisted in `localStorage` under `smartexports.lang` and auto-detected from `navigator.language` on first visit. The header toggle (`EN / SW`) switches instantly without a reload. Add a new locale by:

1. Adding a fully-typed `Dict` object in `src/lib/i18n.tsx`.
2. Adding it to `DICTS` and the `Lang` union.
3. Adding a toggle entry in the `TopBar`.

No string in the UI is hardcoded — every visible piece of copy goes through `t.*`.

---

## 7. PWA / Installability

`public/manifest.webmanifest` + `public/app-icon.png` (512×512, maskable). Linked from `__root.tsx` along with `apple-touch-icon` and `theme-color`. This is **manifest-only** — there is no service worker, so the app does not pretend to work offline. On Android Chrome the install prompt shows automatically after engagement; on iOS Safari, "Add to Home Screen" works because the manifest and apple touch icon are present.

To add true offline behavior later, follow the project's PWA skill and wire `vite-plugin-pwa` with `generateSW`. Do not hand-roll a service worker.

---

## 8. SEO & metadata

- `__root.tsx` defines the global title, description, OG + Twitter cards, theme color, manifest link, and apple touch icon.
- `routes/index.tsx` overrides title + description for the home route. Both are localized in spirit (English copy is the canonical entry point for search engines; the in-app toggle handles users).
- Viewport uses `viewport-fit=cover` so the design respects the iOS notch.
- `public/robots.txt` allows all crawlers and points to `/sitemap.xml`.
- `src/routes/sitemap[.]xml.ts` is a TanStack server route emitting a valid `urlset`. Add new public routes to its `entries` array. `BASE_URL` is intentionally empty until a custom domain is set — relative URLs validate correctly in most tools.

---

## 9. Local development

```bash
# install
bun install

# run against the local FastAPI instance
bun dev

# run against the live API explicitly
VITE_SMARTEXPORTS_API=https://smartexports-api.onrender.com bun dev

# build
bun run build
```

The dev server prints `http://localhost:8080`. The backend's default `CORS_ORIGINS` includes `localhost:8080`, `localhost:5173`, and the Next.js prototype origin `localhost:3000`, so the canonical frontend can talk to a local API without extra CORS configuration. For local frontend dev against the live API, make sure Render's `CORS_ORIGINS` includes `http://localhost:8080`, the deployed frontend origin, and any custom domain.

The backend re-reads `CORS_ORIGINS` at boot — Render redeploys automatically when the env var changes.

To run the backend locally end-to-end:

```bash
git clone https://github.com/mauyaa/smart-export.git
cd smart-export
cp api/.env.example api/.env   # fill NEO4J_*, FEATHERLESS_API_KEY
pip install -r api/requirements.txt
uvicorn api.main:app --reload --port 8000
```

Then in this repo: `bun dev`.

---

## 10. Shipping & deployment

**Backend** — already live on Render at `https://smartexports-api.onrender.com`, auto-deploys from `main` on `mauyaa/smart-export`. CI (`.github/workflows/ci.yml`) runs the pytest smoke suite on every push. Free tier cold-starts after ~15 min idle; the frontend's `onSlow` retry copy is designed for that.

**Frontend** — this Lovable project is the canonical source. The Lovable ↔ GitHub integration creates a fresh repo (e.g. `mauyaa/smart-export-frontend`) and syncs `main` two-ways. It cannot push into the existing non-empty `mauyaa/smart-export`. Two viable layouts:

1. **Two repos (recommended)** — keep `mauyaa/smart-export` for the API and let Lovable manage `mauyaa/smart-export-frontend`. CORS allow-list joins them. This preserves continuous sync from Lovable.
2. **Monorepo merge** — clone the Lovable repo and `rsync` the source into `mauyaa/smart-export/frontend/`. This breaks Lovable sync; only do it if active Lovable iteration is finished.

   ```bash
   rsync -a --exclude='.git' --exclude='node_modules' --exclude='dist' \
     ./ ../smart-export/frontend/
   ```

Hosting targets that work out of the box for the built frontend: Cloudflare Pages (default Lovable publish target), Vercel, Netlify, or any static host fed by `bun run build`. TanStack Start emits a prerendered SSR-friendly bundle.

---

## 11. File map (what lives where)

```
src/
├── lib/
│   ├── api.ts              # typed client + retry/abort/timeout + COMMON_CROPS + makeTicket
│   ├── camera.ts           # getUserMedia rear-camera session + torch toggle + frame capture
│   ├── history.ts          # localStorage recent-checks store (capped, deduped, no PII)
│   ├── image.ts            # client-side downscale + JPEG recompression for uploads
│   ├── telemetry.ts        # event ring buffer + optional sendBeacon to VITE_SMARTEXPORTS_ANALYTICS
│   └── i18n.tsx            # LanguageProvider, dictionaries (en / sw)
├── routes/
│   ├── __root.tsx          # html shell, fonts, manifest, OG meta, providers
│   ├── index.tsx           # full SmartExports app: state machine + 6 screens
│   └── sitemap[.]xml.ts    # /sitemap.xml server route
├── styles.css              # design tokens (oklch), risk palette, utilities
└── router.tsx              # TanStack Start bootstrap (untouched)

public/
├── manifest.webmanifest    # PWA manifest (display: standalone)
├── robots.txt              # Allow: / + sitemap pointer
└── app-icon.png            # 512×512 maskable icon
```

That's the whole frontend. Anything else you want it to do (offline queue, server-side history, Swahili voice prompts, a map of last-mile co-op offices) hooks cleanly into the same primitives: add a screen to the state machine, a key to the dictionary, an event in `telemetry.ts`, and — if it needs the backend — a typed function in `lib/api.ts`.

---

## 12. Codex / agent prompt — connect the two repos & deploy

Drop this verbatim into Codex (or any coding agent) when you want it to wire the Lovable-synced frontend repo to `mauyaa/smart-export` and ship both to production. It assumes the agent has shell access, network egress, and write access to both repos plus the Render and Cloudflare/Vercel dashboards (or environment-variable equivalents).

> **Role.** You are a release engineer for SmartExports. Two repos exist:
> – **Backend:** `https://github.com/mauyaa/smart-export` — FastAPI in `api/`, Cypher in `cypher/`, pytest in `tests/`, GitHub Actions CI, deployed on Render at `https://smartexports-api.onrender.com`.
> – **Frontend:** the Lovable-managed repo for SmartExports (TanStack Start v1 + React 19 + Tailwind v4, bun). Wire shape in `INTEGRATION.md`.
>
> **Goal.** Make the frontend talk to the live backend in production, the preview, and local dev, then publish the frontend. Do not modify backend business logic, Cypher, or LLM prompts.
>
> **Tasks, in order.**
>
> 1. Clone both repos. Read `INTEGRATION.md` and `api/main.py` end-to-end before editing. Confirm the four endpoints (`POST /check`, `POST /extract-label`, `POST /escalate`, `GET /health`) match `src/lib/api.ts` types exactly — including the `escalate` response shape `{ status: "received", message: string }`, the `ExtractLabelResponse.confidence` enum `"high"|"medium"|"low"`, the 20 MB / JPEG-PNG-WEBP limit, and the per-route rate limits (10/10/5/min, global 30/min). If anything drifts, update `src/lib/api.ts` to match the backend, not the other way around.
> 2. In `mauyaa/smart-export` open `api/.env.example` and `api/main.py`. Verify `CORS_ORIGINS` includes, comma-separated: `http://localhost:8080`, the Lovable preview origin `https://id-preview--<project-id>.lovable.app`, the published Lovable origin (e.g. `https://smart-export.lovable.app`), and any configured custom domain. If missing, open a PR adding them to `.env.example` AND set the same value on Render → Environment for the `smartexports-api` service. Trigger a redeploy and wait for `/health` to return `{"status":"ok"}`.
> 3. In the frontend repo, ensure `VITE_SMARTEXPORTS_API` is **unset in production** (it defaults to `https://smartexports-api.onrender.com`). For local dev document `VITE_SMARTEXPORTS_API=http://localhost:8000` in `.env.local.example`. Do not commit any real secrets — the frontend has none.
> 4. Run the contract probe locally before publishing:
>    ```bash
>    bun install
>    bun run build           # must succeed
>    bunx tsgo --noEmit      # strict TS, must succeed
>    curl -sf https://smartexports-api.onrender.com/health
>    curl -sf -X POST https://smartexports-api.onrender.com/check \
>      -H 'content-type: application/json' \
>      -d '{"fertilizer_name":"Urea","crop_name":"maize"}' | jq .risk_level
>    ```
>    First `/check` may take ~30 s on a cold Render dyno — that is expected; the UI's `onSlow` copy covers it. If `curl` returns CORS-blocked from a browser, jump back to step 2.
> 5. Smoke-test the live UI from a headless browser against `http://localhost:8080`: open the app, upload a sample label image to Capture, confirm the OCR result populates Confirm, run `/check` for `(Urea, maize)`, then submit an Escalate from a forced-404 product like `zzz-not-real`. Capture screenshots into `/tmp/smartexports-smoke/` and attach them to the PR description.
> 6. Publish the frontend. If using Lovable: click Publish (or call the publish tool) — Lovable handles Cloudflare Pages. If using Vercel/Netlify/Cloudflare manually: `bun run build`, then deploy `dist/` to the chosen target. Confirm the published origin is in `CORS_ORIGINS` before announcing the URL.
> 7. Post-deploy verification: hit the published URL, run the same Capture → Confirm → Check → Escalate flow, and `JSON.parse(localStorage["smartexports.events"])` to confirm telemetry events fire (`app_open`, `ocr_success`, `check_result`, `escalate_done`). Open a PR titled `chore(release): wire frontend ↔ smartexports-api` against the Lovable-synced frontend repo with the screenshots, the `curl` outputs, and a one-paragraph summary.
>
> **Guardrails.**
> – Never hardcode hex colors, fonts, or copy in components — go through tokens in `src/styles.css` and the `t.*` dictionary in `src/lib/i18n.tsx`.
> – Do not introduce `useEffect + fetch` for initial render; the existing client uses an abortable `request()` helper — extend it instead of bypassing it.
> – Do not push into `mauyaa/smart-export`'s root from the frontend repo. Backend changes (e.g. CORS) go through the backend repo's PR flow.
> – Keep secrets server-side. `FEATHERLESS_API_KEY` and `NEO4J_PASSWORD` live only on Render. The frontend has zero credentials.
> – If a step fails, stop and report — do not paper over a broken contract by mutating the UI.
