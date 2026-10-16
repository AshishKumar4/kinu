/**
 * The Gallery: one object for the whole deployment, holding the index rooms write their listings to (`core
 * slates/gallery.ts`). Rooms list and unlist; the Gallery's routes read, star and report. It holds no slate and grants
 * nothing: a listing's link is the only way in.
 */
import { DurableObject } from 'cloudflare:workers';
import { Effect } from 'effect';
import {
  GalleryIndex, initGalleryTables, type GalleryEntry,
} from '@kinu.run/core/slates';
import {
  censusOf, durableStamps, readStamp, repairSchema, requireOps, SCHEMA_TABLES, StoragePredatesReleaseError, writeStamp,
  type GalleryCategory, type GalleryListing, type GalleryPage, type GallerySlate, type GallerySort, type OpsCaller, type Repair, type TablesAnswer,
} from '@kinu.run/core';
import { settleSync } from '@kinu.run/core/obs';

/** What a signed-in person does to a listing. */
export type GalleryMark =
  | { readonly kind: 'star'; readonly workspace: string; readonly slate: string; readonly on: boolean }
  | { readonly kind: 'report'; readonly workspace: string; readonly slate: string; readonly reason: string };

/** The one Gallery's object name. */
export const GALLERY_OBJECT = 'gallery';

export class GalleryDO extends DurableObject<Env> {
  private readonly gallery: GalleryIndex;

  /** What this activation's repair did, for the deploy's walk; null where the storage was at this build. */
  private readonly schemaRepair: Repair | null;

  /** Why the Gallery's storage may not be read: its repair could not bring it to this build. */
  private readonly storageRefusal: StoragePredatesReleaseError | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Asked once, never caught, as every class's database is (core state/schema-repair.ts). The Gallery is made on its
    // first activation: what it holds is the rooms' listings, which each listed room writes again on its next sync.
    const stamps = durableStamps(ctx.storage.kv);
    const init = (): void => { initGalleryTables((ddl) => { ctx.storage.sql.exec(ddl); }); };

    this.schemaRepair = repairSchema(ctx.storage.sql, {
      schema: 'gallery', tables: SCHEMA_TABLES.gallery, stamps, transactionSync: (write) => ctx.storage.transactionSync(write), init,
    }, 'gallery');

    if (this.schemaRepair?.refused != null) this.storageRefusal = new StoragePredatesReleaseError('gallery', this.schemaRepair.refused);

    if (this.storageRefusal === undefined && readStamp(stamps, ctx.storage.sql, 'gallery') === 'unmade') {
      init();
      writeStamp(stamps, 'gallery');
    }

    this.gallery = new GalleryIndex(ctx.storage.sql);
  }

  /** The Gallery's index, once its storage is this build's: what every member reads it through, refused otherwise. */
  private ready(): Effect.Effect<GalleryIndex, StoragePredatesReleaseError> {
    return this.storageRefusal === undefined ? Effect.succeed(this.gallery) : Effect.fail(this.storageRefusal);
  }

  /** The deploy's walk: the Gallery's tables and what its repair did. */
  async opsTables(caller: OpsCaller): Promise<TablesAnswer> {
    await requireOps(this.env, caller);

    return {
      name: GALLERY_OBJECT, census: censusOf(this.ctx.storage.sql), repair: this.schemaRepair, refused: this.storageRefusal?.reason ?? null,
      workspaces: [], accounts: [], agents: [], rooms: [],
    };
  }

  list(entry: GalleryEntry): void {
    return settleSync(Effect.map(this.ready(), (index) => { index.list(entry, Date.now()); }));
  }

  unlist(workspace: string, slate: string): void {
    return settleSync(Effect.map(this.ready(), (index) => { index.unlist(workspace, slate); }));
  }

  forget(email: string): void {
    return settleSync(Effect.map(this.ready(), (index) => { index.forget(email); }));
  }

  pictured(workspace: string, slate: string, digest: string): void {
    return settleSync(Effect.map(this.ready(), (index) => { index.pictured(workspace, slate, digest); }));
  }

  page(query: { readonly q: string; readonly sort: GallerySort; readonly category: GalleryCategory | null; readonly page: number }, viewer: string | null): GalleryPage {
    return settleSync(Effect.map(this.ready(), (index) => index.page(query, viewer, Date.now())));
  }

  slate(workspace: string, slate: string, viewer: string | null): GallerySlate | null {
    return settleSync(Effect.map(this.ready(), (index) => index.slate(workspace, slate, viewer, Date.now())));
  }

  listed(workspace: string, slate: string): { readonly picture: string | null } | null {
    return settleSync(Effect.map(this.ready(), (index) => index.listed(workspace, slate)));
  }

  /** A signed-in person's star, its withdrawal, or their report; false when the slate is not listed. */
  mark(email: string, mark: GalleryMark): boolean {
    const at = { email, workspace: mark.workspace, slate: mark.slate };

    return settleSync(Effect.map(this.ready(), (index) => (mark.kind === 'star' ? index.star({ ...at, on: mark.on }, Date.now()) : index.report({ ...at, reason: mark.reason }, Date.now()))));
  }

  starred(email: string): GalleryListing[] {
    return settleSync(Effect.map(this.ready(), (index) => index.starred(email, Date.now())));
  }


}
