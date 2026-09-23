/** The Drive: My stuff (`/drive`, `/drive/<path>`) and Shared (`/shared`). Nothing empty is drawn. */
import { startTransition, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Button, Loader } from "@cloudflare/kumo";
import {
  ArrowSquareOutIcon, BookOpenIcon, CaretRightIcon, CopyIcon, DownloadSimpleIcon, FileArchiveIcon,
  FolderPlusIcon, FolderSimpleIcon, GitForkIcon, GlobeIcon, HardDrivesIcon, PencilSimpleIcon, PlusIcon, ProhibitIcon,
  ShareNetworkIcon, SquaresFourIcon, TrashIcon, UploadSimpleIcon, UsersIcon, WarningIcon, XIcon,
} from "@phosphor-icons/react";
import * as v from "valibot";
import {
  APP_ROUTES, DRIVE_SKILLS_DIR, blueprintPagePath, entryRevision, formatBytes, parseSkillFile, shortAge, workspaceDisplayTitle,
  type DriveEntry, type DriveListing, type LiveShareVisibility, type MarkedSkill, type OwnedSlate, type SharedLibrary, type SharedRow,
} from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import {
  addSkillArchive, addSkillFolder, addSkillText, deleteEntry, downloadUrl, inlineUrl, listDrive, makeFolder, markAsSkill,
  readDriveText, renameEntry, uploadFile, uploadFolder, uploadZip, type PickedFile,
} from "@/lib/drive-api";
import { getSharedLibrary, openLiveShare, revokeShare } from "@/lib/shared-api";
import { useAsyncResource, lastValue, type AsyncResource } from "@/hooks/use-async-resource";
import { useCloseOnOutsideClick } from "@/hooks/use-close-on-outside-click";
import { useWorkspaceRpc } from "@/hooks/use-kinu";
import { useWorkspaceRoster } from "@/hooks/use-workspace-roster";
import { useCopy } from "@/hooks/use-copy";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { Modal } from "@/components/ui/Modal";
import { FilledButton } from "@/components/ui/FilledButton";
import { inputCls } from "@/components/ui/form";
import {
  Cover, FileCover, FOLDER_ICON, FolderTile, GRID, LINK_ICON, SHARE_ICON, SKILLS_ICON, SLATE_ICON, Tile, fileIcon, type MenuItem,
} from "@/components/drive/DriveTiles";
import { FileViewer } from "@/components/surfaces/FileViewer";
import { ForkDialog } from "@/components/shared/ForkDialog";
import { ShareSlateDialog } from "@/components/slates/ShareSlateDialog";

export type DriveTab = "mine" | "shared";

function folderHref(path: string): string {
  return path === "/" ? APP_ROUTES.drive : `${APP_ROUTES.drive}${path}`;
}

function childPath(folder: string, name: string): string {
  return folder === "/" ? `/${name}` : `${folder}/${name}`;
}

function relativePathOf(file: File): string {
  return file.webkitRelativePath === "" ? file.name : file.webkitRelativePath;
}

function picked(files: FileList | null): PickedFile[] {
  return [...(files ?? [])].map((file) => ({ path: relativePathOf(file), file }));
}

function pickedFolderName(files: readonly PickedFile[]): string | null {
  const first = files[0]?.path.split("/")[0];

  return first === undefined || first === files[0]?.path ? null : first;
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

function EmptyState({ title, body }: { title: string; body: ReactNode }) {
  return (
    <div data-drive-empty className="flex flex-col items-center px-6 py-16 text-center sm:py-24">
      <span className="flex size-14 items-center justify-center rounded-2xl p-text-3 bg-[color-mix(in_srgb,var(--c-text)_7%,transparent)]">
        <HardDrivesIcon size={26} />
      </span>
      <h2 className="mt-5 p-heading text-[19px] p-text">{title}</h2>
      <p className="mt-2 max-w-[26rem] p-row-text p-text-3">{body}</p>
    </div>
  );
}

function NameDialog({ title, icon, initial, label, action, onCommit, onClose }: {
  title: string; icon: ReactNode; initial: string; label: string; action: string;
  onCommit: (name: string) => Promise<void>; onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = value.trim();
  const valid = name !== "" && !name.includes("/") && name !== "." && name !== "..";

  const submit = (): void => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    startTransition(async () => {
      try {
        await onCommit(name);
        onClose();
      } catch (cause) {
        setError(renderThrownChain({ cause }));
        setBusy(false);
      }
    });
  };

  return (
    <Modal title={title} icon={icon} onClose={onClose} busy={busy}
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <FilledButton data-drive-dialog-commit onClick={submit} disabled={!valid || busy}>{busy ? `${action}…` : action}</FilledButton>
      </>}>
      <form onSubmit={(event) => { event.preventDefault(); submit(); }} className="space-y-2">
        <label className="block p-meta p-text-3" htmlFor="drive-name">{label}</label>
        <input id="drive-name" autoFocus value={value} onChange={(event) => setValue(event.target.value)}
          onFocus={(event) => event.currentTarget.select()} className={inputCls} aria-invalid={value !== "" && !valid} />
        {error !== null && <div role="alert" className="p-notice-danger rounded-md px-3 py-2 text-xs">{error}</div>}
      </form>
    </Modal>
  );
}

function ConfirmDialog({ title, body, action, onConfirm, onClose, marker }: {
  title: string; body: ReactNode; action: string; onConfirm: () => Promise<void>; onClose: () => void; marker: `data-${string}`;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = (): void => {
    setBusy(true);
    setError(null);
    startTransition(async () => {
      try {
        await onConfirm();
        onClose();
      } catch (cause) {
        setError(renderThrownChain({ cause }));
        setBusy(false);
      }
    });
  };

  return (
    <Modal title={title} onClose={onClose} busy={busy} maxWidthClass="max-w-sm"
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <FilledButton danger {...{ [marker]: "" }} onClick={confirm} disabled={busy}>{busy ? `${action}…` : action}</FilledButton>
      </>}>
      <p className="p-row-text p-text-2">{body}</p>
      {error !== null && <div role="alert" className="p-notice-danger rounded-md px-3 py-2 text-xs">{error}</div>}
    </Modal>
  );
}

const DELETE_ALSO: Record<DriveEntry["kind"], string> = {
  file: "",
  folder: " and everything inside it",
  symlink: " (the folder it points at stays)",
};

function AddSkillDialog({ onAdded, onClose }: { onAdded: () => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);

  const run = (work: () => Promise<MarkedSkill>): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    startTransition(async () => {
      try {
        await work();
        onAdded();
        onClose();
      } catch (cause) {
        setError(renderThrownChain({ cause }));
        setBusy(false);
      }
    });
  };

  return (
    <Modal title="New skill" icon={<BookOpenIcon size={18} className="p-accent" />} onClose={onClose} busy={busy} maxWidthClass="max-w-lg"
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <FilledButton data-drive-add-skill-commit onClick={() => run(() => addSkillText(text))} disabled={busy || text.trim() === ""}>
          {busy ? "Adding…" : "Add"}
        </FilledButton>
      </>}>
      <div className="space-y-3">
        <p className="p-row-text p-text-2">
          Paste a <span className="font-mono p-text">SKILL.md</span>: front matter that names it, then the steps. Every workspace you own uses it from its next turn.
        </p>
        <textarea data-drive-skill-text value={text} onChange={(event) => setText(event.target.value)} rows={9} spellCheck={false}
          placeholder={"---\nname: deploy\ndescription: Ship the current branch\n---\nSteps…"}
          aria-label="SKILL.md" className={`${inputCls} font-mono text-xs leading-relaxed`} />
        <div className="flex flex-wrap items-center gap-2">
          <span className="p-meta p-text-3">or pick</span>
          <button type="button" className="p-btn-quiet inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs" disabled={busy}
            onClick={() => folderInput.current?.click()}><FolderSimpleIcon size={13} /> a folder</button>
          <button type="button" className="p-btn-quiet inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs" disabled={busy}
            onClick={() => zipInput.current?.click()}><FileArchiveIcon size={13} /> a zip</button>
          <input ref={folderInput} type="file" className="hidden" {...{ webkitdirectory: "" }} data-drive-skill-folder
            onChange={(event) => {
              const files = picked(event.currentTarget.files);
              event.currentTarget.value = "";

              if (files.length > 0) run(() => addSkillFolder(files, pickedFolderName(files)));
            }} />
          <input ref={zipInput} type="file" accept=".zip,application/zip" className="hidden" data-drive-skill-zip
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";

              if (file !== undefined) run(() => addSkillArchive(file, file.name.replace(/\.zip$/iu, "")));
            }} />
        </div>
        {error !== null && <div role="alert" data-drive-skill-error className="p-notice-danger rounded-md px-3 py-2 text-xs">{error}</div>}
      </div>
    </Modal>
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
        () => { if (live) setText(null); },
      );
    });

    observer.observe(element);

    return () => { live = false; observer.disconnect(); };
  }, [path]);

  const [heading, lines] = text === null ? [null, []] : coverLines(text, name === "SKILL.md");

  return (
    <span ref={holder} className="absolute inset-0">
      {lines.length === 0 ? <FileCover name={name} /> : (
        <span className="absolute inset-0 overflow-hidden p-recessed px-[14%] pt-[5%]">
          <span className={`block h-full overflow-hidden rounded-t-md border border-b-0 p-border p-surface px-3 pt-2.5 text-[8.5px] leading-[1.45] p-text-3 ${PROSE.test(name) ? "" : "font-mono"}`}>
            {heading !== null && <span className="mb-1 block truncate text-[11px] font-semibold p-text">{heading}</span>}
            {lines.map((line, index) => <span key={index} className="block truncate">{line === "" ? "\u00a0" : line}</span>)}
          </span>
        </span>
      )}
    </span>
  );
}

/** The share sheet talks to the slate's own workspace. */
function DriveShareSheet({ slate, onClose }: { slate: OwnedSlate; onClose: () => void }) {
  const { rpc } = useWorkspaceRpc(slate.workspace);

  return <ShareSlateDialog workspace={slate.workspace} slate={slate.id} title={slate.title} rpc={rpc} onClose={onClose} />;
}

const NEW_BUTTON = "h-8 gap-1.5 px-3 text-sm max-sm:!size-9 max-sm:rounded-full max-sm:!p-0";

interface Transfer {
  readonly id: number;
  readonly name: string;
  readonly status: "uploading" | "failed";
  readonly error?: string;
}

function NewMenu({ onFiles, onFolder, onZip, onNewFolder, onNewSkill }: {
  onFiles: (files: File[]) => void;
  onFolder: (files: PickedFile[]) => void;
  onZip: (file: File) => void;
  onNewFolder: () => void;
  onNewSkill: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useCloseOnOutsideClick(open, menu, close);

  const items: readonly { label: string; icon: ReactNode; marker: `data-${string}`; run: () => void; apart?: boolean }[] = [
    { label: "Upload files", icon: <UploadSimpleIcon size={15} />, marker: "data-drive-upload-files", run: () => filesInput.current?.click() },
    { label: "Upload a folder", icon: <FolderSimpleIcon size={15} />, marker: "data-drive-upload-folder", run: () => folderInput.current?.click() },
    { label: "Unpack a .zip", icon: <FileArchiveIcon size={15} />, marker: "data-drive-upload-zip", run: () => zipInput.current?.click() },
    { label: "New folder", icon: <FolderPlusIcon size={15} />, marker: "data-drive-new-folder", run: onNewFolder, apart: true },
    { label: "New skill", icon: <BookOpenIcon size={15} />, marker: "data-drive-add-skill", run: onNewSkill },
  ];

  return (
    <div ref={menu} className="relative">
      <FilledButton className={NEW_BUTTON} aria-label="New" aria-haspopup="menu" aria-expanded={open}
        data-drive-new onClick={() => setOpen((value) => !value)}>
        <PlusIcon size={14} weight="bold" /><span className="max-sm:hidden">New</span>
      </FilledButton>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-52 p-card border p-border p-1.5 p-shadow-menu animate-fade-in">
          {items.map((item) => (
            <div key={item.label}>
              {item.apart === true && <div className="mx-1 my-1.5 border-t p-border" />}
              <button type="button" role="menuitem" {...{ [item.marker]: "" }} onClick={() => { setOpen(false); item.run(); }}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm p-text transition-colors hover:bg-[var(--c-elevated)]">
                <span className="flex shrink-0 p-text-3">{item.icon}</span>{item.label}
              </button>
            </div>
          ))}
        </div>
      )}
      <input ref={filesInput} type="file" multiple className="hidden" data-drive-files-input
        onChange={(event) => { const files = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ""; onFiles(files); }} />
      <input ref={folderInput} type="file" className="hidden" {...{ webkitdirectory: "" }} data-drive-folder-input
        onChange={(event) => { const files = picked(event.currentTarget.files); event.currentTarget.value = ""; onFolder(files); }} />
      <input ref={zipInput} type="file" accept=".zip,application/zip" className="hidden" data-drive-zip-input
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";

          if (file !== undefined) onZip(file);
        }} />
    </div>
  );
}

type Dialog =
  | { kind: "new-folder" }
  | { kind: "rename"; entry: DriveEntry }
  | { kind: "delete"; entry: DriveEntry }
  | { kind: "add-skill" }
  | { kind: "share"; slate: OwnedSlate }
  | { kind: "stop"; row: SharedRow }
  | { kind: "fork"; row: SharedRow };

function VisibilityGlyph({ visibility }: { visibility: LiveShareVisibility | undefined }) {
  if (visibility === undefined) return null;

  return visibility === "public"
    ? <GlobeIcon size={13} className="shrink-0 p-text-4" aria-label="Anyone with the link" />
    : <UsersIcon size={13} className="shrink-0 p-text-4" aria-label="Shared with people" />;
}

function whoCanOpen(row: SharedRow): string {
  if (row.kind === "blueprint" || row.visibility === "public") return "Anyone with the link";

  const users = row.users ?? [];

  return users.length === 1 ? users[0] ?? "" : `${String(users.length)} people`;
}

function whoLoses(row: SharedRow): string {
  const users = row.users ?? [];

  if (row.kind === "blueprint" || row.visibility === "public" || users.length === 0) return "Everyone with the link loses";

  return `${users.join(", ")} ${users.length === 1 ? "loses" : "lose"}`;
}

function isEmptyLibrary(library: SharedLibrary): boolean {
  return library.received.length + library.mine.length === 0;
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
  const loadSkills = useCallback((): Promise<DriveListing | null> => (isRoot ? listDrive(DRIVE_SKILLS_DIR) : Promise.resolve(null)), [isRoot]);
  const skills = useAsyncResource(loadSkills, undefined, isRoot ? "root" : "folder");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [dragOver, setDragOver] = useState(false);
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
    for (const file of files) transfer(file.name, () => uploadFile(childPath(path, file.name), file));
  };

  const act = async (work: () => Promise<void>): Promise<void> => {
    await work();
    listing.reload();
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
    skills.reload();

    if (path !== DRIVE_SKILLS_DIR) await navigate(folderHref(DRIVE_SKILLS_DIR));
  };

  const openFile = (name: string): void => {
    const next = new URLSearchParams(search);
    next.set("file", name);
    setSearch(next);
  };

  const closeFile = (): void => {
    const next = new URLSearchParams(search);
    next.delete("file");
    setSearch(next);
  };

  const shared = lastValue(library.resource);
  const sharesAnything = shared !== null && !isEmptyLibrary(shared);
  const entries = lastValue(listing.resource)?.entries ?? [];
  const skillsListed = (lastValue(skills.resource)?.entries.length ?? 0) > 0;
  const shown = entries.filter((entry) => !(isRoot && entry.name === DRIVE_SKILLS_DIR.slice(1) && !skillsListed));
  const leads = (entry: DriveEntry): number => Number(isRoot && entry.name === DRIVE_SKILLS_DIR.slice(1));

  const folders = shown.filter((entry) => entry.kind !== "file").sort((a, b) => leads(b) - leads(a));
  const files = shown.filter((entry) => entry.kind === "file");
  const slates = isRoot && shared !== null ? shared.slates : [];
  const blueprints = isRoot && shared !== null ? shared.mine.filter((row) => row.kind === "blueprint") : [];

  const settled = (resource: AsyncResource<unknown>): boolean => resource.status !== "loading";

  const mineEmpty = settled(listing.resource) && settled(library.resource) && settled(skills.resource)
    && shown.length === 0 && slates.length === 0 && blueprints.length === 0;

  const chosen = v.safeParse(ChosenState, location.state).success;
  const inSkills = path === DRIVE_SKILLS_DIR;
  const opened = files.find((entry) => entry.name === search.get("file"));

  if (tab === "shared" && shared !== null && !sharesAnything) return <Navigate to={APP_ROUTES.drive} replace state={{ chosen: true }} />;

  if (tab === "mine" && isRoot && !chosen && mineEmpty && sharesAnything) return <Navigate to={APP_ROUTES.shared} replace />;

  const folderMenu = (entry: DriveEntry): MenuItem[] => {
    const full = childPath(path, entry.name);
    const reserved = full === DRIVE_SKILLS_DIR;
    const items: MenuItem[] = [];

    if (entry.kind === "folder" && !reserved && !full.startsWith(`${DRIVE_SKILLS_DIR}/`)) {
      items.push({
        label: "Mark as skill", icon: <BookOpenIcon size={15} />, marker: "data-drive-mark",
        refused: entry.skill ? undefined : entry.skillProblem ?? "Not a skill",
        onSelect: () => background(() => act(async () => { await markAsSkill(full); })),
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
    { label: "Open", icon: <ArrowSquareOutIcon size={15} />, onSelect: () => openFile(entry.name) },
    { label: "Download", icon: <DownloadSimpleIcon size={15} />, marker: "data-drive-download", onSelect: () => window.location.assign(downloadUrl(childPath(path, entry.name))) },
    { label: "Rename", icon: <PencilSimpleIcon size={15} />, marker: "data-drive-rename", onSelect: () => setDialog({ kind: "rename", entry }) },
    { label: "Delete", icon: <TrashIcon size={15} />, marker: "data-drive-delete", danger: true, apart: true, onSelect: () => setDialog({ kind: "delete", entry }) },
  ];

  const blueprintLink = (row: SharedRow): string => new URL(blueprintPagePath(row.id), window.location.origin).toString();

  const shareTile = (row: SharedRow, mine: boolean): ReactNode => {
    const open: MenuItem = row.kind === "live"
      ? { label: "Open", icon: <ArrowSquareOutIcon size={15} />, onSelect: () => openLive(row) }
      : { label: "Open", icon: <ArrowSquareOutIcon size={15} />, onSelect: () => void navigate(blueprintPagePath(row.id)) };

    const menu: MenuItem[] = [open];

    if (row.kind === "blueprint") menu.push({ label: "Copy link", icon: <CopyIcon size={15} />, onSelect: () => copier.copy(blueprintLink(row)) });

    if (mine) {
      menu.push({ label: "Stop sharing", icon: <ProhibitIcon size={15} />, marker: "data-drive-stop-sharing", danger: true, apart: true, onSelect: () => setDialog({ kind: "stop", row }) });
    } else if (row.kind === "blueprint" || (row.workspace !== undefined && row.fork === true)) {
      menu.push({ label: "Fork…", icon: <GitForkIcon size={15} />, onSelect: () => setDialog({ kind: "fork", row }) });
    }

    const age = shortAge(row.createdAt);
    const meta = mine ? whoCanOpen(row) : [row.kind === "live" ? "Live" : "Blueprint", row.owner, age].filter(Boolean).join(" · ");

    return (
      <Tile key={`${row.kind}:${row.id}`} title={row.title} picture={<Cover title={row.title} seed={row.share} />} icon={SHARE_ICON[row.kind]}
        href={row.kind === "blueprint" ? blueprintPagePath(row.id) : undefined} onOpen={row.kind === "live" ? () => openLive(row) : undefined}
        meta={<span className="truncate">{meta}</span>} menu={menu}
        attributes={{ "data-drive-share": row.id, "data-drive-share-kind": row.kind }} />
    );
  };

  let mineBody: ReactNode;

  if (listing.resource.status === "loading") {
    mineBody = <div className="flex justify-center py-16"><Loader size="base" /></div>;
  } else if (listing.resource.status === "error" && lastValue(listing.resource) === null) {
    mineBody = <LoadFailure what="this folder" message={listing.resource.message} onRetry={listing.reload} className="py-3" />;
  } else if (mineEmpty) {
    mineBody = isRoot
      ? <EmptyState title={sharesAnything ? "Nothing here yet" : "Your Drive is empty"}
        body={<>Drop files here, or use New. Every workspace you own sees them at <span className="font-mono p-text-2">/shared</span>, and the slates your workspaces build show up here too.</>} />
      : <EmptyState title="This folder is empty" body="Drop files here, or use New." />;
  } else {
    const titled = [slates, blueprints, folders, files].filter((group) => group.length > 0).length > 1;

    mineBody = (
      <div className="space-y-8">
        {slates.length > 0 && (
          <Section label="Slates" titled={titled}>
            {slates.map((slate) => (
              <Tile key={`${slate.workspace}:${slate.id}`} title={slate.title} picture={<Cover title={slate.title} seed={`${slate.workspace}/${slate.id}`} />}
                icon={SLATE_ICON} href={slateHref(slate)}
                meta={<><span className="truncate">{titleOf(slate.workspace)}</span><VisibilityGlyph visibility={slate.visibility} /></>}
                attributes={{ "data-drive-slate": slate.id, "data-drive-workspace": slate.workspace }}
                menu={[
                  { label: "Open", icon: <ArrowSquareOutIcon size={15} />, onSelect: () => void navigate(slateHref(slate)) },
                  { label: "Share…", icon: <ShareNetworkIcon size={15} />, marker: "data-drive-share-slate", onSelect: () => setDialog({ kind: "share", slate }) },
                  { label: "Go to workspace", icon: <SquaresFourIcon size={15} />, onSelect: () => void navigate(`/workspace/${encodeURIComponent(slate.workspace)}`) },
                ]} />
            ))}
          </Section>
        )}
        {blueprints.length > 0 && <Section label="Blueprints" titled={titled}>{blueprints.map((row) => shareTile(row, true))}</Section>}
        {folders.length > 0 && (
          <Section label={inSkills ? "Skills" : "Folders"} titled={titled}>
            {folders.map((entry) => {
              const full = childPath(path, entry.name);
              const opens = entry.kind === "symlink" && entry.target !== undefined ? entry.target : full;
              const attributes = { "data-drive-entry": entry.name, "data-drive-kind": entry.kind, "data-drive-skill": entry.skill ? "true" : "false" };
              let icon = entry.skill ? SKILLS_ICON : FOLDER_ICON;

              if (entry.kind === "symlink") icon = entry.skill ? SKILLS_ICON : LINK_ICON;

              if (inSkills && entry.skill) {
                let meta = opens === full ? "" : `From ${opens.slice(1)}`;

                if (opens === full && entry.mtimeMs > 0) meta = `Updated ${shortAge(entry.mtimeMs)}`;

                return (
                  <Tile key={entry.name} title={entry.name} icon={<BookOpenIcon size={16} />} href={`${folderHref(opens)}?file=SKILL.md`}
                    picture={<TextCover path={`${opens}/SKILL.md`} name="SKILL.md" />}
                    meta={<span className="truncate">{meta}</span>} menu={folderMenu(entry)} attributes={attributes} />
                );
              }

              return (
                <FolderTile key={entry.name} name={full === DRIVE_SKILLS_DIR ? "Skills" : entry.name} icon={icon}
                  href={folderHref(opens)} menu={folderMenu(entry)} attributes={attributes} />
              );
            })}
          </Section>
        )}
        {files.length > 0 && (
          <Section label="Files" titled={titled}>
            {files.map((entry) => {
              const full = childPath(path, entry.name);
              const age = entry.mtimeMs > 0 ? shortAge(entry.mtimeMs) : null;

              return (
                <Tile key={entry.name} title={entry.name} icon={fileIcon(entry.name)} onOpen={() => openFile(entry.name)}
                  picture={TEXT.test(entry.name) && entry.size > 0 ? <TextCover path={full} name={entry.name} />
                    : <FileCover name={entry.name} image={IMAGE.test(entry.name) ? inlineUrl(full) : undefined} />}
                  meta={<span className="truncate">{[formatBytes(entry.size), age].filter(Boolean).join(" · ")}</span>}
                  menu={fileMenu(entry)}
                  attributes={{ "data-drive-entry": entry.name, "data-drive-kind": entry.kind, "data-drive-skill": "false" }} />
              );
            })}
          </Section>
        )}
      </div>
    );
  }

  let sharedBody: ReactNode = <div className="flex justify-center py-16"><Loader size="base" /></div>;

  if (shared !== null) {
    sharedBody = (
      <div className="space-y-8">
        {shared.received.length > 0 && <Section label="Shared with you">{shared.received.map((row) => shareTile(row, false))}</Section>}
        {shared.mine.length > 0 && <Section label="Shared by you">{shared.mine.map((row) => shareTile(row, true))}</Section>}
      </div>
    );
  }

  let subtitle: ReactNode = null;

  if (tab === "mine" && inSkills) subtitle = "Every workspace you own uses these skills.";
  else if (tab === "mine" && isRoot && !mineEmpty) subtitle = <>Files and folders here are in every workspace you own, at <span className="font-mono p-text-2">/shared</span>.</>;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-5 pb-20 pt-6 sm:px-8 lg:pt-8">
        <header className="flex items-center gap-3">
          <HardDrivesIcon size={22} className="shrink-0 p-text-3" />
          <h1 className="p-display text-2xl">Drive</h1>
          {tab === "mine" && (
            <div className="ml-auto">
              {inSkills ? (
                <FilledButton className={NEW_BUTTON} aria-label="New skill" data-drive-add-skill onClick={() => setDialog({ kind: "add-skill" })}>
                  <PlusIcon size={14} weight="bold" /><span className="max-sm:hidden">New skill</span>
                </FilledButton>
              ) : (
                <NewMenu onFiles={uploadFiles}
                  onFolder={(picks) => { if (picks.length > 0) transfer(pickedFolderName(picks) ?? "folder", () => uploadFolder(path, picks)); }}
                  onZip={(file) => transfer(file.name, () => uploadZip(childPath(path, file.name.replace(/\.zip$/iu, "")), file))}
                  onNewFolder={() => setDialog({ kind: "new-folder" })} onNewSkill={() => setDialog({ kind: "add-skill" })} />
              )}
            </div>
          )}
        </header>

        {sharesAnything && <div className="mt-5"><TabStrip tab={tab} /></div>}
        {tab === "mine" && !isRoot && <div className="mt-6"><Crumbs path={path} /></div>}
        {subtitle !== null && <p className={`p-meta p-text-3 ${isRoot ? "mt-4" : "mt-1"}`}>{subtitle}</p>}

        {notice !== null && (
          <div role="alert" data-drive-notice className="p-notice-danger mt-4 flex items-start gap-2 rounded-md px-3 py-2 text-xs">
            <WarningIcon size={13} className="mt-px shrink-0" />
            <span className="min-w-0 break-words">{notice}</span>
            <button type="button" onClick={() => setNotice(null)} className="ml-auto shrink-0 p-text-3 hover:p-text" aria-label="Dismiss"><XIcon size={12} /></button>
          </div>
        )}
        {library.resource.status === "error" && (
          <LoadFailure what="your slates and shares" message={library.resource.message} onRetry={library.reload} className="mt-4" />
        )}
        {copier.status !== "idle" && <p role="status" className="mt-4 p-meta p-text-3">{copier.status === "copied" ? "Link copied." : "Could not copy the link."}</p>}

        {transfers.length > 0 && (
          <ul className="mt-4 space-y-1">
            {transfers.map((row) => (
              <li key={row.id} data-drive-transfer={row.status} className="flex items-center gap-2 text-xs">
                {row.status === "uploading"
                  ? <><Loader size="sm" /><span className="truncate p-text-2">{row.name}</span><span className="p-text-3">uploading…</span></>
                  : <><WarningIcon size={13} className="shrink-0 p-danger" /><span className="truncate p-text-2">{row.name}</span>
                    <span className="min-w-0 truncate p-danger" title={row.error}>{row.error}</span>
                    <button type="button" onClick={() => setTransfers((rows) => rows.filter((other) => other.id !== row.id))}
                      className="ml-auto shrink-0 p-text-3 hover:p-text" aria-label={`Dismiss ${row.name}`}><XIcon size={12} /></button></>}
              </li>
            ))}
          </ul>
        )}

        {tab === "mine" ? (
          <div data-drive-list className="relative mt-6"
            onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(event) => { event.preventDefault(); setDragOver(false); uploadFiles([...event.dataTransfer.files]); }}>
            {mineBody}
            {dragOver && (
              <div aria-hidden="true" className="pointer-events-none absolute -inset-3 z-20 flex items-center justify-center rounded-[18px] border-2 border-dashed border-[var(--c-accent)] bg-[color-mix(in_srgb,var(--c-bg)_74%,transparent)]">
                <span className="flex items-center gap-2 rounded-full bg-[var(--c-accent)] px-4 py-2 text-sm font-semibold text-[var(--c-accent-on)] p-shadow-menu">
                  <UploadSimpleIcon size={15} weight="bold" /> Drop to add to {isRoot ? "My stuff" : path.slice(path.lastIndexOf("/") + 1)}
                </span>
              </div>
            )}
          </div>
        ) : <div className="mt-6">{sharedBody}</div>}
      </div>

      {opened !== undefined && (
        <>
          <div aria-hidden="true" className="p-scrim fixed inset-0 z-40" onClick={closeFile} />
          <div className="fixed inset-y-0 right-0 z-50 w-full sm:w-[min(640px,92vw)]" data-drive-viewer>
            <FileViewer path={childPath(path, opened.name)} read={readDriveText} revision={entryRevision(opened)}
              rawHref={inlineUrl(childPath(path, opened.name))} downloadHref={downloadUrl(childPath(path, opened.name))}
              onSaved={() => listing.reload()} onClose={closeFile} />
          </div>
        </>
      )}

      {dialog?.kind === "new-folder" && (
        <NameDialog title="New folder" icon={<FolderPlusIcon size={18} className="p-info" />} initial="" label="Folder name" action="Create"
          onCommit={(name) => act(() => makeFolder(childPath(path, name)))} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "rename" && (
        <NameDialog title={`Rename ${dialog.entry.name}`} icon={<PencilSimpleIcon size={18} className="p-text-3" />}
          initial={dialog.entry.name} label="New name" action="Rename"
          onCommit={(name) => act(() => renameEntry(childPath(path, dialog.entry.name), childPath(path, name)))} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog title={`Delete ${dialog.entry.name}?`} action="Delete" marker="data-drive-delete-confirm"
          body={<>This deletes <span className="font-medium p-text">{dialog.entry.name}</span>{DELETE_ALSO[dialog.entry.kind]}. It cannot be undone.</>}
          onConfirm={() => act(() => deleteEntry(childPath(path, dialog.entry.name)))} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "add-skill" && (
        <AddSkillDialog onClose={() => setDialog(null)} onAdded={() => void afterSkillAdded()} />
      )}
      {dialog?.kind === "share" && <DriveShareSheet slate={dialog.slate} onClose={() => { setDialog(null); library.reload(); }} />}
      {dialog?.kind === "stop" && (
        <ConfirmDialog title={`Stop sharing ${dialog.row.title}?`} action="Stop sharing" marker="data-drive-stop-confirm"
          body={`${whoLoses(dialog.row)} access right away, and the link stops working.`}
          onConfirm={async () => {
            const workspace = dialog.row.workspace;

            if (workspace === undefined) throw new Error("this share names no workspace");
            await revokeShare({ workspace, share: dialog.row.share });
            library.reload();
          }}
          onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "fork" && dialog.row.kind === "live" && (
        <ForkDialog live={{ share: dialog.row.share, workspace: dialog.row.workspace ?? "" }} title={dialog.row.title} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "fork" && dialog.row.kind === "blueprint" && (
        <ForkDialog blueprint={dialog.row.id} title={dialog.row.title} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
