import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  getEscalations, getSession, updateEscalationStatus,
  riskClasses, statusClasses, type Escalation,
} from "../lib/experts";

export const Route = createFileRoute("/dashboard/")({
  component: DashboardHome,
});

function DashboardHome() {
  const expert = typeof window !== "undefined" ? getSession() : null;
  const qc = useQueryClient();

  const { data: escalations = [], isLoading, error } = useQuery({
    queryKey: ["escalations", expert?.id],
    queryFn: () => getEscalations(expert!.id),
    enabled: !!expert?.id,
  });

  const markResponded = useMutation({
    mutationFn: (id: string) => updateEscalationStatus(id, "responded"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["escalations", expert?.id] }),
  });

  const stats = useMemo(() => ({
    total: escalations.length,
    pending: escalations.filter(e => (e.status || "pending").toLowerCase() === "pending").length,
    responded: escalations.filter(e => e.status?.toLowerCase() === "responded").length,
    resolved: escalations.filter(e => e.status?.toLowerCase() === "resolved").length,
  }), [escalations]);

  if (!expert) return null;

  return (
    <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
      <div className="mb-8">
        <h1 className="font-display text-3xl text-foreground">Welcome, {expert.name.split(" ")[0]}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {expert.organization} · {escalations.length} escalation{escalations.length === 1 ? "" : "s"} assigned
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-8">
        <StatCard label="Total cases" value={stats.total} />
        <StatCard label="Pending" value={stats.pending} tone="amber" />
        <StatCard label="Responded" value={stats.responded} tone="blue" />
        <StatCard label="Resolved" value={stats.resolved} tone="green" />
      </div>

      <section className="bg-card border border-rule rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-rule">
          <h2 className="font-display text-lg text-foreground">Your escalations</h2>
        </div>

        {isLoading && <div className="p-8 text-center text-muted-foreground text-sm">Loading…</div>}
        {error && (
          <div className="p-8 text-center text-sm text-[color:var(--risky)]">
            Couldn't load escalations. {(error as Error).message}
          </div>
        )}
        {!isLoading && !error && escalations.length === 0 && (
          <div className="p-12 text-center">
            <p className="text-sm text-muted-foreground">
              No escalations assigned yet. They'll appear here when farmers escalate cases matching your expertise.
            </p>
          </div>
        )}

        {escalations.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-secondary/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <Th>Farmer</Th><Th>Crop</Th><Th>Fertilizer</Th>
                  <Th>Risk</Th><Th>County</Th><Th>Date</Th><Th>Status</Th><Th>Action</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {escalations.map((esc) => <Row key={esc.id} esc={esc} onMarkResponded={() => markResponded.mutate(esc.id)} pending={markResponded.isPending && markResponded.variables === esc.id} />)}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-3 font-medium">{children}</th>;
}

function Row({ esc, onMarkResponded, pending }: {
  esc: Escalation; onMarkResponded: () => void; pending: boolean;
}) {
  const status = (esc.status || "pending").toLowerCase();
  return (
    <tr className="hover:bg-secondary/30">
      <td className="px-4 py-3">
        <Link to="/dashboard/$id" params={{ id: esc.id }} className="font-medium text-foreground hover:text-primary">
          {esc.farmerName || "—"}
        </Link>
        {esc.farmerPhone && <div className="text-xs text-muted-foreground">{esc.farmerPhone}</div>}
      </td>
      <td className="px-4 py-3 text-foreground">{esc.crop}</td>
      <td className="px-4 py-3 text-foreground">{esc.fertilizer}</td>
      <td className="px-4 py-3">
        <span className={`inline-block px-2 py-0.5 rounded text-xs border ${riskClasses(esc.riskLevel)}`}>
          {esc.riskLevel}
        </span>
      </td>
      <td className="px-4 py-3 text-foreground">{esc.farmerCounty || "—"}</td>
      <td className="px-4 py-3 text-muted-foreground text-xs">{formatDate(esc.createdAt)}</td>
      <td className="px-4 py-3">
        <span className={`inline-block px-2 py-0.5 rounded text-xs border capitalize ${statusClasses(esc.status)}`}>
          {esc.status || "pending"}
        </span>
      </td>
      <td className="px-4 py-3">
        {status === "pending" ? (
          <button onClick={onMarkResponded} disabled={pending}
            className="text-xs px-3 py-1.5 bg-primary text-primary-foreground rounded hover:opacity-90 disabled:opacity-60">
            {pending ? "…" : "Mark Responded"}
          </button>
        ) : (
          <Link to="/dashboard/$id" params={{ id: esc.id }} className="text-xs text-primary hover:underline">
            View →
          </Link>
        )}
      </td>
    </tr>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone?: "amber" | "blue" | "green" }) {
  const accent = tone === "amber" ? "text-amber-700"
    : tone === "blue" ? "text-blue-700"
    : tone === "green" ? "text-emerald-700"
    : "text-foreground";
  return (
    <div className="bg-card border border-rule rounded-lg p-5">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-1 font-display text-3xl ${accent}`}>{value}</div>
    </div>
  );
}

function formatDate(iso: string | null) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch { return iso; }
}
