/** The Gallery's client (room-api.ts): its pages of listings, a listed slate's own page, and starring or reporting one. */
import { Effect } from "effect";
import {
  GALLERY_REPORT_PATH, GALLERY_STAR_PATH, GalleryPageSchema, GallerySlateSchema, galleryPath, gallerySlatePath,
  type GalleryCategory, type GalleryPage, type GalleryReport, type GallerySlate, type GallerySort, type GalleryStar,
} from "@kinu.run/core";
import { settle } from "@kinu.run/core/obs";
import { refusal, request, respond } from "./http";

export function readGallery(query: { q: string; sort: GallerySort; category: GalleryCategory | null; page: number }): Promise<GalleryPage> {
  return settle(request(GalleryPageSchema, galleryPath(query)));
}

export function readGallerySlate(workspace: string, slate: string): Promise<GallerySlate> {
  return settle(request(GallerySlateSchema, gallerySlatePath(workspace, slate)));
}

/** A POST the Gallery answers with no body. */
function sent(path: string, json: GalleryStar | GalleryReport): Effect.Effect<void> {
  return Effect.gen(function* () {
    const answer = yield* respond(path, { method: "POST", json });

    if (!answer.ok) return yield* Effect.die(yield* refusal(answer, "POST", path));
  });
}

export function starListing(star: GalleryStar): Promise<void> {
  return settle(sent(GALLERY_STAR_PATH, star));
}

export function reportListing(report: GalleryReport): Promise<void> {
  return settle(sent(GALLERY_REPORT_PATH, report));
}
