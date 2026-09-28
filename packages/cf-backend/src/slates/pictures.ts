import * as v from 'valibot';
import { bindingQuickActions, PLATFORM_CATALOG, quickAction, sha256Hex, type BrowserRunQuickActions, type RawSqlExec, type SqlExec } from '@kinu.run/core';
import { diagnostics, toKinuError } from '@kinu.run/core/obs';
import { PREVIEW_CAPABILITY_HANDLE_LENGTH } from '../workspace-host';

const AFTER_LAST_RENDER_MS = 30_000;

const AFTER_FIRST_RENDER_MS = 120_000;

const RETRY_MS = 30_000;

const ATTEMPTS = 3;

const SHOTS_PER_TICK = 3;

const CAPTURE_HANDLE_LIFE_MS = 120_000;

export function initSlatePictureTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS slate_pictures (
    slate          TEXT PRIMARY KEY,
    port           INTEGER NOT NULL,
    digest         TEXT,
    due_at         INTEGER,
    due_since      INTEGER,
    attempts       INTEGER NOT NULL DEFAULT 0,
    capture_handle TEXT,
    capture_until  INTEGER
  )`);
}

const DueRowSchema = v.object({ slate: v.string(), port: v.number(), digest: v.nullable(v.string()), attempts: v.number() });

type DuePicture = v.InferOutput<typeof DueRowSchema>;

const StoredRowSchema = v.object({ slate: v.string(), digest: v.string() });

export class SlatePictures {
  constructor(private readonly db: SqlExec) {}

  rendered(slate: string, port: number, now: number): void {
    this.db.exec(
      `INSERT INTO slate_pictures (slate, port, due_at, due_since) VALUES (?, ?, ?, ?)
       ON CONFLICT (slate) DO UPDATE SET port = excluded.port, attempts = 0,
         due_since = COALESCE(slate_pictures.due_since, excluded.due_since),
         due_at = MIN(excluded.due_at, COALESCE(slate_pictures.due_since, excluded.due_since) + ?)`,
      slate, port, now + AFTER_LAST_RENDER_MS, now, AFTER_FIRST_RENDER_MS,
    );
  }

  nextDueAt(): number | null {
    const [row] = this.db.exec(`SELECT MIN(due_at) AS at FROM slate_pictures`).toArray();

    return v.parse(v.object({ at: v.nullable(v.number()) }), row).at;
  }

  private due(now: number): DuePicture[] {
    return this.db.exec(`SELECT slate, port, digest, attempts FROM slate_pictures WHERE due_at <= ? ORDER BY due_at`, now).toArray()
      .map((row) => v.parse(DueRowSchema, row));
  }

  private removed(slate: string): boolean {
    return this.db.exec(`SELECT 1 AS x FROM slate_pictures WHERE slate = ?`, slate).toArray().length === 0;
  }

  captures(port: number, handle: string, now: number): boolean {
    return this.db.exec(
      `SELECT 1 AS x FROM slate_pictures WHERE port = ? AND capture_handle = ? AND capture_until > ?`, port, handle, now,
    ).toArray().length > 0;
  }

  private openCapture(slate: string, handle: string, until: number): void {
    this.db.exec(`UPDATE slate_pictures SET capture_handle = ?, capture_until = ? WHERE slate = ?`, handle, until, slate);
  }

  private closeCapture(slate: string): void {
    this.db.exec(`UPDATE slate_pictures SET capture_handle = NULL, capture_until = NULL WHERE slate = ?`, slate);
  }

  private stored(slate: string, digest: string): void {
    this.db.exec(`UPDATE slate_pictures SET digest = ?, due_at = NULL, due_since = NULL, attempts = 0 WHERE slate = ?`, digest, slate);
  }

  private failed(picture: DuePicture, now: number): void {
    const attempts = picture.attempts + 1;

    if (attempts >= ATTEMPTS) {
      this.db.exec(`UPDATE slate_pictures SET due_at = NULL, due_since = NULL, attempts = 0 WHERE slate = ?`, picture.slate);

      return;
    }

    this.db.exec(`UPDATE slate_pictures SET due_at = ?, attempts = ? WHERE slate = ?`, now + RETRY_MS * 2 ** attempts, attempts, picture.slate);
  }

  digests(): ReadonlyMap<string, string> {
    return new Map(this.db.exec(`SELECT slate, digest FROM slate_pictures WHERE digest IS NOT NULL`).toArray().map((row) => {
      const picture = v.parse(StoredRowSchema, row);

      return [picture.slate, picture.digest];
    }));
  }

  /** Left open: a shot whose put lands between this listing and the row's removal keeps its object; rare, and teardown reclaims it. */
  async forget(workspace: string, slate: string, bucket: PictureBucket | undefined): Promise<void> {
    try {
      if (bucket !== undefined) await deletePictures(bucket, picturePrefix(workspace, slate));
      this.db.exec(`DELETE FROM slate_pictures WHERE slate = ?`, slate);
    } catch (cause) {
      this.db.exec(
        `UPDATE slate_pictures SET due_at = ? + ? * (1 << MIN(attempts, 7)), due_since = NULL, attempts = attempts + 1 WHERE slate = ?`,
        Date.now(), RETRY_MS, slate,
      );
      diagnostics.failure('slate.picture_delete_failed', toKinuError({
        doing: `deleting the pictures of removed slate ${slate}`, cause, otherwise: 'unavailable',
      }), { workspace, slate });
    }
  }

  async captureDue(capture: PictureCapture, now: number): Promise<boolean> {
    const due = this.due(now);

    if (due.length === 0) return false;
    const live = await capture.slates();

    for (const picture of due) {
      if (!live.has(picture.slate)) await this.forget(capture.workspace, picture.slate, capture.bucket);
    }

    let changed = false;

    for (const picture of due.filter((candidate) => live.has(candidate.slate)).slice(0, SHOTS_PER_TICK)) {
      try {
        changed = await this.shoot(capture, picture) || changed;
      } catch (cause) {
        this.failed(picture, Date.now());
        diagnostics.failure('slate.picture_failed', toKinuError({
          doing: `photographing slate ${picture.slate}`, cause, otherwise: 'unavailable',
        }), { workspace: capture.workspace, slate: picture.slate, attempts: picture.attempts + 1 });
      }
    }

    return changed;
  }

  private async shoot(capture: PictureCapture, picture: DuePicture): Promise<boolean> {
    const token = captureToken();
    this.openCapture(picture.slate, token.slice(0, PREVIEW_CAPABILITY_HANDLE_LENGTH), Date.now() + CAPTURE_HANDLE_LIFE_MS);

    try {
      const url = await capture.url(picture.port, token);

      if (url === null) throw new Error('this deployment has no preview host');
      const shot = await capture.shoot(url);
      const digest = sha256Hex(shot);
      const changed = digest !== picture.digest;

      if (changed) {
        const key = pictureKey(capture.workspace, picture.slate, digest);
        await capture.bucket.put(key, shot, { httpMetadata: { contentType: 'image/webp' } });

        if (this.removed(picture.slate)) {
          await capture.bucket.delete(key);

          return false;
        }

        if (picture.digest !== null) await capture.bucket.delete(pictureKey(capture.workspace, picture.slate, picture.digest));
      }

      this.stored(picture.slate, digest);

      return changed;
    } finally {
      this.closeCapture(picture.slate);
    }
  }
}

export interface PictureBucket {
  get(key: string): Promise<{ readonly body: ReadableStream; readonly httpEtag: string } | null>;
  put(key: string, value: Uint8Array, options: { httpMetadata: { contentType: string } }): Promise<void>;
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix: string }): Promise<{ objects: { key: string }[]; truncated: boolean }>;
}

export interface PictureCapture {
  readonly workspace: string;
  readonly bucket: PictureBucket;
  url(port: number, token: string): Promise<string | null>;
  /** With broken ones. */
  slates(): Promise<ReadonlySet<string>>;
  shoot(url: string): Promise<Uint8Array>;
}

/**
 * One Quick Action per picture, on Chrome: pixel-faithful, and Kitesurf answers 501 for webp. Measured 2026-09-28
 * against the puppeteer launch it replaced (the same viewport, load wait and webp q80): the same image within 2
 * bytes, in 0.95-1.75 s instead of 3.4-5.6 s. `cacheTTL: 0`, since a slate re-renders under the same URL.
 */
export async function quickActionPicture(binding: BrowserRunQuickActions, url: string): Promise<Uint8Array> {
  const response = await quickAction({
    transport: bindingQuickActions(binding), action: 'screenshot', engine: 'chrome',
    options: {
      url, cacheTTL: 0,
      viewport: { width: 1280, height: 800, deviceScaleFactor: 0.5 },
      // Load, not the network: a streaming slate never idles.
      gotoOptions: { waitUntil: 'load', timeout: PLATFORM_CATALOG['browser.navigation.timeout_ms'].limit.value },
      screenshotOptions: { type: 'webp', quality: 80 },
    },
  });

  return new Uint8Array(await response.arrayBuffer());
}

function captureToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(12))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function pictureKey(workspace: string, slate: string, digest: string): string {
  return `${picturePrefix(workspace, slate)}${digest}.webp`;
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
