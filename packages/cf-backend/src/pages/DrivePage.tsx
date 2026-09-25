/** The Drive: My stuff (`/drive`, `/drive/<path>`) and Shared (`/shared`). Nothing empty is drawn. */
import { startTransition, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Loader } from "@cloudflare/kumo";
import {
  ArrowSquareOutIcon, BookOpenIcon, CaretRightIcon, CopyIcon, DownloadSimpleIcon, FolderSimpleIcon, GitForkIcon, GlobeIcon, HardDrivesIcon,
  PencilSimpleIcon, ProhibitIcon, ShareNetworkIcon, SquaresFourIcon, TrashIcon, UploadSimpleIcon, UsersIcon, WarningIcon, XIcon,
} from "@phosphor-icons/react";
import * as v from "valibot";
import {
  APP_ROUTES, BUILTIN_SKILL_FILES, DRIVE_SKILLS_DIR, blueprintPagePath, compareSkillNames, entryRevision, formatBytes, joinDir, parseSkillFile, shortAge,
  skillViewPath, workspaceDisplayTitle,
  type DriveEntry, type DriveListing, type FileText, type LiveShareVisibility, type OwnedSlate, type SharedLibrary, type SharedRow,
  type SkillFileRefusal,
} from "@kinu.run/core";
import { diagnostics, renderThrownChain, toKinuError } from "@kinu.run/core/obs";
import {
  downloadUrl, inlineUrl, listDrive, markAsSkill, readDriveText, uploadFile, uploadFolder, uploadZip,
} from "@/lib/drive-api";
import { getSharedLibrary, openLiveShare } from "@/lib/shared-api";
import { useAsyncResource, lastValue, type AsyncResource } from "@/hooks/use-async-resource";
import { useWorkspaceRoster } from "@/hooks/use-workspace-roster";
import { useCopy } from "@/hooks/use-copy";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { inputCls } from "@/components/ui/form";
import {
  Cover, FileCover, FOLDER_ICON, FolderTile, GRID, LINK_ICON, SHARE_ICON, SKILLS_ICON, SLATE_ICON, Tile, fileIcon, type MenuItem,
} from "@/components/drive/DriveTiles";
import { DriveDialog, pickedFolderName, PrimaryAction, type DriveDialogState } from "@/components/drive/DriveActions";
import { FileViewer } from "@/components/surfaces/FileViewer";
import { SlatePicture } from "@/components/slates/SlatePicture";

export type DriveTab = "mine" | "shared";

function folderHref(path: string): string {
  return path === "/" ? APP_ROUTES.drive : `${APP_ROUTES.drive}${path}`;
}

function slateHref(slate: OwnedSlate): string {
  return `/workspace/${encodeURIComponent(slate.workspace)}?slate=${encodeURIComponent(slate.id)}`;
}

const IMAGE = /\.(?:png|jpe?g|gif|webp|svg)$/iu;

/** A tab or crumb press chose My stuff; a first visit lands on what holds something. */
const ChosenState = v.object({ chosen: v.literal(true) });

function TabStrip({ tab }: { tab: DriveTab }) {
  const tabs: readonly { id: DriveTab; label: string; to: string }[] = [
    { id: "mine", label: "My stuff", to: APP_ROUTES.drive },
    { id: "shared", label: "Shared", to: APP_ROUTES.shared },
  ];

  return (
    <nav aria-label="Drive" className="flex w-fit items-center gap-0.5 rounded-lg p-recessed p-0.5">
      {tabs.map((each) => (
        <Link key={each.id} to={each.to} state={{ chosen: true }} aria-current={each.id === tab ? "page" : undefined} data-drive-tab={each.id}
          className={`whitespace-nowrap rounded-md px-3.5 py-1.5 p-t-control ${each.id === tab ? "p-surface p-text shadow-[0_1px_2px_var(--c-shadow-drop)]" : "p-text-3 hover:p-text"}`}>
          {each.label}
        </Link>
      ))}
    </nav>
  );
}

function Crumbs({ path }: { path: string }) {
  const segments = path.slice(1).split("/");

  return (
    <nav aria-label="Folder" className="flex min-w-0 flex-wrap items-center gap-1.5 p-heading text-[15px] sm:text-[17px]">
      <Link to={APP_ROUTES.drive} state={{ chosen: true }} data-drive-crumb className="shrink-0 p-text-3 transition-colors hover:p-text">My stuff</Link>
      {segments.map((segment, index) => (
        <span key={index} className="flex min-w-0 items-center gap-1.5">
          <CaretRightIcon size={12} className="shrink-0 p-text-4" />
          <Link to={folderHref(`/${segments.slice(0, index + 1).join("/")}`)} data-drive-crumb
            className={`truncate ${index === segments.length - 1 ? "p-text" : "p-text-3 hover:p-text"}`}>
            {index === 0 && `/${segment}` === DRIVE_SKILLS_DIR ? "Skills" : segment}
          </Link>
        </span>
      ))}
    </nav>
  );
}

function Section({ label, titled = true, children }: { label: string; titled?: boolean; children: ReactNode }) {
  return (
    <section aria-label={label} data-drive-section={label}>
      {titled && <h2 className="mb-2.5 p-row-text font-medium p-text-2">{label}</h2>}
      <ul className={GRID}>{children}</ul>
    </section>
  );
}

const TEXT = /\.(?:md|markdown|txt|csv|tsv|json|ya?ml|toml|ts|tsx|js|jsx|py|sh|css|html?)$/iu;

const PROSE = /\.(?:md|markdown|txt)$/iu;

/** A SKILL.md is drawn as its name over its description and steps; any other file as its first lines. */
function coverLines(text: string, skill: boolean): [string | null, string[]] {
  const parsed = skill ? parseSkillFile(text) : null;

  if (parsed?.ok !== true) return [null, text.split("\n").slice(0, 14)];
  const steps = parsed.skill.body.split("\n").filter((line) => line.trim() !== "");

  return [parsed.skill.name, [parsed.skill.description, "", ...steps].slice(0, 12)];
}

function TextPage({ text, name }: { text: string | null; name: string }) {
  const [heading, lines] = text === null ? [null, []] : coverLines(text, name === "SKILL.md");

  if (lines.length === 0) return <FileCover name={name} />;

  return (
    <span className="absolute inset-0 overflow-hidden p-recessed px-[14%] pt-[5%]">
      <span className={`block h-full overflow-hidden rounded-t-md border border-b-0 p-border p-surface px-3 pt-2.5 text-[8.5px] leading-[1.45] p-text-3 ${PROSE.test(name) ? "" : "font-mono"}`}>
        {heading !== null && <span className="mb-1 block truncate text-[11px] font-semibold p-text">{heading}</span>}
        {lines.map((line, index) => <span key={index} className="block truncate">{line === "" ? "\u00a0" : line}</span>)}
      </span>
    </span>
  );
}

/** The first lines of a text file, read once the tile is in view. */
function TextCover({ path, name }: { path: string; name: string }) {
  const holder = useRef<HTMLSpanElement>(null);
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    const element = holder.current;

    if (element === null) return;
    let live = true;

    const observer = new IntersectionObserver((seen) => {
      if (!seen.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      readDriveText(path, 2048).then(
        (file) => { if (live) setText(file.content ?? null); },
        (...rejection: [unknown]) => {
          diagnostics.failure("drive.cover_read_failed", toKinuError({ doing: `read ${path} for its tile`, cause: rejection[0], otherwise: "unavailable" }));
        },
      );
    });

    observer.observe(element);

    return () => { live = false; observer.disconnect(); };
  }, [path]);

  return <span ref={holder} className="absolute inset-0"><TextPage text={text} name={name} /></span>;
}

interface Transfer {
  readonly id: number;
  readonly name: string;
  readonly status: "uploading" | "failed";
  readonly error?: string;
}

function VisibilityGlyph({ visibility }: { visibility: LiveShareVisibility | undefined }) {
  if (visibility === undefined) return null;

  return visibility === "public"
    ? <GlobeIcon size={13} className="shrink-0 p-text-4" aria-label="Anyone with the link" />
    : <UsersIcon size={13} className="shrink-0 p-text-4" aria-label="Shared with people" />;
}

function whyUnused(refusal: SkillFileRefusal): string {
  if (refusal.reason === "builtin") return "A built-in skill has this name, so agents use the built-in";

  if (refusal.reason === "shadowed") return `Agents read ${refusal.by.slice(1)} instead`;

  return `Not a skill name: it ${refusal.problem}`;
}

function NotUsed({ refusal }: { refusal: SkillFileRefusal }) {
  return <span className="truncate p-warning" title={whyUnused(refusal)}>Not used</span>;
}

function SkillMeta({ entry, from }: { entry: DriveEntry; from: string | null }) {
  if (entry.unused !== undefined) return <NotUsed refusal={entry.unused} />;

  if (from !== null) return <span className="truncate">{`From ${from.slice(1)}`}</span>;

  return <span className="truncate">{entry.mtimeMs > 0 ? `Updated ${shortAge(entry.mtimeMs)}` : ""}</span>;
}

function whoCanOpen(row: SharedRow): string {
  if (row.kind === "blueprint" || row.visibility === "public") return "Anyone with the link";

  const users = row.users ?? [];

  return users.length === 1 ? users[0] ?? "" : `${String(users.length)} people`;
}

function isEmptyLibrary(library: SharedLibrary): boolean {
  return library.received.length + library.mine.length === 0;
}

interface MineContents {
  readonly slates: readonly OwnedSlate[];
  readonly blueprints: readonly SharedRow[];
  readonly folders: readonly DriveEntry[];
  readonly files: readonly DriveEntry[];
  readonly builtins: readonly string[];
}

const SKILLS_FOLDER = DRIVE_SKILLS_DIR.slice(1);

function mineContents(path: string, entries: readonly DriveEntry[], library: SharedLibrary | null): MineContents {
  const isRoot = path === "/";
  const isSkills = (entry: DriveEntry): boolean => isRoot && entry.name === SKILLS_FOLDER;

  return {
    slates: isRoot && library !== null ? library.slates : [],
    blueprints: isRoot && library !== null ? library.mine.filter((row) => row.kind === "blueprint") : [],
    folders: entries.filter((entry) => entry.kind !== "file").sort((a, b) => Number(isSkills(b)) - Number(isSkills(a))),
    files: entries.filter((entry) => entry.kind === "file"),
    builtins: path === DRIVE_SKILLS_DIR ? Object.keys(BUILTIN_SKILL_FILES) : [],
  };
}

function isEmptyMine(contents: MineContents): boolean {
  return contents.slates.length + contents.blueprints.length + contents.folders.length + contents.files.length + contents.builtins.length === 0;
}

function ownsNothing(contents: MineContents): boolean {
  return contents.slates.length + contents.blueprints.length + contents.files.length === 0
    && contents.folders.every((entry) => entry.name === SKILLS_FOLDER);
}

/** Shared with nothing in it goes back to My stuff; a first visit to an empty My stuff goes to what is shared. */
function landing(tab: DriveTab, firstVisit: boolean, nothingOwned: boolean, library: SharedLibrary | null): ReactNode {
  const sharesAnything = library !== null && !isEmptyLibrary(library);

  if (tab === "shared" && library !== null && !sharesAnything) return <Navigate to={APP_ROUTES.drive} replace state={{ chosen: true }} />;

  if (tab === "mine" && firstVisit && nothingOwned && sharesAnything) return <Navigate to={APP_ROUTES.shared} replace />;

  return null;
}

function subtitleOf(tab: DriveTab, path: string): ReactNode {
  if (tab !== "mine") return null;

  if (path === DRIVE_SKILLS_DIR) return "Every workspace you own uses these skills.";

  if (path !== "/") return null;

  return <>Files and folders here are in every workspace you own, at <span className="font-mono p-text-2">/shared</span>.</>;
}

function SectionList({ groups, titled = false }: { groups: readonly { label: string; tiles: readonly ReactNode[] }[]; titled?: boolean }) {
  const shown = groups.filter((group) => group.tiles.length > 0);

  return (
    <div className="space-y-8">
      {shown.map((group) => <Section key={group.label} label={group.label} titled={titled || shown.length > 1}>{group.tiles}</Section>)}
    </div>
  );
}

/** Newest first, narrowed to rows whose title, description or sharer holds the search. */
function sharedRows(rows: readonly SharedRow[], needle: string): SharedRow[] {
  return rows
    .filter((row) => needle === "" || [row.title, row.description, row.owner ?? ""].some((text) => text.toLowerCase().includes(needle)))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function SharedBody({ shared, query, tile }: { shared: SharedLibrary | null; query: string; tile: (row: SharedRow, mine: boolean) => ReactNode }) {
  if (shared === null) return <div className="flex justify-center py-16"><Loader size="base" /></div>;
  const needle = query.trim().toLowerCase();
  const received = sharedRows(shared.received, needle);
  const mine = sharedRows(shared.mine, needle);

  if (needle !== "" && received.length + mine.length === 0) {
    return <p className="py-12 text-center p-text-3" data-drive-no-match>{`Nothing matches “${query.trim()}”`}</p>;
  }

  return (
    <SectionList titled groups={[
      { label: "Shared with you", tiles: received.map((row) => tile(row, false)) },
      { label: "Shared by you", tiles: mine.map((row) => tile(row, true)) },
    ]} />
  );
}

function MineBody({ resource, onRetry, empty, children }: {
  resource: AsyncResource<DriveListing>;
  onRetry: () => void;
  empty: boolean;
  children: ReactNode;
}) {
  if (resource.status === "loading") return <div className="flex justify-center py-16"><Loader size="base" /></div>;

  if (resource.status === "error" && resource.last === null) {
    return <LoadFailure what="this folder" message={resource.message} onRetry={onRetry} className="py-3" />;
  }

  if (!empty) return children;

  return (
    <div data-drive-empty className="flex flex-col items-center px-6 py-16 text-center sm:py-24">
      <span className="flex size-14 items-center justify-center rounded-2xl p-text-3 bg-[color-mix(in_srgb,var(--c-text)_7%,transparent)]">
        <FolderSimpleIcon size={26} />
      </span>
      <h2 className="mt-5 p-heading text-[19px] p-text">This folder is empty</h2>
      <p className="mt-2 max-w-[26rem] p-row-text p-text-3">Drop files here, or use New.</p>
    </div>
  );
}

function DropZone({ label, onFiles, children }: { label: string; onFiles: (files: File[]) => void; children: ReactNode }) {
  const [over, setOver] = useState(false);

  return (
    <div data-drive-list className="relative mt-6"
      onDragOver={(event) => { event.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => { event.preventDefault(); setOver(false); onFiles([...event.dataTransfer.files]); }}>
      {children}
      {over && (
        <div aria-hidden="true" className="pointer-events-none absolute -inset-3 z-20 flex items-center justify-center rounded-[18px] border-2 border-dashed border-[var(--c-accent)] bg-[color-mix(in_srgb,var(--c-bg)_74%,transparent)]">
          <span className="flex items-center gap-2 rounded-full bg-[var(--c-accent)] px-4 py-2 text-sm font-semibold text-[var(--c-accent-on)] p-shadow-menu">
            <UploadSimpleIcon size={15} weight="bold" /> Drop to add to {label}
          </span>
        </div>
      )}
    </div>
  );
}

function TransferRow({ row, onDismiss }: { row: Transfer; onDismiss: () => void }) {
  if (row.status === "uploading") {
    return (
      <li data-drive-transfer={row.status} className="flex items-center gap-2 text-xs">
        <Loader size="sm" /><span className="truncate p-text-2">{row.name}</span><span className="p-text-3">uploading…</span>
      </li>
    );
  }

  return (
    <li data-drive-transfer={row.status} className="flex items-center gap-2 text-xs">
      <WarningIcon size={13} className="shrink-0 p-danger" /><span className="truncate p-text-2">{row.name}</span>
      <span className="min-w-0 truncate p-danger" title={row.error}>{row.error}</span>
      <button type="button" onClick={onDismiss} className="ml-auto shrink-0 p-text-3 hover:p-text" aria-label={`Dismiss ${row.name}`}><XIcon size={12} /></button>
    </li>
  );
}

function DriveNotices({ notice, onDismissNotice, listingPending, libraryResource, onRetryLibrary, copyStatus, transfers, onDismissTransfer }: {
  notice: string | null;
  listingPending: boolean;
  onDismissNotice: () => void;
  libraryResource: AsyncResource<SharedLibrary>;
  onRetryLibrary: () => void;
  copyStatus: ReturnType<typeof useCopy>["status"];
  transfers: readonly Transfer[];
  onDismissTransfer: (id: number) => void;
}) {
  return (
    <>
      {notice !== null && (
        <div role="alert" data-drive-notice className="p-notice-danger mt-4 flex items-start gap-2 rounded-md px-3 py-2 text-xs">
          <WarningIcon size={13} className="mt-px shrink-0" />
          <span className="min-w-0 break-words">{notice}</span>
          <button type="button" onClick={onDismissNotice} className="ml-auto shrink-0 p-text-3 hover:p-text" aria-label="Dismiss"><XIcon size={12} /></button>
        </div>
      )}
      {listingPending && <p role="status" data-drive-listing-pending className="mt-4 p-meta p-text-3">Saved. The list will catch up.</p>}
      {libraryResource.status === "error" && (
        <LoadFailure what="your slates and shares" message={libraryResource.message} onRetry={onRetryLibrary} className="mt-4" />
      )}
      {copyStatus !== "idle" && <p role="status" className="mt-4 p-meta p-text-3">{copyStatus === "copied" ? "Link copied." : "Could not copy the link."}</p>}
      {transfers.length > 0 && (
        <ul className="mt-4 space-y-1">
          {transfers.map((row) => <TransferRow key={row.id} row={row} onDismiss={() => onDismissTransfer(row.id)} />)}
        </ul>
      )}
    </>
  );
}

function Drawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <>
      <div aria-hidden="true" className="p-scrim fixed inset-0 z-40" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-50 w-full sm:w-[min(640px,92vw)]" data-drive-viewer>{children}</div>
    </>
  );
}

function FileDrawer({ path, entry, onClose }: { path: string; entry: DriveEntry; onClose: () => void }) {
  return (
    <Drawer onClose={onClose}>
      <FileViewer path={path} read={readDriveText} revision={entryRevision(entry)} rawHref={inlineUrl(path)} downloadHref={downloadUrl(path)} onClose={onClose} />
    </Drawer>
  );
}

const BUILTIN_SKILL_TEXT: ReadonlyMap<string, string> = new Map(
  Object.entries(BUILTIN_SKILL_FILES).map(([name, text]) => [skillViewPath(name), text]),
);

function readBuiltinSkill(path: string): Promise<FileText> {
  return Promise.resolve({ content: BUILTIN_SKILL_TEXT.get(path), readOnlyReason: "Built in: every workspace has this skill, and it can't be changed." });
}

function BuiltinSkillDrawer({ name, onClose }: { name: string; onClose: () => void }) {
  const bytes = `data:text/markdown;charset=utf-8,${encodeURIComponent(BUILTIN_SKILL_FILES[name])}`;

  return (
    <Drawer onClose={onClose}>
      <FileViewer path={skillViewPath(name)} read={readBuiltinSkill} revision="built-in" rawHref={bytes} downloadHref={bytes} onClose={onClose} />
    </Drawer>
  );
}

export default function DrivePage({ tab }: { tab: DriveTab }) {
  const splat = useParams()["*"] ?? "";
  const path = tab === "shared" || splat === "" ? "/" : `/${splat.replace(/\/+$/u, "")}`;
  const isRoot = path === "/";
  const navigate = useNavigate();
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const { entries: roster } = useWorkspaceRoster();
  const copier = useCopy();
  const loadListing = useCallback(() => listDrive(path), [path]);
  const listing = useAsyncResource(loadListing, undefined, path);
  const loadLibrary = useCallback(() => getSharedLibrary(), []);
  const library = useAsyncResource(loadLibrary, undefined, "library");
  const [dialog, setDialog] = useState<DriveDialogState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [listingPending, setListingPending] = useState(false);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [query, setQuery] = useState("");
  const nextTransfer = useRef(0);

  const titleOf = (workspace: string): string => {
    const entry = roster.find((each) => each.name === workspace);

    return entry === undefined ? workspace : workspaceDisplayTitle(entry);
  };

  const transfer = useCallback((name: string, work: () => Promise<void>): void => {
    const id = ++nextTransfer.current;
    setTransfers((rows) => [...rows, { id, name, status: "uploading" }]);
    startTransition(async () => {
      try {
        await work();
        setTransfers((rows) => rows.filter((row) => row.id !== id));
        listing.reload();
      } catch (cause) {
        setTransfers((rows) => rows.map((row) => row.id === id ? { ...row, status: "failed", error: renderThrownChain({ cause }) } : row));
      }
    });
  }, [listing]);

  const uploadFiles = (files: File[]): void => {
    for (const file of files) transfer(file.name, () => uploadFile(joinDir(path, file.name), file));
  };

  const background = (work: () => Promise<void>): void => {
    startTransition(async () => {
      try {
        await work();
      } catch (cause) {
        setNotice(renderThrownChain({ cause }));
      }
    });
  };

  const openLive = (row: SharedRow): void => {
    const workspace = row.workspace;

    if (workspace === undefined) return;
    background(async () => {
      const { url } = await openLiveShare({ workspace, share: row.share });
      window.open(url, "_blank", "noopener");
    });
  };

  const afterSkillAdded = async (): Promise<void> => {
    listing.reload();

    if (path !== DRIVE_SKILLS_DIR) await navigate(folderHref(DRIVE_SKILLS_DIR));
  };

  const show = (key: "file" | "skill", name: string | null): void => {
    const next = new URLSearchParams(search);

    if (name === null) next.delete(key);
    else next.set(key, name);
    setSearch(next);
  };

  const shared = lastValue(library.resource);
  const sharesAnything = shared !== null && !isEmptyLibrary(shared);
  const contents = mineContents(path, lastValue(listing.resource)?.entries ?? [], shared);
  const settled = [listing.resource, library.resource].every((resource) => resource.status !== "loading");
  const inSkills = path === DRIVE_SKILLS_DIR;
  const redirect = landing(tab, isRoot && !v.safeParse(ChosenState, location.state).success, settled && ownsNothing(contents), shared);

  if (redirect !== null) return redirect;

  const folderMenu = (entry: DriveEntry): MenuItem[] => {
    const full = joinDir(path, entry.name);
    const reserved = full === DRIVE_SKILLS_DIR;
    const items: MenuItem[] = [];

    if (entry.kind === "folder" && !reserved && !full.startsWith(`${DRIVE_SKILLS_DIR}/`)) {
      items.push({
        label: "Mark as skill", icon: <BookOpenIcon size={15} />, marker: "data-drive-mark",
        refused: entry.skill ? undefined : entry.skillProblem ?? "Not a skill",
        onSelect: () => background(async () => { await markAsSkill(full); listing.reload(); }),
      });
    }

    items.push({ label: "Download", icon: <DownloadSimpleIcon size={15} />, marker: "data-drive-download", onSelect: () => window.location.assign(downloadUrl(full)) });

    if (reserved) return items;

    return [
      ...items,
      { label: "Rename", icon: <PencilSimpleIcon size={15} />, marker: "data-drive-rename", onSelect: () => setDialog({ kind: "rename", entry }) },
      { label: "Delete", icon: <TrashIcon size={15} />, marker: "data-drive-delete", danger: true, apart: true, onSelect: () => setDialog({ kind: "delete", entry }) },
    ];
  };

  const fileMenu = (entry: DriveEntry): MenuItem[] => [
    { label: "Open", icon: <ArrowSquareOutIcon size={15} />, onSelect: () => show("file", entry.name) },
    { label: "Download", icon: <DownloadSimpleIcon size={15} />, marker: "data-drive-download", onSelect: () => window.location.assign(downloadUrl(joinDir(path, entry.name))) },
    { label: "Rename", icon: <PencilSimpleIcon size={15} />, marker: "data-drive-rename", onSelect: () => setDialog({ kind: "rename", entry }) },
    { label: "Delete", icon: <TrashIcon size={15} />, marker: "data-drive-delete", danger: true, apart: true, onSelect: () => setDialog({ kind: "delete", entry }) },
  ];

  const shareTile = (row: SharedRow, mine: boolean): ReactNode => {
    const open: MenuItem = row.kind === "live"
      ? { label: "Open", icon: <ArrowSquareOutIcon size={15} />, onSelect: () => openLive(row) }
      : { label: "Open", icon: <ArrowSquareOutIcon size={15} />, onSelect: () => void navigate(blueprintPagePath(row.id)) };

    const menu: MenuItem[] = [open];

    if (row.kind === "blueprint") {
      menu.push({ label: "Copy link", icon: <CopyIcon size={15} />, onSelect: () => copier.copy(new URL(blueprintPagePath(row.id), window.location.origin).toString()) });
    }

    if (row.kind === "blueprint" || (row.workspace !== undefined && row.fork === true)) {
      menu.push({ label: "Fork…", icon: <GitForkIcon size={15} />, onSelect: () => setDialog({ kind: "fork", row }) });
    }

    if (mine) {
      menu.push({ label: "Stop sharing", icon: <ProhibitIcon size={15} />, marker: "data-drive-stop-sharing", danger: true, apart: true, onSelect: () => setDialog({ kind: "stop", row }) });
    }

    const meta = mine ? whoCanOpen(row) : [row.kind === "live" ? "Live" : "Blueprint", row.owner, shortAge(row.createdAt)].filter(Boolean).join(" · ");
    const cover = <Cover title={row.title} seed={row.share} />;
    // A live share of yours shows the picture of the slate it shares.
    const slate = mine && row.kind === "live" ? shared?.slates.find((each) => each.workspace === row.workspace && each.id === row.slate) : undefined;

    return (
      <Tile key={`${row.kind}:${row.id}`} title={row.title} icon={SHARE_ICON[row.kind]}
        picture={slate === undefined ? cover : <SlatePicture workspace={slate.workspace} slate={slate} className="absolute inset-0 size-full object-cover object-top" fallback={cover} />}
        href={row.kind === "blueprint" ? blueprintPagePath(row.id) : undefined} onOpen={row.kind === "live" ? () => openLive(row) : undefined}
        meta={<span className="truncate">{meta}</span>} menu={menu}
        attributes={{ "data-drive-share": row.id, "data-drive-share-kind": row.kind }} />
    );
  };

  const slateTile = (slate: OwnedSlate): ReactNode => (
    <Tile key={`${slate.workspace}:${slate.id}`} title={slate.title}
      picture={<SlatePicture workspace={slate.workspace} slate={slate} className="absolute inset-0 size-full object-cover object-top"
        fallback={<Cover title={slate.title} seed={`${slate.workspace}/${slate.id}`} />} />}
      icon={SLATE_ICON} href={slateHref(slate)}
      meta={<><span className="truncate">{titleOf(slate.workspace)}</span><VisibilityGlyph visibility={slate.visibility} /></>}
      attributes={{ "data-drive-slate": slate.id, "data-drive-workspace": slate.workspace }}
      menu={[
        { label: "Open", icon: <ArrowSquareOutIcon size={15} />, onSelect: () => void navigate(slateHref(slate)) },
        { label: "Share…", icon: <ShareNetworkIcon size={15} />, marker: "data-drive-share-slate", onSelect: () => setDialog({ kind: "share", slate }) },
        { label: "Go to workspace", icon: <SquaresFourIcon size={15} />, onSelect: () => void navigate(`/workspace/${encodeURIComponent(slate.workspace)}`) },
      ]} />
  );

  const folderTile = (entry: DriveEntry): ReactNode => {
    const full = joinDir(path, entry.name);
    const opens = entry.kind === "symlink" && entry.target !== undefined ? entry.target : full;
    const attributes = { "data-drive-entry": entry.name, "data-drive-kind": entry.kind, "data-drive-skill": entry.skill ? "true" : "false" };
    let icon = entry.skill ? SKILLS_ICON : FOLDER_ICON;

    if (entry.kind === "symlink") icon = entry.skill ? SKILLS_ICON : LINK_ICON;

    if (inSkills && entry.skill) {
      return (
        <Tile key={entry.name} title={entry.name} icon={<BookOpenIcon size={16} />} href={`${folderHref(opens)}?file=SKILL.md`}
          picture={<TextCover path={`${opens}/SKILL.md`} name="SKILL.md" />}
          meta={<SkillMeta entry={entry} from={opens === full ? null : opens} />} menu={folderMenu(entry)} attributes={attributes} />
      );
    }

    return (
      <FolderTile key={entry.name} name={full === DRIVE_SKILLS_DIR ? "Skills" : entry.name} icon={icon}
        href={folderHref(opens)} menu={folderMenu(entry)} attributes={attributes} />
    );
  };

  const builtinTile = (name: string): ReactNode => (
    <Tile key={`builtin:${name}`} title={name} icon={<BookOpenIcon size={16} />} onOpen={() => show("skill", name)}
      picture={<TextPage text={BUILTIN_SKILL_FILES[name]} name="SKILL.md" />}
      meta={<span className="truncate">Built in</span>} menu={[]} attributes={{ "data-drive-builtin": name }} />
  );

  /** By name, a built-in first. */
  const skillTiles = (): ReactNode[] => [
    ...contents.builtins.map((name) => ({ name, tile: builtinTile(name) })),
    ...contents.folders.map((entry) => ({ name: entry.name, tile: folderTile(entry) })),
  ].sort((a, b) => compareSkillNames(a.name, b.name)).map((each) => each.tile);

  const fileTile = (entry: DriveEntry): ReactNode => {
    const full = joinDir(path, entry.name);
    const age = entry.mtimeMs > 0 ? shortAge(entry.mtimeMs) : null;

    return (
      <Tile key={entry.name} title={entry.name} icon={fileIcon(entry.name)} onOpen={() => show("file", entry.name)}
        picture={TEXT.test(entry.name) && entry.size > 0 ? <TextCover path={full} name={entry.name} />
          : <FileCover name={entry.name} image={IMAGE.test(entry.name) ? inlineUrl(full) : undefined} />}
        meta={entry.unused === undefined ? <span className="truncate">{[formatBytes(entry.size), age].filter(Boolean).join(" · ")}</span> : <NotUsed refusal={entry.unused} />}
        menu={fileMenu(entry)}
        attributes={{ "data-drive-entry": entry.name, "data-drive-kind": entry.kind, "data-drive-skill": "false" }} />
    );
  };

  const opened = contents.files.find((entry) => entry.name === search.get("file"));
  const builtin = contents.builtins.find((name) => name === search.get("skill"));
  const subtitle = subtitleOf(tab, path);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-5 pb-20 pt-6 sm:px-8 lg:pt-8">
        <header className="flex items-center gap-3">
          <HardDrivesIcon size={22} className="shrink-0 p-text-3" />
          <h1 className="p-display text-2xl">Drive</h1>
          {tab === "mine" && (
            <div className="ml-auto">
              <PrimaryAction inSkills={inSkills} onFiles={uploadFiles}
                onFolder={(picks) => { if (picks.length > 0) transfer(pickedFolderName(picks) ?? "folder", () => uploadFolder(path, picks)); }}
                onZip={(file) => transfer(file.name, () => uploadZip(joinDir(path, file.name.replace(/\.zip$/iu, "")), file))}
                onNewFolder={() => setDialog({ kind: "new-folder" })} onNewSkill={() => setDialog({ kind: "add-skill" })} />
            </div>
          )}
        </header>

        {sharesAnything && (
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <TabStrip tab={tab} />
            {tab === "shared" && (
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search shared" aria-label="Search shared"
                data-drive-search className={`${inputCls} w-full sm:ml-auto sm:w-60`} />
            )}
          </div>
        )}
        {tab === "mine" && !isRoot && <div className="mt-6"><Crumbs path={path} /></div>}
        {subtitle !== null && <p className={`p-meta p-text-3 ${isRoot ? "mt-4" : "mt-1"}`}>{subtitle}</p>}

        <DriveNotices notice={notice} onDismissNotice={() => setNotice(null)} listingPending={listingPending} libraryResource={library.resource} onRetryLibrary={library.reload}
          copyStatus={copier.status} transfers={transfers} onDismissTransfer={(id) => setTransfers((rows) => rows.filter((row) => row.id !== id))} />

        {tab === "mine" ? (
          <DropZone label={isRoot ? "My stuff" : path.slice(path.lastIndexOf("/") + 1)} onFiles={uploadFiles}>
            <MineBody resource={listing.resource} onRetry={listing.reload} empty={isEmptyMine(contents)}>
              <SectionList groups={[
                { label: "Slates", tiles: contents.slates.map(slateTile) },
                { label: "Blueprints", tiles: contents.blueprints.map((row) => shareTile(row, true)) },
                { label: inSkills ? "Skills" : "Folders", tiles: inSkills ? skillTiles() : contents.folders.map(folderTile) },
                { label: "Files", tiles: contents.files.map(fileTile) },
              ]} />
            </MineBody>
          </DropZone>
        ) : (
          <div className="mt-6"><SharedBody shared={shared} query={query} tile={shareTile} /></div>
        )}
      </div>

      {opened !== undefined && <FileDrawer path={joinDir(path, opened.name)} entry={opened} onClose={() => show("file", null)} />}
      {builtin !== undefined && <BuiltinSkillDrawer name={builtin} onClose={() => show("skill", null)} />}
      {dialog !== null && (
        <DriveDialog dialog={dialog} folder={path} onClose={() => setDialog(null)} onListingChanged={listing.reload}
          onSharesChanged={(behind) => { if (behind === "pending") setListingPending(true); library.reload(); }} onSkillAdded={() => void afterSkillAdded()} />
      )}
    </div>
  );
}
