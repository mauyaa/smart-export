import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  COMMON_CROPS,
  NetworkError,
  checkFertilizer,
  escalate,
  extractLabel,
  type ExtractLabelResponse,
  type ResultCard,
  type RiskLevel,
} from "@/lib/api";
import { compressImage } from "@/lib/image";
import { useI18n, type Lang } from "@/lib/i18n";
import { getHistory, recordCheck, clearHistory, type HistoryEntry } from "@/lib/history";
import { trackEvent } from "@/lib/telemetry";
import { openRearCamera, captureFrame, type CameraSession } from "@/lib/camera";
import ambientLeaves from "@/assets/ambient-leaves.jpg.asset.json";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "SmartExports — EU compliance for Kenyan fertilizers" },
      {
        name: "description",
        content:
          "Snap a fertilizer label. Get a Safe, Risky, or Unclear verdict in seconds — grounded in EU regulations and real rejection cases.",
      },
    ],
  }),
  component: SmartExportsApp,
});

type Step = "intro" | "capture" | "confirm" | "loading" | "result" | "escalate";
type OcrConfidence = "high" | "medium" | "low" | null;

type DemoSample = {
  product: string;
  crop: string;
  risk: RiskLevel;
};
type AppText = ReturnType<typeof useI18n>["t"];

const DEMO_SAMPLES: DemoSample[] = [
  { product: "Orthene 75SP", crop: "French Beans", risk: "Risky" },
  { product: "Muriate of Potash", crop: "Avocado", risk: "Safe" },
  { product: "Unknown product", crop: "French Beans", risk: "Unclear" },
];

// Type-safe wrappers for hooks
const useTypedState = useState;
const useTypedRef = useRef;

function SmartExportsApp() {
  const { t } = useI18n();
  const [step, setStep] = useState<Step>("intro");
  const [photo, setPhoto] = useState<{ file: File; url: string } | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [ocrConfidence, setOcrConfidence] = useState<OcrConfidence>(null);
  const [product, setProduct] = useState("");
  const [ingredients, setIngredients] = useState<string[]>([]);
  const [crop, setCrop] = useState<string>("");
  const [result, setResult] = useState<ResultCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [escalated, setEscalated] = useState<{ ticket: string } | null>(null);
  const [slow, setSlow] = useState(false);

  // Track every in-flight request so we can cancel on back / reset / unmount.
  const inflight = useRef<Set<AbortController>>(new Set());
  const newSignal = useCallback(() => {
    const c = new AbortController();
    inflight.current.add(c);
    return {
      signal: c.signal,
      done: () => inflight.current.delete(c),
    };
  }, []);
  const abortAll = useCallback(() => {
    for (const c of inflight.current) c.abort();
    inflight.current.clear();
  }, []);

  useEffect(
    () => () => {
      if (photo) URL.revokeObjectURL(photo.url);
    },
    [photo],
  );
  useEffect(() => () => abortAll(), [abortAll]);
  useEffect(() => {
    trackEvent("app_open");
  }, []);

  const reset = () => {
    abortAll();
    setStep("intro");
    setPhoto(null);
    setProduct("");
    setIngredients([]);
    setOcrConfidence(null);
    setCrop("");
    setResult(null);
    setError(null);
    setEscalated(null);
    setSlow(false);
  };

  // Re-check a product from history with one tap.
  const reCheckFromHistory = (entry: HistoryEntry) => {
    trackEvent("history_open", { crop: entry.crop });
    setProduct(entry.product);
    setCrop(entry.crop);
    setPhoto(null);
    setIngredients([]);
    setOcrConfidence(null);
    setResult(null);
    setError(null);
    setEscalated(null);
    setSlow(false);
    // Skip capture/confirm — go straight to the check.
    void runCheckWith(entry.product, entry.crop);
  };

  const runSample = (sample: DemoSample) => {
    trackEvent("sample_check", { crop: sample.crop, risk: sample.risk });
    abortAll();
    setPhoto(null);
    setProduct(sample.product);
    setCrop(sample.crop);
    setIngredients([]);
    setOcrConfidence(null);
    setResult(null);
    setError(null);
    setEscalated(null);
    setSlow(false);
    void runCheckWith(sample.product, sample.crop);
  };

  const runCheckWith = async (p: string, c: string) => {
    if (!p.trim() || !c) return;
    setError(null);
    setSlow(false);
    setStep("loading");
    trackEvent("check_submit", { crop: c });
    const { signal, done } = newSignal();
    try {
      const r = await checkFertilizer(
        { fertilizer_name: p.trim(), crop_name: c },
        { signal, onSlow: () => setSlow(true) },
      );
      if (signal.aborted) return;
      setResult(r);
      setProduct(r.fertilizer);
      setCrop(r.crop);
      setStep("result");
      recordCheck({ product: r.fertilizer, crop: r.crop, risk: normalizeRisk(r.risk_level) });
      trackEvent("check_result", { crop: r.crop, risk: r.risk_level, matched_via: r.matched_via });
    } catch (e) {
      if (signal.aborted) return;
      if (e instanceof ApiError && e.status === 404) {
        trackEvent("check_not_found", { crop: c });
        const fallback = makeUnknownResult(p.trim(), c, t);
        setResult(fallback);
        setProduct(fallback.fertilizer);
        setCrop(fallback.crop);
        setStep("result");
        recordCheck({ product: fallback.fertilizer, crop: fallback.crop, risk: "Unclear" });
        return;
      }
      if (e instanceof ApiError) {
        setError(e.detail);
        trackEvent("check_error", { status: e.status });
      } else if (e instanceof NetworkError) {
        setError(t.errors.network);
        trackEvent("check_error", { reason: "network" });
      } else {
        setError(t.errors.generic);
        trackEvent("check_error", { reason: "unknown" });
      }
      setStep("confirm");
    } finally {
      done();
      setSlow(false);
    }
  };

  const onPhoto = async (raw: File) => {
    setError(null);
    setSlow(false);
    setOcrConfidence(null);
    const file = await compressImage(raw);
    const url = URL.createObjectURL(file);
    setPhoto({ file, url });
    setStep("confirm");
    setExtracting(true);
    const { signal, done } = newSignal();
    try {
      const r: ExtractLabelResponse = await extractLabel(file, {
        signal,
        onSlow: () => setSlow(true),
      });
      if (signal.aborted) return;
      const confidence = normalizeConfidence(r.confidence);
      setOcrConfidence(confidence);
      setProduct(r.product_name ?? "");
      setIngredients(
        (r.possible_ingredients ?? []).filter(
          (s): s is string => typeof s === "string" && s.length > 0,
        ),
      );
      if (!r.product_name || confidence === "low") {
        setError(t.errors.ocrEmpty);
        trackEvent("ocr_empty");
      } else {
        trackEvent("ocr_success", { confidence });
        if (confidence === "high" && crop) void runCheckWith(r.product_name, crop);
      }
    } catch (e) {
      if (signal.aborted) return;
      if (e instanceof ApiError) {
        setError(e.detail);
        trackEvent("ocr_error", { status: e.status });
      } else if (e instanceof NetworkError) {
        setError(t.errors.network);
        trackEvent("ocr_error", { reason: "network" });
      } else {
        setError(t.errors.ocrFail);
        trackEvent("ocr_error", { reason: "unknown" });
      }
    } finally {
      done();
      setExtracting(false);
      setSlow(false);
    }
  };

  const runCheck = () => runCheckWith(product, crop);

  const selectCrop = (nextCrop: string) => {
    setCrop(nextCrop);
    if (ocrConfidence === "high" && product.trim().length > 1) {
      void runCheckWith(product, nextCrop);
    }
  };

  const submitEscalate = async (contact: string, notes: string) => {
    const { signal, done } = newSignal();
    trackEvent("escalate_submit", { crop });
    try {
      const r = await escalate(
        {
          fertilizer_name: product.trim(),
          crop_name: crop,
          farmer_contact: contact || undefined,
          notes: notes || undefined,
        },
        { signal },
      );
      setEscalated({ ticket: r.ticket });
      trackEvent("escalate_done", { ok: true });
    } finally {
      done();
    }
  };

  return (
    <div className="relative min-h-dvh overflow-hidden bg-background text-foreground">
      <div className="paper-grain pointer-events-none absolute inset-0 opacity-60" />
      <AmbientPanel />
      <div className="relative mx-auto flex min-h-dvh w-full max-w-110 flex-col px-6 pb-10 pt-6 lg:mx-0 lg:ml-[max(3rem,calc(50vw-30rem))]">
        <TopBar onReset={step !== "intro" ? reset : undefined} />

        <main className="flex-1">
          {step === "intro" && (
            <Intro
              onStart={() => setStep("capture")}
              onPick={reCheckFromHistory}
              onSample={runSample}
            />
          )}
          {step === "capture" && (
            <Capture
              onPhoto={onPhoto}
              onBack={() => {
                abortAll();
                setStep("intro");
              }}
            />
          )}
          {step === "confirm" && photo && (
            <Confirm
              photo={photo}
              product={product}
              setProduct={setProduct}
              ingredients={ingredients}
              crop={crop}
              setCrop={selectCrop}
              ocrConfidence={ocrConfidence}
              extracting={extracting}
              slow={slow}
              error={error}
              onSubmit={runCheck}
              onRetake={() => {
                abortAll();
                setPhoto(null);
                setProduct("");
                setIngredients([]);
                setOcrConfidence(null);
                setStep("capture");
              }}
            />
          )}
          {step === "loading" && (
            <Loading
              product={product}
              crop={crop}
              slow={slow}
              onCancel={() => {
                abortAll();
                setStep("confirm");
              }}
            />
          )}
          {step === "result" && result && (
            <Result result={result} onAgain={reset} onEscalate={() => setStep("escalate")} />
          )}
          {step === "escalate" && (
            <Escalate
              product={product}
              crop={crop}
              done={escalated}
              onSubmit={submitEscalate}
              onDone={reset}
            />
          )}
        </main>

        <Footer />
      </div>
    </div>
  );
}

/* ---------- Layout pieces ---------- */

function TopBar({ onReset }: { onReset?: () => void }) {
  const { t, lang, setLang } = useI18n();
  const next: Lang = lang === "en" ? "sw" : "en";
  return (
    <header className="flex items-center justify-between">
      <button onClick={onReset} className="flex items-center gap-2" aria-label="SmartExports home">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-sm bg-foreground text-background">
          <Leaf className="h-4 w-4" />
        </span>
        <span className="text-sm font-medium tracking-tight">SmartExports</span>
      </button>
      <div className="flex items-center gap-4">
        <button
          onClick={() => {
            trackEvent("lang_switch", { lang: next });
            setLang(next);
          }}
          className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground transition hover:text-foreground"
          aria-label={`Switch language to ${t.topbar.switchTo}`}
        >
          {lang === "en" ? "EN / SW" : "SW / EN"}
        </button>
        {onReset && (
          <button
            onClick={onReset}
            className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground transition hover:text-foreground"
          >
            {t.topbar.startOver}
          </button>
        )}
      </div>
    </header>
  );
}

function AmbientPanel() {
  // Decorative only — hidden on mobile so the design brief is untouched on phones.
  // On lg+ it fills the right half behind a soft paper-tinted wash + heavy blur.
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 right-0 hidden w-1/2 overflow-hidden lg:block"
    >
      <img
        src={ambientLeaves.url}
        alt=""
        width={1024}
        height={1536}
        loading="lazy"
        className="absolute inset-0 h-full w-full scale-110 object-cover opacity-80"
        style={{ filter: "blur(28px) saturate(115%)" }}
      />
      {/* Fade into the paper column on the left so the boundary is invisible */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(to right, var(--paper) 0%, color-mix(in oklab, var(--paper) 70%, transparent) 22%, transparent 55%)",
        }}
      />
      {/* Warm wash to harmonize with the clay palette */}
      <div
        className="absolute inset-0 mix-blend-multiply"
        style={{
          background:
            "linear-gradient(135deg, color-mix(in oklab, var(--paper) 35%, transparent), color-mix(in oklab, var(--primary) 12%, transparent))",
        }}
      />
    </div>
  );
}

function Footer() {
  const { t } = useI18n();
  return (
    <footer className="mt-10 flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
      <span>{t.footer.region}</span>
      <span>{t.footer.tag}</span>
    </footer>
  );
}

/* ---------- 01 · Intro ---------- */

function Intro({
  onStart,
  onPick,
  onSample,
}: {
  onStart: () => void;
  onPick: (e: HistoryEntry) => void;
  onSample: (sample: DemoSample) => void;
}) {
  const { t } = useI18n();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  useEffect(() => {
    setHistory(getHistory());
  }, []);

  return (
    <section className="animate-fade-up pt-10">
      <StepLabel index="01" label={t.intro.kicker} />

      <h1 className="mt-6 font-display text-[44px] leading-[0.95] tracking-tight">
        {t.intro.h1a}
        <br />
        <em className="font-display italic text-primary">{t.intro.h1b}</em> {t.intro.h1c}
      </h1>

      <p className="mt-5 max-w-[34ch] text-[15px] leading-relaxed text-muted-foreground">
        {t.intro.lede}
      </p>

      <div className="mt-10 hairline" />

      <ul className="mt-6 space-y-4 text-[13px]">
        {t.intro.bullets.map((b, i) => (
          <Bullet key={i} n={["①", "②", "③"][i]} title={b.title} body={b.body} />
        ))}
      </ul>

      <div className="mt-12">
        <PrimaryButton onClick={onStart}>
          {t.intro.cta}
          <ArrowRight className="ml-2 h-4 w-4" />
        </PrimaryButton>
        <p className="mt-3 text-center text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
          {t.intro.note}
        </p>
        <p className="mt-2 text-center text-[11px] text-muted-foreground/70">
          No smartphone? Dial{" "}
          <span className="font-mono font-medium text-foreground">*384*58768#</span> on any phone
        </p>
      </div>

      <div className="mt-8 rounded-md border border-border bg-card/70 p-4">
        <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
          {t.intro.samplesTitle}
        </p>
        <div className="mt-3 space-y-2">
          {DEMO_SAMPLES.map((sample) => (
            <button
              key={`${sample.product}-${sample.crop}`}
              onClick={() => onSample(sample)}
              className="flex w-full items-center justify-between gap-3 rounded-sm border border-border bg-background px-3 py-2 text-left transition hover:border-foreground/40"
            >
              <span className="min-w-0">
                <span className="block truncate font-display text-[17px] leading-tight tracking-tight">
                  {sample.product}
                </span>
                <span className="block text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  {sample.crop}
                </span>
              </span>
              <span className="inline-flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                <RiskDot risk={sample.risk} />
                {t.result.verdict[sample.risk]}
              </span>
            </button>
          ))}
        </div>
      </div>

      {history.length > 0 && (
        <div className="mt-12">
          <div className="hairline mb-4" />
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
              {t.history.title}
            </p>
            <button
              onClick={() => {
                clearHistory();
                setHistory([]);
              }}
              className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground"
            >
              {t.history.clear}
            </button>
          </div>
          <ul className="mt-3 divide-y divide-border">
            {history.map((h) => (
              <li key={`${h.product}-${h.crop}-${h.ts}`}>
                <button
                  onClick={() => onPick(h)}
                  className="flex w-full items-center justify-between gap-3 py-3 text-left"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-display text-[18px] leading-tight tracking-tight">
                      {h.product}
                    </span>
                    <span className="block text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                      {h.crop} · {t.history.ago(timeAgo(h.ts))}
                    </span>
                  </span>
                  <RiskDot risk={h.risk} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function RiskDot({ risk }: { risk: RiskLevel }) {
  const cls =
    risk === "Safe"
      ? "bg-[color:var(--safe)]"
      : risk === "Risky"
        ? "bg-[color:var(--risky)]"
        : "bg-[color:var(--unclear)]";
  return (
    <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${cls}`} aria-label={risk} />
  );
}

const Bullet = ({ n, title, body }: { n: string; title: string; body: string }) => (
  <li className="flex gap-4">
    <span className="font-display text-xl leading-none text-primary">{n}</span>
    <div>
      <p className="font-medium">{title}</p>
      <p className="text-muted-foreground">{body}</p>
    </div>
  </li>
);

/* ---------- 02 · Capture ---------- */

function Capture({ onPhoto, onBack }: { onPhoto: (f: File) => void; onBack: () => void }) {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [session, setSession] = useState<CameraSession | null>(null);
  const [torch, setTorchState] = useState(false);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);

  const startCamera = useCallback(async () => {
    trackEvent("capture_open_camera");
    try {
      const s = await openRearCamera();
      setSession(s);
      setDenied(false);
      if (videoRef.current) {
        videoRef.current.srcObject = s.stream;
        await videoRef.current.play().catch(() => {});
      }
    } catch {
      setDenied(true);
    }
  }, []);

  useEffect(
    () => () => {
      session?.stop();
    },
    [session],
  );

  // Attach the stream if the <video> mounts after the session is ready.
  useEffect(() => {
    if (session && videoRef.current && !videoRef.current.srcObject) {
      videoRef.current.srcObject = session.stream;
      videoRef.current.play().catch(() => {});
    }
  }, [session]);

  const toggleTorch = async () => {
    if (!session) return;
    const next = !torch;
    const ok = await session.setTorch(next);
    if (ok) {
      setTorchState(next);
      trackEvent("capture_torch_toggle", { ok: next });
    }
  };

  const shoot = async () => {
    if (!videoRef.current || busy) return;
    setBusy(true);
    try {
      const file = await captureFrame(videoRef.current);
      session?.stop();
      setSession(null);
      onPhoto(file);
    } finally {
      setBusy(false);
    }
  };

  const closeCamera = () => {
    session?.stop();
    setSession(null);
    setTorchState(false);
  };

  return (
    <section className="animate-fade-up pt-10">
      <StepLabel index="02" label={t.capture.kicker} />
      <h2 className="mt-6 font-display text-[34px] leading-none tracking-tight">{t.capture.h2}</h2>
      <p className="mt-4 max-w-[34ch] text-[14px] text-muted-foreground">{t.capture.lede}</p>

      <div className="relative mt-8 aspect-4/5 w-full overflow-hidden rounded-md border border-dashed border-border bg-card/40 p-3">
        <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-sm border border-border/60 bg-paper">
          {session ? (
            <>
              <video
                ref={videoRef}
                playsInline
                muted
                className="absolute inset-0 h-full w-full object-cover"
              />
              {/* Framing guide */}
              <div className="pointer-events-none absolute inset-6 rounded-sm border border-white/70 mix-blend-difference" />
              {session.hasTorch && (
                <button
                  onClick={toggleTorch}
                  className="absolute right-3 top-3 rounded-full bg-black/55 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-white backdrop-blur"
                >
                  {torch ? t.capture.torchOn : t.capture.torchOff}
                </button>
              )}
              <button
                onClick={closeCamera}
                className="absolute left-3 top-3 rounded-full bg-black/55 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-white backdrop-blur"
              >
                {t.capture.close}
              </button>
            </>
          ) : (
            <div className="text-center">
              <CameraIcon className="mx-auto h-10 w-10 text-muted-foreground" />
              <p className="mt-3 text-xs uppercase tracking-[0.2em] text-muted-foreground">
                {t.capture.frameHint}
              </p>
            </div>
          )}
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            trackEvent("capture_upload_file");
            onPhoto(f);
          }
        }}
      />

      {denied && (
        <p className="mt-4 rounded-sm border border-border bg-card px-3 py-2 text-[12px] text-muted-foreground">
          {t.capture.cameraDenied}
        </p>
      )}

      <div className="mt-10">
        {session ? (
          <PrimaryButton onClick={shoot} disabled={busy}>
            <CameraIcon className="mr-2 h-4 w-4" />
            {t.capture.shoot}
          </PrimaryButton>
        ) : (
          <PrimaryButton onClick={startCamera}>
            <CameraIcon className="mr-2 h-4 w-4" />
            {t.capture.openCamera}
          </PrimaryButton>
        )}
        <div className="mt-3 flex items-center justify-between">
          <button
            onClick={() => {
              closeCamera();
              onBack();
            }}
            className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground"
          >
            {t.capture.back}
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground"
          >
            {t.capture.upload}
          </button>
        </div>
      </div>
    </section>
  );
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function normalizeRisk(r: unknown): RiskLevel {
  const s = String(r ?? "").toLowerCase();
  if (s === "safe") return "Safe";
  if (s === "risky") return "Risky";
  return "Unclear";
}

function makeUnknownResult(product: string, crop: string, t: AppText): ResultCard {
  return {
    fertilizer: product || t.result.unknownProduct,
    crop,
    risk_level: "Unclear",
    explanation: t.result.unknownExplanation(product || t.result.unknownProduct, crop),
    next_step: t.result.nextStep.Unclear,
    alternative_product: null,
    evidence: {},
    matched_via: "manual_review",
  };
}

function normalizeConfidence(value: unknown): Exclude<OcrConfidence, null> {
  const s = String(value ?? "").toLowerCase();
  if (s === "high" || s === "medium" || s === "low") return s;
  return "low";
}

/* ---------- 03 · Confirm ---------- */

function Confirm({
  photo,
  product,
  setProduct,
  ingredients,
  crop,
  setCrop,
  ocrConfidence,
  extracting,
  slow,
  error,
  onSubmit,
  onRetake,
}: {
  photo: { file: File; url: string };
  product: string;
  setProduct: (s: string) => void;
  ingredients: string[];
  crop: string;
  setCrop: (s: string) => void;
  ocrConfidence: OcrConfidence;
  extracting: boolean;
  slow: boolean;
  error: string | null;
  onSubmit: () => void;
  onRetake: () => void;
}) {
  const { t } = useI18n();
  const canSubmit = product.trim().length > 1 && crop.length > 0;
  return (
    <section className="animate-fade-up pt-8">
      <StepLabel index="03" label={t.confirm.kicker} />
      <h2 className="mt-5 font-display text-[30px] leading-none tracking-tight">{t.confirm.h2}</h2>

      <div className="mt-6 flex gap-4">
        <div className="h-24 w-24 shrink-0 overflow-hidden rounded-sm border border-border bg-muted">
          <img src={photo.url} alt="Fertilizer label" className="h-full w-full object-cover" />
        </div>
        <button
          onClick={onRetake}
          className="self-start text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground"
        >
          {t.confirm.retake}
        </button>
      </div>

      <div className="mt-8 space-y-6">
        <Field label={t.confirm.productLabel}>
          <input
            value={product}
            onChange={(e) => setProduct(e.target.value)}
            placeholder={extracting ? t.confirm.reading + "…" : t.confirm.productPlaceholder}
            className="w-full border-0 border-b border-border bg-transparent pb-2 font-display text-[26px] leading-tight tracking-tight outline-none transition focus:border-foreground"
          />
          {extracting && (
            <p className="mt-2 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
              <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-primary" />{" "}
              {t.confirm.reading}
            </p>
          )}
          {extracting && slow && (
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              {t.loading.waking}
            </p>
          )}
          {!extracting && ocrConfidence && <ConfidenceNotice confidence={ocrConfidence} />}
        </Field>

        {ingredients.length > 0 && (
          <Field label={t.confirm.alsoSeen}>
            <div className="-mx-1 mt-1 flex flex-wrap gap-2">
              {ingredients.slice(0, 8).map((ing) => (
                <span
                  key={ing}
                  className="rounded-full border border-border px-3 py-1 text-[12px] text-muted-foreground"
                >
                  {ing}
                </span>
              ))}
            </div>
          </Field>
        )}

        <Field label={t.confirm.cropLabel}>
          <div className="-mx-1 mt-2 flex flex-wrap gap-2">
            {COMMON_CROPS.map((c) => (
              <button
                key={c}
                onClick={() => setCrop(c)}
                className={
                  "rounded-full border px-3 py-1.5 text-[13px] transition " +
                  (crop === c
                    ? "border-foreground bg-foreground text-background"
                    : "border-border text-foreground hover:border-foreground")
                }
              >
                {c}
              </button>
            ))}
          </div>
        </Field>
      </div>

      {error && (
        <p className="mt-6 rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
          {error}
        </p>
      )}

      <div className="mt-10">
        <PrimaryButton onClick={onSubmit} disabled={!canSubmit}>
          {t.confirm.cta}
          <ArrowRight className="ml-2 h-4 w-4" />
        </PrimaryButton>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
        {label}
      </p>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function ConfidenceNotice({ confidence }: { confidence: Exclude<OcrConfidence, null> }) {
  const { t } = useI18n();
  const tone =
    confidence === "high"
      ? "border-[color:var(--safe)] bg-[color:var(--safe-soft)] text-[color:var(--safe)]"
      : confidence === "medium"
        ? "border-[color:var(--unclear)] bg-[color:var(--unclear-soft)] text-[color:var(--unclear)]"
        : "border-[color:var(--risky)] bg-[color:var(--risky-soft)] text-[color:var(--risky)]";
  return (
    <div className={`mt-3 rounded-sm border px-3 py-2 ${tone}`}>
      <p className="text-[10px] font-medium uppercase tracking-[0.18em]">
        {t.confirm.confidence[confidence].label}
      </p>
      <p className="mt-1 text-[12px] leading-relaxed text-foreground">
        {t.confirm.confidence[confidence].body}
      </p>
    </div>
  );
}

/* ---------- Loading ---------- */

function Loading({
  product,
  crop,
  slow,
  onCancel,
}: {
  product: string;
  crop: string;
  slow: boolean;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const steps = useMemo(() => t.loading.steps, [t]);
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((x) => Math.min(x + 1, steps.length - 1)), 900);
    return () => clearInterval(id);
  }, [steps.length]);

  return (
    <section className="animate-fade-up flex flex-col items-center pt-24 text-center">
      <span className="relative inline-flex h-3 w-3 rounded-full bg-primary animate-pulse-ring" />
      <h2 className="mt-10 font-display text-[26px] leading-tight tracking-tight">
        {t.loading.title(product, crop)}
      </h2>
      <ul className="mt-8 space-y-2 text-[13px] text-muted-foreground">
        {steps.map((s, idx) => (
          <li
            key={s}
            className={"transition-opacity " + (idx <= i ? "text-foreground" : "opacity-40")}
          >
            {idx < i ? "✓" : idx === i ? "→" : "·"} &nbsp;{s}
          </li>
        ))}
      </ul>
      {slow && (
        <p className="mt-6 max-w-[30ch] text-[12px] leading-relaxed text-muted-foreground">
          {t.loading.waking}
        </p>
      )}
      <button
        onClick={onCancel}
        className="mt-10 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground"
      >
        {t.escalate.cancel}
      </button>
    </section>
  );
}

/* ---------- Result ---------- */

const RISK_THEME: Record<RiskLevel, { bg: string; fg: string; bar: string }> = {
  Safe: {
    bg: "bg-[color:var(--safe-soft)]",
    fg: "text-[color:var(--safe)]",
    bar: "bg-[color:var(--safe)]",
  },
  Risky: {
    bg: "bg-[color:var(--risky-soft)]",
    fg: "text-[color:var(--risky)]",
    bar: "bg-[color:var(--risky)]",
  },
  Unclear: {
    bg: "bg-[color:var(--unclear-soft)]",
    fg: "text-[color:var(--unclear)]",
    bar: "bg-[color:var(--unclear)]",
  },
};

type EvidenceHit = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function evidenceHits(evidence: Record<string, unknown>, key: string): EvidenceHit[] {
  const value = evidence[key];
  return Array.isArray(value)
    ? value.filter((hit): hit is EvidenceHit => Boolean(asRecord(hit)))
    : [];
}

function summarizeEvidence(result: ResultCard) {
  const regulatoryHits = evidenceHits(result.evidence, "regulatoryHits");
  const rejectionHits = evidenceHits(result.evidence, "rejectionHits");
  const organicHits = evidenceHits(result.evidence, "organicHits");
  const hit = regulatoryHits[0] ?? rejectionHits[0] ?? organicHits[0] ?? null;
  const restriction = asRecord(hit?.restriction);
  const rejection = asRecord(hit?.rejectionCase);
  const organic = asRecord(hit?.organicRestriction);
  const limit = restriction?.limit;
  const unit = textValue(restriction?.unit);

  return {
    substance: textValue(hit?.substance),
    regulation:
      textValue(restriction?.regulationName) ??
      textValue(restriction?.regulationCode) ??
      textValue(organic?.regulationCode),
    limit:
      limit !== undefined && limit !== null ? `${String(limit)}${unit ? ` ${unit}` : ""}` : null,
    rejection: textValue(rejection?.summary),
    hasRejection: rejectionHits.length > 0,
    organicNote: textValue(organic?.note),
  };
}

function Result({
  result,
  onAgain,
  onEscalate,
}: {
  result: ResultCard;
  onAgain: () => void;
  onEscalate: () => void;
}) {
  const { t, lang } = useI18n();
  // Normalize risk level defensively (some backends may capitalize differently).
  const normalized =
    (["Safe", "Risky", "Unclear"] as RiskLevel[]).find(
      (k) => k.toLowerCase() === String(result.risk_level || "").toLowerCase(),
    ) ?? "Unclear";
  const theme = RISK_THEME[normalized];
  const verdictWord = t.result.verdict[normalized];
  const evidence = summarizeEvidence(result);
  const fallbackExplanation = t.result.localizedExplanation[normalized](
    result.fertilizer,
    result.crop,
    evidence.substance,
    evidence.regulation,
  );
  const explanation =
    lang === "sw" || normalized === "Safe" ? fallbackExplanation : result.explanation;
  const nextStep = lang === "sw" ? t.result.nextStep[normalized] : result.next_step;
  const needsReview = normalized === "Risky" || normalized === "Unclear";
  const matchLabel = result.matched_via?.startsWith("fuzzy")
    ? t.result.matchFuzzy
    : result.matched_via === "manual_review"
      ? t.result.matchReview
      : t.result.matchExact;

  const shareUrl = useMemo(() => {
    const text = t.result.shareText(result.fertilizer, result.crop, verdictWord, explanation);
    return `https://wa.me/?text=${encodeURIComponent(text)}`;
  }, [explanation, result, verdictWord, t]);

  return (
    <section className="animate-fade-up pt-6">
      <StepLabel index="04" label={t.result.kicker} />

      <div className={"mt-5 overflow-hidden rounded-md " + theme.bg}>
        <div className={"h-1 w-full " + theme.bar} />
        <div className="px-5 pb-6 pt-5">
          <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-foreground/60">
            {result.fertilizer} · {result.crop}
          </p>
          <h2 className={"mt-2 font-display text-[64px] leading-[0.9] tracking-tight " + theme.fg}>
            {verdictWord}.
          </h2>
          <span
            className={
              "mt-4 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] " +
              theme.fg
            }
          >
            <span className={"h-2 w-2 rounded-full " + theme.bar} />
            {verdictWord}
          </span>
          <p className="mt-4 text-[14px] leading-relaxed text-foreground">{explanation}</p>
        </div>
      </div>

      {(evidence.substance || evidence.regulation || evidence.limit) && (
        <Block label={t.result.flaggedLabel}>
          <div className="space-y-3 text-[14px] leading-relaxed">
            {evidence.substance && (
              <p>
                <span className="font-medium">{t.result.containsLabel}:</span> {evidence.substance}
              </p>
            )}
            {evidence.regulation && (
              <p>
                <span className="font-medium">{t.result.regulationLabel}:</span>{" "}
                {evidence.regulation}
              </p>
            )}
            {evidence.limit && (
              <p>
                <span className="font-medium">{t.result.limitLabel}:</span> {evidence.limit}
              </p>
            )}
          </div>
        </Block>
      )}

      <Block label={t.result.nextLabel}>
        <p className="text-[14px] leading-relaxed">{nextStep}</p>
      </Block>

      {result.alternative_product && (
        <Block label={t.result.altLabel}>
          <p className="font-display text-[24px] leading-tight tracking-tight">
            {t.result.consider(result.alternative_product)}
          </p>
          <p className="mt-1 text-[12px] text-muted-foreground">{t.result.altSub(result.crop)}</p>
        </Block>
      )}

      <EvidenceDetails evidence={evidence} />

      <Block label={t.result.matchLabel}>
        <p className="text-[12px] uppercase tracking-[0.18em] text-muted-foreground">
          {matchLabel}
        </p>
      </Block>

      <div className="mt-10 space-y-3">
        {needsReview && <PrimaryButton onClick={onEscalate}>{t.result.expertReview}</PrimaryButton>}
        <button
          onClick={onAgain}
          className="flex h-12 w-full items-center justify-center rounded-sm border border-foreground/15 bg-card text-[13px] font-medium tracking-tight text-foreground transition hover:border-foreground/40"
        >
          {t.result.again}
        </button>
        <a
          href={shareUrl}
          target="_blank"
          rel="noreferrer noopener"
          onClick={() => trackEvent("share_whatsapp", { risk: normalized })}
          className="flex h-12 w-full items-center justify-center rounded-sm border border-foreground/15 bg-card text-[13px] font-medium tracking-tight text-foreground transition hover:border-foreground/40"
        >
          <WhatsAppIcon className="mr-2 h-4 w-4" />
          {t.result.share}
        </a>
        {!needsReview && (
          <button
            onClick={onEscalate}
            className="block w-full text-center text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground"
          >
            {t.result.flag}
          </button>
        )}
      </div>
    </section>
  );
}

function EvidenceDetails({ evidence }: { evidence: ReturnType<typeof summarizeEvidence> }) {
  const { t } = useI18n();
  if (!evidence.regulation && !evidence.limit && !evidence.rejection && !evidence.organicNote) {
    return null;
  }
  return (
    <details className="mt-8 rounded-sm border border-border bg-card px-4 py-3">
      <summary className="cursor-pointer text-[12px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {t.result.detailsTitle}
      </summary>
      <div className="mt-4 space-y-3">
        <DetailRow label={t.result.regulationLabel} value={evidence.regulation} />
        <DetailRow label={t.result.limitLabel} value={evidence.limit} />
        <DetailRow
          label={t.result.rejectionLabel}
          value={evidence.rejection ?? t.result.rejectionNo}
        />
        <DetailRow label={t.result.organicLabel} value={evidence.organicNote} />
      </div>
    </details>
  );
}

function DetailRow({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-[13px] leading-relaxed">{value}</p>
    </div>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-8">
      <div className="hairline mb-4" />
      <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
        {label}
      </p>
      <div className="mt-2">{children}</div>
    </div>
  );
}

/* ---------- Escalate ---------- */

function Escalate({
  product,
  crop,
  done,
  onSubmit,
  onDone,
}: {
  product: string;
  crop: string;
  done: { ticket: string } | null;
  onSubmit: (contact: string, notes: string) => Promise<void>;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [contact, setContact] = useState("");
  const [notes, setNotes] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const submit = useCallback(async () => {
    setSending(true);
    setErr(null);
    try {
      await onSubmit(contact, notes);
    } catch (e) {
      if (e instanceof ApiError) setErr(e.detail);
      else if (e instanceof NetworkError) setErr(t.errors.network);
      else setErr(t.errors.sendFail);
    } finally {
      setSending(false);
    }
  }, [contact, notes, onSubmit, t]);

  const copyTicket = async () => {
    if (!done) return;
    try {
      await navigator.clipboard.writeText(done.ticket);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* ignore */
    }
  };

  if (done) {
    return (
      <section className="animate-fade-up pt-16 text-center">
        <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-safe-soft text-safe">
          ✓
        </span>
        <h2 className="mt-6 font-display text-[30px] leading-tight tracking-tight">
          {t.escalate.doneTitle}
        </h2>
        <p className="mx-auto mt-3 max-w-[30ch] text-[14px] text-muted-foreground">
          {t.escalate.doneBody(product, crop)}
        </p>

        <div className="mx-auto mt-8 max-w-[18rem] rounded-md border border-border bg-card px-5 py-4 text-left">
          <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
            {t.escalate.ticketLabel}
          </p>
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="font-display text-[22px] tracking-tight">{done.ticket}</span>
            <button
              onClick={copyTicket}
              className="rounded-sm border border-border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground transition hover:border-foreground hover:text-foreground"
            >
              {copied ? t.escalate.copied : t.escalate.copy}
            </button>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            {t.escalate.ticketHint}
          </p>
        </div>

        <div className="mt-10">
          <PrimaryButton onClick={onDone}>{t.escalate.done}</PrimaryButton>
        </div>
      </section>
    );
  }

  return (
    <section className="animate-fade-up pt-8">
      <StepLabel index="!" label={t.escalate.kicker} />
      <h2 className="mt-5 font-display text-[30px] leading-none tracking-tight">{t.escalate.h2}</h2>
      <p className="mt-3 max-w-[34ch] text-[14px] text-muted-foreground">
        {t.escalate.lede(product)}
      </p>

      <div className="mt-8 space-y-6">
        <Field label={t.escalate.contactLabel}>
          <input
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            placeholder={t.escalate.contactPh}
            className="w-full border-0 border-b border-border bg-transparent pb-2 text-[16px] outline-none focus:border-foreground"
          />
        </Field>
        <Field label={t.escalate.notesLabel}>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder={t.escalate.notesPh}
            className="w-full resize-none border-0 border-b border-border bg-transparent pb-2 text-[14px] outline-none focus:border-foreground"
          />
        </Field>
      </div>

      {err && (
        <p className="mt-6 rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
          {err}
        </p>
      )}

      <div className="mt-10 space-y-3">
        <PrimaryButton onClick={submit} disabled={sending}>
          {sending ? t.escalate.sending : t.escalate.cta}
        </PrimaryButton>
        <button
          onClick={onDone}
          className="block w-full text-center text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground"
        >
          {t.escalate.cancel}
        </button>
      </div>
    </section>
  );
}

/* ---------- Atoms ---------- */

function StepLabel({ index, label }: { index: string; label: string }) {
  return (
    <div className="flex items-center gap-3 text-[10px] font-medium uppercase tracking-[0.24em] text-muted-foreground">
      <span className="font-display text-base italic text-primary">{index}</span>
      <span className="hairline flex-1" />
      <span>{label}</span>
    </div>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="group flex h-14 w-full items-center justify-center gap-2 rounded-sm bg-foreground px-6 text-[14px] font-medium tracking-tight text-background transition hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/* ---------- Inline icons ---------- */

function Leaf({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M11 20A7 7 0 0 1 4 13C4 8 9 4 20 4c0 9-4 16-9 16Z" />
      <path d="M2 22c5-3 8-7 9-13" />
    </svg>
  );
}
function ArrowRight({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12h14" />
      <path d="m13 5 7 7-7 7" />
    </svg>
  );
}
function CameraIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14.5 4h-5L8 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-4l-1.5-2Z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}
function WhatsAppIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M20.52 3.48A11.78 11.78 0 0 0 12.02 0C5.53 0 .27 5.26.27 11.74c0 2.07.54 4.09 1.57 5.87L0 24l6.55-1.72a11.74 11.74 0 0 0 5.47 1.39h.01c6.48 0 11.74-5.26 11.74-11.74 0-3.14-1.22-6.09-3.25-8.45ZM12.03 21.4h-.01a9.66 9.66 0 0 1-4.92-1.35l-.35-.21-3.89 1.02 1.04-3.79-.23-.39a9.62 9.62 0 0 1-1.48-5.14c0-5.32 4.33-9.65 9.65-9.65 2.58 0 5 1 6.83 2.83a9.6 9.6 0 0 1 2.83 6.82c0 5.32-4.33 9.66-9.65 9.66Zm5.32-7.23c-.29-.15-1.72-.85-1.99-.94-.27-.1-.46-.15-.66.15s-.76.94-.93 1.13c-.17.19-.34.22-.63.07-.29-.15-1.22-.45-2.32-1.43-.86-.77-1.44-1.71-1.61-2-.17-.29-.02-.45.13-.6.13-.13.29-.34.43-.51.14-.17.19-.29.29-.48.1-.19.05-.36-.02-.51-.07-.15-.66-1.6-.9-2.19-.24-.57-.48-.49-.66-.5l-.56-.01c-.19 0-.51.07-.78.36-.27.29-1.03 1.01-1.03 2.46s1.05 2.85 1.2 3.05c.15.19 2.08 3.18 5.04 4.46.7.3 1.25.48 1.68.62.7.22 1.34.19 1.85.12.56-.08 1.72-.7 1.97-1.38.24-.68.24-1.27.17-1.39-.07-.12-.27-.19-.56-.34Z" />
    </svg>
  );
}
