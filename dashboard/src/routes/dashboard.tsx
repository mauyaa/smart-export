import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { clearSession, getSession, type Expert } from "../lib/experts";


export const Route = createFileRoute("/dashboard")({
  head: () => ({ meta: [{ title: "Expert Dashboard — SmartExports" }] }),
  component: DashboardLayout,
});

function DashboardLayout() {
  const navigate = useNavigate();
  const [expert, setExpert] = useState<Expert | null>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    const s = getSession();
    if (!s) navigate({ to: "/" });
    else setExpert(s);
  }, [navigate]);

  if (!expert) return null;

  function signOut() {
    clearSession();
    navigate({ to: "/" });
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-rule bg-card">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <Link to="/dashboard" className="flex items-center gap-2.5">
            <img src="/app-icon.png" alt="" className="h-8 w-8 rounded-lg" />
            <span className="font-display text-xl text-foreground">SmartExports</span>
            <span className="text-xs uppercase tracking-wider text-muted-foreground border-l border-rule pl-2 ml-1">Expert</span>
          </Link>

          <div className="flex items-center gap-3">
            <a
              href="https://front-end-nu-rosy-90.vercel.app/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-muted-foreground hover:text-foreground hidden sm:inline"
            >
              Farmer app ↗
            </a>
            <div className="text-right hidden sm:block">
              <div className="text-sm font-medium text-foreground">{expert.name}</div>
              <div className="text-xs text-muted-foreground">{expert.organization}</div>
            </div>
            <button onClick={signOut}
              className="text-sm text-muted-foreground hover:text-foreground border border-rule px-3 py-1.5 rounded-md hover:bg-secondary">
              Sign out
            </button>
          </div>
        </div>
      </header>

      {pathname.startsWith("/dashboard/") && pathname !== "/dashboard/" && (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-4">
          <Link to="/dashboard" className="text-sm text-muted-foreground hover:text-foreground">
            ← Back to dashboard
          </Link>
        </div>
      )}

      <Outlet />
    </div>
  );
}
