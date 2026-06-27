import { Download, Share2, WifiOff, X } from "lucide-react";
import { useEffect, useState } from "react";

import { useI18n } from "@/lib/i18n";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

function isStandalone() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator && (navigator as Navigator & { standalone?: boolean }).standalone)
  );
}

export function MobileAppStatus() {
  const { t } = useI18n();
  const [online, setOnline] = useState(true);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [canOfferInstall, setCanOfferInstall] = useState(false);
  const [showIosHelp, setShowIosHelp] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setOnline(navigator.onLine);

    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
      setCanOfferInstall(true);
    };
    const onInstalled = () => {
      setInstallEvent(null);
      setCanOfferInstall(false);
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("beforeinstallprompt", onInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);

    const isiOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const timer = window.setTimeout(() => {
      if (isiOS && !isStandalone()) setCanOfferInstall(true);
    }, 1800);

    if (import.meta.env.PROD && "serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js").catch(() => {
        // The application remains fully usable if service-worker registration is blocked.
      });
    }

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = async () => {
    if (!installEvent) {
      setShowIosHelp(true);
      return;
    }
    await installEvent.prompt();
    const { outcome } = await installEvent.userChoice;
    if (outcome === "accepted") setCanOfferInstall(false);
    setInstallEvent(null);
  };

  return (
    <>
      {!online && (
        <div
          className="offline-banner fixed inset-x-3 top-3 z-[70] mx-auto flex max-w-md items-center gap-3 rounded-lg bg-foreground px-4 py-3 text-sm text-background shadow-xl"
          role="status"
          aria-live="polite"
        >
          <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t.mobile.offline}</span>
        </div>
      )}

      {canOfferInstall && !dismissed && !isStandalone() && (
        <aside
          className="install-card fixed inset-x-3 bottom-3 z-[60] mx-auto max-w-md rounded-xl border border-border bg-card/95 p-4 shadow-2xl backdrop-blur-xl"
          aria-label={t.mobile.installTitle}
        >
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="absolute right-2 top-2 grid h-10 w-10 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t.mobile.dismiss}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>

          <div className="flex gap-3 pr-9">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-foreground text-background">
              <Download className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <p className="font-semibold tracking-tight">{t.mobile.installTitle}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {t.mobile.installBody}
              </p>
            </div>
          </div>

          {showIosHelp ? (
            <div className="mt-4 flex items-center gap-2 rounded-lg bg-muted px-3 py-2.5 text-xs leading-relaxed">
              <Share2 className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <span>{t.mobile.iosHelp}</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={install}
              className="mt-4 flex min-h-11 w-full items-center justify-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition active:scale-[0.99]"
            >
              {t.mobile.installCta}
            </button>
          )}
        </aside>
      )}
    </>
  );
}
