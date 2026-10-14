/** Raw bytes ride the files HTTP route: the RPC transport is the chat WebSocket, whose 1 MiB frame ceiling is below ordinary file sizes. */
import { Effect, Cause } from 'effect';
import {
  useCallback, useEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useParams } from "react-router-dom";
import { Loader } from "@cloudflare/kumo";
import {
  ArrowsClockwiseIcon, ArrowUpIcon, CaretDownIcon, CaretRightIcon,
  DownloadSimpleIcon, FileIcon, FolderIcon, FolderOpenIcon, HouseIcon,
  MagnifyingGlassIcon, PencilSimpleIcon, PlugIcon, TrashIcon, UploadSimpleIcon,
  WarningIcon, XIcon,
} from "@phosphor-icons/react";
import {
  formatBytes, joinDir, parentDir, shortAge, MOUNT_EXECUTORS, type DirEntry, type MountInfo,
} from "@kinu.run/core";
import { renderThrownChain, showing, settle, detach } from "@kinu.run/core/obs";
import { executorLabel, type ExecutorInfo } from "@kinu.run/core";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { TileMenu, type MenuItem } from "@/components/drive/DriveTiles";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { useMounts } from "@/hooks/use-mounts";
import { useToggledSet } from "@/hooks/use-toggled-set";
import { useFileDrop } from "@/hooks/use-file-drop";
import { useUploads } from "@/hooks/use-uploads";
import { FileViewer } from "./FileViewer";
import {
  PLANE, entryRevision, nextTreeCache, putFileBytes, type CachedDir,
} from "@kinu.run/core";
import type { VfsRevision } from "@nimbus-sh/core/vfs/vfs.js";
import { composing } from "@/components/ui/form";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";

/** An upload over a file already there: replaced only on the owner's word. */
function ReplacePrompt({ name, onReplace, onKeep }: { name: string; onReplace: () => void; onKeep: () => void }) {
  return (
    <div role="alertdialog" aria-label={`Replace ${name}?`} className="flex min-w-0 flex-1 items-center gap-2" data-upload-replace>
      <WarningIcon size={12} className="p-warning shrink-0" />
      <span className="p-text-2 truncate">Replace <span className="p-text">{name}</span>?</span>
      <span className="p-text-3 hidden @[30rem]:inline truncate">A file with this name is already here.</span>
      <span className="ml-auto flex shrink-0 gap-1">
        <button type="button" data-upload-keep onClick={onKeep}
          className="rounded px-2 py-0.5 p-text-2 hover:p-text p-row-hover focus-visible:ring-1 focus-visible:ring-[var(--c-accent)] outline-hidden">Cancel</button>
        <button type="button" data-upload-confirm onClick={onReplace} autoFocus
          className="rounded px-2 py-0.5 p-accent hover:underline focus-visible:ring-1 focus-visible:ring-[var(--c-accent)] outline-hidden">Replace</button>
      </span>
    </div>
  );
}

const MOUNT_EXECUTOR: Record<string, string> = Object.fromEntries(
  Object.entries(MOUNT_EXECUTORS).map(([mount, executor]) => [mount.slice(1), executor]),
);

/** The list's columns at every width: icon, name, then size and age, one cell below 26rem and a column each from it. A
 *  touch screen keeps a gutter for the row's menu, which a pointer finds on hover over the age. */
const COLUMNS = "grid-cols-[1rem_minmax(0,1fr)_auto] @[26rem]:grid-cols-[1rem_minmax(0,1fr)_4.5rem_4rem] items-center gap-x-2.5 px-3 pointer-coarse:pr-11";

/** What the menu covers under a pointer while it shows. */
const UNDER_MENU = "pointer-fine:group-hover:invisible pointer-fine:group-has-[[data-drive-menu]:focus-visible]:invisible pointer-fine:group-has-[[aria-expanded=true]]:invisible";

/** A row a finger can take on a touch screen; dense under a pointer. */
const ROW_HEIGHT = "min-h-8 pointer-coarse:min-h-11";

/** A machine that is not there, in the list and the tree where its folder would be. */
interface OfflineRow {
  readonly name: string;
  /** Its own name, where it says more than the folder's. */
  readonly label: string | null;
  readonly reason: string;
  readonly onConnect?: () => void;
}

type ListRow = { readonly entry: DirEntry; readonly index: number } | OfflineRow;

/** Each offline machine among the folders, by name, as its folder would sort. */
function placeOffline(entries: readonly DirEntry[], offline: readonly OfflineRow[]): ListRow[] {
  const rows: ListRow[] = entries.map((entry, index) => ({ entry, index }));

  for (const row of [...offline].sort((a, b) => a.name.localeCompare(b.name))) {
    const at = rows.findIndex((other) => "entry" in other && (other.entry.type === "file" || other.entry.name.localeCompare(row.name) > 0));

    rows.splice(at === -1 ? rows.length : at, 0, row);
  }

  return rows;
}

/** A machine's label as its folder wears it: none where it only repeats the folder's name. */
function beside(label: string, folder: string): string | null {
  return label.toLowerCase() === folder.toLowerCase() ? null : label;
}

/** The bytes as a download whatever the route answers: `download` keeps an error page from replacing the app. */
function saveAs(href: string): void {
  const link = document.createElement("a");

  link.href = href;
  link.download = "";
  link.click();
}



/** The root's machines as Files shows them: a live one's own name beside its folder, and one that is away as a row. */
function useMachines(executors: readonly ExecutorInfo[], mounts: readonly MountInfo[], onConnectDevice: () => void) {
  const deviceLabel = executors.find((e) => e.name === "device")?.label;

  return useMemo(() => {
    const labelOf = (executor: string) => (executor === "device" ? deviceLabel ?? executorLabel("device") : executorLabel(executor));

    // A machine that is not there keeps its place among the root's folders, in the list and the tree alike; a listed
    // folder of its name would only refuse.
    const away = mounts.flatMap((mount): OfflineRow[] => {
      const name = Object.keys(MOUNT_EXECUTOR).find((point) => MOUNT_EXECUTOR[point] === mount.name);

      return name === undefined || mount.live ? [] : [{
        name, label: beside(labelOf(mount.name), name), reason: mount.reason ?? "not available",
        ...(mount.name === "device" && { onConnect: onConnectDevice }),
      }];
    });

    const badgeFor = (name: string): string | null => {
      const executor = MOUNT_EXECUTOR[name];

      return executor !== undefined && mounts.some((m) => m.name === executor && m.live) ? beside(labelOf(executor), name) : null;
    };

    return { away, badgeFor };
  }, [deviceLabel, mounts, onConnectDevice]);
}

export interface FilesSurfaceProps {
  rpc: WorkspaceRpc;
  executors: ExecutorInfo[];
  jump?: { path: string; file?: string; nonce: number } | null;
  onConnectDevice: () => void;
}

/** "3 folders, 2 files", naming only what the folder holds. */
function folderCount(folders: number, files: number): string {
  const said = [
    ...(folders > 0 ? [`${String(folders)} ${folders === 1 ? "folder" : "folders"}`] : []),
    ...(files > 0 || folders === 0 ? [`${String(files)} ${files === 1 ? "file" : "files"}`] : []),
  ];

  return said.join(", ");
}


export function FilesSurface({ rpc, executors, jump, onConnectDevice }: FilesSurfaceProps) {
  const agentName = useParams().agentId ?? "";
  const [path, setPath] = useState("/");
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [renaming, setRenaming] = useState<{ path: string; draft: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [treeCache, setTreeCache] = useState<ReadonlyMap<string, CachedDir>>(new Map());
  const { set: expanded, toggle: toggleExpanded } = useToggledSet(() => new Set(["/"]));
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { resource: mountsResource, reload: reloadMounts } = useMounts(rpc, executors);
  const mounts = lastValue(mountsResource) ?? [];

  const listDir = useCallback((dir: string): Promise<{ path: string; entries: DirEntry[] }> => settle(Effect.gen(function* () {
    const r = yield* Effect.promise(async () => rpc("getExecutorFiles", [PLANE, dir]));

    if (r.error) return yield* Effect.die(new Error(r.error));
    const listed = r.entries ?? [];
    const at = r.path ?? dir;
    setTreeCache((prev) => nextTreeCache(prev, at, listed));

    return { path: at, entries: listed };
  })), [rpc]);

  /** A bare mount point's listing, answered for the directory it landed on: written as that listing adopts the
   *  landed path, taken by the load the adoption starts, which then asks for nothing. */
  const landed = useRef<{ readonly path: string; readonly entries: DirEntry[] } | null>(null);

  // Keyed on `path` so an old directory's listing never renders under the new breadcrumb.
  const loadListing = useCallback((): Promise<DirEntry[]> => settle(Effect.catchCause(Effect.gen(function* () {
    const held = landed.current;

    landed.current = null;

    if (held?.path === path) return held.entries;
    const listed = yield* Effect.promise(async () => listDir(path));

    // A bare mount point lists the consented directory; adopt the returned path so child paths resolve.
    if (listed.path !== path) {
      landed.current = listed;
      setPath(listed.path);
    }

    return listed.entries;
  }), (failed) => Effect.gen(function* () {
    const e = Cause.squash(failed);

    return yield* Effect.die(new Error(renderThrownChain({ cause: e }), { cause: e }));
  }))), [listDir, path]);

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

  const lastJump = useRef(0);
  useEffect(() => {
    if (!jump || jump.nonce === lastJump.current) return;
    lastJump.current = jump.nonce;
    setPreview(jump.file ?? null);
    setFilter("");
    setPath(jump.path);
  }, [jump]);

  const run = useCallback((op: Effect.Effect<void>) => settle(Effect.gen(function* () {
    setNotice(null);

    return yield* Effect.catchCause(op, showing(setNotice));
  })), []);

  const readPlaneFile = useCallback((full: string) => rpc("readExecutorFile", [PLANE, full]), [rpc]);

  const rawUrl = useCallback((full: string, download: boolean) =>
    `/api/workspaces/${encodeURIComponent(agentName)}/files`
    + `?executor=${encodeURIComponent(PLANE)}&path=${encodeURIComponent(full)}${download ? "&download=1" : ""}`,
  [agentName]);

  // One file's bytes, raw over HTTP (no base64 inflation, no frame ceiling): created only where none is, or, with
  // `revision`, replacing exactly the file the owner chose to replace.
  const put = useCallback((target: string, file: File, revision?: VfsRevision) => putFileBytes(rawUrl(target, false), file, revision), [rawUrl]);

  const { uploads, upload, replace: replaceUpload, keep: keepExisting } = useUploads({ put, reload: async () => { await reloadListing(); } });

  // Takes a materialized array: a live FileList empties when the input clears or the drop handler returns. Each file's
  // place is fixed where it was dropped.
  const uploadFiles = useCallback((list: readonly File[]) => upload(list.map((file) => ({ file, target: joinDir(path, file.name) }))), [path, upload]);

  const commitRename = useCallback((from: string, draft: string) => run(Effect.gen(function* () {
    const name = draft.trim();
    setRenaming(null);

    if (!name || name.includes("/")) return yield* Effect.die(new Error("a name cannot be empty or contain /"));
    const to = joinDir(parentDir(from), name);

    if (to === from) return;
    const out = yield* Effect.promise(() => rpc("renameExecutorFile", [PLANE, from, to]));

    if ("error" in out) return yield* Effect.die(new Error(out.error));

    if (preview === from) setPreview(to);
    reloadListing();
  })), [preview, reloadListing, rpc, run]);

  const deletePath = useCallback((full: string) => run(Effect.gen(function* () {
    setConfirmDelete(null);
    const out = yield* Effect.promise(() => rpc("deleteExecutorFile", [PLANE, full]));

    if ("error" in out) return yield* Effect.die(new Error(out.error));

    if (preview === full) setPreview(null);
    reloadListing();
  })), [preview, reloadListing, rpc, run]);

  const uploadDropped = useCallback((files: FileList) => {
    const dropped = [...files];

    detach(Effect.promise(() => run(Effect.promise(() => uploadFiles(dropped)))));
  }, [run, uploadFiles]);

  const { dragOver, handlers: listDrop } = useFileDrop(uploadDropped);

  const atRoot = path === "/";
  const segments = path.split("/").filter(Boolean);

  const needle = filter.trim().toLowerCase();
  const { away, badgeFor } = useMachines(executors, mounts, onConnectDevice);
  const offline = atRoot ? away.filter((row) => row.name.includes(needle)) : [];

  const filtered = useMemo(
    () => entries.filter((e) => e.name.toLowerCase().includes(needle) && !(atRoot && away.some((row) => row.name === e.name))),
    [atRoot, away, entries, needle],
  );

  const open = useCallback((entry: DirEntry) => {
    const full = joinDir(path, entry.name);

    if (entry.type === "dir") {
      setFilter("");
      setPath(full);
    } else {
      setPreview(full);
    }
  }, [path]);

  /** Read from the current `entries` so any refetch hands the viewer a new revision; `""` when not listed. */
  const previewRevision = useMemo(() => {
    if (!preview) return "";
    const name = preview.slice(preview.lastIndexOf("/") + 1);

    const entry = preview === joinDir(path, name)
      ? entries.find((candidate) => candidate.name === name)
      : undefined;

    return entry ? entryRevision(entry) : "";
  }, [entries, path, preview]);

  const onKeyDown = useCallback((e: ReactKeyboardEvent) => {
    if (renaming) return;
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
      <div className="hidden @[44rem]:block w-52 shrink-0 border-r p-border overflow-y-auto py-2">
        <TreeNode
          dir="/" label="Workspace" depth={0}
          path={path} previewPath={preview} expanded={expanded} cache={treeCache}
          badgeFor={badgeFor} away={away}
          onNavigate={(dir) => { setFilter(""); setPath(dir); }}
          onOpenFile={setPreview}
          onToggle={(dir) => run(Effect.gen(function* () {
            toggleExpanded(dir);

            if (!treeCache.has(dir)) yield* Effect.promise(() => listDir(dir));
          }))}
        />
      </div>

      <div className="flex-1 min-w-0 flex flex-col relative">
        <div className="px-3 py-2 border-b p-border flex items-center gap-1 text-xs font-mono shrink-0 overflow-x-auto">
          <button data-files-crumb onClick={() => setPath("/")}
            className="p-text-3 hover:p-text shrink-0" title="Workspace root">/</button>
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
            onChange={(e) => detach(Effect.promise(async () => {
              const picked = [...(e.currentTarget.files ?? [])];
              e.currentTarget.value = "";

              return run(Effect.promise(() => uploadFiles(picked)));
            }))} />
          <div className="ml-auto flex items-center gap-0.5 shrink-0">
            <button onClick={() => setPath(parentDir(path))} disabled={atRoot}
              className="p-text-3 hover:p-text p-1 disabled:opacity-30 disabled:hover:p-text-3"
              title="Parent directory" aria-label="Parent directory"><ArrowUpIcon size={12} /></button>
            <button onClick={() => setPath("/")} disabled={atRoot}
              className="p-text-3 hover:p-text p-1 disabled:opacity-30 disabled:hover:p-text-3"
              title="Workspace root" aria-label="Workspace root"><HouseIcon size={12} /></button>
            <button onClick={() => uploadInputRef.current?.click()}
              className="flex items-center gap-1 p-text-3 hover:p-text p-1"
              title={`Upload files to ${path}`}><UploadSimpleIcon size={11} />Upload</button>
            {/* Drops every cached listing: a plane without mtime gives `nextTreeCache` nothing to compare. */}
            <button onClick={() => detach(Effect.promise(() => run(Effect.sync(() => {
              setTreeCache(new Map());
              reloadListing();
              reloadMounts();
            }))))}
              className="p-text-3 hover:p-text p-1"
              title="Refresh" aria-label="Refresh"><ArrowsClockwiseIcon size={11} /></button>
          </div>
        </div>

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

        {/* The viewer covers the column below 64rem and stands beside the list from it. */}
        <div className="flex-1 min-h-0 flex">
          <div
            ref={listRef}
            data-files-list
            tabIndex={0}
            onKeyDown={onKeyDown}
            className={`group/list flex-1 min-w-0 overflow-y-auto pb-1 text-xs outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--c-accent)] ${dragOver ? "outline-dashed outline-2 -outline-offset-2 outline-[var(--c-accent)]" : ""}`}
            {...listDrop}
          >
            <div aria-hidden="true" className={`sticky top-0 z-[1] hidden @[26rem]:grid ${COLUMNS} h-7 border-b p-border p-sidebar p-meta p-text-3`}>
              <span /><span>Name</span><span className="text-right">Size</span><span className="text-right">Modified</span>
            </div>
            {err && <div className="p-danger px-3 py-1.5 break-words">{err}</div>}
            {uploads.map((u) => {
              // Named by its folder too once the owner has browsed away from it.
              const name = parentDir(u.target) === path ? u.target.slice(u.target.lastIndexOf("/") + 1) : u.target;

              return (
                <div key={u.target} className={`flex items-center gap-2.5 px-3 ${ROW_HEIGHT} p-row-text`} data-upload={u.status} data-upload-target={u.target}>
                  {u.status === "uploading" && <><Loader size="sm" /><span className="p-text-2 truncate">{name}</span><span className="ml-auto p-meta p-text-3 shrink-0">uploading…</span></>}
                  {u.status === "error" && <><WarningIcon size={16} className="p-danger shrink-0" /><span className="p-text-2 truncate">{name}</span><span className="p-meta p-danger truncate">{u.error}</span></>}
                  {u.status === "exists" && (
                    <ReplacePrompt name={name} onReplace={() => detach(Effect.promise(() => replaceUpload(u)))} onKeep={() => keepExisting(u.target)} />
                  )}
                </div>
              );
            })}
            {loading && <div className="p-text-3 px-3 py-1.5">Loading…</div>}
            {!loading && !atRoot && (
              <button
                data-files-up-row
                onClick={() => setPath(parentDir(path))}
                className={`grid ${COLUMNS} ${ROW_HEIGHT} w-full text-left p-text-3 hover:p-text p-row-hover`}
              ><ArrowUpIcon size={16} /><span className="p-row-text">..</span></button>
            )}
            {!loading && placeOffline(filtered, offline).map((row) => {
              if (!("entry" in row)) return <OfflineMountRow key={`offline-${row.name}`} row={row} />;

              const { entry, index } = row;
              const full = joinDir(path, entry.name);

              return (
                <EntryRow
                  key={entry.name}
                  entry={entry} badge={atRoot ? badgeFor(entry.name) : null}
                  selected={index === selected}
                  previewing={preview === full}
                  renaming={renaming?.path === full ? renaming.draft : null}
                  confirming={confirmDelete === full}
                  downloadHref={entry.type === "file" ? rawUrl(full, true) : null}
                  onSelect={() => setSelected(index)}
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
            {!loading && filtered.length === 0 && offline.length === 0 && entries.length > 0 && (
              <div className="p-text-3 italic px-3 py-1.5">Nothing here matches "{filter}".</div>
            )}
            {!loading && entries.length === 0 && offline.length === 0 && !err && (
              <div className="p-text-3 italic px-3 py-1.5">This folder is empty. Drop files here to upload.</div>
            )}
            {!loading && filtered.length > 0 && (
              <div className="px-3 pt-1.5 pb-1 p-text-3 p-meta border-t p-border mt-1">
                {filter ? `${String(filtered.length)} of ${String(entries.length)} match` : folderCount(dirCount, filtered.length - dirCount)}
                <span className="ml-2 hidden @[44rem]:inline p-text-4">↑↓ move · Enter open · Backspace up · F2 rename · Del delete</span>
              </div>
            )}
          </div>

          {preview && (
            <FileViewer
              path={preview} read={readPlaneFile}
              revision={previewRevision}
              rawHref={rawUrl(preview, false)}
              downloadHref={rawUrl(preview, true)}
              onSaved={() => { reloadListing(); }}
              onClose={() => setPreview(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function TreeNode({ dir, label, depth, path, previewPath, expanded, cache, badgeFor, away = [], onNavigate, onOpenFile, onToggle }: {
  dir: string;
  label: string;
  depth: number;
  path: string;
  previewPath: string | null;
  expanded: ReadonlySet<string>;
  cache: ReadonlyMap<string, CachedDir>;
  badgeFor: (name: string) => string | null;
  /** The root's machines that are not there, placed as the list places them. */
  away?: readonly OfflineRow[];
  onNavigate: (dir: string) => void;
  onOpenFile: (path: string) => void;
  onToggle: (dir: string) => Promise<void>;
}) {
  const isOpen = expanded.has(dir);
  const listed = cache.get(dir)?.entries;
  const children = listed && placeOffline(listed.filter((child) => !away.some((row) => row.name === child.name)), away);
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
          onClick={(e) => detach(Effect.promise(async () => {
            e.stopPropagation();

            return onToggle(dir);
          }))}
          className="p-text-3 hover:p-text shrink-0"
          aria-label={isOpen ? `Collapse ${label}` : `Expand ${label}`}
        >
          {isOpen ? <CaretDownIcon size={10} /> : <CaretRightIcon size={10} />}
        </button>
        {isOpen ? <FolderOpenIcon size={13} className="p-info shrink-0" weight="fill" />
          : <FolderIcon size={13} className="p-info shrink-0" weight="fill" />}
        <span className="truncate">{label}</span>
        {depth === 1 && badgeFor(label) && (
          <span data-mount-badge className="truncate p-meta p-text-3">{badgeFor(label)}</span>
        )}
      </div>
      {isOpen && children === undefined && (
        <div className="p-text-4 p-meta" style={{ paddingLeft: `${28 + depth * 12}px` }}>loading…</div>
      )}
      {isOpen && children?.map((row) => {
        if (!("entry" in row)) return <OfflineTreeRow key={`offline-${row.name}`} row={row} depth={depth + 1} />;
        const child = row.entry;
        const full = joinDir(dir, child.name);

        return child.type === "dir" ? (
          <TreeNode
            key={child.name}
            dir={full} label={child.name} depth={depth + 1}
            path={path} previewPath={previewPath} expanded={expanded} cache={cache} badgeFor={badgeFor}
            onNavigate={onNavigate} onOpenFile={onOpenFile} onToggle={onToggle}
          />
        ) : (
          <div
            key={child.name}
            data-files-tree-file={full}
            title={child.name}
            className={`flex items-center gap-1 pr-2 py-0.5 text-xs cursor-pointer p-row-hover ${
              previewPath === full ? "p-fill p-text font-medium" : "p-text-2"}`}
            style={{ paddingLeft: `${20 + (depth + 1) * 12}px` }}
            onClick={() => onOpenFile(full)}
          >
            <FileIcon size={12} className="p-text-3 shrink-0" />
            <span className="truncate">{child.name}</span>
          </div>
        );
      })}
    </div>
  );
}

/** The tree's row for a machine that is not there: as the list says it, with no way in until it connects. */
function OfflineTreeRow({ row, depth }: { row: OfflineRow; depth: number }) {
  return (
    <div data-files-tree-offline={row.name} title={`${row.label ?? row.name}: ${row.reason}`}
      className="group flex items-center gap-1 pr-2 py-0.5 text-xs p-text-4"
      style={{ paddingLeft: `${22 + depth * 12}px` }}>
      {/* Where a folder's icon stands beside its caret. */}
      <PlugIcon size={13} className="shrink-0" />
      <span className="truncate">{row.name}</span>
      <span className="ml-1 truncate p-meta">offline</span>
      {row.onConnect && (
        <button type="button" data-files-tree-connect onClick={row.onConnect}
          className="ml-auto shrink-0 p-meta font-medium p-accent hover:underline opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100">
          Connect
        </button>
      )}
    </div>
  );
}

/** A machine that is not there, as a row of the list: its name where its folder would be, and the way to bring it. */
function OfflineMountRow({ row }: { row: OfflineRow }) {
  return (
    <div data-files-offline-mount title={row.reason} className={`grid ${COLUMNS} ${ROW_HEIGHT}`}>
      <PlugIcon size={16} className="p-text-4" />
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate p-row-text p-text-3">{row.name}</span>
        <span data-mount-badge className="truncate p-meta p-text-4">
          {row.label === null ? "offline" : `${row.label} · offline`}
        </span>
      </span>
      <span className="text-right @[26rem]:col-span-2">
        {row.onConnect && (
          <button type="button" data-files-connect onClick={row.onConnect}
            className="p-meta font-medium p-accent hover:underline">Connect</button>
        )}
      </span>
    </div>
  );
}

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
  onRenameCommit: (draft: string) => Promise<void>;
  onRenameCancel: () => void;
  onAskDelete: () => void;
  onDelete: () => Promise<void>;
  onCancelDelete: () => void;
}) {
  const size = entry.type === "file" && entry.size != null ? formatBytes(entry.size) : null;
  const age = entry.mtimeMs ? shortAge(entry.mtimeMs) : null;
  const changed = entry.mtimeMs ? new Date(entry.mtimeMs).toLocaleString() : undefined;

  const fetchItem: MenuItem[] = downloadHref === null ? [] : [{
    label: "Download", icon: <DownloadSimpleIcon size={16} />, onSelect: () => saveAs(downloadHref), marker: "data-files-download",
  }];

  const menu: MenuItem[] = [
    ...fetchItem,
    { label: "Rename", icon: <PencilSimpleIcon size={16} />, onSelect: () => onRenameDraft(entry.name), marker: "data-files-rename" },
    { label: "Delete", icon: <TrashIcon size={16} />, onSelect: onAskDelete, danger: true, apart: true, marker: "data-files-delete" },
  ];

  // The cursor shows only while the keys drive it; what is open in the viewer stays marked.
  const tone = previewing ? "p-fill p-text" : `p-text ${selected ? "group-focus-visible/list:p-fill" : ""}`;

  return (
    <div
      data-files-entry
      aria-selected={selected || undefined}
      title={entry.name}
      className={`group relative grid ${COLUMNS} ${ROW_HEIGHT} cursor-pointer p-row-hover ${tone}`}
      onClick={() => { onSelect(); onOpen(); }}
    >
      {entry.type === "dir"
        ? <FolderIcon size={16} className="p-info" weight="fill" />
        : <FileIcon size={16} className="p-text-3" />}
      <span className="flex min-w-0 items-baseline gap-2">
        {renaming !== null ? (
          <input
            data-files-rename-input
            autoFocus
            value={renaming}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onRenameDraft(e.currentTarget.value)}
            onKeyDown={(e) => detach(Effect.promise(async () => {
              e.stopPropagation();

              if (composing(e.nativeEvent)) return;

              if (e.key === "Enter") return onRenameCommit(e.currentTarget.value);

              if (e.key === "Escape") onRenameCancel();
            }))}
            onBlur={onRenameCancel}
            className="w-full min-w-0 bg-transparent border p-border rounded-xs px-1.5 py-0 p-row-text p-text"
          />
        ) : (
          <span className={`truncate p-row-text ${previewing ? "font-medium" : ""}`}>{entry.name}</span>
        )}
        {badge && <span data-mount-badge className="truncate p-meta p-text-3">{badge}</span>}
      </span>
      {confirming ? (
        <span className="flex items-center justify-end gap-2.5 p-meta @[26rem]:col-span-2" onClick={(e) => e.stopPropagation()}>
          <button data-files-delete-confirm onClick={(...args: Parameters<typeof onDelete>) => detach(Effect.promise(async () => onDelete(...args)))}
            className="font-medium p-danger hover:underline" aria-label={`Delete ${entry.name}`}>Delete</button>
          <button onClick={onCancelDelete} className="p-text-3 hover:p-text" aria-label="Keep it">Keep</button>
        </span>
      ) : (
        <>
          <span className="hidden truncate text-right p-meta p-text-3 @[26rem]:block">{size}</span>
          <span className={`hidden text-right p-meta p-text-3 @[26rem]:block ${UNDER_MENU}`} title={changed}>{age}</span>
          <span className={`whitespace-nowrap text-right p-meta p-text-3 @[26rem]:hidden ${UNDER_MENU}`} title={changed}>
            {[size, age].filter((part) => part !== null).join(" · ")}
          </span>
        </>
      )}
      {/* No transform on the way: the menu is a fixed sheet on a phone. */}
      <span className="absolute inset-y-0 right-1.5 flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100 pointer-coarse:opacity-100"
        onClick={(e) => e.stopPropagation()}>
        <span className="relative size-7">
          <TileMenu name={entry.name} items={menu} className="inset-0" />
        </span>
      </span>
    </div>
  );
}
