/**
 * Typed client for `/api/drive/*`; the session rides the HttpOnly cookie.
 * Folders upload as one zip (core's `packZip`) so the object lands the whole set or none.
 */
import { Effect } from 'effect';
import {
  DriveListingSchema, MarkedSkillSchema, packZip, type DriveListing, type FileText, type MarkedSkill,
} from '@kinu.run/core';
import { settle } from '@kinu.run/core/obs';
import * as v from 'valibot';
import { refusal, request, respond, type HttpRequest } from './http';

function api<Schema extends v.GenericSchema>(schema: Schema, method: string, path: string, init: Omit<HttpRequest, 'method'> = {}): Effect.Effect<v.InferOutput<Schema>> {
  return request(schema, `/api/drive${path}`, { method, ...init });
}

const Ok = v.object({ ok: v.literal(true) });

/** One entry inside a folder the browser picked: its path relative to that folder, and its bytes. */
export interface PickedFile {
  readonly path: string;
  readonly file: Blob;
}

async function zipped(files: readonly PickedFile[]): Promise<Blob> {
  const entries = await Promise.all(files.map(async (entry) => ({ path: entry.path, bytes: new Uint8Array(await entry.file.arrayBuffer()) })));
  const archive = packZip(entries);
  const owned = new Uint8Array(new ArrayBuffer(archive.byteLength));
  owned.set(archive);

  return new Blob([owned], { type: 'application/zip' });
}

export function listDrive(path: string): Promise<DriveListing> {
  return settle(api(DriveListingSchema, 'GET', `?path=${encodeURIComponent(path)}`));
}

export async function makeFolder(path: string): Promise<void> {
  return settle(Effect.asVoid(api(Ok, 'POST', '/folders', { json: { path } })));
}

export async function renameEntry(from: string, to: string): Promise<void> {
  return settle(Effect.asVoid(api(Ok, 'POST', '/rename', { json: { from, to } })));
}

export async function deleteEntry(path: string): Promise<void> {
  return settle(Effect.asVoid(api(Ok, 'DELETE', `?path=${encodeURIComponent(path)}`)));
}

/** How an upload is ended and told of its progress: the share of its body that has gone, 0 to 1. */
export interface UploadWatch {
  readonly signal: AbortSignal;
  readonly progress: (share: number) => void;
}

function upload(query: string, body: Blob, watch: UploadWatch): Effect.Effect<void> {
  const sent = (bytes: number): void => { watch.progress(body.size === 0 ? 1 : Math.min(1, bytes / body.size)); };

  return Effect.asVoid(api(Ok, 'PUT', `/files?${query}`, { body, signal: watch.signal, sent }));
}

export function uploadFile(path: string, file: Blob, watch: UploadWatch): Promise<void> {
  return settle(upload(`path=${encodeURIComponent(path)}`, file, watch));
}

export function uploadZip(folder: string, archive: Blob, watch: UploadWatch): Promise<void> {
  return settle(upload(`folder=${encodeURIComponent(folder)}&unpack=zip`, archive, watch));
}

export async function uploadFolder(folder: string, files: readonly PickedFile[], watch: UploadWatch): Promise<void> {
  await uploadZip(folder, await zipped(files), watch);
}

export function markAsSkill(path: string): Promise<MarkedSkill> {
  return settle(api(MarkedSkillSchema, 'POST', '/skills/mark', { json: { path } }));
}

export function addSkillText(skill: string): Promise<MarkedSkill> {
  return settle(api(MarkedSkillSchema, 'POST', '/skills', { json: { skill } }));
}

/** `name` is the folder's name, used as the skill's name when front matter states none. */
export async function addSkillArchive(archive: Blob, name: string | null): Promise<MarkedSkill> {
  const query = name === null ? '' : `?name=${encodeURIComponent(name)}`;

  return settle(api(MarkedSkillSchema, 'PUT', `/skills${query}`, { body: archive }));
}

export async function addSkillFolder(files: readonly PickedFile[], name: string | null): Promise<MarkedSkill> {
  return addSkillArchive(await zipped(files), name);
}

export function downloadUrl(path: string): string {
  return `/api/drive/files?path=${encodeURIComponent(path)}&download=1`;
}

export function inlineUrl(path: string): string {
  return `/api/drive/files?path=${encodeURIComponent(path)}`;
}

/** The most bytes one zip of a whole Drive holds: the browser assembles each in memory, so a large Drive is several. */
const DRIVE_ZIP_BYTES = 512 * 1024 ** 2;

/** Every file under `path`, depth first, by its path from the Drive's root; a link is the file it names, so it is not. */
function driveFiles(path: string): Effect.Effect<readonly { readonly path: string; readonly size: number }[]> {
  return Effect.gen(function* () {
    const listing = yield* api(DriveListingSchema, 'GET', `?path=${encodeURIComponent(path)}`);
    const files: { readonly path: string; readonly size: number }[] = [];

    for (const entry of listing.entries) {
      const at = `${path === '/' ? '' : path}/${entry.name}`;

      if (entry.kind === 'folder') files.push(...(yield* driveFiles(at)));
      else if (entry.kind === 'file') files.push({ path: at, size: entry.size });
    }

    return files;
  });
}

function fileBytes(path: string): Effect.Effect<Uint8Array> {
  return Effect.gen(function* () {
    const res = yield* respond(downloadUrl(path));

    if (!res.ok) return yield* Effect.die(yield* refusal(res, 'GET', downloadUrl(path)));

    return new Uint8Array(yield* Effect.promise(async () => res.arrayBuffer()));
  });
}

/**
 * The whole Drive as zips of at most 512 MB each, in its own paths, handed to `save` one at a time as each fills:
 * `drive.zip`, then `drive-2.zip`. `progress` hears the files read of all; the zips' count.
 */
export function zipWholeDrive(save: (zip: Blob, name: string) => Effect.Effect<void>, progress: (read: number, of: number) => void): Promise<number> {
  return settle(Effect.gen(function* () {
    const files = yield* driveFiles('/');
    let batch: { readonly path: string; readonly bytes: Uint8Array }[] = [];
    let held = 0;
    let zips = 0;

    const flush = Effect.gen(function* () {
      if (batch.length === 0) return;
      const archive = packZip(batch);
      const owned = new Uint8Array(new ArrayBuffer(archive.byteLength));

      owned.set(archive);
      zips += 1;
      yield* save(new Blob([owned], { type: 'application/zip' }), zips === 1 ? 'drive.zip' : `drive-${String(zips)}.zip`);
      batch = [];
      held = 0;
    });

    for (const [index, file] of files.entries()) {
      if (held > 0 && held + file.size > DRIVE_ZIP_BYTES) yield* flush;
      batch.push({ path: file.path.slice(1), bytes: yield* fileBytes(file.path) });
      held += file.size;
      progress(index + 1, files.length);
    }

    yield* flush;

    return zips;
  }));
}

const PREVIEW_BYTES = 256 * 1024;

/** A prefix of the file's text; no revision, so the viewer is read-only. */
export function readDriveText(path: string, cap = PREVIEW_BYTES): Promise<FileText> {
  return settle(Effect.gen(function* () {
    const res = yield* respond(inlineUrl(path));

    if (!res.ok) return yield* Effect.die(yield* refusal(res, 'GET', inlineUrl(path)));

    if (res.body === null) return { content: '' };
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;

    while (size < cap) {
      const { done, value } = yield* Effect.promise(async () => reader.read());

      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }

    if (size >= cap) {
      truncated = true;
      yield* Effect.promise(async () => reader.cancel());
    }

    const bytes = new Uint8Array(size);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const shown = bytes.subarray(0, Math.min(size, cap));

    if (shown.includes(0)) return { error: 'This file is not text. Download it to open it.' };

    return { content: new TextDecoder().decode(shown), truncated };
  }));
}
