/** The Gallery's client (room-api.ts): its pages of listings, a listed slate's own page, and starring or reporting one. */
import {
  GALLERY_REPORT_PATH, GALLERY_STAR_PATH, GalleryPageSchema, GallerySlateSchema, galleryPath, gallerySlatePath,
  type GalleryCategory, type GalleryPage, type GalleryReport, type GallerySlate, type GallerySort, type GalleryStar,
} from "@kinu.run/core";
import { settle } from "@kinu.run/core/obs";
import { posted, request } from "./http";

export function readGallery(query: { q: string; sort: GallerySort; category: GalleryCategory | null; page: number }): Promise<GalleryPage> {
  return settle(request(GalleryPageSchema, galleryPath(query)));
}

export function readGallerySlate(workspace: string, slate: string): Promise<GallerySlate> {
  return settle(request(GallerySlateSchema, gallerySlatePath(workspace, slate)));
}

export function starListing(star: GalleryStar): Promise<void> {
  return settle(posted(GALLERY_STAR_PATH, star));
}

export function reportListing(report: GalleryReport): Promise<void> {
  return settle(posted(GALLERY_REPORT_PATH, report));
}
