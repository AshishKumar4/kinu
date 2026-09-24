/**
 * Shared by the drive and its viewer: the plane's name, the one write path, and which pane a path
 * opens in. A tested contract: HTML is untrusted markup, and a clipped read must not be written back.
 */
import * as v from "valibot";
import { inlineFileType } from './file-types';
import type { DirEntry } from './files';
import { tolerate } from '../obs/index';
import { VfsRevisionSchema, type VfsRevision } from '../types/primitives';

/** The composite plane (workspace tree plus mount table); the drive always browses through it. */
export const PLANE = "workspace";

/** Platform state, not anyone's work: Nimbus runtimes, bindings and images; Kinu agent state. */
const SYSTEM_MANAGED_DIRECTORIES: ReadonlySet<string> = new Set(['.nimbus', '.kinu']);

export function isSystemManaged(name: string): boolean {
  return SYSTEM_MANAGED_DIRECTORIES.has(name);
}

/** `revision` is the backend's exact compare-and-write token; size/mtime never authorize an edit. */
export interface FileText {
  content?: string;
  truncated?: boolean;
  revision?: VfsRevision;
  readOnlyReason?: string;
  error?: string;
}

/** Image and PDF use the download's raw-bytes route; the rest is text via the viewer RPC. */
export type ViewerKind = "image" | "pdf" | "text";

/** Same registry as the download route's headers, so inline rendering matches exactly. */
export function viewerKindOf(path: string): ViewerKind {
  const inlineType = inlineFileType(path);

  if (inlineType?.startsWith("image/")) return "image";

  return inlineType === "application/pdf" ? "pdf" : "text";
}

export class FileWriteConflict extends Error {
  constructor(readonly currentRevision: VfsRevision) {
    super('This file changed after you opened it.');
    this.name = 'FileWriteConflict';
  }
}

export type TextRender = "markdown" | "html" | "source";

export function textRenderOf(path: string): TextRender {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();

  if (name.endsWith(".md") || name.endsWith(".markdown")) return "markdown";

  if (name.endsWith(".html") || name.endsWith(".htm")) return "html";

  return "source";
}

/** A truncated read is a prefix: writing it back would delete everything past the cap. */
export function fileTextEditable(file: FileText | null): boolean {
  return file !== null
    && file.error === undefined
    && file.truncated !== true
    && file.revision !== undefined;
}

/** Size and mtime as a comparable token. `""` when the plane reports neither (container stat has no
 * mtime); then only an explicit refresh can tell fresh from stale. */
export function entryRevision(entry: { size?: number; mtimeMs?: number }): string {
  return `${String(entry.size ?? "")}:${String(entry.mtimeMs ?? "")}`;
}

export interface CachedDir {
  readonly entries: readonly DirEntry[];
  readonly revision: string;
}

/** Installs `dir`'s fresh listing and drops every cached child it contradicts (missing or at a new
 * revision), subtree included. */
export function nextTreeCache(
  cache: ReadonlyMap<string, CachedDir>,
  dir: string,
  entries: readonly DirEntry[],
): ReadonlyMap<string, CachedDir> {
  const fresh = new Map<string, string>(
    entries.filter((entry) => entry.type === "dir")
      .map((entry) => [dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`, entryRevision(entry)]),
  );

  const contradicted: string[] = [];

  for (const [path, cached] of cache) {
    if (path === dir) continue;
    const revision = fresh.get(path);
    const gone = revision === undefined && isChildOf(dir, path);

    if (gone || (revision !== undefined && revision !== cached.revision)) contradicted.push(path);
  }

  const next = new Map<string, CachedDir>();

  for (const [path, cached] of cache) {
    if (path === dir) continue;

    if (contradicted.some((root) => isUnder(root, path))) continue;
    next.set(path, cached);
  }

  next.set(dir, { entries, revision: cache.get(dir)?.revision ?? "" });

  return next;
}

const isUnder = (ancestor: string, path: string): boolean =>
  path === ancestor || path.startsWith(ancestor === "/" ? "/" : `${ancestor}/`);

const isChildOf = (dir: string, path: string): boolean =>
  isUnder(dir, path) && !path.slice(dir === "/" ? 1 : dir.length + 1).includes("/");

/** Untrusted markup in an iframe with an empty sandbox (opaque origin, no scripts/forms/navigation);
 * the CSP blocks remote subresources, the one thing the sandbox still permits. */
export function sandboxedHtml(source: string): string {
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:";

  return `<meta http-equiv="Content-Security-Policy" content="${csp}">${source}`;
}

export async function putFileBytes(
  href: string,
  body: Blob | string,
  expectedRevision?: VfsRevision,
): Promise<void> {
  const headers = expectedRevision === undefined
    ? undefined
    : { "If-Match": JSON.stringify(expectedRevision) };

  const response = await fetch(href, { method: "PUT", body, headers });

  if (response.ok) return;
  const text = await response.text();

  const parsed = v.safeParse(
    v.object({ error: v.optional(v.string()), revision: v.optional(VfsRevisionSchema) }),
    tolerate<unknown>(() => JSON.parse(text), "malformed-input"),
  );

  if (response.status === 412 && parsed.success && parsed.output.revision !== undefined) {
    throw new FileWriteConflict(parsed.output.revision);
  }

  const detail = parsed.success ? parsed.output.error : text.trim() || undefined;
  throw new Error(detail ?? `the write was refused (${String(response.status)})`);
}
