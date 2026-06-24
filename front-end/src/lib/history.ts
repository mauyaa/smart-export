// Local-only history of recent checks. No backend, no PII — lives in
// localStorage so a farmer can re-open the app and see what they already
// asked about. Capped to 10 entries.

import type { RiskLevel } from "./api";

const KEY = "smartexports.history.v1";
const MAX = 10;

export interface HistoryEntry {
  ts: number;
  product: string;
  crop: string;
  risk: RiskLevel;
}

function read(): HistoryEntry[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is HistoryEntry =>
        e &&
        typeof e.product === "string" &&
        typeof e.crop === "string" &&
        typeof e.ts === "number",
    );
  } catch {
    return [];
  }
}

function write(entries: HistoryEntry[]) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX)));
  } catch {
    /* quota / private mode — silently drop */
  }
}

export function getHistory(): HistoryEntry[] {
  return read();
}

export function recordCheck(entry: Omit<HistoryEntry, "ts">): void {
  const list = read();
  // Dedup on (product, crop) — keep latest.
  const filtered = list.filter(
    (e) =>
      e.product.toLowerCase() !== entry.product.toLowerCase() ||
      e.crop.toLowerCase() !== entry.crop.toLowerCase(),
  );
  filtered.unshift({ ...entry, ts: Date.now() });
  write(filtered);
}

export function clearHistory(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
