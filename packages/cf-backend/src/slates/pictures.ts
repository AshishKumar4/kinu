import type { Browser, BrowserWorker } from '@cloudflare/puppeteer';
import * as v from 'valibot';
import { sha256Hex, type RawSqlExec, type SqlExec } from '@kinu.run/core';
import { diagnostics, toKinuError } from '@kinu.run/core/obs';
import { PREVIEW_CAPABILITY_HANDLE_LENGTH } from '../workspace-host';

const AFTER_LAST_RENDER_MS = 30_000;

const AFTER_FIRST_RENDER_MS = 120_000;

const RETRY_MS = 30_000;

const LOCAL_DEV_ZONE = '.localhost';

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

  async forget(workspace: string, slate: string, bucket: PictureBucket | undefined): Promise<void> {
    try {
      if (bucket !== undefined) await deletePictures(bucket, picturePrefix(workspace, slate));
      this.db.exec(`DELETE FROM slate_pictures WHERE slate = ?`, slate);
    } catch (cause) {
      diagnostics.failure('slate.picture_delete_failed', toKinuError({
        doing: `deleting the pictures of removed slate ${slate}`, cause, otherwise: 'unavailable',
      }), { workspace, slate });
    }
  }

  async captureDue(capture: PictureCapture, now: number): Promise<boolean> {
    const due = this.due(now);

    if (due.length === 0) return false;
    let camera: Camera;

    try {
      camera = await capture.camera();
    } catch (cause) {
      for (const picture of due) this.failed(picture, Date.now());
      throw cause;
    }

    let changed = false;

    try {
      for (const picture of due.slice(0, SHOTS_PER_TICK)) {
        try {
          changed = await this.shoot(camera, capture, picture) || changed;
        } catch (cause) {
          this.failed(picture, Date.now());
          diagnostics.failure('slate.picture_failed', toKinuError({
            doing: `photographing slate ${picture.slate}`, cause, otherwise: 'unavailable',
          }), { workspace: capture.workspace, slate: picture.slate, attempts: picture.attempts + 1 });
        }
      }
    } finally {
      await camera.close();
    }

    return changed;
  }

  private async shoot(camera: Camera, capture: PictureCapture, picture: DuePicture): Promise<boolean> {
    const token = captureToken();
    this.openCapture(picture.slate, token.slice(0, PREVIEW_CAPABILITY_HANDLE_LENGTH), Date.now() + CAPTURE_HANDLE_LIFE_MS);

    try {
      const url = await capture.url(picture.port, token);

      if (url === null) throw new Error('this deployment has no preview host');
      const shot = await camera.shoot(url);
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

export interface Camera {
  shoot(url: string): Promise<Uint8Array>;
  close(): Promise<void>;
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
  camera(): Promise<Camera>;
}

/** Loaded on first capture, not at cold start. */
export async function browserCamera(binding: BrowserWorker): Promise<Camera> {
  const { default: puppeteer } = await import('@cloudflare/puppeteer');
  const browser = await puppeteer.launch(binding);

  return { shoot: (url) => photograph(browser, url), close: () => browser.close() };
}

function captureToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(12))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Waits on load, not the network: a streaming slate never idles. */
async function photograph(browser: Browser, url: string): Promise<Uint8Array> {
  const page = await browser.newPage();

  try {
    if (new URL(url).hostname.endsWith(LOCAL_DEV_ZONE)) {
      await (await page.createCDPSession()).send('Security.setIgnoreCertificateErrors', { ignore: true });
    }

    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 0.5 });
    const response = await page.goto(url, { waitUntil: 'load', timeout: CAPTURE_HANDLE_LIFE_MS });

    if (response === null || !response.ok()) throw new Error(`the preview answered ${String(response?.status() ?? 'nothing')}`);
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => { requestAnimationFrame(() => { resolve(); }); });
    }));

    return await page.screenshot({ type: 'webp', quality: 80 });
  } finally {
    await page.close();
  }
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
