// Expert / dashboard API client and session helpers
export const API_BASE =
  (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_API_BASE) ||
  "https://smartexports-api.onrender.com";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

// Thrown when the request never reaches the server (offline, DNS, CORS, timeout).
export class NetworkError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "NetworkError";
    this.cause = cause;
  }
}


export interface Expert {
  id: string;
  name: string;
  email: string;
  organization?: string;
  bio?: string;
  cropTags?: string[];
  phone?: string;
}

export interface Escalation {
  id: string;
  farmerName: string | null;
  farmerPhone: string | null;
  farmerCounty: string | null;
  fertilizer: string;
  crop: string;
  riskLevel: "Safe" | "Risky" | "Unclear" | string;
  status: "pending" | "responded" | "resolved" | string;
  createdAt: string | null;
  explanation?: string | null;
  notes?: string | null;
}

const SESSION_KEY = "smartexports.expert";

export function getSession(): Expert | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Expert) : null;
  } catch {
    return null;
  }
}

export function setSession(expert: Expert) {
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(expert));
}

export function clearSession() {
  window.localStorage.removeItem(SESSION_KEY);
}

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      const d = await res.json();
      if (typeof d?.detail === "string") detail = d.detail;
    } catch { /* ignore */ }
    throw new ApiError(res.status, detail);
  }
  return res.json();
}

// Render's free tier cold-starts after idle periods, so a request can
// legitimately take several seconds the first time. RETRYABLE_STATUS covers
// the gateway errors that show up while the server is waking up.
const RETRYABLE_STATUS = new Set([502, 503, 504]);

interface RequestOptions extends RequestInit {
  /** Called once if the request is still in flight after `slowAfterMs`. */
  onSlow?: () => void;
  slowAfterMs?: number;
  /** Set false to disable the single automatic retry. Defaults to true. */
  retry?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { onSlow, slowAfterMs = 6000, retry = true, ...init } = options;

  const attempt = async (): Promise<Response> => {
    const slowTimer = onSlow ? setTimeout(onSlow, slowAfterMs) : undefined;
    try {
      return await fetch(`${API_BASE}${path}`, init);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      throw new NetworkError(
        "Could not reach the SmartExports server. Check your connection and try again.",
        err,
      );
    } finally {
      if (slowTimer) clearTimeout(slowTimer);
    }
  };

  let res: Response;
  try {
    res = await attempt();
  } catch (err) {
    if (retry && err instanceof NetworkError) {
      res = await attempt();
    } else {
      throw err;
    }
  }

  if (!res.ok && retry && RETRYABLE_STATUS.has(res.status)) {
    res = await attempt();
  }

  return parse<T>(res);
}

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
  phone: string;
  organization: string;
  county: string;
  crop_tags: string[];
  substance_tags: string[];
  bio?: string;
}

export interface CallOptions {
  signal?: AbortSignal;
  /** Called once if the request is still in flight after ~6s (e.g. Render cold start). */
  onSlow?: () => void;
}

export async function registerExpert(input: RegisterInput, opts: CallOptions = {}) {
  return request<{ status: string; expert_id: string; name: string; email: string }>(
    "/experts/register",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: opts.signal,
      onSlow: opts.onSlow,
    },
  );
}

export async function loginExpert(email: string, password: string, opts: CallOptions = {}) {
  return request<{ status: string; expert: Expert }>("/experts/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal: opts.signal,
    onSlow: opts.onSlow,
  });
}

export async function getEscalations(expertId: string, opts: CallOptions = {}): Promise<Escalation[]> {
  const data = await request<{ escalations: Escalation[] }>(`/experts/${expertId}/escalations`, {
    signal: opts.signal,
    onSlow: opts.onSlow,
  });
  return data.escalations ?? [];
}

export async function updateEscalationStatus(
  escalationId: string,
  status: "pending" | "responded" | "resolved",
  opts: CallOptions = {},
) {
  return request<{ id: string; status: string }>(
    `/escalations/${escalationId}/status?status=${status}`,
    { method: "PATCH", signal: opts.signal, onSlow: opts.onSlow },
  );
}

export const KENYA_COUNTIES = [
  "Baringo","Bomet","Bungoma","Busia","Elgeyo-Marakwet","Embu","Garissa","Homa Bay",
  "Isiolo","Kajiado","Kakamega","Kericho","Kiambu","Kilifi","Kirinyaga","Kisii",
  "Kisumu","Kitui","Kwale","Laikipia","Lamu","Machakos","Makueni","Mandera",
  "Marsabit","Meru","Migori","Mombasa","Murang'a","Nairobi","Nakuru","Nandi",
  "Narok","Nyamira","Nyandarua","Nyeri","Samburu","Siaya","Taita-Taveta","Tana River",
  "Tharaka-Nithi","Trans Nzoia","Turkana","Uasin Gishu","Vihiga","Wajir","West Pokot",
];

export const CROP_OPTIONS = [
  "Tea","Coffee","Avocado","Macadamia","French Beans","Snow Peas",
  "Mango","Cut Flowers","Passion Fruit","Pineapple","Maize","Horticulture",
];

export function riskClasses(level: string) {
  const l = (level || "").toLowerCase();
  if (l === "safe") return "bg-[color:var(--safe-soft)] text-[color:var(--safe)] border-[color:var(--safe)]/30";
  if (l === "risky") return "bg-[color:var(--risky-soft)] text-[color:var(--risky)] border-[color:var(--risky)]/30";
  return "bg-[color:var(--unclear-soft)] text-[color:var(--unclear)] border-[color:var(--unclear)]/30";
}

export function statusClasses(status: string) {
  const s = (status || "pending").toLowerCase();
  if (s === "resolved") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (s === "responded") return "bg-blue-50 text-blue-700 border-blue-200";
  return "bg-amber-50 text-amber-800 border-amber-200";
}
