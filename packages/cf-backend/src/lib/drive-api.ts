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

export async function uploadFile(path: string, file: Blob, signal?: AbortSignal): Promise<void> {
  return settle(Effect.asVoid(api(Ok, 'PUT', `/files?path=${encodeURIComponent(path)}`, { body: file, signal })));
}

export async function uploadZip(folder: string, archive: Blob, signal?: AbortSignal): Promise<void> {
  return settle(Effect.asVoid(api(Ok, 'PUT', `/files?folder=${encodeURIComponent(folder)}&unpack=zip`, { body: archive, signal })));
}

export async function uploadFolder(folder: string, files: readonly PickedFile[], signal?: AbortSignal): Promise<void> {
  await uploadZip(folder, await zipped(files), signal);
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
