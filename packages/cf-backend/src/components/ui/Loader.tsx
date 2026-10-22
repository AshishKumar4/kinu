/**
 * Waiting (docs/DESIGN-SYSTEM.md §2): Kumo's spinner, only inside a busy control or for under a second; content that
 * takes longer stands as skeleton bars where it will be.
 */
import { Loader as KumoLoader } from "@cloudflare/kumo";

export function Loader({ size = "base" }: { size?: "sm" | "base" | "lg" }) {
  return <KumoLoader size={size} />;
}

/** `lines` bars, the last shorter, as text will sit. */
export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div aria-hidden className="space-y-2" data-skeleton>
      {Array.from({ length: lines }, (_, at) => <div key={at} className={`p-skeleton-bar h-3 rounded-[var(--r-pill)] ${at === lines - 1 ? "w-3/5" : "w-full"}`} />)}
    </div>
  );
}
