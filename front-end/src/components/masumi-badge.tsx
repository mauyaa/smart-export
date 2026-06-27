// MasumiBadge — shows Masumi agent identity on the result card.
// Displayed after every /masumi/check response, or as a persistent
// "available as agent" indicator on the intro screen.

interface MasumiReceiptProps {
  receipt: {
    receipt_id: string;
    agent_id: string;
    network: string;
    sandbox: boolean;
    price_lovelace: number;
    validated_at: number;
    protocol: string;
  };
}

export function MasumiReceiptBadge({ receipt }: MasumiReceiptProps) {
  const ada = (receipt.price_lovelace / 1_000_000).toFixed(1);
  const network = receipt.sandbox ? "Sandbox" : receipt.network;

  return (
    <div className="mt-6 rounded-sm border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-2">
        <CardanoIcon className="h-4 w-4 shrink-0 text-[#0033AD]" />
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground">
          Masumi Agent Receipt
        </p>
        {receipt.sandbox && (
          <span className="ml-auto rounded-full bg-amber-100 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-amber-700">
            Sandbox
          </span>
        )}
      </div>

      <div className="mt-3 space-y-1.5 font-mono text-[11px] text-muted-foreground">
        <div className="flex justify-between gap-4">
          <span>Receipt</span>
          <span className="truncate text-foreground">{receipt.receipt_id}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span>Network</span>
          <span className="text-foreground">{network}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span>Price</span>
          <span className="text-foreground">{ada} ADA</span>
        </div>
        <div className="flex justify-between gap-4">
          <span>Protocol</span>
          <span className="text-foreground">{receipt.protocol}</span>
        </div>
      </div>

      <a
        href="https://masumi.network"
        target="_blank"
        rel="noreferrer noopener"
        className="mt-3 inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground transition hover:text-foreground"
      >
        masumi.network ↗
      </a>
    </div>
  );
}

/** Compact "agent available" badge shown on the intro screen */
export function MasumiAgentBadge() {
  return (
    <a
      href="https://masumi.network"
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
      title="SmartExports is registered as a paid AI agent on the Masumi / Cardano network"
    >
      <CardanoIcon className="h-3.5 w-3.5 text-[#0033AD]" />
      Masumi Agent · 1 ADA / check
    </a>
  );
}

function CardanoIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      {/* Cardano "ada" simplified mark */}
      <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm0 1.8a8.2 8.2 0 110 16.4A8.2 8.2 0 0112 3.8zm0 2.4a5.8 5.8 0 100 11.6A5.8 5.8 0 0012 6.2zm0 1.6a4.2 4.2 0 110 8.4 4.2 4.2 0 010-8.4zm-1 2v4.4l3.4 2-0.8 1.4L9 15V9.8l2-.6z" />
    </svg>
  );
}
