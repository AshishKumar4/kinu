/** What adds to or changes the Drive: New, and the dialogs its menus open. */
import { startTransition, useCallback, useRef, useState, type ReactNode } from "react";
import { Button } from "@cloudflare/kumo";
import {
  BookOpenIcon, FileArchiveIcon, FolderPlusIcon, FolderSimpleIcon, PencilSimpleIcon, PlusIcon, UploadSimpleIcon,
} from "@phosphor-icons/react";
import type { DriveEntry, MarkedSkill, OwnedSlate, SharedRow } from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import {
  addSkillArchive, addSkillFolder, addSkillText, deleteEntry, makeFolder, renameEntry, type PickedFile,
} from "@/lib/drive-api";
import { revokeShare } from "@/lib/shared-api";
import { useCloseOnOutsideClick } from "@/hooks/use-close-on-outside-click";
import { useWorkspaceRpc } from "@/hooks/use-kinu";
import { Modal } from "@/components/ui/Modal";
import { FilledButton } from "@/components/ui/FilledButton";
import { inputCls } from "@/components/ui/form";
import { ForkDialog } from "@/components/shared/ForkDialog";
import { ShareSlateDialog } from "@/components/slates/ShareSlateDialog";

export function childPath(folder: string, name: string): string {
  return folder === "/" ? `/${name}` : `${folder}/${name}`;
}

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

/** The share sheet talks to the slate's own workspace. */
function DriveShareSheet({ slate, onClose }: { slate: OwnedSlate; onClose: () => void }) {
  const { rpc } = useWorkspaceRpc(slate.workspace);

  return <ShareSlateDialog workspace={slate.workspace} slate={slate.id} title={slate.title} rpc={rpc} onClose={onClose} />;
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

/** New, or New skill in the Skills folder: the page's one action, always in the same place. */
export function PrimaryAction({ inSkills, ...rest }: NewProps & { readonly inSkills: boolean }) {
  if (!inSkills) return <NewMenu {...rest} />;

  return (
    <FilledButton className={NEW_BUTTON} aria-label="New skill" data-drive-add-skill onClick={rest.onNewSkill}>
      <PlusIcon size={14} weight="bold" /><span className="max-sm:hidden">New skill</span>
    </FilledButton>
  );
}

function whoLoses(row: SharedRow): string {
  const users = row.users ?? [];

  if (row.kind === "blueprint" || row.visibility === "public" || users.length === 0) return "Everyone with the link loses";

  return `${users.join(", ")} ${users.length === 1 ? "loses" : "lose"}`;
}

export type DriveDialogState =
  | { kind: "new-folder" }
  | { kind: "rename"; entry: DriveEntry }
  | { kind: "delete"; entry: DriveEntry }
  | { kind: "add-skill" }
  | { kind: "share"; slate: OwnedSlate }
  | { kind: "stop"; row: SharedRow }
  | { kind: "fork"; row: SharedRow };

export function DriveDialog({ dialog, folder, onClose, onListingChanged, onSharesChanged, onSkillAdded }: {
  dialog: DriveDialogState;
  folder: string;
  onClose: () => void;
  onListingChanged: () => void;
  onSharesChanged: () => void;
  onSkillAdded: () => void;
}) {
  const act = async (work: () => Promise<void>): Promise<void> => {
    await work();
    onListingChanged();
  };

  switch (dialog.kind) {
    case "new-folder":
      return (
        <NameDialog title="New folder" icon={<FolderPlusIcon size={18} className="p-info" />} initial="" label="Folder name" action="Create"
          onCommit={(name) => act(() => makeFolder(childPath(folder, name)))} onClose={onClose} />
      );
    case "rename":
      return (
        <NameDialog title={`Rename ${dialog.entry.name}`} icon={<PencilSimpleIcon size={18} className="p-text-3" />}
          initial={dialog.entry.name} label="New name" action="Rename"
          onCommit={(name) => act(() => renameEntry(childPath(folder, dialog.entry.name), childPath(folder, name)))} onClose={onClose} />
      );
    case "delete":
      return (
        <ConfirmDialog title={`Delete ${dialog.entry.name}?`} action="Delete" marker="data-drive-delete-confirm"
          body={<>This deletes <span className="font-medium p-text">{dialog.entry.name}</span>{DELETE_ALSO[dialog.entry.kind]}. It cannot be undone.</>}
          onConfirm={() => act(() => deleteEntry(childPath(folder, dialog.entry.name)))} onClose={onClose} />
      );
    case "add-skill":
      return <AddSkillDialog onClose={onClose} onAdded={onSkillAdded} />;
    case "share":
      return <DriveShareSheet slate={dialog.slate} onClose={() => { onClose(); onSharesChanged(); }} />;
    case "stop":
      return (
        <ConfirmDialog title={`Stop sharing ${dialog.row.title}?`} action="Stop sharing" marker="data-drive-stop-confirm"
          body={`${whoLoses(dialog.row)} access right away, and the link stops working.`}
          onConfirm={async () => {
            const workspace = dialog.row.workspace;

            if (workspace === undefined) throw new Error("this share names no workspace");
            await revokeShare({ workspace, share: dialog.row.share });
            onSharesChanged();
          }}
          onClose={onClose} />
      );
    case "fork":
      return dialog.row.kind === "live"
        ? <ForkDialog live={{ share: dialog.row.share, workspace: dialog.row.workspace ?? "" }} title={dialog.row.title} onClose={onClose} />
        : <ForkDialog blueprint={dialog.row.id} title={dialog.row.title} onClose={onClose} />;
  }
}
