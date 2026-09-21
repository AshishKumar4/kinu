/**
 * Typed client for `/api/drive/*` — the owner's Drive. The session rides the
 * HttpOnly cookie, so the fetches are bare. Every answer is parsed through the
 * schema core declares for it, and a refusal arrives as {@link DriveApiError}
 * carrying the reason the object gave, which the page shows as it is.
 *
 * Folders leave the browser as one zip: `packZip` is core's own writer, so a
 * dropped folder or a picked skill directory is one PUT rather than one per
 * file, and the object lands the whole set or none of it.
 */
import {
  DriveListingSchema, MarkedSkillSchema, packZip, type DriveListing, type MarkedSkill,
} from '@kinu.run/core';
import { tolerateAsync } from '@kinu.run/core/obs';
import { DEFAULT_CALL_TIMEOUT_MS } from 'agents/client';
import * as v from 'valibot';

const ErrorBody = v.object({ error: v.string() });

/** A refusal or failure, as the route answered it. */
class DriveApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'DriveApiError';
  }
}

async function failure(res: Response): Promise<DriveApiError> {
  const parsed = v.safeParse(ErrorBody, await tolerateAsync(() => res.json(), 'malformed-input'));

  return new DriveApiError(res.status, parsed.success ? parsed.output.error : `request failed (${String(res.status)})`);
}

async function api<Schema extends v.GenericSchema>(schema: Schema, method: string, path: string, init: RequestInit = {}): Promise<v.InferOutput<Schema>> {
  const res = await fetch(`/api/drive${path}`, {
    method,
    signal: method === 'GET' ? AbortSignal.timeout(DEFAULT_CALL_TIMEOUT_MS) : undefined,
    ...init,
  });

  if (!res.ok) throw await failure(res);

  return v.parse(schema, await res.json());
}

function jsonBody<Body>(body: Body): RequestInit {
  return { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
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
  return api(DriveListingSchema, 'GET', `?path=${encodeURIComponent(path)}`);
}

export async function makeFolder(path: string): Promise<void> {
  await api(Ok, 'POST', '/folders', jsonBody({ path }));
}

export async function renameEntry(from: string, to: string): Promise<void> {
  await api(Ok, 'POST', '/rename', jsonBody({ from, to }));
}

export async function deleteEntry(path: string): Promise<void> {
  await api(Ok, 'DELETE', `?path=${encodeURIComponent(path)}`);
}

/** One file's bytes to `path`; an existing file there is replaced. */
export async function uploadFile(path: string, file: Blob): Promise<void> {
  await api(Ok, 'PUT', `/files?path=${encodeURIComponent(path)}`, { body: file });
}

/** A zip's entries unpacked under `folder`. */
export async function uploadZip(folder: string, archive: Blob): Promise<void> {
  await api(Ok, 'PUT', `/files?folder=${encodeURIComponent(folder)}&unpack=zip`, { body: archive });
}

/** A picked folder, landed under `folder` with its own name as the root. */
export async function uploadFolder(folder: string, files: readonly PickedFile[]): Promise<void> {
  await uploadZip(folder, await zipped(files));
}

export function markAsSkill(path: string): Promise<MarkedSkill> {
  return api(MarkedSkillSchema, 'POST', '/skills/mark', jsonBody({ path }));
}

/** A skill from the pasted text of one SKILL.md. */
export function addSkillText(skill: string): Promise<MarkedSkill> {
  return api(MarkedSkillSchema, 'POST', '/skills', jsonBody({ skill }));
}

/** A skill from a picked folder or a zip; `name` is the folder's name, the
 *  skill's name when its front matter states none. */
export async function addSkillArchive(archive: Blob, name: string | null): Promise<MarkedSkill> {
  const query = name === null ? '' : `?name=${encodeURIComponent(name)}`;

  return api(MarkedSkillSchema, 'PUT', `/skills${query}`, { body: archive });
}

export async function addSkillFolder(files: readonly PickedFile[], name: string | null): Promise<MarkedSkill> {
  return addSkillArchive(await zipped(files), name);
}

/** Where a browser fetches an entry's bytes: a file as itself, a folder as a zip. */
export function downloadUrl(path: string): string {
  return `/api/drive/files?path=${encodeURIComponent(path)}&download=1`;
}
