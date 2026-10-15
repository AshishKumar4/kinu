/** What adds to or changes the Drive: New, and the dialogs its menus open. */
import { Effect } from 'effect';
import { startTransition, useCallback, useRef, useState, type ReactNode } from "react";
import { Button } from "@cloudflare/kumo";
import {
  BookOpenIcon, FileArchiveIcon, FolderPlusIcon, FolderSimpleIcon, PencilSimpleIcon, PlusIcon, UploadSimpleIcon,
} from "@phosphor-icons/react";
import { joinDir, type DriveEntry, type MarkedSkill } from "@kinu.run/core";
import { showing, settle } from "@kinu.run/core/obs";
import {
  addSkillArchive, addSkillFolder, addSkillText, deleteEntry, makeFolder, renameEntry, type PickedFile,
} from "@/lib/drive-api";
import { leaveSlate, type DriveCard, type OwnedSlate } from "@/lib/shared-api";
import { useCloseOnOutsideClick } from "@/hooks/use-close-on-outside-click";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FilledButton } from "@/components/ui/FilledButton";
import { inputCls } from "@/components/ui/form";
import { ForkDialog } from "@/components/shared/ForkDialog";
import { RoomSheet } from "@/components/sharing/RoomSheet";
import { useWorkspaceRoster } from "@/hooks/use-workspace-roster";

function relativePathOf(file: File): string {
  return file.webkitRelativePath === "" ? file.name : file.webkitRelativePath;
}

function picked(files: FileList | null): PickedFile[] {
  return [...(files ?? [])].map((file) => ({ path: relativePathOf(file), file }));
}

export function pickedFolderName(files: readonly PickedFile[]): string | null {
  const first = files[0]?.path.split("/")[0];

  return first === undefined || first === files[0]?.path ? null : first;
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
    startTransition(() => settle(Effect.catchCause(Effect.gen(function* () {
      yield* Effect.promise(async () => onCommit(name));
      onClose();
    }), showing((chain) => {
      setError(chain);
      setBusy(false);
    }))));
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
    startTransition(() => settle(Effect.catchCause(Effect.gen(function* () {
      yield* Effect.promise(async () => work());
      onAdded();
      onClose();
    }), showing((chain) => {
      setError(chain);
      setBusy(false);
    }))));
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

const NEW_BUTTON = "h-8 gap-1.5 px-3 text-sm max-sm:!size-9 max-sm:rounded-full max-sm:!p-0";

interface NewProps {
  readonly onFiles: (files: File[]) => void;
  readonly onFolder: (files: PickedFile[]) => void;
  readonly onZip: (file: File) => void;
  readonly onNewFolder: () => void;
  readonly onNewSkill: () => void;
}

function NewMenu({ onFiles, onFolder, onZip, onNewFolder, onNewSkill }: NewProps) {
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

/** New, or New skill in Skills: the page's one action, in one place. */
export function PrimaryAction({ inSkills, ...rest }: NewProps & { readonly inSkills: boolean }) {
  if (!inSkills) return <NewMenu {...rest} />;

  return (
    <FilledButton className={NEW_BUTTON} aria-label="New skill" data-drive-add-skill onClick={rest.onNewSkill}>
      <PlusIcon size={14} weight="bold" /><span className="max-sm:hidden">New skill</span>
    </FilledButton>
  );
}

export type DriveDialogState =
  | { kind: "new-folder" }
  | { kind: "rename"; entry: DriveEntry }
  | { kind: "delete"; entry: DriveEntry }
  | { kind: "add-skill" }
  | { kind: "share"; slate: OwnedSlate }
  | { kind: "leave"; card: DriveCard }
  | { kind: "fork"; card: DriveCard };

export function DriveDialog({ dialog, folder, onClose, onListingChanged, onSharesChanged, onSkillAdded }: {
  dialog: DriveDialogState;
  folder: string;
  onClose: () => void;
  onListingChanged: () => void;
  onSharesChanged: () => void;
  onSkillAdded: () => void;
}) {
  const { create } = useWorkspaceRoster();

  const act = async (work: () => Promise<void>): Promise<void> => {
    await work();
    onListingChanged();
  };

  switch (dialog.kind) {
    case "new-folder":
      return (
        <NameDialog title="New folder" icon={<FolderPlusIcon size={18} className="p-info" />} initial="" label="Folder name" action="Create"
          onCommit={(name) => act(() => makeFolder(joinDir(folder, name)))} onClose={onClose} />
      );
    case "rename":
      return (
        <NameDialog title={`Rename ${dialog.entry.name}`} icon={<PencilSimpleIcon size={18} className="p-text-3" />}
          initial={dialog.entry.name} label="New name" action="Rename"
          onCommit={(name) => act(() => renameEntry(joinDir(folder, dialog.entry.name), joinDir(folder, name)))} onClose={onClose} />
      );
    case "delete":
      return (
        <ConfirmDialog title={`Delete ${dialog.entry.name}?`} action="Delete" marker="data-drive-delete-confirm" maxWidthClass="max-w-sm"
          onConfirm={() => act(() => deleteEntry(joinDir(folder, dialog.entry.name)))} onClose={onClose}>
          <p className="p-row-text p-text-2">This deletes <span className="font-medium p-text">{dialog.entry.name}</span>{DELETE_ALSO[dialog.entry.kind]}. It cannot be undone.</p>
        </ConfirmDialog>
      );
    case "add-skill":
      return <AddSkillDialog onClose={onClose} onAdded={onSkillAdded} />;
    case "share":
      return <RoomSheet workspace={dialog.slate.workspace} slate={dialog.slate.id} title={dialog.slate.title} onClose={() => { onClose(); onSharesChanged(); }} />;
    case "leave":
      return (
        <ConfirmDialog title={dialog.card.relation === "shared" ? `Leave ${dialog.card.title}?` : `Remove ${dialog.card.title}?`}
          action={dialog.card.relation === "shared" ? "Leave" : "Remove"} marker="data-drive-leave-confirm" maxWidthClass="max-w-sm"
          onConfirm={() => settle(Effect.gen(function* () {
            yield* Effect.promise(async () => leaveSlate({ workspace: dialog.card.workspace, slate: dialog.card.slate }));
            onSharesChanged();
          }))}
          onClose={onClose}>
          <p className="p-row-text p-text-2">{dialog.card.relation === "shared"
            ? "It leaves your Drive, and you stop being able to open it until it's shared with you again."
            : "It leaves your Drive. Its link still opens it."}</p>
        </ConfirmDialog>
      );
    case "fork":
      return <ForkDialog room={{ workspace: dialog.card.workspace, slate: dialog.card.slate }} title={dialog.card.title} mode="fork" onClose={onClose} create={create} />;
  }
}
