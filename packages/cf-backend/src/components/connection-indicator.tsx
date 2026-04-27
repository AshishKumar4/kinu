import type { ConnectionStatus } from "@/hooks/use-proteus";

const STATUS_MAP: Record<ConnectionStatus, { dot: string; cls: string; label: string }> = {
  connected:    { dot: "bg-[var(--c-success)]", cls: "p-success", label: "Connected" },
  connecting:   { dot: "bg-[var(--c-warning)]", cls: "p-warning", label: "Connecting..." },
  disconnected: { dot: "bg-[var(--c-danger)]",  cls: "p-danger",  label: "Disconnected" },
  error:        { dot: "bg-[var(--c-danger)]",  cls: "p-danger",  label: "Error" },
};

export function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const s = STATUS_MAP[status] ?? STATUS_MAP.disconnected;
  return (
    <div className="flex items-center gap-2" role="status">
      <span className={`size-2 rounded-full ${s.dot}`} />
      <span className={`text-xs ${s.cls}`}>{s.label}</span>
    </div>
  );
}
