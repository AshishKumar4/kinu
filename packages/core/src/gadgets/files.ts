/**
 * Gadgets as the file plane holds them.
 *
 * There is no ledger and no blob column: the directory under `gadgets/` IS the
 * gadget, written through the same `file` tool, `workspace.*` calls and shell
 * the agent writes everything else with, and versioned by the workspace's own
 * git. Every read here re-validates, because the plane is agent-writable and
 * "it was valid when we looked" is not a property a later read may assume.
 *
 * Reads only. Nothing in core writes a gadget: the agent does, and the host
 * reacts to the write (`vfs.events` in the owning object) by releasing the
 * resident process and telling the UI. The next call boots a new server.
 */

import type { VFS } from '../types/primitives';
import { parseJsonValue } from '../utils/json';
import { KinuError, refusalOf, renderThrownChain, tolerateAsync, type Refusal } from '../obs/index';
import { sha256Hex } from '../safety/argument-digest';
import {
  GADGET_CLIENT_FILE, GADGET_CLIENT_STYLE_FILE, GADGET_DIR, GADGET_LIMITS, GADGET_MANIFEST_FILE,
  GADGET_SERVER_FILE, isGadgetSlug, parseGadgetManifest, type GadgetManifest, type GadgetManifestResult,
} from './manifest';

/** One gadget the host can list: its declaration and which halves exist. */
export interface GadgetRecord {
  readonly slug: string;
  readonly manifest: GadgetManifest;
  readonly hasServer: boolean;
  readonly hasClient: boolean;
}

/** A directory under `gadgets/` whose manifest does not parse. Listed
 *  beside the valid ones so the agent sees why its tab is missing instead
 *  of a list that quietly omits it. */
export interface GadgetProblem {
  readonly slug: string;
  readonly error: string;
}

export interface GadgetListing {
  readonly gadgets: GadgetRecord[];
  readonly problems: GadgetProblem[];
}

export type GadgetReadResult<T> =
  | ({ ok: true } & T)
  | ({ ok: false } & Refusal);

function gadgetPath(slug: string, file: string): string {
  return `${GADGET_DIR}/${slug}/${file}`;
}

async function readText(vfs: VFS, path: string): Promise<string> {
  const raw = await vfs.readFile(path, { encoding: 'utf8' });
  return raw instanceof Uint8Array ? new TextDecoder().decode(raw) : raw;
}

/** The text at `path`, or null when there is no such file. Any other failure
 *  is the plane's own and propagates. */
async function readTextIfPresent(vfs: VFS, path: string): Promise<string | null> {
  return (await tolerateAsync(() => readText(vfs, path), 'enoent')) ?? null;
}

async function isDir(vfs: VFS, path: string): Promise<boolean> {
  return (await vfs.stat(path))?.isDir === true;
}

/**
 * Read one gadget's declaration and which halves are present.
 *
 * `missing` when there is no such directory or no manifest; `bad_input` when
 * the manifest does not validate, carrying the field so the model can fix it
 * in one shot.
 */
export async function readGadget(vfs: VFS, slug: string): Promise<GadgetReadResult<{ record: GadgetRecord }>> {
  if (!isGadgetSlug(slug)) {
    return { ok: false, ...refusalOf(new KinuError('bad_input',
      `"${slug}" is not a gadget slug: lowercase letters, digits and hyphens, at most ${GADGET_LIMITS.slugChars} characters`)) };
  }
  const manifestText = await readTextIfPresent(vfs, gadgetPath(slug, GADGET_MANIFEST_FILE));
  if (manifestText === null) {
    return { ok: false, ...refusalOf(new KinuError('missing',
      `No gadget named "${slug}": ${gadgetPath(slug, GADGET_MANIFEST_FILE)} does not exist.`)) };
  }
  if (manifestText.length > GADGET_LIMITS.manifestChars) {
    return { ok: false, ...refusalOf(new KinuError('bad_input',
      `${gadgetPath(slug, GADGET_MANIFEST_FILE)} is ${manifestText.length} characters; the limit is ${GADGET_LIMITS.manifestChars}.`)) };
  }
  let parsed: GadgetManifestResult;
  try {
    parsed = parseGadgetManifest(parseJsonValue(manifestText));
  } catch (error) {
    return { ok: false, ...refusalOf(new KinuError('bad_input',
      `${gadgetPath(slug, GADGET_MANIFEST_FILE)} is not JSON: ${renderThrownChain({ cause: error })}`)) };
  }
  if (!parsed.ok) return { ok: false, ...refusalOf(new KinuError('bad_input', parsed.error)) };
  const [hasServer, hasClient] = await Promise.all([
    vfs.exists(gadgetPath(slug, GADGET_SERVER_FILE)),
    vfs.exists(gadgetPath(slug, GADGET_CLIENT_FILE)),
  ]);
  return { ok: true, record: { slug, manifest: parsed.manifest, hasServer, hasClient } };
}

/**
 * Every gadget directory, valid ones as records and the rest as problems.
 *
 * Oldest-first is not available from a directory listing, so the order is the
 * plane's: a stable listing order keeps the tab strip stable as gadgets are
 * added.
 */
export async function listGadgets(vfs: VFS): Promise<GadgetListing> {
  if (!(await isDir(vfs, GADGET_DIR))) return { gadgets: [], problems: [] };
  const entries = await vfs.readdir(GADGET_DIR);
  const gadgets: GadgetRecord[] = [];
  const problems: GadgetProblem[] = [];
  for (const name of entries) {
    if (!isGadgetSlug(name)) {
      problems.push({ slug: name, error: `"${name}" is not a gadget slug: lowercase letters, digits and hyphens only` });
      continue;
    }
    if (!(await isDir(vfs, `${GADGET_DIR}/${name}`))) continue;
    const read = await readGadget(vfs, name);
    if (read.ok) gadgets.push(read.record);
    // A directory with no manifest is a directory, not a broken gadget.
    else if (read.reason !== 'missing') problems.push({ slug: name, error: read.error });
  }
  return { gadgets, problems };
}

/** The client half: the module the iframe runs, and its stylesheet. */
export async function readGadgetClient(vfs: VFS, slug: string): Promise<GadgetReadResult<{ js: string; css: string | null }>> {
  const gadget = await readGadget(vfs, slug);
  if (!gadget.ok) return gadget;
  const js = await readTextIfPresent(vfs, gadgetPath(slug, GADGET_CLIENT_FILE));
  if (js === null) {
    return { ok: false, ...refusalOf(new KinuError('missing',
      `Gadget "${slug}" has no ${GADGET_CLIENT_FILE} yet.`)) };
  }
  if (js.length > GADGET_LIMITS.clientChars) {
    return { ok: false, ...refusalOf(new KinuError('bad_input',
      `${gadgetPath(slug, GADGET_CLIENT_FILE)} is ${js.length} characters; the limit is ${GADGET_LIMITS.clientChars}.`)) };
  }
  const css = await readTextIfPresent(vfs, gadgetPath(slug, GADGET_CLIENT_STYLE_FILE));
  return { ok: true, js, css };
}

/** The server half with a digest of exactly the bytes the resident process
 *  boots — the identity a write changes. */
export async function readGadgetServer(vfs: VFS, slug: string): Promise<GadgetReadResult<{ js: string; digest: string }>> {
  const gadget = await readGadget(vfs, slug);
  if (!gadget.ok) return gadget;
  const js = await readTextIfPresent(vfs, gadgetPath(slug, GADGET_SERVER_FILE));
  if (js === null) {
    return { ok: false, ...refusalOf(new KinuError('missing',
      `Gadget "${slug}" has no ${GADGET_SERVER_FILE}, so it has no server to call.`)) };
  }
  if (js.length > GADGET_LIMITS.serverChars) {
    return { ok: false, ...refusalOf(new KinuError('bad_input',
      `${gadgetPath(slug, GADGET_SERVER_FILE)} is ${js.length} characters; the limit is ${GADGET_LIMITS.serverChars}.`)) };
  }
  // `sha256Hex` is the repository's one digest: the bytes the resident process
  // boots, so two gadgets with the same source share a digest and one edited
  // source never does.
  return { ok: true, js, digest: sha256Hex(js) };
}
