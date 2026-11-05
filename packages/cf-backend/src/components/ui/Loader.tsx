/**
 * Waiting (docs/DESIGN-SYSTEM.md §2): Kumo's spinner, only inside a busy control or for under a second; content that
 * takes longer stands as skeleton bars where it will be.
 */
import { Loader as KumoLoader } from "@cloudflare/kumo";

export function Loader({ size = "base" }: { size?: "sm" | "base" | "lg" }) {
  return <KumoLoader size={size} />;
}
