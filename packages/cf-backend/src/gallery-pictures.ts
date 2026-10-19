/**
 * The design gallery's pictures: what a slate or a workspace blueprint looks like at work, drawn once from mock slates
 * and frames of this gallery, and answered for the digests its fixtures name. Stands in for `lib/picture-src.ts`.
 */
import prBoard from "./gallery-assets/pr-board.webp";
import deploys from "./gallery-assets/deploys.webp";
import logs from "./gallery-assets/logs.webp";
import report from "./gallery-assets/report.webp";
import ghidra from "./gallery-assets/ghidra.webp";
import release from "./gallery-assets/release.webp";
import incident from "./gallery-assets/incident.webp";
import assistant from "./gallery-assets/assistant.webp";

const BY_DIGEST = new Map([
  ["pic-pr-board", prBoard],
  // The Gallery fixture's own PR review board (gallery-listings.tsx).
  ["fb78dc00234ee9eeda9437ad7af4cd8c89a6836d2111827b4df00569ecd26b74", prBoard],
  ["pic-deploys", deploys],
  ["pic-logs", logs],
  ["pic-report", report],
  ["pic-ghidra", ghidra],
  ["pic-release", release],
  ["pic-incident", incident],
  ["pic-assistant", assistant],
]);

export function pictureSrc(path: string): string {
  return BY_DIGEST.get(path.split("/").at(-1) ?? "") ?? path;
}
