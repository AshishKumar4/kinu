import { Effect, Cause } from 'effect';
import type { Browser, BrowserWorker } from '@cloudflare/puppeteer';
import * as v from 'valibot';
import { DARK_PICTURE, isWorkspaceName, markStoreChanged, sha256Hex, VIEWER_EXCHANGE_PATH, type RawSqlExec, type SqlExec } from '@kinu.run/core';
import { SlateDirectoryName } from '@kinu.run/core/slates';
import { diagnostics, recording, toKinuError, settle } from '@kinu.run/core/obs';
import { PREVIEW_CAPABILITY_HANDLE_LENGTH } from '../workspace-host';

const AFTER_LAST_RENDER_MS = 30_000;

const AFTER_FIRST_RENDER_MS = 120_000;

const RETRY_MS = 30_000;

const LOCAL_DEV_ZONE = '.localhost';

const ATTEMPTS = 3;

/** A picture no row names any more is kept this long: past the 30 days a restore of the workspace reaches, and a day,
 *  so a workspace restored to a moment before it was replaced finds the picture its row names (ARCHITECTURE-DECISIONS
 *  W7). */
const GRAVE_MS = 31 * 86_400_000;

const SHOTS_PER_TICK = 3;

const CAPTURE_HANDLE_LIFE_MS = 120_000;

/** The view of a slate its owner's private preview shows: every other view is a listed share's, named by its id. */
const PREVIEW_VIEW = 'preview';

/**
 * One picture per slate and view. `preview` is the owner's private preview, entered by its port with a capture handle
 * of its own: it draws with the owner's own reads, so it is the owner's alone (their Drive). Any other view is a listed
 * share's, taken through the share's own host as a visitor with no account who continued past its consent page, so
 * under the share's own authority in its own mode: only these are ever a Gallery card's. `listing` is a share view's
 * incarnation, minted as its listing makes it and never reused, so a shot taken for one listing never lands in the next.
 * `taken` is the publication a share's picture was taken at; it is due again once its listing is read at another. Rows
 * are a cache the camera refills, and rows predating views are the preview's.
 */
export function initSlatePictureTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS slate_pictures ( /* refilled by packages/cf-backend/src/slates/pictures.ts */
    slate          TEXT NOT NULL,
    view           TEXT NOT NULL DEFAULT 'preview',
    listing        TEXT,
    port           INTEGER,
    digest         TEXT,
    taken          TEXT,
    due_at         INTEGER,
    due_since      INTEGER,
    attempts       INTEGER NOT NULL DEFAULT 0,
    capture_handle TEXT,
    capture_until  INTEGER,
    PRIMARY KEY (slate, view)
  )`);
  // A picture's R2 object no row names any more, deleted once `due_at` passes ({@link GRAVE_MS}).
  execRaw(`CREATE TABLE IF NOT EXISTS slate_picture_graves (
    key    TEXT PRIMARY KEY,
    due_at INTEGER NOT NULL
  )`);
}

const DueRowSchema = v.object({
  slate: v.string(), view: v.string(), listing: v.nullable(v.string()), port: v.nullable(v.number()), digest: v.nullable(v.string()), attempts: v.number(),
});

type DuePicture = v.InferOutput<typeof DueRowSchema>;

const StoredRowSchema = v.object({ slate: v.string(), digest: v.string() });

const NamedRowSchema = v.object({ slate: v.string(), view: v.string(), digest: v.string() });

export class SlatePictures {
  constructor(private readonly db: SqlExec) {}

  rendered(slate: string, port: number, now: number): void {
    this.db.exec(
      `INSERT INTO slate_pictures (slate, view, port, due_at, due_since) VALUES (?, '${PREVIEW_VIEW}', ?, ?, ?)
       ON CONFLICT (slate, view) DO UPDATE SET port = excluded.port, attempts = 0,
         due_since = COALESCE(slate_pictures.due_since, excluded.due_since),
         due_at = MIN(excluded.due_at, COALESCE(slate_pictures.due_since, excluded.due_since) + ?)`,
      slate, port, now + AFTER_LAST_RENDER_MS, now, AFTER_FIRST_RENDER_MS,
    );
  }

  /**
   * `share` of `slate` listed at `publication`: its view due a picture, unless one is due already or its picture was
   * taken at that publication.
   */
  listed(slate: string, share: string, publication: string, now: number): void {
    this.db.exec(`INSERT INTO slate_pictures (slate, view, listing) VALUES (?, ?, ?) ON CONFLICT (slate, view) DO NOTHING`, slate, share, captureToken());
    this.db.exec(
      `UPDATE slate_pictures SET due_at = ?, attempts = 0 WHERE slate = ? AND view = ? AND due_at IS NULL AND taken IS NOT ?`,
      now + AFTER_LAST_RENDER_MS, slate, share, publication,
    );
  }

  /** The digest of `share`'s picture of `slate`, taken through the share; null until one is. */
  shareDigest(slate: string, share: string): string | null {
    const [row] = this.db.exec(`SELECT digest FROM slate_pictures WHERE slate = ? AND view = ? AND view <> '${PREVIEW_VIEW}'`, slate, share).toArray();

    return row === undefined ? null : v.parse(v.object({ digest: v.nullable(v.string()) }), row).digest;
  }

  /**
   * `share` listed no more: its view goes at once, so a listing made later is a view of its own, then its pictures. R2
   * refusing to list them leaves them to go with the slate.
   */
  unlisted(workspace: string, slate: string, share: string, bucket: PictureBucket | undefined): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      this.db.exec(`DELETE FROM slate_pictures WHERE slate = ? AND view = ? AND view <> '${PREVIEW_VIEW}'`, slate, share);
      markStoreChanged(this.db);

      if (bucket !== undefined) this.bury(yield* Effect.promise(() => listedKeys(bucket, sharePicturePrefix(workspace, slate, share))), Date.now());
    }));
  }

  nextDueAt(): number | null {
    const [row] = this.db.exec(`SELECT MIN(at) AS at FROM (SELECT MIN(due_at) AS at FROM slate_pictures UNION ALL SELECT MIN(due_at) FROM slate_picture_graves)`).toArray();

    return v.parse(v.object({ at: v.nullable(v.number()) }), row).at;
  }

  /** `keys` named by no row now: each deleted {@link GRAVE_MS} from `now`, unless a row names it again first. */
  private bury(keys: readonly string[], now: number): void {
    for (const key of keys) {
      this.db.exec(`INSERT INTO slate_picture_graves (key, due_at) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET due_at = MAX(due_at, excluded.due_at)`, key, now + GRAVE_MS);
    }
  }

  /**
   * A shot no row came to name, deleted at once: every key a row stops naming is buried first (a replacement, a removal,
   * an unlisting), so one with no grave was never named and no restore can name it. One with a grave keeps its due.
   */
  private discarded(bucket: PictureBucket, keys: readonly string[]): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const unnamed = keys.filter((key) => this.db.exec(`SELECT 1 FROM slate_picture_graves WHERE key = ?`, key).toArray().length === 0);

      if (unnamed.length > 0) yield* Effect.promise(async () => bucket.delete([...unnamed]));
    });
  }

  /** The pictures whose grace has passed, deleted from R2, then their graves. */
  private swept(bucket: PictureBucket, now: number): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const due = this.db.exec(`SELECT key FROM slate_picture_graves WHERE due_at <= ?`, now).toArray().map((row) => v.parse(v.object({ key: v.string() }), row).key);

      if (due.length === 0) return;
      yield* Effect.promise(async () => bucket.delete([...due]));

      for (const key of due) this.db.exec(`DELETE FROM slate_picture_graves WHERE key = ?`, key);
    });
  }

  private due(now: number): DuePicture[] {
    return this.db.exec(`SELECT slate, view, listing, port, digest, attempts FROM slate_pictures WHERE due_at <= ? ORDER BY due_at`, now).toArray()
      .map((row) => v.parse(DueRowSchema, row));
  }

  private removed(picture: DuePicture): boolean {
    return this.db.exec(`SELECT 1 AS x FROM slate_pictures WHERE slate = ? AND view = ?`, picture.slate, picture.view).toArray().length === 0;
  }

  /** Whether `picture`'s view is still the listing it was due for: unlisted and listed again, it is a view of its own. */
  private sameListing(picture: DuePicture): boolean {
    return this.db.exec(`SELECT 1 AS x FROM slate_pictures WHERE slate = ? AND view = ? AND listing IS ?`, picture.slate, picture.view, picture.listing).toArray().length > 0;
  }

  /** Whether `handle` is a preview capture's own, open on `port` now: only a preview view's shot opens one. */
  captures(port: number, handle: string, now: number): boolean {
    return this.db.exec(
      `SELECT 1 AS x FROM slate_pictures WHERE view = '${PREVIEW_VIEW}' AND port = ? AND capture_handle = ? AND capture_until > ?`, port, handle, now,
    ).toArray().length > 0;
  }

  private openCapture(slate: string, handle: string, until: number): void {
    this.db.exec(`UPDATE slate_pictures SET capture_handle = ?, capture_until = ? WHERE slate = ? AND view = '${PREVIEW_VIEW}'`, handle, until, slate);
  }

  private closeCapture(slate: string): void {
    this.db.exec(`UPDATE slate_pictures SET capture_handle = NULL, capture_until = NULL WHERE slate = ? AND view = '${PREVIEW_VIEW}'`, slate);
  }

  /** `keys` are its new version's places, named again, so no grave holds them. */
  private stored(picture: DuePicture, digest: string, taken: string | null, keys: readonly string[]): void {
    this.db.exec(
      `UPDATE slate_pictures SET digest = ?, taken = ?, due_at = NULL, due_since = NULL, attempts = 0 WHERE slate = ? AND view = ?`,
      digest, taken, picture.slate, picture.view,
    );

    for (const key of keys) this.db.exec(`DELETE FROM slate_picture_graves WHERE key = ?`, key);
    markStoreChanged(this.db);
  }

  /** A shot of `picture` that failed: its own listing waits longer, or gives up; a listing that replaced it is left due. */
  private failed(picture: DuePicture, now: number): void {
    const attempts = picture.attempts + 1;
    const at = [picture.slate, picture.view, picture.listing] as const;

    if (attempts >= ATTEMPTS) {
      this.db.exec(`UPDATE slate_pictures SET due_at = NULL, due_since = NULL, attempts = 0 WHERE slate = ? AND view = ? AND listing IS ?`, ...at);

      return;
    }

    this.db.exec(`UPDATE slate_pictures SET due_at = ?, attempts = ? WHERE slate = ? AND view = ? AND listing IS ?`, now + RETRY_MS * 2 ** attempts, attempts, ...at);
  }

  /** Each slate's private preview picture, for its owner alone. */
  digests(): ReadonlyMap<string, string> {
    return new Map(this.db.exec(`SELECT slate, digest FROM slate_pictures WHERE view = '${PREVIEW_VIEW}' AND digest IS NOT NULL`).toArray().map((row) => {
      const picture = v.parse(StoredRowSchema, row);

      return [picture.slate, picture.digest];
    }));
  }

  /** The R2 key of each picture a row names: its light capture, which every stored version has. */
  namedKeys(workspace: string): string[] {
    return this.db.exec(`SELECT slate, view, digest FROM slate_pictures WHERE digest IS NOT NULL`).toArray().map((row) => {
      const named = v.parse(NamedRowSchema, row);

      return viewPictureKey(workspace, named, named.digest);
    });
  }

  /** Left open: a shot whose put lands between this listing and the row's removal keeps its object; rare, and teardown reclaims it. */
  forget(workspace: string, slate: string, bucket: PictureBucket | undefined, now = Date.now()): Promise<void> {
    return settle(Effect.catchCause(Effect.gen({ self: this }, function* () {
      if (bucket !== undefined) this.bury(yield* Effect.promise(() => listedKeys(bucket, picturePrefix(workspace, slate))), now);
      this.db.exec(`DELETE FROM slate_pictures WHERE slate = ?`, slate);
      markStoreChanged(this.db);
    }), recording({ doing: `deleting the pictures of removed slate ${slate}`, otherwise: 'unavailable' }, (failure) => {
      this.db.exec(
        `UPDATE slate_pictures SET due_at = ? + ? * (1 << MIN(attempts, 7)), due_since = NULL, attempts = attempts + 1 WHERE slate = ?`,
        Date.now(), RETRY_MS, slate,
      );
      diagnostics.failure('slate.picture_delete_failed', failure, { workspace, slate });
    })));
  }

  captureDue(capture: PictureCapture, now: number): Promise<boolean> {
    return settle(Effect.gen({ self: this }, function* () {
      yield* this.swept(capture.bucket, now);
      const due = this.due(now);

      if (due.length === 0) return false;
      const live = yield* Effect.promise(async () => capture.slates());

      for (const picture of due) {
        if (!live.has(picture.slate)) yield* Effect.promise(async () => this.forget(capture.workspace, picture.slate, capture.bucket, now));
      }

      const shots = due.filter((picture) => live.has(picture.slate));

      if (shots.length === 0) return false;
      let camera: Camera;

      yield* Effect.catchCause(Effect.gen({ self: this }, function* () {
        camera = yield* Effect.promise(async () => capture.camera());
      }), (failed) => Effect.gen({ self: this }, function* () {
        for (const picture of shots) this.failed(picture, Date.now());

        return yield* Effect.failCause(failed);
      }));

      let changed = false;

      yield* Effect.ensuring(Effect.gen({ self: this }, function* () {
        for (const picture of shots.slice(0, SHOTS_PER_TICK)) {
          yield* Effect.catchCause(Effect.gen({ self: this }, function* () {
            changed = (yield* this.shoot(camera, capture, picture, now)) || changed;
          }), (failed) => Effect.sync(() => {
            const cause = Cause.squash(failed);
            this.failed(picture, Date.now());
            diagnostics.failure('slate.picture_failed', toKinuError({
              doing: `photographing slate ${picture.slate}`, cause, otherwise: 'unavailable',
            }), { workspace: capture.workspace, slate: picture.slate, attempts: picture.attempts + 1 });
          }));
        }
      }), Effect.gen({ self: this }, function* () {
        yield* Effect.promise(async () => camera.close());
      }));

      return changed;
    }));
  }

  private shoot(camera: Camera, capture: PictureCapture, picture: DuePicture, now: number): Effect.Effect<boolean> {
    return picture.view === PREVIEW_VIEW ? this.shootPreview(camera, capture, picture, now) : this.shootShare(camera, capture, picture, now);
  }

  /** The owner's private preview, entered by its port with a capture handle open only while it is shot. */
  private shootPreview(camera: Camera, capture: PictureCapture, picture: DuePicture, now: number): Effect.Effect<boolean> {
    return Effect.gen({ self: this }, function* () {
      const token = captureToken();
      this.openCapture(picture.slate, token.slice(0, PREVIEW_CAPABILITY_HANDLE_LENGTH), Date.now() + CAPTURE_HANDLE_LIFE_MS);

      return yield* Effect.ensuring(Effect.gen({ self: this }, function* () {
        const { port } = picture;
        const url = port === null ? null : yield* Effect.promise(async () => capture.url(port, token));

        if (url === null) return yield* Effect.die(new Error('this deployment has no preview host'));

        // The owner's own preview, kept as theirs alone while its slate is: no share's view ever takes it.
        return yield* this.kept(camera, capture, picture, { url, taken: null, holds: () => !this.removed(picture), now });
      }), Effect.sync(() => {
        this.closeCapture(picture.slate);
      }));
    });
  }

  /** A listed share's picture, taken through its own host past its consent page; listed no more, none is taken. */
  private shootShare(camera: Camera, capture: PictureCapture, picture: DuePicture, now: number): Effect.Effect<boolean> {
    return Effect.gen({ self: this }, function* () {
      const entry = yield* Effect.promise(async () => capture.share(picture.view));

      if (entry === null) {
        this.db.exec(`UPDATE slate_pictures SET due_at = NULL, attempts = 0 WHERE slate = ? AND view = ? AND listing IS ?`, picture.slate, picture.view, picture.listing);

        return false;
      }

      // Kept only for the listing it was due for, under the share's authority as it stood as the shot began.
      return yield* this.kept(camera, capture, picture, { url: entry.url, taken: entry.publication, holds: () => entry.held() && this.sameListing(picture), now });
    });
  }

  /**
   * The shot at `url`, stored under its digest in its view's own place, and the one before it buried for {@link GRAVE_MS}
   * from `now`. `holds` is read once the shot is in R2, with nothing awaited before it is kept: what no longer holds
   * keeps nothing of it. A slate
   * that draws itself dark too has that capture beside it (`DARK_PICTURE`), the digest naming the pair; one that draws
   * the same either way has its light capture alone, by its own digest.
   */
  private kept(
    camera: Camera, capture: PictureCapture, picture: DuePicture,
    at: { readonly url: string; readonly taken: string | null; readonly holds: () => boolean; readonly now: number },
  ): Effect.Effect<boolean> {
    return Effect.gen({ self: this }, function* () {
      const shots = yield* Effect.promise(async () => camera.shoot(at.url));
      const dark = sha256Hex(shots.dark) === sha256Hex(shots.light) ? null : shots.dark;
      const digest = dark === null ? sha256Hex(shots.light) : sha256Hex(Buffer.concat([shots.light, dark]));
      const changed = digest !== picture.digest;
      const keys = versionKeys(capture.workspace, picture, digest);

      if (changed) {
        yield* Effect.promise(async () => capture.bucket.put(keys[0], shots.light, { httpMetadata: { contentType: 'image/webp' } }));

        if (dark !== null) yield* Effect.promise(async () => capture.bucket.put(keys[1], dark, { httpMetadata: { contentType: 'image/webp' } }));
      }

      if (!at.holds()) {
        if (changed) yield* this.discarded(capture.bucket, keys);

        return false;
      }

      this.stored(picture, digest, at.taken, keys);
      const previous = picture.digest;

      if (changed && previous !== null) this.bury(versionKeys(capture.workspace, picture, previous), at.now);

      return changed;
    });
  }
}

/** A slate as the camera took it: as it draws in a light page, then in a dark one. */
export interface Shots {
  readonly light: Uint8Array;
  readonly dark: Uint8Array;
}

export interface Camera {
  shoot(url: string): Promise<Shots>;
  close(): Promise<void>;
}

export interface PictureBucket {
  get(key: string): Promise<{ readonly body: ReadableStream; readonly httpEtag: string } | null>;
  put(key: string, value: Uint8Array, options: { httpMetadata: { contentType: string } }): Promise<void>;
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix: string; cursor?: string }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
}

/** Every key under `prefix`, page by page. */
async function listedKeys(bucket: PictureBucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];

  for (let cursor: string | undefined, more = true; more;) {
    const listed = await bucket.list(cursor === undefined ? { prefix } : { prefix, cursor });

    keys.push(...listed.objects.map((object) => object.key));
    more = listed.truncated;
    cursor = listed.cursor;
  }

  return keys;
}

export interface PictureCapture {
  readonly workspace: string;
  readonly bucket: PictureBucket;
  url(port: number, token: string): Promise<string | null>;
  /**
   * A listed share's host entered past its consent page (`shareCaptureUrl`), the publication it serves now, and whether
   * the authority the shot is taken under still holds where it would be kept (`SlateLiveShareStore.galleryCapture`);
   * null once it is listed no more.
   */
  share(share: string): Promise<{ readonly url: string; readonly publication: string; held(): boolean } | null>;
  /** With broken ones. */
  slates(): Promise<ReadonlySet<string>>;
  camera(): Promise<Camera>;
}

/** Loaded on first capture, not at cold start: its own 640 KB chunk (e6aff5c5b), compiled then (b179dead9). */
export async function browserCamera(binding: Pick<BrowserRun, 'fetch'>): Promise<Camera> {
  const { default: puppeteer } = await import('@cloudflare/puppeteer');
  // Puppeteer types the binding's fetch as the global one, whose `preconnect` is a hint it never gives.
  const worker: BrowserWorker = { fetch: Object.assign((input: RequestInfo | URL, init?: RequestInit) => binding.fetch(input, init), { preconnect: () => undefined }) };
  const browser = await puppeteer.launch(worker);

  return { shoot: (url) => photograph(browser, url), close: () => browser.close() };
}

function captureToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(12))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Waits on load, not the network: a streaming slate never idles. Taken light, then dark with the page as it stands:
 *  `prefers-color-scheme` is what a slate's own CSS reads, so a slate that draws a dark of its own does so. */
async function photograph(browser: Browser, url: string): Promise<Shots> {
  const page = await browser.newPage();

  try {
    if (new URL(url).hostname.endsWith(LOCAL_DEV_ZONE)) {
      await (await page.createCDPSession()).send('Security.setIgnoreCertificateErrors', { ignore: true });
    }

    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 0.5 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);

    const response = await page.goto(url, { waitUntil: 'load', timeout: CAPTURE_HANDLE_LIFE_MS });

    if (response === null || !response.ok()) throw new Error(`the preview answered ${String(response?.status() ?? 'nothing')}`);

    const inScheme = async (scheme: 'light' | 'dark'): Promise<Uint8Array> => {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      // Two frames drawn: what the scheme set out is on the page.
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => { requestAnimationFrame(() => { resolve(); }); });
      }));

      return await page.screenshot({ type: 'webp', quality: 80 });
    };

    return { light: await inScheme('light'), dark: await inScheme('dark') };
  } finally {
    await page.close();
  }
}

/** A picture as a route names it: its slate, and the digest of one version, its dark capture's with `DARK_PICTURE`. */
export const PictureAddressSchema = v.object({
  workspace: v.pipe(v.string(), v.check(isWorkspaceName)),
  slate: SlateDirectoryName,
  digest: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}(?:-dark)?$/u)),
});

/** The version a picture address names, without its mode. */
export function pictureVersion(digest: string): string {
  return digest.endsWith(DARK_PICTURE) ? digest.slice(0, -DARK_PICTURE.length) : digest;
}

/**
 * A picture's bytes by its {@link pictureKey}, for a caller its route admitted: the owner's own route, or the Gallery's
 * for a listed slate. `cache` is who may keep them; a digest names one version, so either keeps it for good. Null when
 * there is none.
 */
async function readSlatePicture(bucket: PictureBucket, key: string, cache: 'private' | 'public'): Promise<Response | null> {
  const object = await bucket.get(key);

  if (object === null) return null;

  return new Response(object.body, {
    headers: { 'content-type': 'image/webp', 'cache-control': `${cache}, max-age=31536000, immutable`, etag: object.httpEtag },
  });
}

/** A picture in the mode its address asks: the dark capture where the slate drew one, else its light one. */
export async function readPictureInMode(bucket: PictureBucket, keyOf: (digest: string) => string, digest: string, cache: 'private' | 'public'): Promise<Response | null> {
  const dark = digest === pictureVersion(digest) ? null : await readSlatePicture(bucket, keyOf(digest), cache);

  return dark ?? await readSlatePicture(bucket, keyOf(pictureVersion(digest)), cache);
}


export function pictureKey(workspace: string, slate: string, digest: string): string {
  return `${picturePrefix(workspace, slate)}${digest}.webp`;
}

/** A listed share's picture of its slate: kept under the share, where no preview picture's key can reach. */
export function sharePictureKey(workspace: string, slate: string, share: string, digest: string): string {
  return `${sharePicturePrefix(workspace, slate, share)}${digest}.webp`;
}

function sharePicturePrefix(workspace: string, slate: string, share: string): string {
  return `${picturePrefix(workspace, slate)}shares/${share}/`;
}

function viewPictureKey(workspace: string, picture: Pick<DuePicture, 'slate' | 'view'>, digest: string): string {
  return picture.view === PREVIEW_VIEW ? pictureKey(workspace, picture.slate, digest) : sharePictureKey(workspace, picture.slate, picture.view, digest);
}

/** A version's two places: its light capture, and its dark one where the slate drew one. */
function versionKeys(workspace: string, picture: Pick<DuePicture, 'slate' | 'view'>, digest: string): readonly [string, string] {
  return [viewPictureKey(workspace, picture, digest), viewPictureKey(workspace, picture, `${digest}${DARK_PICTURE}`)];
}

/** Where a share's host takes a visitor with no account past its consent page, on to its slate's own page. */
export function shareCaptureUrl(host: string): string {
  return new URL(`${VIEWER_EXCHANGE_PATH}?consent=1`, host).toString();
}

export function picturePrefix(workspace: string, slate?: string): string {
  return slate === undefined ? `slate-pictures/${workspace}/` : `slate-pictures/${workspace}/${slate}/`;
}

export async function deletePictures(bucket: PictureBucket, prefix: string): Promise<void> {
  for (;;) {
    const listed = await bucket.list({ prefix });

    if (listed.objects.length > 0) await bucket.delete(listed.objects.map((object) => object.key));

    if (!listed.truncated) return;
  }
}
