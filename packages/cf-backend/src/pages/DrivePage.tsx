/**
 * The Drive — the owner's one tenant, the same tree every workspace mounts at
 * `/shared`. One folder at a time under a breadcrumb, each entry on the
 * roster's 56px line with its kind, size and age; the actions a file manager
 * owes — upload, new folder, rename, delete, download — and the two that make
 * this Drive a skills library: "Mark as skill" on any folder that already is
 * one, "Add skill" from a pasted SKILL.md or a picked folder or zip.
 *
 * The URL is the folder: `/shared/projects/ops` lists `/projects/ops` on the
 * tenant, so a folder is a link a reader can hand on. `/shared/blueprints`
 * is the one folder whose contents are not bytes: it draws the shared library.
 */
import { startTransition, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Button, Loader } from "@cloudflare/kumo";
import {
  ArrowSquareOutIcon, BookOpenIcon, CaretRightIcon, DownloadSimpleIcon, FileIcon, FileZipIcon, FolderIcon,
  FolderPlusIcon, FolderSimpleIcon, HardDrivesIcon, LinkSimpleIcon, PencilSimpleIcon, TrashIcon, UploadSimpleIcon,
  WarningIcon, XIcon,
} from "@phosphor-icons/react";
import { DRIVE_BLUEPRINTS_DIR, DRIVE_SKILLS_DIR, formatBytes, shortAge, type DriveEntry, type MarkedSkill } from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import {
  addSkillArchive, addSkillFolder, addSkillText, deleteEntry, downloadUrl, listDrive, makeFolder, markAsSkill, renameEntry,
  uploadFile, uploadFolder, uploadZip, type PickedFile,
} from "@/lib/drive-api";
import { useAsyncResource, lastValue } from "@/hooks/use-async-resource";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { Modal } from "@/components/ui/Modal";
import { FilledButton } from "@/components/ui/FilledButton";
import { inputCls } from "@/components/ui/form";
import { SharedLibraryView, type SharedLibraryProps } from "@/components/shared/SharedLibrary";

/** The Drive's URL for a tenant folder. */
function folderHref(path: string): string {
  return path === "/" ? "/shared" : `/shared${path}`;
}

function childPath(folder: string, name: string): string {
  return folder === "/" ? `/${name}` : `${folder}/${name}`;
}

/** The browser's relative path for a picked folder entry, or its name. */
function relativePathOf(file: File): string {
  return file.webkitRelativePath === "" ? file.name : file.webkitRelativePath;
}

function picked(files: FileList | null): PickedFile[] {
  return [...(files ?? [])].map((file) => ({ path: relativePathOf(file), file }));
}

/** The name a picked folder was chosen by: the first segment every entry shares. */
function pickedFolderName(files: readonly PickedFile[]): string | null {
  const first = files[0]?.path.split("/")[0];

  return first === undefined || first === files[0]?.path ? null : first;
}

function Breadcrumbs({ path }: { path: string }) {
  const segments = path === "/" ? [] : path.slice(1).split("/");

  return (
    <nav aria-label="Folder" className="flex min-w-0 flex-wrap items-center gap-1 p-row-text">
      <Link to={folderHref("/")} data-drive-crumb className={`shrink-0 ${segments.length === 0 ? "p-text font-medium" : "p-text-3 hover:p-text"}`}>Drive</Link>
      {segments.map((segment, index) => (
        <span key={index} className="flex min-w-0 items-center gap-1">
          <CaretRightIcon size={11} className="shrink-0 p-text-4" />
          <Link to={folderHref(`/${segments.slice(0, index + 1).join("/")}`)} data-drive-crumb
            className={`truncate ${index === segments.length - 1 ? "p-text font-medium" : "p-text-3 hover:p-text"}`}>{segment}</Link>
        </span>
      ))}
    </nav>
  );
}

/** A dialog that asks for one name and commits it. */
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

function DeleteDialog({ entry, onConfirm, onClose }: { entry: DriveEntry; onConfirm: () => Promise<void>; onClose: () => void }) {
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
    <Modal title={`Delete ${entry.kind === "folder" ? "folder" : entry.kind === "symlink" ? "link" : "file"}`}
      icon={<TrashIcon size={18} className="p-danger" />} onClose={onClose} busy={busy}
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <FilledButton danger data-drive-delete-confirm onClick={confirm} disabled={busy}>{busy ? "Deleting…" : "Delete"}</FilledButton>
      </>}>
      <p className="text-xs p-text-2 leading-relaxed">
        Delete <span className="font-medium p-text">{entry.name}</span>
        {entry.kind === "folder" ? " and everything inside it" : entry.kind === "symlink" ? " (the folder it points at stays)" : ""}?
        This cannot be undone.
      </p>
      {error !== null && <div role="alert" className="p-notice-danger rounded-md px-3 py-2 text-xs">{error}</div>}
    </Modal>
  );
}

/** Add a skill: the text of one SKILL.md, or a picked folder or zip. */
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
    <Modal title="Add skill" icon={<BookOpenIcon size={18} className="p-accent" />} onClose={onClose} busy={busy} maxWidthClass="max-w-lg"
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <FilledButton data-drive-add-skill-commit onClick={() => run(() => addSkillText(text))} disabled={busy || text.trim() === ""}>
          {busy ? "Adding…" : "Add from text"}
        </FilledButton>
      </>}>
      <div className="space-y-3">
        <p className="text-xs p-text-2 leading-relaxed">
          A skill is a folder with a <span className="font-mono p-text">SKILL.md</span>: front matter naming it, then the
          instructions. It lands under <span className="font-mono p-text">{DRIVE_SKILLS_DIR}</span> and every workspace reads it from
          its next turn.
        </p>
        <textarea data-drive-skill-text value={text} onChange={(event) => setText(event.target.value)} rows={9} spellCheck={false}
          placeholder={"---\nname: deploy\ndescription: Ship the current branch\n---\nSteps…"}
          aria-label="SKILL.md" className={`${inputCls} font-mono text-xs leading-relaxed`} />
        <div className="flex flex-wrap items-center gap-2">
          <span className="p-meta p-text-3">or pick</span>
          <button type="button" className="p-btn-quiet inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs" disabled={busy}
            onClick={() => folderInput.current?.click()}><FolderSimpleIcon size={13} /> a folder</button>
          <button type="button" className="p-btn-quiet inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs" disabled={busy}
            onClick={() => zipInput.current?.click()}><FileZipIcon size={13} /> a zip</button>
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

const ROW_ACTION = "rounded-md p-1.5 p-text-3 transition-colors hover:bg-[var(--c-elevated)] hover:p-text disabled:opacity-40 disabled:hover:p-text-3 disabled:hover:bg-transparent";

function EntryIcon({ entry }: { entry: DriveEntry }) {
  if (entry.skill) return <BookOpenIcon size={18} weight="fill" className="shrink-0 p-accent" />;

  if (entry.kind === "symlink") return <LinkSimpleIcon size={18} className="shrink-0 p-info" />;

  if (entry.kind === "folder") return <FolderIcon size={18} weight="fill" className="shrink-0 p-info" />;

  return <FileIcon size={18} className="shrink-0 p-text-3" />;
}

function DriveRow({ folder, entry, first, onRename, onDelete, onMark }: {
  folder: string; entry: DriveEntry; first: boolean;
  onRename: () => void; onDelete: () => void; onMark: () => void;
}) {
  const path = childPath(folder, entry.name);
  const reserved = folder === "/" && (path === DRIVE_SKILLS_DIR || path === DRIVE_BLUEPRINTS_DIR);
  const isFolder = entry.kind !== "file";
  const inSkills = path.startsWith(`${DRIVE_SKILLS_DIR}/`);
  const age = entry.mtimeMs > 0 ? shortAge(entry.mtimeMs) : null;
  const meta = entry.kind === "file" ? formatBytes(entry.size) : entry.kind === "symlink" ? `→ ${entry.target ?? ""}` : "folder";

  return (
    <div data-drive-entry={entry.name} data-drive-kind={entry.kind} data-drive-skill={entry.skill ? "true" : "false"}
      className={`group flex h-14 items-center gap-3 px-4 transition-colors p-card-hover ${first ? "" : "border-t p-border"}`}>
      {isFolder ? (
        <Link to={folderHref(entry.kind === "symlink" && entry.target !== undefined ? entry.target : path)}
          className="flex min-w-0 flex-1 items-center gap-3 focus-visible:outline-none">
          <EntryIcon entry={entry} />
          <span className="min-w-0 flex-1">
            <span className="block truncate p-row-text font-medium p-text">{entry.name}</span>
            <span className="block truncate p-meta p-text-3">{meta}</span>
          </span>
        </Link>
      ) : (
        <a href={downloadUrl(path).replace("&download=1", "")} target="_blank" rel="noopener"
          className="flex min-w-0 flex-1 items-center gap-3 focus-visible:outline-none">
          <EntryIcon entry={entry} />
          <span className="min-w-0 flex-1">
            <span className="block truncate p-row-text font-medium p-text">{entry.name}</span>
            <span className="block truncate p-meta p-text-3">{meta}</span>
          </span>
        </a>
      )}
      {entry.skill && <span data-drive-skill-badge className="p-badge-success hidden rounded px-1.5 py-0.5 text-[10px] sm:inline">skill</span>}
      {reserved && <span className="p-badge-neutral hidden rounded px-1.5 py-0.5 text-[10px] sm:inline">reserved</span>}
      {age !== null && <span className="hidden shrink-0 p-meta p-text-4 tabular-nums sm:inline">{age}</span>}
      <span className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100">
        {isFolder && !inSkills && !reserved && (
          <button type="button" data-drive-mark onClick={onMark} disabled={!entry.skill} className={ROW_ACTION}
            title={entry.skill ? `Mark ${entry.name} as a skill` : entry.skillProblem ?? "Not a skill"}
            aria-label={`Mark ${entry.name} as skill`}>
            <BookOpenIcon size={14} />
          </button>
        )}
        <a href={downloadUrl(path)} data-drive-download className={ROW_ACTION} title={`Download ${entry.name}`} aria-label={`Download ${entry.name}`}>
          <DownloadSimpleIcon size={14} />
        </a>
        <button type="button" data-drive-rename onClick={onRename} disabled={reserved} className={ROW_ACTION}
          title={reserved ? "Reserved folders keep their name" : `Rename ${entry.name}`} aria-label={`Rename ${entry.name}`}>
          <PencilSimpleIcon size={14} />
        </button>
        <button type="button" data-drive-delete onClick={onDelete} disabled={reserved} className={`${ROW_ACTION} hover:p-danger`}
          title={reserved ? "Reserved folders stay" : `Delete ${entry.name}`} aria-label={`Delete ${entry.name}`}>
          <TrashIcon size={14} />
        </button>
      </span>
    </div>
  );
}

interface Transfer {
  readonly id: number;
  readonly name: string;
  readonly status: "uploading" | "failed";
  readonly error?: string;
}

/** The upload controls: files, a folder, or a zip to unpack, each its own picker. */
function UploadMenu({ disabled, onFiles, onFolder, onZip }: {
  disabled: boolean;
  onFiles: (files: File[]) => void; onFolder: (files: PickedFile[]) => void; onZip: (file: File) => void;
}) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;

    const onClick = (event: MouseEvent) => {
      if (menu.current && event.target instanceof Node && !menu.current.contains(event.target)) setOpen(false);
    };

    document.addEventListener("click", onClick);

    return () => document.removeEventListener("click", onClick);
  }, [open]);

  const item = "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm p-card-hover";

  return (
    <div ref={menu} className="relative">
      <Button variant="secondary" size="sm" disabled={disabled} data-drive-upload aria-haspopup="menu" aria-expanded={open}
        icon={<UploadSimpleIcon size={13} />} onClick={() => setOpen((value) => !value)}>Upload</Button>
      {open && (
        <div role="menu" className="absolute right-0 z-10 mt-1 w-44 p-card border p-border p-1.5 p-shadow-menu">
          <button type="button" role="menuitem" data-drive-upload-files className={item} onClick={() => { setOpen(false); filesInput.current?.click(); }}>
            <FileIcon size={14} /> Files
          </button>
          <button type="button" role="menuitem" data-drive-upload-folder className={item} onClick={() => { setOpen(false); folderInput.current?.click(); }}>
            <FolderSimpleIcon size={14} /> Folder
          </button>
          <button type="button" role="menuitem" data-drive-upload-zip className={item} onClick={() => { setOpen(false); zipInput.current?.click(); }}>
            <FileZipIcon size={14} /> Zip, unpacked
          </button>
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
  | { kind: "add-skill" };

export default function DrivePage({ library }: { library?: SharedLibraryProps } = {}) {
  const splat = useParams()["*"] ?? "";
  const path = splat === "" ? "/" : `/${splat.replace(/\/+$/u, "")}`;
  const navigate = useNavigate();
  const load = useCallback(() => listDrive(path), [path]);
  const listing = useAsyncResource(load, undefined, path);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const nextTransfer = useRef(0);
  const isLibrary = path === DRIVE_BLUEPRINTS_DIR;

  useEffect(() => { setNotice(null); setDialog(null); }, [path]);

  /** One upload, shown while it runs and kept on failure with its reason. */
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

  const uploadPickedFolder = (files: PickedFile[]): void => {
    if (files.length === 0) return;
    transfer(pickedFolderName(files) ?? "folder", () => uploadFolder(path, files));
  };

  const unpackZip = (file: File): void => {
    transfer(file.name, () => uploadZip(childPath(path, file.name.replace(/\.zip$/iu, "")), file));
  };

  /** A change that lands, then the listing re-read to show it. */
  const act = async (work: () => Promise<void>): Promise<void> => {
    await work();
    listing.reload();
  };

  /** Mark one folder; a refusal is the page's notice, since no dialog is open. */
  const mark = (name: string): void => {
    startTransition(async () => {
      try {
        await act(async () => { await markAsSkill(childPath(path, name)); });
      } catch (cause) {
        setNotice(renderThrownChain({ cause }));
      }
    });
  };

  const afterSkillAdded = async (): Promise<void> => {
    listing.reload();

    if (path !== DRIVE_SKILLS_DIR) await navigate(folderHref(DRIVE_SKILLS_DIR));
  };

  const entries = lastValue(listing.resource)?.entries ?? [];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
        <header className="flex items-center gap-3">
          <HardDrivesIcon size={22} className="shrink-0 p-text-3" />
          <h1 className="p-display text-2xl">Drive</h1>
        </header>
        <p className="p-meta p-text-3 -mt-3">
          Every workspace you own sees this tree at <span className="font-mono p-text-2">/shared</span>. Folders under
          <span className="font-mono p-text-2"> {DRIVE_SKILLS_DIR}</span> are skills in all of them.
        </p>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <Breadcrumbs path={path} />
          {!isLibrary && (
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" size="sm" data-drive-new-folder icon={<FolderPlusIcon size={13} />} onClick={() => setDialog({ kind: "new-folder" })}>New folder</Button>
              <UploadMenu disabled={listing.resource.status === "loading"} onFiles={uploadFiles} onFolder={uploadPickedFolder} onZip={unpackZip} />
              <FilledButton className="h-8 px-3 text-sm" data-drive-add-skill onClick={() => setDialog({ kind: "add-skill" })}>
                <BookOpenIcon size={13} weight="bold" /> Add skill
              </FilledButton>
            </div>
          )}
        </div>

        {notice !== null && (
          <div role="alert" data-drive-notice className="p-notice-danger flex items-start gap-2 rounded-md px-3 py-2 text-xs">
            <WarningIcon size={13} className="mt-px shrink-0" />
            <span className="min-w-0 break-words">{notice}</span>
            <button type="button" onClick={() => setNotice(null)} className="ml-auto shrink-0 p-text-3 hover:p-text" aria-label="Dismiss"><XIcon size={12} /></button>
          </div>
        )}

        {isLibrary ? (
          <SharedLibraryView {...library} />
        ) : (
          <section aria-label="Folder contents" data-drive-list
            onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(event) => { event.preventDefault(); setDragOver(false); uploadFiles([...event.dataTransfer.files]); }}
            className={`overflow-hidden rounded-[14px] border p-surface transition-colors ${dragOver ? "border-[var(--c-accent)] border-dashed" : "p-border"}`}>
            {transfers.map((row) => (
              <div key={row.id} data-drive-transfer={row.status} className="flex h-10 items-center gap-2 border-b p-border px-4 text-xs">
                {row.status === "uploading"
                  ? <><Loader size="sm" /><span className="truncate p-text-2">{row.name}</span><span className="p-text-3">uploading…</span></>
                  : <><WarningIcon size={13} className="shrink-0 p-danger" /><span className="truncate p-text-2">{row.name}</span>
                    <span className="min-w-0 truncate p-danger" title={row.error}>{row.error}</span>
                    <button type="button" onClick={() => setTransfers((rows) => rows.filter((other) => other.id !== row.id))}
                      className="ml-auto shrink-0 p-text-3 hover:p-text" aria-label={`Dismiss ${row.name}`}><XIcon size={12} /></button></>}
              </div>
            ))}
            {listing.resource.status === "loading" && <div className="flex justify-center py-10"><Loader size="base" /></div>}
            {listing.resource.status === "error" && (
              <LoadFailure what="this folder" message={listing.resource.message} onRetry={listing.reload} className="px-4 py-3" />
            )}
            {listing.resource.status === "ready" && entries.length === 0 && (
              <div data-drive-empty className="px-5 py-10 text-center">
                <p className="p-row-text p-text-3">This folder is empty.</p>
                <p className="mt-1 p-meta p-text-4">Drop files here, or use Upload and New folder.</p>
              </div>
            )}
            {listing.resource.status !== "loading" && entries.map((entry, index) => (
              <DriveRow key={entry.name} folder={path} entry={entry} first={index === 0 && transfers.length === 0}
                onRename={() => setDialog({ kind: "rename", entry })}
                onDelete={() => setDialog({ kind: "delete", entry })}
                onMark={() => mark(entry.name)} />
            ))}
          </section>
        )}

        {!isLibrary && path === "/" && (
          <p className="p-meta p-text-4 flex items-center gap-1.5">
            <ArrowSquareOutIcon size={12} />
            <span>Blueprints shared with you live in <Link to={folderHref(DRIVE_BLUEPRINTS_DIR)} className="p-accent">blueprints</Link>.</span>
          </p>
        )}
      </div>

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
        <DeleteDialog entry={dialog.entry} onConfirm={() => act(() => deleteEntry(childPath(path, dialog.entry.name)))} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "add-skill" && (
        <AddSkillDialog onAdded={() => void afterSkillAdded()} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
