// SmartExports API client — fully typed against api/main.py
// Base URL is overridable via VITE_SMARTEXPORTS_API for local dev.

export const API_BASE =
  cleanBaseUrl(import.meta.env.VITE_SMARTEXPORTS_API as string | undefined) ??
  (import.meta.env.DEV ? "http://localhost:8000" : "https://smartexports-api.onrender.com");

function cleanBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : undefined;
}

export type RiskLevel = "Safe" | "Risky" | "Unclear";

export interface ResultCard {
  fertilizer: string;
  crop: string;
  risk_level: RiskLevel;
  explanation: string;
  next_step: string;
  alternative_product?: string | null;
  evidence: Record<string, unknown>;
  matched_via: string;
}

export interface ExtractLabelResponse {
  product_name: string | null;
  possible_ingredients?: string[];
  confidence: string;
  raw_model_output: string;
}

export class ApiError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

export class NetworkError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

async function parseError(res: Response): Promise<never> {
  let detail = `Request failed (${res.status})`;
  try {
    const data = await res.json();
    if (typeof data?.detail === "string") detail = data.detail;
    else if (data?.detail) detail = JSON.stringify(data.detail);
  } catch {
    /* ignore */
  }
  throw new ApiError(res.status, detail);
}

// Render free-tier cold starts can take 30s+. We retry once on transient
// network/5xx with a longer cap, surfacing "waking up" via onSlow callback.
export interface RequestOptions {
  signal?: AbortSignal;
  // Called when the request crosses the slow threshold (likely cold start).
  onSlow?: () => void;
}

interface InternalOpts extends RequestOptions {
  timeoutMs?: number;
  slowAfterMs?: number;
}

async function request(
  path: string,
  init: RequestInit,
  opts: InternalOpts = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const slowAfterMs = opts.slowAfterMs ?? 6_000;
  const attempt = async (timeout: number): Promise<Response> => {
    const controller = new AbortController();
    const userSignal = opts.signal;
    if (userSignal) {
      if (userSignal.aborted) controller.abort(userSignal.reason);
      else
        userSignal.addEventListener("abort", () => controller.abort(userSignal.reason), {
          once: true,
        });
    }
    const timeoutId = setTimeout(
      () => controller.abort(new DOMException("Timeout", "TimeoutError")),
      timeout,
    );
    const slowId = opts.onSlow ? setTimeout(() => opts.onSlow?.(), slowAfterMs) : null;
    try {
      return await fetch(`${API_BASE}${path}`, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
      if (slowId) clearTimeout(slowId);
    }
  };

  try {
    const res = await attempt(timeoutMs);
    // Retry once on 502/503/504 (Render warming up).
    if ([502, 503, 504].includes(res.status)) {
      opts.onSlow?.();
      return await attempt(timeoutMs);
    }
    return res;
  } catch (e) {
    if (opts.signal?.aborted) throw e; // user cancelled
    // One retry for network errors / timeout (cold start).
    opts.onSlow?.();
    try {
      return await attempt(timeoutMs);
    } catch (e2) {
      throw new NetworkError(
        "Could not reach the server. Check your connection and try again.",
        e2,
      );
    }
  }
}

export async function checkFertilizer(
  input: { fertilizer_name: string; crop_name: string },
  opts: RequestOptions = {},
): Promise<ResultCard> {
  const res = await request(
    "/check",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
    opts,
  );
  if (!res.ok) await parseError(res);
  return res.json();
}

export async function extractLabel(
  file: File,
  opts: RequestOptions = {},
): Promise<ExtractLabelResponse> {
  const form = new FormData();
  form.append("file", file);
  const res = await request(
    "/extract-label",
    { method: "POST", body: form },
    { ...opts, timeoutMs: 60_000, slowAfterMs: 8_000 },
  );
  if (!res.ok) await parseError(res);
  return res.json();
}

export async function escalate(
  input: {
    fertilizer_name: string;
    crop_name: string;
    farmer_name?: string;
    farmer_contact?: string;
    farmer_county?: string;
    risk_level?: RiskLevel;
    substances?: string[];
    notes?: string;
  },
  opts: RequestOptions = {},
): Promise<{ ok: boolean; ticket: string }> {
  // Client-generated ticket reference (backend doesn't return one yet).
  const ticket = makeTicket();
  const payload = { ...input, notes: input.notes ? `[${ticket}] ${input.notes}` : `[${ticket}]` };
  const res = await request(
    "/escalate",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    opts,
  );
  if (!res.ok) await parseError(res);
  await res.json().catch(() => undefined);
  return { ok: true, ticket };
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

function makeTicket(): string {
  // Compact, human-readable, low collision: SX-XXXXXX (base32 of random+time).
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/1/O/I/L
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
  return `SX-${out}`;
}

// Kenyan export-bound crops commonly screened.
export const COMMON_CROPS = [
  "Tea",
  "Coffee",
  "Avocado",
  "Macadamia",
  "French Beans",
  "Snow Peas",
  "Mango",
  "Cut Flowers",
  "Passion Fruit",
  "Pineapple",
] as const;

// Kenyan counties — used to match an escalation to the right local expert.
// Kept in sync with dashboard/src/lib/experts.ts (KENYA_COUNTIES).
export const KENYA_COUNTIES = [
  "Baringo", "Bomet", "Bungoma", "Busia", "Elgeyo-Marakwet", "Embu", "Garissa", "Homa Bay",
  "Isiolo", "Kajiado", "Kakamega", "Kericho", "Kiambu", "Kilifi", "Kirinyaga", "Kisii",
  "Kisumu", "Kitui", "Kwale", "Laikipia", "Lamu", "Machakos", "Makueni", "Mandera",
  "Marsabit", "Meru", "Migori", "Mombasa", "Murang'a", "Nairobi", "Nakuru", "Nandi",
  "Narok", "Nyamira", "Nyandarua", "Nyeri", "Samburu", "Siaya", "Taita-Taveta", "Tana River",
  "Tharaka-Nithi", "Trans Nzoia", "Turkana", "Uasin Gishu", "Vihiga", "Wajir", "West Pokot",
] as const;

// ── Masumi agent protocol ─────────────────────────────────────────────────────

export interface MasumiReceipt {
  receipt_id: string;
  agent_id: string;
  network: string;
  wallet: string;
  price_lovelace: number;
  payment_token: string;
  sandbox: boolean;
  validated_at: number;
  protocol: string;
}

export interface MasumiResultCard extends ResultCard {
  masumi_receipt: MasumiReceipt;
}

/**
 * Call the Masumi-protocol /masumi/check endpoint.
 * In sandbox mode (no real wallet configured) any paymentToken value works,
 * including undefined — the receipt will be marked sandbox: true.
 */
export async function checkFertilizerMasumi(
  input: { fertilizer_name: string; crop_name: string },
  paymentToken?: string,
  opts: RequestOptions = {},
): Promise<MasumiResultCard> {
  const res = await request(
    "/masumi/check",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fertilizer_name: input.fertilizer_name,
        crop_name: input.crop_name,
        masumi_payment_token: paymentToken ?? null,
      }),
    },
    opts,
  );
  if (!res.ok) await parseError(res);
  return res.json();
}

/**
 * Fetch the Masumi agent card — pricing, capabilities, wallet address.
 * External platforms call this to discover the SmartExports agent.
 */
export async function getMasumiAgentCard(): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/masumi/agent-card`);
  if (!res.ok) throw new ApiError(res.status, "Could not fetch Masumi agent card");
  return res.json();
}
