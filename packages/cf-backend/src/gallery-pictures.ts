/**
 * The design gallery's pictures: what a slate looks like at work, captured once from mock slates of this gallery, and
 * answered for the digests its fixtures name (core `web/picture-src.ts` `answerPictures`, at the gallery's start): the
 * gallery's server is static, so a picture route the app addresses is read from these files instead.
 */
import prBoard from "./gallery-assets/pr-board.webp";
import logs from "./gallery-assets/logs.webp";
import ghidra from "./gallery-assets/ghidra.webp";
import incident from "./gallery-assets/incident.webp";

const PUBLIC = `${import.meta.env.BASE_URL}assets/explore`;

/** The digests the gallery's fixtures name a slate's picture by; each is a capture below. */
export const GALLERY_PICTURE = {
  prBoard: "pic-pr-board",
  logs: "pic-logs",
  ghidra: "pic-ghidra",
  incident: "pic-incident",
  deploys: "pic-deploys",
  report: "pic-report",
  release: "pic-release",
  assistant: "pic-assistant",
} as const;

const BY_DIGEST = new Map<string, string>([
  [GALLERY_PICTURE.prBoard, prBoard],
  // The Gallery fixture's own PR review board (gallery-listings.tsx).
  ["fb78dc00234ee9eeda9437ad7af4cd8c89a6836d2111827b4df00569ecd26b74", prBoard],
  [GALLERY_PICTURE.logs, logs],
  [GALLERY_PICTURE.ghidra, ghidra],
  [GALLERY_PICTURE.incident, incident],
  [GALLERY_PICTURE.deploys, `${PUBLIC}/deploys.webp`],
  [GALLERY_PICTURE.report, `${PUBLIC}/report.webp`],
  [GALLERY_PICTURE.release, `${PUBLIC}/release.webp`],
  [GALLERY_PICTURE.assistant, `${PUBLIC}/assistant.webp`],
]);

/** A picture path's last segment is its digest; one the gallery holds is its file. */
export function galleryPicture(path: string): string | null {
  return BY_DIGEST.get(path.split("/").at(-1) ?? "") ?? null;
}
