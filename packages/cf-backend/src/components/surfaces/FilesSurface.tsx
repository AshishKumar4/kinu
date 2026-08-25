/**
 * Files surface — the workspace's ONE drive. The composite file plane
 * (workspace tree + /pc and /sandbox mounts, core/src/vfs/mounts.ts) browsed
 * whole: folder tree, listing, preview, upload, download, rename, delete.
 *
 * Every byte crosses the EXISTING file plane: listings and text previews ride
 * the executor-file RPCs against the `workspace` executor — whose file view
 * IS the mount-table plane — and raw bytes (upload, download, image/PDF
 * preview src) ride the files HTTP route, because the RPC transport is the
 * chat WebSocket and its 1 MiB frame ceiling sits below ordinary file sizes.
 * There is no second pipeline: a mount is an ordinary folder here, wearing a
 * small origin badge, and every boundary the owning executor enforces
 * (device consent, path scoping) is enforced on the mounted path too.
 *
 * An OFFLINE mount is a stated absence rather than a missing row: the plane's
 * root listing only carries live mounts, so the root view appends the absent
 * ones as disabled rows naming their reason (connect your PC, no container).
 */
import {
  useCallback, useEffect, useMemo, useRef, useState,
  type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Link, useParams } from "react-router-dom";
import { Loader } from "@cloudflare/kumo";
import {
  ArrowsClockwiseIcon, ArrowUpIcon, CaretDownIcon, CaretRightIcon, CheckIcon,
  DownloadSimpleIcon, FileIcon, FolderIcon, FolderOpenIcon, HouseIcon,
  MagnifyingGlassIcon, PencilSimpleIcon, PlugIcon, TrashIcon, UploadSimpleIcon,
  WarningIcon, XIcon,
} from "@phosphor-icons/react";
import * as v from "valibot";
import { joinDir, parentDir, EXECUTOR_MOUNTS, type DirEntry, type MountInfo } from "@kinu.run/core";
import { renderThrownChain, tolerate } from "@kinu.run/core/obs";
import type { Rpc } from "@/lib/protocol";
import { executorLabel, type ExecutorInfo } from "@/lib/executors";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { useToggledSet } from "@/hooks/use-toggled-set";

/** The executor whose file view is the composite plane — the workspace tree
 *  extended by the mount table. The drive browses THROUGH it, always. */
const PLANE = "workspace";

interface DirectoryResponse { path?: string; entries?: DirEntry[]; error?: string }
interface FileText { content?: string; truncated?: boolean; error?: string }
type WriteResult = { ok: true } | { error: string };
const UploadErrorSchema = v.object({ error: v.optional(v.string()) });

interface UploadState { name: string; status: "uploading" | "error"; error?: string }

/** Mount-point name (root entry) → the executor that serves it. */
const MOUNT_EXECUTOR: Record<string, string> = Object.fromEntries(
  Object.entries(EXECUTOR_MOUNTS).map(([executor, prefix]) => [prefix.slice(1), executor]),
);

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg',
]);

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
}

/** Sizes at a glance, in the unit that keeps the column scannable. */
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Relative "when", for the Modified column. Coarse on purpose. */
function fmtWhen(mtimeMs: number | undefined): string {
  if (!mtimeMs) return "";
  const delta = Date.now() - mtimeMs;
  if (delta < 60e3) return "just now";
  if (delta < 36e5) return `${Math.round(delta / 60e3)}m ago`;
  if (delta < 864e5) return `${Math.round(delta / 36e5)}h ago`;
  if (delta < 30 * 864e5) return `${Math.round(delta / 864e5)}d ago`;
  return new Date(mtimeMs).toLocaleDateString();
}

export interface FilesSurfaceProps {
  rpc: Rpc;
  executors: ExecutorInfo[];
  /** One-shot navigation intent from another surface (an Environment card's
   *  Files action). The nonce distinguishes two jumps to the same path. */
  jump?: { path: string; nonce: number } | null;
}

export function FilesSurface({ rpc, executors, jump }: FilesSurfaceProps) {
  const agentName = useParams().agentId ?? "";
  const [path, setPath] = useState("/");
  /** One failure line for row operations (rename/delete/download prep). */
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [renaming, setRenaming] = useState<{ path: string; draft: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [dragOver, setDragOver] = useState(false);
  /** Lazy directory cache for the tree; the listing always refetches. */
  const [treeCache, setTreeCache] = useState<ReadonlyMap<string, DirEntry[]>>(new Map());
  const { set: expanded, toggle: toggleExpanded } = useToggledSet(() => new Set(["/"]));
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Mount roster: origin badges, liveness, and the offline rows the root
  // listing honestly omits.
  const loadMounts = useCallback(() => rpc<MountInfo[]>("listMounts"), [rpc]);
  const { resource: mountsResource, reload: reloadMounts } = useAsyncResource(loadMounts);
  const mounts = lastValue(mountsResource) ?? [];

  const listDir = useCallback(async (dir: string): Promise<DirEntry[]> => {
    const r = await rpc<DirectoryResponse>("getExecutorFiles", [PLANE, dir]);
    if (r.error) throw new Error(r.error);
    const listed = r.entries ?? [];
    setTreeCache((prev) => {
      const next = new Map(prev);
      next.set(r.path ?? dir, listed);
      return next;
    });
    return listed;
  }, [rpc]);

  // Keyed on `path`: a listing for the OLD directory must never render under
  // the NEW one's breadcrumb. `useAsyncResource`'s identity check forces the
  // rendered value to "loading" the instant `path` changes, in the SAME
  // render as the navigation — closing the window a `useEffect`-driven fetch
  // otherwise leaves open between the crumb bar updating and the listing
  // arriving. A slow scheduler widens that window; it cannot reopen this one.
  const loadListing = useCallback(async (): Promise<DirEntry[]> => {
    try {
      return await listDir(path);
    } catch (e) {
      throw new Error(renderThrownChain({ cause: e }), { cause: e });
    }
  }, [listDir, path]);
  const { resource: listing, reload: reloadListing } = useAsyncResource(loadListing, undefined, path);
  const entries = lastValue(listing) ?? [];
  const loading = listing.status === "loading";
  const err = listing.status === "error" ? listing.message : null;

  useEffect(() => {
    if (listing.status === "ready") setSelected(0);
  }, [listing]);

  useEffect(() => {
    setRenaming(null);
    setConfirmDelete(null);
  }, [path]);

  // A jump is consumed exactly once per nonce.
  const lastJump = useRef(0);
  useEffect(() => {
    if (!jump || jump.nonce === lastJump.current) return;
    lastJump.current = jump.nonce;
    setPreview(null);
    setFilter("");
    setPath(jump.path);
  }, [jump]);

  /** Row-operation runner: every rejection lands in the notice banner. */
  const run = useCallback((op: () => Promise<void>) => {
    setNotice(null);
    void op().then(undefined, (error: Error) => setNotice(renderThrownChain({ cause: error })));
  }, []);

  const rawUrl = useCallback((full: string, download: boolean) =>
    `/api/workspaces/${encodeURIComponent(agentName)}/files`
    + `?executor=${encodeURIComponent(PLANE)}&path=${encodeURIComponent(full)}${download ? "&download=1" : ""}`,
  [agentName]);

  // Takes a MATERIALIZED array, never a live FileList: an input's FileList
  // empties the instant its value is cleared, and a dataTransfer's when the
  // drop handler returns — a live reference here uploaded nothing, silently.
  const uploadFiles = useCallback(async (list: readonly File[]) => {
    if (list.length === 0) return;
    setUploads(list.map((f) => ({ name: f.name, status: "uploading" as const })));
    for (const f of list) {
      try {
        // Raw bytes over HTTP: no base64 inflation, no frame ceiling.
        const res = await fetch(rawUrl(joinDir(path, f.name), false), { method: "PUT", body: f });
        if (!res.ok) {
          const body = await res.text();
          const parsed = v.safeParse(
            UploadErrorSchema,
            tolerate<unknown>(() => JSON.parse(body), "malformed-input"),
          );
          const detail = parsed.success ? parsed.output.error : body.trim() || undefined;
          throw new Error(detail ?? `upload failed (${res.status})`);
        }
        setUploads((prev) => prev.filter((u) => u.name !== f.name));
      } catch (e) {
        setUploads((prev) => prev.map((u) => u.name === f.name
          ? { ...u, status: "error" as const, error: renderThrownChain({ cause: e }) }
          : u));
      }
    }
    await reloadListing();
  }, [path, rawUrl, reloadListing]);

  const commitRename = useCallback((from: string, draft: string) => run(async () => {
    const name = draft.trim();
    setRenaming(null);
    if (!name || name.includes("/")) throw new Error("a name cannot be empty or contain /");
    const to = joinDir(parentDir(from), name);
    if (to === from) return;
    const out = await rpc<WriteResult>("renameExecutorFile", [PLANE, from, to]);
    if ("error" in out) throw new Error(out.error);
    if (preview === from) setPreview(to);
    await reloadListing();
  }), [preview, reloadListing, rpc, run]);

  const deletePath = useCallback((full: string) => run(async () => {
    setConfirmDelete(null);
    const out = await rpc<WriteResult>("deleteExecutorFile", [PLANE, full]);
    if ("error" in out) throw new Error(out.error);
    if (preview === full) setPreview(null);
    await reloadListing();
  }), [preview, reloadListing, rpc, run]);

  const onListDragOver = useCallback((e: ReactDragEvent) => {
    if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragOver(true); }
  }, []);
  const onListDragLeave = useCallback((e: ReactDragEvent) => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setDragOver(false);
  }, []);
  const onListDrop = useCallback((e: ReactDragEvent) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    setDragOver(false);
    const dropped = [...e.dataTransfer.files];
    run(() => uploadFiles(dropped));
  }, [run, uploadFiles]);

  const atRoot = path === "/";
  const segments = path.split("/").filter(Boolean);

  // Offline mounts, appended to the root view as stated absences.
  const offlineMounts = atRoot
    ? mounts.filter((m) => !m.live && Object.values(MOUNT_EXECUTOR).includes(m.name))
    : [];

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((e) => e.name.toLowerCase().includes(needle));
  }, [entries, filter]);

  const laptopLabel = executors.find((e) => e.name === "laptop")?.label;
  const badgeFor = useCallback((entryName: string): string | null => {
    if (!atRoot) return null;
    const executor = MOUNT_EXECUTOR[entryName];
    if (!executor || !mounts.some((m) => m.name === executor && m.live)) return null;
    return executor === "laptop" ? laptopLabel ?? executorLabel("laptop") : executorLabel(executor);
  }, [atRoot, laptopLabel, mounts]);

  const open = useCallback((entry: DirEntry) => {
    const full = joinDir(path, entry.name);
    if (entry.type === "dir") {
      setFilter("");
      setPath(full);
    } else {
      setPreview(full);
    }
  }, [path]);

  // Keyboard: the list is a roving-focus widget. Arrows move, Enter opens,
  // Backspace goes up, F2 renames, Delete asks, Escape backs out.
  const onKeyDown = useCallback((e: ReactKeyboardEvent) => {
    if (renaming) return; // the rename input owns the keyboard
    const current = filtered[selected];
    if (e.key === "ArrowDown") { e.preventDefault(); setSelected((i) => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSelected((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && current) { e.preventDefault(); open(current); }
    else if (e.key === "Backspace" && !atRoot) { e.preventDefault(); setPath(parentDir(path)); }
    else if (e.key === "F2" && current) { e.preventDefault(); setRenaming({ path: joinDir(path, current.name), draft: current.name }); }
    else if (e.key === "Delete" && current) { e.preventDefault(); setConfirmDelete(joinDir(path, current.name)); }
    else if (e.key === "Escape") {
      e.preventDefault();
      if (confirmDelete) setConfirmDelete(null);
      else if (preview) setPreview(null);
      else if (filter) setFilter("");
    }
  }, [atRoot, confirmDelete, filter, filtered, open, path, preview, renaming, selected]);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const dirCount = filtered.filter((e) => e.type === "dir").length;

  return (
    <div className="@container flex h-full -m-5 min-h-0" data-files-surface>
      {/* ── Folder tree (hidden on narrow widths; the breadcrumb still navigates) ── */}
      <div className="hidden @[44rem]:block w-52 shrink-0 border-r p-border overflow-y-auto py-2">
        <TreeNode
          dir="/" label="Workspace" depth={0}
          path={path} expanded={expanded} cache={treeCache}
          badgeFor={badgeFor}
          onNavigate={(dir) => { setFilter(""); setPath(dir); }}
          onToggle={(dir) => run(async () => {
            toggleExpanded(dir);
            if (!treeCache.has(dir)) await listDir(dir);
          })}
        />
      </div>

      {/* ── Listing + preview ── */}
      <div className="flex-1 min-w-0 flex flex-col relative">
        {/* Path bar: the address AND the way up — every ancestor is a target. */}
        <div className="px-3 py-2 border-b p-border flex items-center gap-1 text-xs font-mono shrink-0 overflow-x-auto">
          <button data-files-crumb onClick={() => setPath("/")}
            className="p-text-3 hover:p-text shrink-0" title="Drive root">/</button>
          {segments.map((seg, i) => (
            <span key={i} className="flex items-center gap-1 min-w-0">
              <button
                data-files-crumb
                onClick={() => setPath(`/${segments.slice(0, i + 1).join("/")}`)}
                className={`truncate ${i === segments.length - 1 ? "p-text" : "p-text-3 hover:p-text"}`}
              >{seg}</button>
              {i < segments.length - 1 && <span className="p-text-3 shrink-0">/</span>}
            </span>
          ))}
          <input ref={uploadInputRef} type="file" multiple className="hidden"
            onChange={(e) => { const picked = [...(e.currentTarget.files ?? [])]; e.currentTarget.value = ""; run(() => uploadFiles(picked)); }} />
          <div className="ml-auto flex items-center gap-0.5 shrink-0">
            <button onClick={() => setPath(parentDir(path))} disabled={atRoot}
              className="p-text-3 hover:p-text p-1 disabled:opacity-30 disabled:hover:p-text-3"
              title="Parent directory" aria-label="Parent directory"><ArrowUpIcon size={12} /></button>
            <button onClick={() => setPath("/")} disabled={atRoot}
              className="p-text-3 hover:p-text p-1 disabled:opacity-30 disabled:hover:p-text-3"
              title="Drive root" aria-label="Drive root"><HouseIcon size={12} /></button>
            <button onClick={() => uploadInputRef.current?.click()}
              className="flex items-center gap-1 p-text-3 hover:p-text p-1"
              title={`Upload files to ${path}`}><UploadSimpleIcon size={11} />Upload</button>
            <button onClick={() => run(async () => { await reloadListing(); reloadMounts(); })}
              className="p-text-3 hover:p-text p-1"
              title="Refresh" aria-label="Refresh"><ArrowsClockwiseIcon size={11} /></button>
          </div>
        </div>

        {/* Filter-as-you-type over the current directory. */}
        <div className="px-3 py-1.5 border-b p-border flex items-center gap-1.5 shrink-0">
          <MagnifyingGlassIcon size={12} className="p-text-3 shrink-0" />
          <input
            data-files-filter
            value={filter}
            onChange={(e) => { setFilter(e.currentTarget.value); setSelected(0); }}
            placeholder="Filter this folder…"
            className="flex-1 bg-transparent text-xs p-text outline-hidden placeholder:p-text-4"
          />
          {filter && (
            <button onClick={() => setFilter("")} className="p-text-3 hover:p-text" aria-label="Clear filter">
              <XIcon size={12} />
            </button>
          )}
        </div>

        {mountsResource.status === "error" && (
          <LoadFailure what="the environments" message={mountsResource.message} onRetry={reloadMounts} className="px-3 py-2" />
        )}
        {notice && (
          <div data-files-notice className="px-3 py-1.5 text-xs p-danger border-b p-border flex items-start gap-1.5">
            <WarningIcon size={13} className="shrink-0 mt-px" />
            <span className="break-words min-w-0">{notice}</span>
            <button onClick={() => setNotice(null)} className="ml-auto p-text-3 hover:p-text shrink-0" aria-label="Dismiss">
              <XIcon size={12} />
            </button>
          </div>
        )}

        <div
          ref={listRef}
          data-files-list
          tabIndex={0}
          onKeyDown={onKeyDown}
          className={`flex-1 overflow-y-auto py-1 text-xs outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--c-accent)] ${dragOver ? "outline-dashed outline-2 -outline-offset-2 outline-[var(--c-accent)]" : ""}`}
          onDragOver={onListDragOver} onDragLeave={onListDragLeave} onDrop={onListDrop}
        >
          {err && <div className="p-danger px-3 py-1.5 break-words">{err}</div>}
          {uploads.map((u) => (
            <div key={u.name} className="flex items-center gap-1.5 font-mono px-3 py-1">
              {u.status === "uploading"
                ? <><Loader size="sm" /><span className="p-text-2 truncate">{u.name}</span><span className="p-text-3">uploading…</span></>
                : <><WarningIcon size={12} className="p-danger shrink-0" /><span className="p-text-2 truncate">{u.name}</span><span className="p-danger truncate">{u.error}</span></>}
            </div>
          ))}
          {loading && <div className="p-text-3 px-3 py-1.5">Loading…</div>}
          {!loading && !atRoot && (
            <button
              data-files-up-row
              onClick={() => setPath(parentDir(path))}
              className="flex items-center gap-2 w-full text-left font-mono px-3 py-1 p-text-3 hover:p-text p-row-hover"
            ><ArrowUpIcon size={12} className="shrink-0" /><span>..</span></button>
          )}
          {!loading && filtered.map((entry, i) => {
            const full = joinDir(path, entry.name);
            const badge = badgeFor(entry.name);
            return (
              <EntryRow
                key={entry.name}
                entry={entry} badge={badge}
                selected={i === selected}
                previewing={preview === full}
                renaming={renaming?.path === full ? renaming.draft : null}
                confirming={confirmDelete === full}
                downloadHref={entry.type === "file" ? rawUrl(full, true) : null}
                onSelect={() => setSelected(i)}
                onOpen={() => open(entry)}
                onRenameDraft={(draft) => setRenaming({ path: full, draft })}
                onRenameCommit={(draft) => commitRename(full, draft)}
                onRenameCancel={() => setRenaming(null)}
                onAskDelete={() => setConfirmDelete(full)}
                onDelete={() => deletePath(full)}
                onCancelDelete={() => setConfirmDelete(null)}
              />
            );
          })}
          {offlineMounts.map((m) => {
            const mountName = Object.entries(MOUNT_EXECUTOR).find(([, executor]) => executor === m.name)?.[0] ?? m.name;
            return (
              <div key={`offline-${m.name}`} data-files-offline-mount
                className="flex items-center gap-2 w-full font-mono px-3 py-1 p-text-4"
                title={m.reason ?? "not available"}>
                <PlugIcon size={12} className="shrink-0" />
                <span>{mountName}</span>
                <span data-mount-badge className="text-[10px] px-1.5 py-px rounded-full border p-border border-dashed">
                  {m.name === "laptop" ? laptopLabel ?? executorLabel("laptop") : executorLabel(m.name)}
                </span>
                <span className="p-text-4 truncate">— {m.reason ?? "not available"}</span>
                {m.name === "laptop" && (
                  <Link to="/user/settings#devices" className="p-accent hover:underline shrink-0">connect</Link>
                )}
              </div>
            );
          })}
          {!loading && filtered.length === 0 && entries.length > 0 && (
            <div className="p-text-3 italic px-3 py-1.5">Nothing here matches “{filter}”.</div>
          )}
          {!loading && entries.length === 0 && offlineMounts.length === 0 && !err && (
            <div className="p-text-3 italic px-3 py-1.5">This folder is empty. Drop files here to upload.</div>
          )}
          {!loading && filtered.length > 0 && (
            <div className="px-3 pt-1.5 pb-1 p-text-3 text-[10px] tabular-nums border-t p-border mt-1">
              {dirCount > 0 && `${dirCount} ${dirCount === 1 ? "folder" : "folders"}, `}
              {filtered.length - dirCount} {filtered.length - dirCount === 1 ? "file" : "files"}
              {filter && ` matching of ${entries.length}`}
              <span className="ml-2 hidden @[44rem]:inline p-text-4">↑↓ move · Enter open · Backspace up · F2 rename · Del delete</span>
            </div>
          )}
        </div>

        {/* Preview: a side panel where there is room, an overlay where not. */}
        {preview && (
          <FilePreview
            path={preview} rpc={rpc}
            inlineHref={rawUrl(preview, false)}
            downloadHref={rawUrl(preview, true)}
            onClose={() => setPreview(null)}
          />
        )}
      </div>
    </div>
  );
}

/* ── Folder tree ─────────────────────────────────────────────────── */

function TreeNode({ dir, label, depth, path, expanded, cache, badgeFor, onNavigate, onToggle }: {
  dir: string;
  label: string;
  depth: number;
  path: string;
  expanded: ReadonlySet<string>;
  cache: ReadonlyMap<string, DirEntry[]>;
  badgeFor: (name: string) => string | null;
  onNavigate: (dir: string) => void;
  onToggle: (dir: string) => void;
}) {
  const isOpen = expanded.has(dir);
  const children = cache.get(dir);
  const active = path === dir;
  return (
    <div>
      <div
        data-files-tree-node={dir}
        className={`flex items-center gap-1 pr-2 py-0.5 text-xs cursor-pointer p-row-hover ${active ? "p-fill p-text font-medium" : "p-text-2"}`}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        onClick={() => onNavigate(dir)}
      >
        <button
          onClick={(e) => { e.stopPropagation(); onToggle(dir); }}
          className="p-text-3 hover:p-text shrink-0"
          aria-label={isOpen ? `Collapse ${label}` : `Expand ${label}`}
        >
          {isOpen ? <CaretDownIcon size={10} /> : <CaretRightIcon size={10} />}
        </button>
        {isOpen ? <FolderOpenIcon size={13} className="p-info shrink-0" weight="fill" />
          : <FolderIcon size={13} className="p-info shrink-0" weight="fill" />}
        <span className="truncate">{label}</span>
        {depth === 1 && badgeFor(label) && (
          <span data-mount-badge className="text-[9px] px-1 py-px rounded-full p-fill p-text-3 shrink-0">
            {badgeFor(label)}
          </span>
        )}
      </div>
      {isOpen && children === undefined && (
        <div className="p-text-4 text-[10px]" style={{ paddingLeft: `${28 + depth * 12}px` }}>loading…</div>
      )}
      {isOpen && children?.filter((c) => c.type === "dir").map((child) => (
        <TreeNode
          key={child.name}
          dir={joinDir(dir, child.name)} label={child.name} depth={depth + 1}
          path={path} expanded={expanded} cache={cache} badgeFor={badgeFor}
          onNavigate={onNavigate} onToggle={onToggle}
        />
      ))}
    </div>
  );
}

/* ── One listing row ─────────────────────────────────────────────── */

function EntryRow({ entry, badge, selected, previewing, renaming, confirming, downloadHref, onSelect, onOpen, onRenameDraft, onRenameCommit, onRenameCancel, onAskDelete, onDelete, onCancelDelete }: {
  entry: DirEntry;
  badge: string | null;
  selected: boolean;
  previewing: boolean;
  renaming: string | null;
  confirming: boolean;
  downloadHref: string | null;
  onSelect: () => void;
  onOpen: () => void;
  onRenameDraft: (draft: string) => void;
  onRenameCommit: (draft: string) => void;
  onRenameCancel: () => void;
  onAskDelete: () => void;
  onDelete: () => void;
  onCancelDelete: () => void;
}) {
  return (
    <div
      data-files-entry
      aria-selected={selected || undefined}
      title={entry.name}
      className={`group flex items-center gap-2 w-full text-left font-mono px-3 py-1 p-row-hover cursor-pointer ${
        selected || previewing ? "p-fill p-text" : "p-text-2 hover:p-text"}`}
      onClick={() => { onSelect(); onOpen(); }}
    >
      {entry.type === "dir"
        ? <FolderIcon size={12} className="p-info shrink-0" weight="fill" />
        : <FileIcon size={12} className="p-text-3 shrink-0" />}
      {renaming !== null ? (
        <input
          data-files-rename-input
          autoFocus
          value={renaming}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onRenameDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") onRenameCommit(e.currentTarget.value);
            if (e.key === "Escape") onRenameCancel();
          }}
          onBlur={onRenameCancel}
          className="flex-1 min-w-0 bg-transparent border p-border rounded-xs px-1 py-0 text-xs p-text outline-hidden focus:border-[var(--c-accent)]"
        />
      ) : (
        <span className="truncate flex-1">{entry.name}</span>
      )}
      {badge && (
        <span data-mount-badge className="text-[10px] px-1.5 py-px rounded-full p-fill p-text-3 shrink-0">{badge}</span>
      )}
      {confirming ? (
        <span className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          <span className="p-danger text-[10px]">delete?</span>
          <button data-files-delete-confirm onClick={onDelete} className="p-danger hover:opacity-80 p-0.5" aria-label={`Delete ${entry.name}`}>
            <CheckIcon size={12} />
          </button>
          <button onClick={onCancelDelete} className="p-text-3 hover:p-text p-0.5" aria-label="Keep it">
            <XIcon size={12} />
          </button>
        </span>
      ) : (
        <span
          className="items-center gap-0.5 shrink-0 hidden group-hover:flex"
          onClick={(e) => e.stopPropagation()}
        >
          {downloadHref && (
            <a data-files-download href={downloadHref} className="p-text-3 hover:p-text p-0.5"
              title={`Download ${entry.name}`} aria-label={`Download ${entry.name}`}>
              <DownloadSimpleIcon size={12} />
            </a>
          )}
          <button data-files-rename onClick={() => onRenameDraft(entry.name)} className="p-text-3 hover:p-text p-0.5"
            title={`Rename ${entry.name}`} aria-label={`Rename ${entry.name}`}>
            <PencilSimpleIcon size={12} />
          </button>
          <button data-files-delete onClick={onAskDelete} className="p-text-3 hover:p-danger p-0.5"
            title={`Delete ${entry.name}`} aria-label={`Delete ${entry.name}`}>
            <TrashIcon size={12} />
          </button>
        </span>
      )}
      <span className="p-text-3 shrink-0 tabular-nums w-12 text-right">
        {entry.type === "file" && entry.size != null ? fmtSize(entry.size) : ""}
      </span>
      <span className="p-text-4 shrink-0 tabular-nums w-16 text-right hidden @[56rem]:inline">
        {fmtWhen(entry.mtimeMs)}
      </span>
    </div>
  );
}

/* ── Preview ─────────────────────────────────────────────────────── */

/** Text rides the viewer RPC; images and PDFs ride the same raw-bytes route
 *  the download uses — one pipeline, two dispositions. */
function FilePreview({ path, rpc, inlineHref, downloadHref, onClose }: {
  path: string;
  rpc: Rpc;
  inlineHref: string;
  downloadHref: string;
  onClose: () => void;
}) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const ext = extensionOf(path);
  const kind = Object.hasOwn(IMAGE_EXTENSIONS, ext) ? "image" : ext === "pdf" ? "pdf" : "text";
  // `null` IS the loading state: the pre must never paint before the answer,
  // or a reader (and the browser gate) sees an empty file that is not empty.
  const [file, setFile] = useState<FileText | null>(null);

  useEffect(() => {
    if (kind !== "text") return;
    setFile(null);
    void rpc<FileText>("readExecutorFile", [PLANE, path])
      .then(setFile, (error: Error) => setFile({ error: renderThrownChain({ cause: error }) }));
  }, [kind, path, rpc]);

  return (
    <div
      data-files-preview
      className="absolute inset-0 z-10 p-bg flex flex-col border-l p-border @[64rem]:static @[64rem]:w-[42%] @[64rem]:shrink-0"
    >
      <div className="px-3 py-2 border-b p-border flex items-center gap-2 shrink-0">
        <FileIcon size={13} className="p-text-3 shrink-0" />
        <span className="text-xs font-mono p-text truncate" title={path}>{name}</span>
        <div className="ml-auto flex items-center gap-1 shrink-0">
          <a data-files-download href={downloadHref} className="flex items-center gap-1 text-[11px] p-text-2 hover:p-text p-1" title={`Download ${name}`}>
            <DownloadSimpleIcon size={12} />Download
          </a>
          <button onClick={onClose} className="p-text-3 hover:p-text p-1" title="Close preview" aria-label="Close preview">
            <XIcon size={13} />
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {kind === "image" && (
          <div className="h-full flex items-center justify-center p-4">
            <img src={inlineHref} alt={name} className="max-w-full max-h-full object-contain rounded-sm border p-border" />
          </div>
        )}
        {kind === "pdf" && (
          <embed src={inlineHref} type="application/pdf" className="w-full h-full" title={name} />
        )}
        {kind === "text" && (
          file === null ? <div className="h-full flex items-center justify-center"><Loader size="base" /></div>
          : file.error ? (
            <div className="p-4 text-xs space-y-2">
              <div className="p-danger break-words">{file.error}</div>
              <a href={downloadHref} className="inline-flex items-center gap-1 p-accent hover:underline">
                <DownloadSimpleIcon size={12} />Download instead
              </a>
            </div>
          ) : (
            <pre className="p-3 text-[11px] leading-relaxed font-mono p-text-2 whitespace-pre-wrap break-words">
              {file.content ?? ""}
              {file.truncated && <span className="p-text-4">{"\n… truncated for preview — download for the whole file"}</span>}
            </pre>
          )
        )}
      </div>
    </div>
  );
}
