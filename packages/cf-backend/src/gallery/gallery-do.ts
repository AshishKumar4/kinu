/**
 * The Gallery: one object for the whole deployment, holding the index rooms write their listings to (`core
 * slates/gallery.ts`). Rooms list and unlist; the Gallery's routes read, star and report. It holds no slate and grants
 * nothing: a listing's link is the only way in.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  GalleryIndex, initGalleryTables, type GalleryEntry,
} from '@kinu.run/core/slates';
import type { GalleryCategory, GalleryListing, GalleryPage, GallerySlate, GallerySort } from '@kinu.run/core';

/** What a signed-in person does to a listing. */
export type GalleryMark =
  | { readonly kind: 'star'; readonly workspace: string; readonly slate: string; readonly on: boolean }
  | { readonly kind: 'report'; readonly workspace: string; readonly slate: string; readonly reason: string };

/** The one Gallery's object name. */
export const GALLERY_OBJECT = 'gallery';

export class GalleryDO extends DurableObject<Env> {
  private readonly index: GalleryIndex;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initGalleryTables((ddl) => { ctx.storage.sql.exec(ddl); });
    this.index = new GalleryIndex(ctx.storage.sql);
  }

  list(entry: GalleryEntry): void {
    this.index.list(entry, Date.now());
  }

  unlist(workspace: string, slate: string): void {
    this.index.unlist(workspace, slate);
  }

  forget(email: string): void {
    this.index.forget(email);
  }

  pictured(workspace: string, slate: string, digest: string): void {
    this.index.pictured(workspace, slate, digest);
  }

  page(query: { readonly q: string; readonly sort: GallerySort; readonly category: GalleryCategory | null; readonly page: number }, viewer: string | null): GalleryPage {
    return this.index.page(query, viewer, Date.now());
  }

  slate(workspace: string, slate: string, viewer: string | null): GallerySlate | null {
    return this.index.slate(workspace, slate, viewer, Date.now());
  }

  listed(workspace: string, slate: string): { readonly picture: string | null } | null {
    return this.index.listed(workspace, slate);
  }

  /** A signed-in person's star, its withdrawal, or their report; false when the slate is not listed. */
  mark(email: string, mark: GalleryMark): boolean {
    const at = { email, workspace: mark.workspace, slate: mark.slate };

    return mark.kind === 'star' ? this.index.star({ ...at, on: mark.on }, Date.now()) : this.index.report({ ...at, reason: mark.reason }, Date.now());
  }

  starred(email: string): GalleryListing[] {
    return this.index.starred(email, Date.now());
  }


}
