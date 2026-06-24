const configuredBaseUrl = process.env.NEXT_PUBLIC_API_URL?.trim();
const BASE_URL =
  configuredBaseUrl?.replace(/\/+$/, "") ||
  (process.env.NODE_ENV === "development"
    ? "http://localhost:8000"
    : "https://smartexports-api.onrender.com");

// ── Types ──────────────────────────────────────────────────────────────────

export type RiskLevel = "Safe" | "Risky" | "Unclear";
export type Confidence = "high" | "medium" | "low";

export interface CheckResult {
  fertilizer: string;
  crop: string;
  risk_level: RiskLevel;
  explanation: string;
  next_step: string;
  alternative_product: string | null;
  evidence: {
    regulatoryHits: any[];
    rejectionHits: any[];
    organicHits: any[];
  };
  matched_via: string;
}

export interface ExtractLabelResult {
  product_name: string | null;
  possible_ingredients: string[];
  confidence: Confidence;
  raw_model_output: string;
}

export interface EscalateResult {
  status: string;
  message: string;
}

// ── API calls ──────────────────────────────────────────────────────────────

export async function checkFertilizer(
  fertilizer_name: string,
  crop_name: string
): Promise<CheckResult> {
  const res = await fetch(`${BASE_URL}/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fertilizer_name, crop_name }),
  });

  if (res.status === 404) {
    throw new NotFoundError("Product not found in dataset.");
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Something went wrong. Please try again.");
  }

  return res.json();
}

export async function extractLabel(file: File): Promise<ExtractLabelResult> {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(`${BASE_URL}/extract-label`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Label extraction failed. Try entering the name manually.");
  }

  return res.json();
}

export async function escalate(
  fertilizer_name: string,
  crop_name: string,
  farmer_contact?: string,
  notes?: string
): Promise<EscalateResult> {
  const res = await fetch(`${BASE_URL}/escalate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fertilizer_name, crop_name, farmer_contact, notes }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Escalation failed. Please try again.");
  }

  return res.json();
}

// ── Custom errors ──────────────────────────────────────────────────────────

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
