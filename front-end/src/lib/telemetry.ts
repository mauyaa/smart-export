// Minimal, privacy-respecting telemetry.
//
// • Always writes a compact event log to localStorage (capped, ring buffer)
//   so a pilot team can pull `localStorage.smartexports.events` from a
//   farmer's phone during field visits and see what happened.
// • If VITE_SMARTEXPORTS_ANALYTICS is set, also POSTs each event via
//   sendBeacon (non-blocking, ignores failures). No PII is included.
//
// All events go through trackEvent() so we have one chokepoint to audit.

type EventName =
  | "app_open"
  | "capture_open_camera"
  | "capture_upload_file"
  | "capture_torch_toggle"
  | "ocr_success"
  | "ocr_empty"
  | "ocr_error"
  | "check_submit"
  | "check_result"
  | "check_not_found"
  | "check_error"
  | "escalate_submit"
  | "escalate_done"
  | "share_whatsapp"
  | "history_open"
  | "lang_switch"
  | "sample_check";

interface EventPayload {
  // Whitelisted fields only — never raw user input free-form.
  crop?: string;
  risk?: string;
  matched_via?: string;
  ok?: boolean;
  status?: number;
  reason?: string;
  lang?: string;
  confidence?: string;
}

interface StoredEvent {
  t: number;
  n: EventName;
  d?: EventPayload;
}

const KEY = "smartexports.events";
const MAX = 200;
const ENDPOINT = (import.meta.env.VITE_SMARTEXPORTS_ANALYTICS as string | undefined) ?? "";

// Anonymous, per-install id. Not tied to user identity.
function sessionId(): string {
  const k = "smartexports.sid";
  try {
    let v = localStorage.getItem(k);
    if (!v) {
      v = Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(k, v);
    }
    return v;
  } catch {
    return "anon";
  }
}

function pushLocal(ev: StoredEvent) {
  if (typeof localStorage === "undefined") return;
  try {
    const raw = localStorage.getItem(KEY);
    const list: StoredEvent[] = raw ? JSON.parse(raw) : [];
    list.push(ev);
    if (list.length > MAX) list.splice(0, list.length - MAX);
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

function postBeacon(ev: StoredEvent) {
  if (!ENDPOINT || typeof navigator === "undefined") return;
  try {
    const body = JSON.stringify({ ...ev, sid: sessionId() });
    if (typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
    } else {
      fetch(ENDPOINT, {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json" },
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

export function trackEvent(name: EventName, data?: EventPayload): void {
  const ev: StoredEvent = { t: Date.now(), n: name, ...(data ? { d: data } : {}) };
  pushLocal(ev);
  postBeacon(ev);
}

export function readEvents(): StoredEvent[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
