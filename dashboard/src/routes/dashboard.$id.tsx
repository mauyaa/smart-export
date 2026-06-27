import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  getEscalations, getSession, updateEscalationStatus,
  riskClasses, statusClasses,
} from "../lib/experts";

export const Route = createFileRoute("/dashboard/$id")({
  component: EscalationDetail,
});

function EscalationDetail() {
  const { id } = Route.useParams();
  const expert = typeof window !== "undefined" ? getSession() : null;
  const qc = useQueryClient();
  const [notes, setNotes] = useState("");
  const [savedNotice, setSavedNotice] = useState(false);

  const { data: escalations = [], isLoading } = useQuery({
    queryKey: ["escalations", expert?.id],
    queryFn: () => getEscalations(expert!.id),
    enabled: !!expert?.id,
  });

  const esc = escalations.find((e) => e.id === id);

  // Local notes per escalation
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(`smartexports.notes.${id}`);
    if (saved) setNotes(saved);
  }, [id]);

  function saveNotes() {
    window.localStorage.setItem(`smartexports.notes.${id}`, notes);
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2000);
  }

  const updateStatus = useMutation({
    mutationFn: (status: "pending" | "responded" | "resolved") =>
      updateEscalationStatus(id, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["escalations", expert?.id] }),
  });

  if (!expert) return null;
  if (isLoading) return <main className="max-w-4xl mx-auto px-4 py-12 text-sm text-muted-foreground">Loading…</main>;
  if (!esc) {
    return (
      <main className="max-w-4xl mx-auto px-4 py-12">
        <p className="text-sm text-muted-foreground">Escalation not found.</p>
        <Link to="/dashboard" className="text-sm text-primary hover:underline mt-2 inline-block">← Back</Link>
      </main>
    );
  }

  return (
    <main className="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <header>
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
              Escalation · {esc.id.slice(0, 8)}
            </p>
            <h1 className="font-display text-3xl text-foreground">
              {esc.fertilizer} on {esc.crop}
            </h1>
          </div>
          <div className="flex gap-2">
            <span className={`px-2.5 py-1 rounded text-xs border ${riskClasses(esc.riskLevel)}`}>
              {esc.riskLevel}
            </span>
            <span className={`px-2.5 py-1 rounded text-xs border capitalize ${statusClasses(esc.status)}`}>
              {esc.status || "pending"}
            </span>
          </div>
        </div>
      </header>

      <div className="grid md:grid-cols-2 gap-4">
        <Panel title="Farmer details">
          <Row label="Name" value={esc.farmerName} />
          <Row label="Phone" value={esc.farmerPhone} />
          <Row label="County" value={esc.farmerCounty} />
        </Panel>

        <Panel title="Product details">
          <Row label="Fertilizer" value={esc.fertilizer} />
          <Row label="Crop" value={esc.crop} />
          <Row label="Risk level" value={esc.riskLevel} />
          <Row
            label="Substances"
            value={esc.substances && esc.substances.length > 0 ? esc.substances.join(", ") : "None flagged"}
          />
          <Row label="Date submitted" value={formatDate(esc.createdAt)} />
        </Panel>
      </div>

      <Panel title="AI explanation">
        <p className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap">
          {esc.explanation || "No system explanation recorded for this escalation. Use the notes below to record your assessment."}
        </p>
      </Panel>

      <Panel title="Update status">
        <div className="flex flex-wrap gap-2">
          {(["pending", "responded", "resolved"] as const).map((s) => {
            const active = (esc.status || "pending").toLowerCase() === s;
            return (
              <button
                key={s} onClick={() => updateStatus.mutate(s)} disabled={updateStatus.isPending}
                className={`px-3 py-1.5 text-sm rounded-md border capitalize transition ${
                  active
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background text-foreground border-rule hover:border-primary/50"
                }`}
              >{s}</button>
            );
          })}
        </div>
        {updateStatus.isError && (
          <p className="text-xs text-[color:var(--risky)] mt-2">
            {(updateStatus.error as Error).message}
          </p>
        )}
      </Panel>

      <Panel title="Your response notes">
        <textarea
          value={notes} onChange={(e) => setNotes(e.target.value)} rows={6}
          placeholder="Document your advice to the farmer, recommended actions, follow-ups…"
          className="w-full px-3 py-2 border border-rule rounded-md bg-background text-foreground text-sm outline-none focus:border-primary"
        />
        <div className="flex items-center gap-3 mt-3">
          <button onClick={saveNotes}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:opacity-90">
            Save notes
          </button>
          {savedNotice && <span className="text-xs text-emerald-700">Saved locally ✓</span>}
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Notes are stored on this device. The backend's escalation notes field is set when the farmer first escalates.
        </p>
      </Panel>
    </main>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-card border border-rule rounded-lg p-5">
      <h2 className="font-display text-lg text-foreground mb-3">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex justify-between py-1.5 text-sm border-b border-rule/60 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground font-medium text-right">{value || "—"}</span>
    </div>
  );
}

function formatDate(iso: string | null) {
  if (!iso) return null;
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
