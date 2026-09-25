/** Raw bytes ride the files HTTP route: the RPC transport is the chat WebSocket, whose 1 MiB frame ceiling is below ordinary file sizes. */
import {
  useCallback, useEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useParams } from "react-router-dom";
import { Loader } from "@cloudflare/kumo";
import {
  ArrowsClockwiseIcon, ArrowUpIcon, CaretDownIcon, CaretRightIcon, CheckIcon,
  DownloadSimpleIcon, FileIcon, FolderIcon, FolderOpenIcon, HouseIcon,
  MagnifyingGlassIcon, PencilSimpleIcon, PlugIcon, TrashIcon, UploadSimpleIcon,
  WarningIcon, XIcon,
} from "@phosphor-icons/react";
import {
  formatBytes, joinDir, parentDir, MOUNT_EXECUTORS, type DirEntry, type MountInfo,
} from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import type { Rpc } from "@kinu.run/core";
import { executorLabel, type ExecutorInfo } from "@kinu.run/core";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { useToggledSet } from "@/hooks/use-toggled-set";
import { useFileDrop } from "@/hooks/use-file-drop";
import { FileViewer } from "./FileViewer";
import {
  PLANE, entryRevision, nextTreeCache, putFileBytes, type CachedDir, type FileText,
} from "@kinu.run/core";
import { composing } from "@/components/ui/form";

interface DirectoryResponse { path?: string; entries?: DirEntry[]; error?: string }

type WriteResult = { ok: true } | { error: string };

interface UploadState { name: string; status: "uploading" | "error"; error?: string }

const MOUNT_EXECUTOR: Record<string, string> = Object.fromEntries(
  Object.entries(MOUNT_EXECUTORS).map(([mount, executor]) => [mount.slice(1), executor]),
);



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
  jump?: { path: string; file?: string; nonce: number } | null;
  onConnectDevice: () => void;
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
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [treeCache, setTreeCache] = useState<ReadonlyMap<string, CachedDir>>(new Map());
  const { set: expanded, toggle: toggleExpanded } = useToggledSet(() => new Set(["/"]));
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const loadMounts = useCallback(() => rpc<MountInfo[]>("listMounts"), [rpc]);
  const { resource: mountsResource, reload: reloadMounts } = useAsyncResource(loadMounts);
  const mounts = lastValue(mountsResource) ?? [];

  const listDir = useCallback(async (dir: string): Promise<{ path: string; entries: DirEntry[] }> => {
    const r = await rpc<DirectoryResponse>("getExecutorFiles", [PLANE, dir]);

    if (r.error) throw new Error(r.error);
    const listed = r.entries ?? [];
    const at = r.path ?? dir;
    setTreeCache((prev) => nextTreeCache(prev, at, listed));

    return { path: at, entries: listed };
  }, [rpc]);

  // Keyed on `path` so an old directory's listing never renders under the new breadcrumb.
  const loadListing = useCallback(async (): Promise<DirEntry[]> => {
    try {
      const listed = await listDir(path);

      // A bare mount point lists the consented directory; adopt the returned path so child paths resolve.
      if (listed.path !== path) setPath(listed.path);

      return listed.entries;
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

  const lastJump = useRef(0);
  useEffect(() => {
    if (!jump || jump.nonce === lastJump.current) return;
    lastJump.current = jump.nonce;
    setPreview(jump.file ?? null);
    setFilter("");
    setPath(jump.path);
  }, [jump]);

  const run = useCallback(async (op: () => Promise<void>) => {
    setNotice(null);

    try {
      await op();
    } catch (cause) {
      setNotice(renderThrownChain({ cause }));
    }
  }, []);

  const readPlaneFile = useCallback((full: string) => rpc<FileText>("readExecutorFile", [PLANE, full]), [rpc]);

  const rawUrl = useCallback((full: string, download: boolean) =>
    `/api/workspaces/${encodeURIComponent(agentName)}/files`
    + `?executor=${encodeURIComponent(PLANE)}&path=${encodeURIComponent(full)}${download ? "&download=1" : ""}`,
  [agentName]);

  // Takes a materialized array: a live FileList empties when the input clears or the drop handler returns.
  const uploadFiles = useCallback(async (list: readonly File[]) => {
    if (list.length === 0) return;
    setUploads(list.map((f) => ({ name: f.name, status: "uploading" as const })));

    for (const f of list) {
      try {
        // Raw bytes over HTTP: no base64 inflation, no frame ceiling.
        await putFileBytes(rawUrl(joinDir(path, f.name), false), f);
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

  const uploadDropped = useCallback((files: FileList) => {
    const dropped = [...files];

    return run(() => uploadFiles(dropped));
  }, [run, uploadFiles]);

  const { dragOver, handlers: listDrop } = useFileDrop(uploadDropped);

  const atRoot = path === "/";
  const segments = path.split("/").filter(Boolean);

  const offlineMounts = atRoot
    ? mounts.filter((m) => !m.live && Object.values(MOUNT_EXECUTOR).includes(m.name))
    : [];

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();

    if (!needle) return entries;

    return entries.filter((e) => e.name.toLowerCase().includes(needle));
  }, [entries, filter]);

  const deviceLabel = executors.find((e) => e.name === "device")?.label;

  const badgeFor = useCallback((entryName: string): string | null => {
    if (!atRoot) return null;
    const executor = MOUNT_EXECUTOR[entryName];

    if (!executor || !mounts.some((m) => m.name === executor && m.live)) return null;

    return executor === "device" ? deviceLabel ?? executorLabel("device") : executorLabel(executor);
  }, [atRoot, deviceLabel, mounts]);

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
          badgeFor={badgeFor}
          onNavigate={(dir) => { setFilter(""); setPath(dir); }}
          onOpenFile={setPreview}
          onToggle={(dir) => run(async () => {
            toggleExpanded(dir);

            if (!treeCache.has(dir)) await listDir(dir);
          })}
        />
      </div>

      <div className="flex-1 min-w-0 flex flex-col relative">
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
            onChange={(e) => {
              const picked = [...(e.currentTarget.files ?? [])];
              e.currentTarget.value = "";

              return run(() => uploadFiles(picked));
            }} />
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
            {/* Drops every cached listing: a plane without mtime gives `nextTreeCache` nothing to compare. */}
            <button onClick={() => run(async () => {
              setTreeCache(new Map());
              await reloadListing();
              reloadMounts();
            })}
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

        <div
          ref={listRef}
          data-files-list
          tabIndex={0}
          onKeyDown={onKeyDown}
          className={`flex-1 overflow-y-auto py-1 text-xs outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--c-accent)] ${dragOver ? "outline-dashed outline-2 -outline-offset-2 outline-[var(--c-accent)]" : ""}`}
          {...listDrop}
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
          {!loading && filtered.length > 0 && (
            <div
              data-files-grid
              className="grid gap-1 px-2 py-1 grid-cols-2 @[30rem]:grid-cols-3 @[44rem]:grid-cols-4 @[64rem]:grid-cols-6"
            >
              {filtered.map((entry, i) => {
                const full = joinDir(path, entry.name);

                return (
                  <EntryTile
                    key={entry.name}
                    entry={entry} badge={badgeFor(entry.name)}
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
            </div>
          )}
          {offlineMounts.map((m) => {
            const mountName = Object.entries(MOUNT_EXECUTOR).find(([, executor]) => executor === m.name)?.[0] ?? m.name;

            return (
              <div key={`offline-${m.name}`} data-files-offline-mount
                className="flex items-center gap-2 w-full font-mono px-3 py-1 p-text-4"
                title={m.reason ?? "not available"}>
                <PlugIcon size={12} className="shrink-0" />
                <span>{mountName}</span>
                <span data-mount-badge className="p-t-status px-1.5 py-px rounded-full border p-border border-dashed">
                  {m.name === "device" ? deviceLabel ?? executorLabel("device") : executorLabel(m.name)}
                </span>
                <span className="p-text-4 truncate">{m.reason ?? "not available"}</span>
                {m.name === "device" && (
                  <button type="button" data-files-connect onClick={onConnectDevice}
                    className="p-accent hover:underline shrink-0">Connect</button>
                )}
              </div>
            );
          })}
          {!loading && filtered.length === 0 && entries.length > 0 && (
            <div className="p-text-3 italic px-3 py-1.5">Nothing here matches "{filter}".</div>
          )}
          {!loading && entries.length === 0 && offlineMounts.length === 0 && !err && (
            <div className="p-text-3 italic px-3 py-1.5">This folder is empty. Drop files here to upload.</div>
          )}
          {!loading && filtered.length > 0 && (
            <div className="px-3 pt-1.5 pb-1 p-text-3 p-meta tabular-nums border-t p-border mt-1">
              {dirCount > 0 && `${dirCount} ${dirCount === 1 ? "folder" : "folders"}, `}
              {filtered.length - dirCount} {filtered.length - dirCount === 1 ? "file" : "files"}
              {filter && ` matching of ${entries.length}`}
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
  );
}

function TreeNode({ dir, label, depth, path, previewPath, expanded, cache, badgeFor, onNavigate, onOpenFile, onToggle }: {
  dir: string;
  label: string;
  depth: number;
  path: string;
  previewPath: string | null;
  expanded: ReadonlySet<string>;
  cache: ReadonlyMap<string, CachedDir>;
  badgeFor: (name: string) => string | null;
  onNavigate: (dir: string) => void;
  onOpenFile: (path: string) => void;
  onToggle: (dir: string) => Promise<void>;
}) {
  const isOpen = expanded.has(dir);
  const children = cache.get(dir)?.entries;
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
          onClick={(e) => {
            e.stopPropagation();

            return onToggle(dir);
          }}
          className="p-text-3 hover:p-text shrink-0"
          aria-label={isOpen ? `Collapse ${label}` : `Expand ${label}`}
        >
          {isOpen ? <CaretDownIcon size={10} /> : <CaretRightIcon size={10} />}
        </button>
        {isOpen ? <FolderOpenIcon size={13} className="p-info shrink-0" weight="fill" />
          : <FolderIcon size={13} className="p-info shrink-0" weight="fill" />}
        <span className="truncate">{label}</span>
        {depth === 1 && badgeFor(label) && (
          <span data-mount-badge className="p-t-status px-1 py-px rounded-full p-fill p-text-3 shrink-0">
            {badgeFor(label)}
          </span>
        )}
      </div>
      {isOpen && children === undefined && (
        <div className="p-text-4 p-meta" style={{ paddingLeft: `${28 + depth * 12}px` }}>loading…</div>
      )}
      {isOpen && children?.map((child) => {
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

function EntryTile({ entry, badge, selected, previewing, renaming, confirming, downloadHref, onSelect, onOpen, onRenameDraft, onRenameCommit, onRenameCancel, onAskDelete, onDelete, onCancelDelete }: {
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
  const meta = [
    entry.type === "file" && entry.size != null ? formatBytes(entry.size) : null,
    fmtWhen(entry.mtimeMs) || null,
  ].filter(Boolean).join(" · ");

  return (
    <div
      data-files-entry
      aria-selected={selected || undefined}
      title={entry.name}
      className={`group relative flex flex-col items-center gap-1.5 rounded-md border px-2 py-2.5 cursor-pointer ${
        selected || previewing
          ? "p-fill p-text border-[var(--c-accent)]"
          : "p-text-2 border-transparent hover:p-text p-row-hover"}`}
      onClick={() => { onSelect(); onOpen(); }}
    >
      {entry.type === "dir"
        ? <FolderIcon size={26} className="p-info shrink-0" weight="fill" />
        : <FileIcon size={26} className="p-text-3 shrink-0" />}
      {renaming !== null ? (
        <input
          data-files-rename-input
          autoFocus
          value={renaming}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onRenameDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();

            if (composing(e.nativeEvent)) return;

            if (e.key === "Enter") return onRenameCommit(e.currentTarget.value);

            if (e.key === "Escape") onRenameCancel();
          }}
          onBlur={onRenameCancel}
          className="w-full min-w-0 bg-transparent border p-border rounded-xs px-1 py-0 text-center p-annotation p-text outline-hidden focus:border-[var(--c-accent)]"
        />
      ) : (
        <span className="w-full text-center p-annotation line-clamp-2 break-all">
          {entry.name}
        </span>
      )}
      {badge && (
        <span data-mount-badge className="p-t-status px-1.5 py-px rounded-full p-fill p-text-3 shrink-0">{badge}</span>
      )}
      {confirming ? (
        <span className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          <span className="p-danger p-t-status">delete?</span>
          <button data-files-delete-confirm onClick={onDelete} className="p-danger hover:opacity-80 p-0.5" aria-label={`Delete ${entry.name}`}>
            <CheckIcon size={12} />
          </button>
          <button onClick={onCancelDelete} className="p-text-3 hover:p-text p-0.5" aria-label="Keep it">
            <XIcon size={12} />
          </button>
        </span>
      ) : (
        <span className="p-meta p-text-4 tabular-nums truncate max-w-full">{meta}</span>
      )}
      <span
        className="absolute top-1 right-1 items-center gap-0.5 hidden group-hover:flex p-bg rounded-xs"
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
    </div>
  );
}
