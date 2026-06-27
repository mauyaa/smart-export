import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import {
  registerExpert, setSession, KENYA_COUNTIES, CROP_OPTIONS,
} from "../lib/experts";


export const Route = createFileRoute("/signup")({
  head: () => ({
    meta: [
      { title: "Expert Signup — SmartExports" },
      { name: "description", content: "Join SmartExports as an expert advisor for Kenyan exporters." },
    ],
  }),
  component: SignupPage,
});

function SignupPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: "", email: "", password: "", phone: "",
    organization: "", county: "", bio: "",
  });
  const [crops, setCrops] = useState<string[]>([]);
  const [substances, setSubstances] = useState<string[]>([]);
  const [substanceInput, setSubstanceInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function toggleCrop(c: string) {
    setCrops((prev) => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c]);
  }

  function addSubstance() {
    const v = substanceInput.trim();
    if (v && !substances.includes(v)) setSubstances([...substances, v]);
    setSubstanceInput("");
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.county) { setError("Please choose a county."); return; }
    if (crops.length === 0) { setError("Pick at least one crop specialization."); return; }
    setLoading(true);
    try {
      const data = await registerExpert({
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        phone: form.phone.trim(),
        organization: form.organization.trim(),
        county: form.county,
        crop_tags: crops,
        substance_tags: substances,
        bio: form.bio.trim(),
      });
      setSession({
        id: data.expert_id,
        name: data.name,
        email: data.email,
        organization: form.organization,
        cropTags: crops,
        phone: form.phone,
        bio: form.bio,
      });
      navigate({ to: "/dashboard" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-background px-4 py-12">
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-8">
          <Link to="/" className="inline-block">
            <img src="/app-icon.png" alt="SmartExports" className="h-14 w-14 mx-auto rounded-2xl shadow-sm" />
            <div className="font-display text-3xl text-foreground mt-3">SmartExports</div>
          </Link>
          <p className="text-sm text-muted-foreground mt-1">Expert Portal</p>

        </div>

        <div className="bg-card border border-rule rounded-lg p-8 shadow-sm">
          <h1 className="font-display text-2xl text-foreground mb-1">Create expert account</h1>
          <p className="text-sm text-muted-foreground mb-6">
            Tell us your expertise so we can route the right escalations to you.
          </p>

          <form onSubmit={onSubmit} className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Full name">
                <input className="input" required value={form.name} onChange={(e) => set("name", e.target.value)} />
              </Field>
              <Field label="Email">
                <input className="input" type="email" required value={form.email} onChange={(e) => set("email", e.target.value)} />
              </Field>
              <Field label="Password">
                <input className="input" type="password" required minLength={6} value={form.password} onChange={(e) => set("password", e.target.value)} />
              </Field>
              <Field label="Phone">
                <input className="input" type="tel" required value={form.phone} onChange={(e) => set("phone", e.target.value)} />
              </Field>
              <Field label="Organization">
                <input className="input" required value={form.organization} onChange={(e) => set("organization", e.target.value)} />
              </Field>
              <Field label="County">
                <select className="input" required value={form.county} onChange={(e) => set("county", e.target.value)}>
                  <option value="">Select…</option>
                  {KENYA_COUNTIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>
            </div>

            <Field label="Crop specializations">
              <div className="flex flex-wrap gap-2">
                {CROP_OPTIONS.map((c) => {
                  const active = crops.includes(c);
                  return (
                    <button
                      key={c} type="button" onClick={() => toggleCrop(c)}
                      className={`px-3 py-1.5 rounded-full text-sm border transition ${
                        active
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-background text-foreground border-rule hover:border-primary/50"
                      }`}
                    >{c}</button>
                  );
                })}
              </div>
            </Field>

            <Field label="Substance tags">
              <div className="flex gap-2">
                <input
                  className="input flex-1" placeholder="e.g. Chlorpyrifos"
                  value={substanceInput}
                  onChange={(e) => setSubstanceInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSubstance(); } }}
                />
                <button type="button" onClick={addSubstance}
                  className="px-4 py-2 border border-rule rounded-md text-sm hover:bg-secondary">
                  Add
                </button>
              </div>
              {substances.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {substances.map((s) => (
                    <span key={s} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-secondary text-secondary-foreground rounded text-xs">
                      {s}
                      <button type="button" onClick={() => setSubstances(substances.filter(x => x !== s))}
                        className="text-muted-foreground hover:text-foreground">×</button>
                    </span>
                  ))}
                </div>
              )}
            </Field>

            <Field label="Short bio">
              <textarea className="input" rows={3} value={form.bio} onChange={(e) => set("bio", e.target.value)}
                placeholder="Brief background, years of experience, certifications…" />
            </Field>

            {error && (
              <div className="text-sm text-[color:var(--risky)] bg-[color:var(--risky-soft)] border border-[color:var(--risky)]/30 rounded px-3 py-2">
                {error}
              </div>
            )}

            <button type="submit" disabled={loading}
              className="w-full bg-primary text-primary-foreground rounded-md py-2.5 font-medium hover:opacity-90 transition disabled:opacity-60">
              {loading ? "Creating account…" : "Create account"}
            </button>
          </form>

          <p className="text-sm text-muted-foreground text-center mt-6">
            Already have an account?{" "}
            <Link to="/" className="text-primary font-medium hover:underline">Sign in</Link>
          </p>
        </div>

        <p className="text-center text-xs text-muted-foreground mt-6">
          Looking for the farmer app?{" "}
          <a
            href="https://front-end-nu-rosy-90.vercel.app/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            Open SmartExports →
          </a>
        </p>
      </div>

      <style>{`
        .input {
          width: 100%; padding: 0.55rem 0.75rem;
          border: 1px solid var(--rule); border-radius: 0.375rem;
          background: var(--background); color: var(--foreground);
          font-size: 0.9rem; outline: none;
        }
        .input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 18%, transparent); }
      `}</style>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-foreground block mb-1.5">{label}</span>
      {children}
    </label>
  );
}
