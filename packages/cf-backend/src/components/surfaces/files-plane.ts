/**
 * What the drive and its viewer both need to address the file plane: the
 * plane's name, the one way bytes go IN, and which pane a path opens in.
 *
 * The dispatch lives here rather than inside the viewer so it is a TESTED
 * contract — the same reason the download route's headers live in `lib/http`.
 * Two of these answers are load-bearing beyond layout: an HTML file is
 * untrusted markup, and a file read that was clipped must not be written back.
 */
import * as v from "valibot";
import { inlineFileType, type DirEntry } from "@kinu.run/core";
import { tolerate } from "@kinu.run/core/obs";

/** The executor whose file view is the composite plane — the workspace tree
 *  extended by the mount table. The drive browses THROUGH it, always. */
export const PLANE = "workspace";

/** One file's text, as the viewer RPC answers it. `revision` is the backend's
 * exact compare-and-write token; size/mtime never authorize an edit. */
export interface FileText {
  content?: string;
  truncated?: boolean;
  revision?: number;
  readOnlyReason?: string;
  error?: string;
}

/** Which pane draws a file. Image and PDF ride the raw-bytes route the download
 *  uses; everything else is read as text through the viewer RPC. */
export type ViewerKind = "image" | "pdf" | "text";

/** ONE file-type registry: `inlineFileType` is the same answer the download
 * route's headers are built from, so a type the browser will render inline is
 * exactly a type this shows inline. */
export function viewerKindOf(path: string): ViewerKind {
  const inlineType = inlineFileType(path);
  if (inlineType?.startsWith("image/")) return "image";
  return inlineType === "application/pdf" ? "pdf" : "text";
}

export class FileWriteConflict extends Error {
  constructor(readonly currentRevision: number) {
    super('This file changed after you opened it.');
    this.name = 'FileWriteConflict';
  }
}

/** The rendered form each text file opens in. Source is every other file's. */
export type TextRender = "markdown" | "html" | "source";

export function textRenderOf(path: string): TextRender {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name.endsWith(".md") || name.endsWith(".markdown")) return "markdown";
  if (name.endsWith(".html") || name.endsWith(".htm")) return "html";
  return "source";
}

/**
 * Whether this read may be edited in place.
 *
 * A truncated read is a PREFIX of the file. Writing that buffer back would
 * delete everything past the cap, so the whole file has to arrive first — and a
 * read that failed has no buffer to write back at all.
 */
export function fileTextEditable(file: FileText | null): boolean {
  return file !== null
    && file.error === undefined
    && file.truncated !== true
    && file.revision !== undefined;
}

/**
 * What a listing says about one entry's CONTENT, as a comparable token.
 *
 * The plane reports size and mtime per entry and nothing else, so this is the
 * whole revision available without a second field on the wire — and it is
 * enough: a directory whose children changed has a new mtime, and a file whose
 * bytes changed has a new size or a new mtime. `""` for a plane that reports
 * neither (the container synthesizes stat from a listing and has no mtime),
 * which is honest: nothing here can then tell fresh from stale, and only an
 * explicit refresh can.
 */
export function entryRevision(entry: { size?: number; mtimeMs?: number }): string {
  return `${String(entry.size ?? "")}:${String(entry.mtimeMs ?? "")}`;
}

/** One cached directory listing, with the revision its OWN entry carried in its
 *  parent's listing when it was read. */
export interface CachedDir {
  readonly entries: readonly DirEntry[];
  readonly revision: string;
}

/**
 * The tree cache with `dir`'s fresh listing installed, and everything the fresh
 * listing contradicts dropped.
 *
 * A cached child is contradicted when the fresh listing no longer names it, or
 * names it at a different revision. Dropping it drops its whole subtree: a
 * directory whose contents moved cannot leave descendants behind that were read
 * through it. Without this the cache was keyed by path alone and never
 * revalidated, so a folder changed by a shell, an agent, or another tab kept
 * rendering its old children for as long as the tab stayed open.
 */
export function nextTreeCache(
  cache: ReadonlyMap<string, CachedDir>,
  dir: string,
  entries: readonly DirEntry[],
): ReadonlyMap<string, CachedDir> {
  const fresh = new Map<string, string>(
    entries.filter((entry) => entry.type === "dir")
      .map((entry) => [dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`, entryRevision(entry)]),
  );
  // shape this replaced deleted from the map it was iterating.
  const contradicted: string[] = [];
  for (const [path, cached] of cache) {
    if (path === dir) continue;
    const revision = fresh.get(path);
    // A child of `dir` the fresh listing does not name is gone from this plane.
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

/**
 * HTML preview, with no way to reach anything.
 *
 * A workspace or DEVICE file's markup is untrusted input, and this app has no
 * HTML-injection sink (`lib/security-headers.ts`) — so it does not get one here.
 * The document is parsed inside an iframe with an EMPTY sandbox: an opaque
 * origin, no scripts, no forms, no navigation, no access to this page. The CSP
 * on top of that stops the one thing sandboxing still permits, which is loading
 * remote subresources and telling a third party the file was opened.
 */
export function sandboxedHtml(source: string): string {
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:";
  return `<meta http-equiv="Content-Security-Policy" content="${csp}">${source}`;
}

/** The files route's failure body, for a PUT that was refused. */
export async function putFileBytes(
  href: string,
  body: Blob | string,
  expectedRevision?: number,
): Promise<void> {
  const headers = expectedRevision === undefined
    ? undefined
    : { "If-Match": String(expectedRevision) };
  const response = await fetch(href, { method: "PUT", body, headers });
  if (response.ok) return;
  const text = await response.text();
  const parsed = v.safeParse(
    v.object({ error: v.optional(v.string()), revision: v.optional(v.number()) }),
    tolerate<unknown>(() => JSON.parse(text), "malformed-input"),
  );
  if (response.status === 412 && parsed.success && parsed.output.revision !== undefined) {
    throw new FileWriteConflict(parsed.output.revision);
  }
  const detail = parsed.success ? parsed.output.error : text.trim() || undefined;
  throw new Error(detail ?? `the write was refused (${String(response.status)})`);
}
