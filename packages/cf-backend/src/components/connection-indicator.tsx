import type { ConnectionStatus } from "@/hooks/use-kinu";

const STATUS_MAP = {
  connected:    { dot: "bg-[var(--c-success)]", cls: "p-success", label: "Connected" },
  connecting:   { dot: "bg-[var(--c-warning)]", cls: "p-warning", label: "Connecting..." },
  disconnected: { dot: "bg-[var(--c-danger)]",  cls: "p-danger",  label: "Disconnected" },
  error:        { dot: "bg-[var(--c-danger)]",  cls: "p-danger",  label: "Error" },
} satisfies Record<ConnectionStatus, { dot: string; cls: string; label: string }>;

export function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const s = STATUS_MAP[status];
  return (
    <div className="flex shrink-0 items-center gap-2" role="status" aria-label={s.label}>
      <span className={`size-2 rounded-full ${s.dot}`} />
      {/* Healthy is the quiet default — the dot says it, and the ~70px the word
          costs is what pushes the header's two halves into each other. Trouble
          still gets words. */}
      {status !== "connected" && <span className={`text-xs ${s.cls}`}>{s.label}</span>}
    </div>
  );
}
