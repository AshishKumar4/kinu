/** Raw bytes ride the files HTTP route: the RPC transport is the chat WebSocket, whose 1 MiB frame ceiling is below ordinary file sizes. */
import { Effect, Cause } from 'effect';
import {
  useCallback, useEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type ReactNode,
} from "react";
import { useParams } from "react-router-dom";
import { Loader } from "@/components/ui/Loader";
import {
  ArrowsClockwiseIcon, ArrowUpIcon, CaretDownIcon,
  DownloadSimpleIcon, EyeIcon, FileIcon, FolderIcon, FolderOpenIcon, HouseIcon, ListIcon,
  MagnifyingGlassIcon, PencilSimpleIcon, PlugIcon, SquaresFourIcon, TrashIcon, UploadSimpleIcon,
  WarningIcon, XIcon,
} from "@phosphor-icons/react";
import {
  DEFAULT_FILES_VIEW, formatBytes, joinDir, parentDir, shortAge, MOUNT_EXECUTORS,
  type DirEntry, type EnvironmentInfo, type FilesView,
} from "@kinu.run/core";
import { renderThrownChain, showing, settle, detach } from "@kinu.run/core/obs";
import { executorLabel, type ExecutorInfo } from "@kinu.run/core";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { Menu, type MenuItem } from "@/components/ui/Menu";
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
import { getFilesView, setFilesView } from "@/lib/user-api";
import { Button } from "@/components/ui/Button";
import { FilePicker } from "@/components/ui/FilePicker";
import { EntriesHead, EntryButton, TreeRow, entryProps, type EntryState } from "@/components/ui/Entries";
import { InlineAction } from "@/components/ui/InlineAction";
import { DropHint } from "@/components/ui/FilePicker";
import { TextInput } from "@/components/ui/Field";

/** An upload over a file already there: replaced only on the owner's word. */
function ReplacePrompt({ name, onReplace, onKeep }: { name: string; onReplace: () => void; onKeep: () => void }) {
  return (
    <div role="alertdialog" aria-label={`Replace ${name}?`} className="flex min-w-0 flex-1 items-center gap-2" data-upload-replace>
      <WarningIcon size={12} className="p-warning shrink-0" />
      <span className="p-text-2 truncate">Replace <span className="p-text">{name}</span>?</span>
      <span className="p-text-3 hidden @[30rem]:inline truncate">A file with this name is already here.</span>
      <span className="ml-auto flex shrink-0 gap-1">
        <Button variant="ghost" size="sm" data-upload-keep onClick={onKeep}>Cancel</Button>
        <Button variant="ghost" size="sm" data-upload-confirm onClick={onReplace} autoFocus>Replace</Button>
      </span>
    </div>
  );
}

const MOUNT_EXECUTOR: Record<string, string> = Object.fromEntries(
  Object.entries(MOUNT_EXECUTORS).map(([mount, executor]) => [mount.slice(1), executor]),
);

/** The list's columns at every width: icon, name, then size and age, one cell below 26rem and a column each from it. A
 *  touch screen keeps a gutter for the row's menu, which a pointer finds on hover over the age. */
const COLUMNS = "grid-cols-[var(--layout-files-row)] @[26rem]:grid-cols-[var(--layout-files-row-wide)] items-center gap-x-3 px-3 pointer-coarse:pr-12";

/** Tiles fill the column's width, as many as fit at their least. */
const TILE_GRID = "grid grid-cols-[var(--layout-files-tiles)] gap-1 px-2 py-1";

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

/** The arrow keys among tiles, by where the grid draws them. */
const TILE_KEYS = new Map<string, "left" | "right" | "up" | "down">([["ArrowLeft", "left"], ["ArrowRight", "right"], ["ArrowUp", "up"], ["ArrowDown", "down"]]);

/**
 * The entry an arrow moves to among tiles, by where they stand: beside it in reading order, or in the row above or
 * below, the one nearest its column, as a desktop's icon view moves. An offline machine's tile is passed over. Not an
 * arrow, undefined; an arrow with nowhere to go, null.
 */
function tileStep(list: HTMLElement | null, from: string | undefined, key: string): string | null | undefined {
  const way = TILE_KEYS.get(key);

  if (way === undefined) return undefined;
  const tiles = [...(list?.querySelectorAll<HTMLElement>("[data-files-entry]") ?? [])];
  const at = tiles.find((tile) => tile.title === from);

  if (at === undefined) return tiles[0]?.title ?? null;

  if (way === "left" || way === "right") return tiles[tiles.indexOf(at) + (way === "right" ? 1 : -1)]?.title ?? null;

  const box = at.getBoundingClientRect();
  const centre = box.left + box.width / 2;

  const row = tiles.map((tile) => ({ tile, box: tile.getBoundingClientRect() }))
    .filter((other) => (way === "down" ? other.box.top >= box.bottom - 1 : other.box.bottom <= box.top + 1));

  const edge = way === "down" ? Math.min(...row.map((other) => other.box.top)) : Math.max(...row.map((other) => other.box.top));

  const nearest = row.filter((other) => Math.abs(other.box.top - edge) < 2)
    .sort((a, b) => Math.abs(a.box.left + a.box.width / 2 - centre) - Math.abs(b.box.left + b.box.width / 2 - centre))[0];

  return nearest?.tile.title ?? null;
}

/** The bytes as a download whatever the route answers: `download` keeps an error page from replacing the app. */
function saveAs(href: string): void {
  const link = document.createElement("a");

  link.href = href;
  link.download = "";
  link.click();
}



/** The root's machines as Files shows them: a live one's own name beside its folder, and one that is away as a row. */
function useMachines(executors: readonly ExecutorInfo[], mounts: readonly EnvironmentInfo[], onConnectDevice: () => void) {
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

/** The account's Files view: its stored choice once read, and each change kept as it is made. */
function useFilesView(): readonly [FilesView, (view: FilesView) => void] {
  const { resource } = useAsyncResource(getFilesView, undefined, "files-view");
  const [chosen, setChosen] = useState<FilesView | null>(null);

  const choose = useCallback((next: FilesView) => {
    setChosen(next);
    detach(Effect.promise(() => setFilesView(next)));
  }, []);

  return [chosen ?? lastValue(resource) ?? DEFAULT_FILES_VIEW, choose];
}

/** How the folder is drawn, and whether its hidden items are among the rest: the account's, wherever it opens Files. */
function ViewMenu({ view, onChange }: { view: FilesView; onChange: (view: FilesView) => void }) {
  return (
    <Menu name="View" trigger={{
      label: "View options",
      icon: view.layout === "tiles" ? <SquaresFourIcon size={14} /> : <ListIcon size={14} />,
    }} items={[
      { label: "List", icon: <ListIcon size={16} />, radio: true, checked: view.layout === "list", marker: "data-files-view-list", onSelect: () => onChange({ ...view, layout: "list" }) },
      { label: "Tiles", icon: <SquaresFourIcon size={16} />, radio: true, checked: view.layout === "tiles", marker: "data-files-view-tiles", onSelect: () => onChange({ ...view, layout: "tiles" }) },
      { label: "Show hidden items", icon: <EyeIcon size={16} />, apart: true, checked: view.hidden, marker: "data-files-view-hidden", onSelect: () => onChange({ ...view, hidden: !view.hidden }) },
    ]} />
  );
}

/** A folder's page as the server answers it: `next` is where the following page starts, absent after the last. */
interface FolderPage { readonly path: string; readonly entries: DirEntry[]; readonly next?: number }

/**
 * The folder at `path`, a page at a time: the first as the path opens, each following one on `more`. A bare mount
 * point's answer names the folder it landed on, which `adopt` makes the path; `cache` hears each first page.
 */
function useFolder(rpc: WorkspaceRpc, target: { readonly path: string; readonly hidden: boolean }, adopt: (path: string) => void, cache: (dir: string, entries: DirEntry[]) => void) {
  const { path, hidden } = target;

  const listDir = useCallback((dir: string, from?: number): Promise<FolderPage> => settle(Effect.gen(function* () {
    const r = yield* Effect.promise(async () => rpc("getExecutorFiles", [PLANE, dir, { ...(from !== undefined && { from }), hidden }]));

    if (r.error) return yield* Effect.die(new Error(r.error));
    const listed = r.entries ?? [];
    const at = r.path ?? dir;

    if (from === undefined) cache(at, listed);

    return { path: at, entries: listed, ...(r.next !== undefined && { next: r.next }) };
  })), [cache, hidden, rpc]);

  /** A bare mount point's listing, answered for the directory it landed on: written as that listing adopts the
   *  landed path, taken by the load the adoption starts, which then asks for nothing. */
  const landed = useRef<FolderPage | null>(null);

  // Keyed on `path` so an old directory's listing never renders under the new breadcrumb.
  const loadListing = useCallback((): Promise<FolderPage> => settle(Effect.catchCause(Effect.gen(function* () {
    const held = landed.current;

    landed.current = null;

    if (held?.path === path) return held;
    const listed = yield* Effect.promise(async () => listDir(path));

    // A bare mount point lists the consented directory; adopt the returned path so child paths resolve.
    if (listed.path !== path) {
      landed.current = listed;
      adopt(listed.path);
    }

    return listed;
  }), (failed) => Effect.gen(function* () {
    const e = Cause.squash(failed);

    return yield* Effect.die(new Error(renderThrownChain({ cause: e }), { cause: e }));
  }))), [adopt, listDir, path]);

  // Keyed on what is listed too: hidden items shown is another listing of the folder.
  const { resource: listing, reload } = useAsyncResource(loadListing, undefined, `${hidden ? "all" : "shown"}:${path}`);
  // The pages read after the first, dropped whenever the first is read again.
  const [later, setLater] = useState<FolderPage | null>(null);

  useEffect(() => { setLater(null); }, [listing]);

  const first = lastValue(listing);
  const shown = later?.path === first?.path ? later : null;
  const next = shown === null ? first?.next : shown.next;

  const more = useCallback(async () => {
    if (first === null || next === undefined) return;
    const page = await listDir(first.path, next);

    setLater({ path: first.path, entries: [...(shown?.entries ?? []), ...page.entries], ...(page.next !== undefined && { next: page.next }) });
  }, [first, listDir, next, shown]);

  return {
    listing, listDir, reload, more, next,
    entries: [...(first?.entries ?? []), ...(shown?.entries ?? [])],
    loading: listing.status === "loading",
    err: listing.status === "error" ? listing.message : null,
  };
}

/** The row under a folder's loaded entries while it has more (`next`): pressed, the next page joins them. */
function MoreRow({ next, more }: { next: number | undefined; more: () => Promise<void> }) {
  if (next === undefined) return null;

  return (
    <EntryButton data-files-more onClick={() => detach(Effect.promise(more))} className={`grid ${COLUMNS} ${ROW_HEIGHT}`}>
      <CaretDownIcon size={16} /><span className="t-body">Load more</span>
    </EntryButton>
  );
}

export interface FilesSurfaceProps {
  rpc: WorkspaceRpc;
  executors: ExecutorInfo[];
  jump?: { path: string; file?: string; nonce: number } | null;
  onConnectDevice: () => void;
}

/** "3 folders, 2 files", naming only what the folder holds, and that more follow when they do. */
function folderCount(folders: number, files: number, more: boolean): string {
  const said = [
    ...(folders > 0 ? [`${String(folders)} ${folders === 1 ? "folder" : "folders"}`] : []),
    ...(files > 0 || folders === 0 ? [`${String(files)} ${files === 1 ? "file" : "files"}`] : []),
    ...(more ? ["more below"] : []),
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

  const cacheListing = useCallback((dir: string, listed: DirEntry[]) => setTreeCache((prev) => nextTreeCache(prev, dir, listed)), []);
  const [view, chooseView] = useFilesView();
  const folder = useFolder(rpc, { path, hidden: view.hidden }, setPath, cacheListing);
  const { Entry, Away, grid, columns } = LAYOUTS[view.layout];

  // The tree's folders were read for the other choice: each is read again as it is opened.
  useEffect(() => { setTreeCache(new Map()); }, [view.hidden]);
  const { listing, entries, loading, err, listDir, reload: reloadListing } = folder;

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
    const tiled = view.layout === "tiles" ? tileStep(listRef.current, current?.name, e.key) : undefined;

    if (tiled !== undefined) {
      e.preventDefault();

      if (tiled !== null) setSelected(filtered.findIndex((entry) => entry.name === tiled));
    }
    else if (e.key === "ArrowDown") { e.preventDefault(); setSelected((i) => Math.min(i + 1, filtered.length - 1)); }
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
  }, [atRoot, confirmDelete, filter, filtered, open, path, preview, renaming, selected, view.layout]);

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
        {/* Only the crumbs scroll: a scrolling row would clip the view menu that opens under it. */}
        <div className="t-meta t-mono px-3 py-2 border-b p-border flex items-center gap-1 shrink-0">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            <InlineAction data-files-crumb onClick={() => setPath("/")} className="shrink-0 p-text-3" title="Workspace root">/</InlineAction>
            {segments.map((seg, i) => (
              <span key={i} className="flex items-center gap-1 min-w-0">
                <InlineAction data-files-crumb onClick={() => setPath(`/${segments.slice(0, i + 1).join("/")}`)}
                  className={`truncate ${i === segments.length - 1 ? "p-text" : "p-text-3"}`}>{seg}</InlineAction>
                {i < segments.length - 1 && <span className="p-text-3 shrink-0">/</span>}
              </span>
            ))}
          </div>
          <FilePicker ref={uploadInputRef} multiple onChange={(e) => detach(Effect.promise(async () => {
              const picked = [...(e.currentTarget.files ?? [])];
              e.currentTarget.value = "";

              return run(Effect.promise(() => uploadFiles(picked)));
            }))} />
          <div className="ml-auto flex items-center gap-px shrink-0">
            <Button variant="ghost" size="sm" icon={<ArrowUpIcon size={14} />} onClick={() => setPath(parentDir(path))} disabled={atRoot} title="Parent directory" aria-label="Parent directory" />
            <Button variant="ghost" size="sm" icon={<HouseIcon size={14} />} onClick={() => setPath("/")} disabled={atRoot} title="Workspace root" aria-label="Workspace root" />
            <Button variant="ghost" size="sm" icon={<UploadSimpleIcon size={14} />} onClick={() => uploadInputRef.current?.click()} title={`Upload files to ${path}`}>Upload</Button>
            <ViewMenu view={view} onChange={chooseView} />
            {/* Drops every cached listing: a plane without mtime gives `nextTreeCache` nothing to compare. */}
            <Button variant="ghost" size="sm" icon={<ArrowsClockwiseIcon size={14} />} onClick={() => detach(Effect.promise(() => run(Effect.sync(() => {
              setTreeCache(new Map());
              reloadListing();
              reloadMounts();
            }))))} title="Refresh" aria-label="Refresh" />
          </div>
        </div>

        <div className="px-3 py-1 border-b p-border flex items-center gap-2 shrink-0">
          <MagnifyingGlassIcon size={12} className="p-text-3 shrink-0" />
          <TextInput bare data-files-filter className="t-meta flex-1" value={filter}
            onChange={(e) => { setFilter(e.currentTarget.value); setSelected(0); }} placeholder="Filter this folder…" />
          {filter && (
            <Button variant="ghost" size="sm" icon={<XIcon size={14} />} onClick={() => setFilter("")} aria-label="Clear filter" />
          )}
        </div>

        {mountsResource.status === "error" && (
          <LoadFailure what="the environments" message={mountsResource.message} onRetry={reloadMounts} className="px-3 py-2" />
        )}
        {notice && (
          <div data-files-notice className="t-meta px-3 py-1 p-danger border-b p-border flex items-start gap-2">
            <WarningIcon size={13} className="shrink-0 mt-px" />
            <span className="break-words min-w-0">{notice}</span>
            <Button variant="ghost" size="sm" icon={<XIcon size={14} />} className="ml-auto shrink-0" onClick={() => setNotice(null)} aria-label="Dismiss" />
          </div>
        )}

        {/* The viewer covers the column below 64rem and stands beside the list from it. */}
        <div className="flex-1 min-h-0 flex">
          <div
            ref={listRef}
            data-files-list
            tabIndex={0}
            onKeyDown={onKeyDown}
            className="t-meta group/list relative flex-1 min-w-0 overflow-y-auto pb-1"
            {...listDrop}
          >
            {dragOver && <DropHint><UploadSimpleIcon size={16} weight="bold" /> Drop to upload to {path}</DropHint>}
            {columns}
            {err && <div className="p-danger px-3 py-1 break-words">{err}</div>}
            {uploads.map((u) => {
              // Named by its folder too once the owner has browsed away from it.
              const name = parentDir(u.target) === path ? u.target.slice(u.target.lastIndexOf("/") + 1) : u.target;

              return (
                <div key={u.target} className={`flex items-center gap-3 px-3  ${ROW_HEIGHT} t-body`} data-upload={u.status} data-upload-target={u.target}>
                  {u.status === "uploading" && <><Loader size="sm" /><span className="p-text-2 truncate">{name}</span><span className="t-meta ml-auto p-text-3 shrink-0">uploading…</span></>}
                  {u.status === "error" && <><WarningIcon size={16} className="p-danger shrink-0" /><span className="p-text-2 truncate">{name}</span><span className="t-meta p-danger truncate">{u.error}</span></>}
                  {u.status === "exists" && (
                    <ReplacePrompt name={name} onReplace={() => detach(Effect.promise(() => replaceUpload(u)))} onKeep={() => keepExisting(u.target)} />
                  )}
                </div>
              );
            })}
            {loading && <div className="p-text-3 px-3 py-1">Loading…</div>}
            {!loading && !atRoot && (
              <EntryButton data-files-up-row onClick={() => setPath(parentDir(path))} className={`grid ${COLUMNS} ${ROW_HEIGHT}`}>
                <ArrowUpIcon size={16} /><span className="t-body">..</span>
              </EntryButton>
            )}
            {!loading && (
              <div data-files-layout={view.layout} className={grid}>
                {placeOffline(filtered, offline).map((row) => {
                  if (!("entry" in row)) return <Away key={`offline-${row.name}`} row={row} />;

                  const { entry, index } = row;
                  const full = joinDir(path, entry.name);

                  return (
                    <Entry
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
              </div>
            )}
            {!loading && <MoreRow next={folder.next} more={() => run(Effect.promise(folder.more))} />}
            {!loading && filtered.length === 0 && offline.length === 0 && entries.length > 0 && (
              <div className="p-text-3 italic px-3 py-1">Nothing here matches "{filter}".</div>
            )}
            {!loading && entries.length === 0 && offline.length === 0 && !err && (
              <div className="p-text-3 italic px-3 py-1">This folder is empty. Drop files here to upload.</div>
            )}
            {!loading && filtered.length > 0 && (
              <div className="t-meta px-3 pt-1 pb-1 p-text-3 border-t p-border mt-1">
                {filter ? `${String(filtered.length)} of ${String(entries.length)} match` : folderCount(dirCount, filtered.length - dirCount, folder.next !== undefined)}
                <span className="ml-2 hidden @[44rem]:inline p-text-3">{LAYOUTS[view.layout].moves} move · Enter open · Backspace up · F2 rename · Del delete</span>
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

function TreeNode({ dir, label, hidden = false, depth, path, previewPath, expanded, cache, badgeFor, away = [], onNavigate, onOpenFile, onToggle }: {
  dir: string;
  label: string;
  /** Listed because hidden items are shown: dimmed as the list dims it. */
  hidden?: boolean;
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
      <TreeRow depth={depth} open={active} hidden={hidden} data-files-tree-node={dir} onOpen={() => onNavigate(dir)}
        fold={{ open: isOpen, label: isOpen ? `Collapse ${label}` : `Expand ${label}` }} onFold={() => detach(Effect.promise(() => onToggle(dir)))}>
        {isOpen ? <FolderOpenIcon data-entry-face size={14} className="p-info shrink-0" weight="fill" />
          : <FolderIcon data-entry-face size={14} className="p-info shrink-0" weight="fill" />}
        <span data-entry-face className="truncate">{label}</span>
        {depth === 1 && badgeFor(label) && (
          <span data-mount-badge className="t-meta truncate p-text-3">{badgeFor(label)}</span>
        )}
      </TreeRow>
      {isOpen && children === undefined && <TreeRow depth={depth + 1} inert>loading…</TreeRow>}
      {isOpen && children?.map((row) => {
        if (!("entry" in row)) return <OfflineTreeRow key={`offline-${row.name}`} row={row} depth={depth + 1} />;
        const child = row.entry;
        const full = joinDir(dir, child.name);

        return child.type === "dir" ? (
          <TreeNode
            key={child.name}
            dir={full} label={child.name} hidden={child.hidden === true} depth={depth + 1}
            path={path} previewPath={previewPath} expanded={expanded} cache={cache} badgeFor={badgeFor}
            onNavigate={onNavigate} onOpenFile={onOpenFile} onToggle={onToggle}
          />
        ) : (
          <TreeRow key={child.name} depth={depth + 1} open={previewPath === full} hidden={child.hidden === true} title={child.name}
            data-files-tree-file={full} onOpen={() => onOpenFile(full)}>
            <FileIcon data-entry-face size={14} className="p-text-3 shrink-0" />
            <span data-entry-face className="truncate">{child.name}</span>
          </TreeRow>
        );
      })}
    </div>
  );
}

/** The tree's row for a machine that is not there: as the list says it, with no way in until it connects. */
function OfflineTreeRow({ row, depth }: { row: OfflineRow; depth: number }) {
  return (
    <TreeRow depth={depth} inert className="group" data-files-tree-offline={row.name} title={`${row.label ?? row.name}: ${row.reason}`}>
      <PlugIcon size={14} className="shrink-0" />
      <span className="truncate">{row.name}</span>
      <span className="t-meta ml-1 truncate">offline</span>
      {row.onConnect && (
        <Button variant="ghost" size="sm" className="ml-auto shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100" data-files-tree-connect onClick={row.onConnect}>
          Connect
        </Button>
      )}
    </TreeRow>
  );
}

/** A machine that is not there, as a row of the list: its name where its folder would be, and the way to bring it. */
function OfflineMountRow({ row }: { row: OfflineRow }) {
  return (
    <div data-files-offline-mount title={row.reason} className={`grid ${COLUMNS} ${ROW_HEIGHT}`}>
      <PlugIcon size={16} className="p-text-3" />
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="t-body truncate p-text-3">{row.name}</span>
        <span data-mount-badge className="t-meta truncate p-text-3">
          {row.label === null ? "offline" : `${row.label} · offline`}
        </span>
      </span>
      <span className="text-right @[26rem]:col-span-2">
        {row.onConnect && (
          <Button variant="ghost" size="sm" data-files-connect onClick={row.onConnect}>Connect</Button>
        )}
      </span>
    </div>
  );
}

/** What a folder's entry is drawn from, as a row or a tile. */
interface EntryProps {
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
}

/** An entry's size and age as the reader is told them, and its age to the second on hover. */
function entryFacts(entry: DirEntry) {
  return {
    size: entry.type === "file" && entry.size != null ? formatBytes(entry.size) : null,
    age: entry.mtimeMs ? shortAge(entry.mtimeMs) : null,
    changed: entry.mtimeMs ? new Date(entry.mtimeMs).toLocaleString() : undefined,
  };
}

/** The entry's own menu: its bytes, its name, and its removal. */
function entryMenu({ entry, downloadHref, onRenameDraft, onAskDelete }: EntryProps): MenuItem[] {
  const fetchItem: MenuItem[] = downloadHref === null ? [] : [{
    label: "Download", icon: <DownloadSimpleIcon size={16} />, onSelect: () => saveAs(downloadHref), marker: "data-files-download",
  }];

  return [
    ...fetchItem,
    { label: "Rename", icon: <PencilSimpleIcon size={16} />, onSelect: () => onRenameDraft(entry.name), marker: "data-files-rename" },
    { label: "Delete", icon: <TrashIcon size={16} />, onSelect: onAskDelete, danger: true, apart: true, marker: "data-files-delete" },
  ];
}

/** The cursor shows only while the keys drive it; what is open in the viewer stays marked. A hidden item is dimmed. */
function entryState({ entry, previewing, selected }: EntryProps): EntryState {
  return { open: previewing, cursor: selected, hidden: entry.hidden === true };
}

function EntryIcon({ entry, size }: { entry: DirEntry; size: number }) {
  return entry.type === "dir"
    ? <FolderIcon data-entry-face size={size} className="shrink-0 p-info" weight="fill" />
    : <FileIcon data-entry-face size={size} className="shrink-0 p-text-3" />;
}

function RenameField({ draft, onRenameDraft, onRenameCommit, onRenameCancel, className }: {
  draft: string;
  onRenameDraft: (draft: string) => void;
  onRenameCommit: (draft: string) => Promise<void>;
  onRenameCancel: () => void;
  className: string;
}) {
  return (
    <TextInput size="sm"
      data-files-rename-input
      autoFocus
      value={draft}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onRenameDraft(e.currentTarget.value)}
      onKeyDown={(e) => detach(Effect.promise(async () => {
        e.stopPropagation();

        if (composing(e.nativeEvent)) return;

        if (e.key === "Enter") return onRenameCommit(e.currentTarget.value);

        if (e.key === "Escape") onRenameCancel();
      }))}
      onBlur={onRenameCancel}
      className={`min-w-0 ${className}`}
    />
  );
}

function DeleteChoice({ name, onDelete, onCancelDelete, className }: {
  name: string;
  onDelete: () => Promise<void>;
  onCancelDelete: () => void;
  className: string;
}) {
  return (
    <span className={`t-meta flex items-center gap-3 ${className}`} onClick={(e) => e.stopPropagation()}>
      <Button variant="danger" size="sm" data-files-delete-confirm onClick={() => detach(Effect.promise(onDelete))} aria-label={`Delete ${name}`}>Delete</Button>
      <Button variant="ghost" size="sm" onClick={onCancelDelete} aria-label="Keep it">Keep</Button>
    </span>
  );
}

/** The entry's menu, out of sight until a pointer is over it, the keys reach it, or a finger could want it. */
function EntryMenu({ props, className }: { props: EntryProps; className: string }) {
  return (
    <span className={`opacity-0 group-hover:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100 pointer-coarse:opacity-100 ${className}`}
      onClick={(e) => e.stopPropagation()}>
      <span className="relative block size-7">
        <Menu name={props.entry.name} items={entryMenu(props)} className="absolute inset-0" />
      </span>
    </span>
  );
}

function EntryRow(props: EntryProps) {
  const { entry, badge, renaming, confirming, onSelect, onOpen } = props;
  const { size, age, changed } = entryFacts(entry);

  return (
    <div
      data-files-entry
      aria-selected={props.selected || undefined}
      title={entry.name}
      {...entryProps(entryState(props), `group relative grid ${COLUMNS} ${ROW_HEIGHT}`)}
      onClick={() => { onSelect(); onOpen(); }}
    >
      <EntryIcon entry={entry} size={16} />
      <span data-entry-face className="flex min-w-0 items-baseline gap-2">
        {renaming !== null
          ? <RenameField draft={renaming} {...props} className="w-full" />
          : <span className="t-body truncate">{entry.name}</span>}
        {badge && <span data-mount-badge className="t-meta truncate p-text-3">{badge}</span>}
      </span>
      {confirming ? (
        <DeleteChoice name={entry.name} {...props} className="justify-end @[26rem]:col-span-2" />
      ) : (
        <>
          <span className="t-meta hidden truncate text-right p-text-3 @[26rem]:block">{size}</span>
          <span className={`t-meta hidden text-right p-text-3 @[26rem]:block ${UNDER_MENU}`} title={changed}>{age}</span>
          <span className={`t-meta whitespace-nowrap text-right p-text-3 @[26rem]:hidden ${UNDER_MENU}`} title={changed}>
            {[size, age].filter((part) => part !== null).join(" · ")}
          </span>
        </>
      )}
      {/* No transform on the way: the menu is a fixed sheet on a phone. */}
      <EntryMenu props={props} className="absolute inset-y-0 right-2 flex items-center" />
    </div>
  );
}

/** An entry as a tile: its icon large, its name on up to two lines, and what it holds under them. */
function EntryTile(props: EntryProps) {
  const { entry, badge, renaming, confirming, onSelect, onOpen } = props;
  const { size, age, changed } = entryFacts(entry);

  return (
    <div
      data-files-entry
      aria-selected={props.selected || undefined}
      title={entry.name}
      {...entryProps({ ...entryState(props), tile: true }, "group relative flex min-w-0 flex-col items-center gap-1 px-2 pb-2 pt-3")}
      onClick={() => { onSelect(); onOpen(); }}
    >
      <EntryIcon entry={entry} size={32} />
      {renaming !== null
        ? <RenameField draft={renaming} {...props} className="w-full text-center" />
        : <span data-entry-face className="t-body line-clamp-2 w-full break-words text-center">{entry.name}</span>}
      {badge && <span data-mount-badge className="t-meta max-w-full truncate p-text-3">{badge}</span>}
      {confirming
        ? <DeleteChoice name={entry.name} {...props} className="justify-center" />
        : <span className="t-meta max-w-full truncate p-text-3" title={changed}>{[size, age].filter((part) => part !== null).join(" · ")}</span>}
      <EntryMenu props={props} className="absolute right-1 top-1" />
    </div>
  );
}

/** A machine that is not there, as a tile where its folder's would be: its name, that it is away, and the way to bring it. */
function OfflineMountTile({ row }: { row: OfflineRow }) {
  return (
    <div data-files-offline-mount title={row.reason} {...entryProps({ tile: true, inert: true }, "flex min-w-0 flex-col items-center gap-1 px-2 pb-2 pt-3")}>
      <PlugIcon size={32} className="p-text-3" />
      <span className="t-body max-w-full truncate p-text-3">{row.name}</span>
      {row.label !== null && <span data-mount-badge className="t-meta max-w-full truncate p-text-3">{row.label}</span>}
      <span className="t-meta flex items-baseline gap-2">
        <span className="p-text-3">offline</span>
        {row.onConnect && (
          <Button variant="ghost" size="sm" data-files-connect onClick={row.onConnect}>Connect</Button>
        )}
      </span>
    </div>
  );
}

/** The list's column heads, from 26rem where it has columns. */
const COLUMN_HEADS = (
  <EntriesHead className={`hidden @[26rem]:grid ${COLUMNS} t-meta h-7`}>
    <span /><span>Name</span><span className="text-right">Size</span><span className="text-right">Modified</span>
  </EntriesHead>
);

/** What a way of drawing a folder draws it with: a list's rows sit in the list itself, tiles in their grid. */
interface Layout {
  readonly Entry: (props: EntryProps) => ReactNode;
  readonly Away: (props: { row: OfflineRow }) => ReactNode;
  readonly grid: string;
  readonly columns: ReactNode;
  /** The keys that move the selection, as the footer names them. */
  readonly moves: string;
}

const LAYOUTS: Readonly<Record<FilesView["layout"], Layout>> = {
  list: { Entry: EntryRow, Away: OfflineMountRow, grid: "contents", columns: COLUMN_HEADS, moves: "↑↓" },
  tiles: { Entry: EntryTile, Away: OfflineMountTile, grid: TILE_GRID, columns: null, moves: "Arrows" },
};
