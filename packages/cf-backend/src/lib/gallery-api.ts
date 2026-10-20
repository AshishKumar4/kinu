/** The Gallery's client (room-api.ts): a listed slate's own page, and starring or reporting one. Its list is Explore's. */
import {
  GALLERY_REPORT_PATH, GALLERY_STAR_PATH, GallerySlateSchema, gallerySlatePath, type GalleryReport, type GallerySlate, type GalleryStar,
} from "@kinu.run/core";
import { settle } from "@kinu.run/core/obs";
import { posted, request } from "./http";

export function readGallerySlate(workspace: string, slate: string): Promise<GallerySlate> {
  return settle(request(GallerySlateSchema, gallerySlatePath(workspace, slate)));
}

export function starListing(star: GalleryStar): Promise<void> {
  return settle(posted(GALLERY_STAR_PATH, star));
}

export function reportListing(report: GalleryReport): Promise<void> {
  return settle(posted(GALLERY_REPORT_PATH, report));
}
