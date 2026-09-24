import { useRef, useState, type ReactNode } from "react";
import { CaretDownIcon, CheckIcon, FolderSimpleIcon } from "@phosphor-icons/react";
import { useCloseOnOutsideClick } from "@/hooks/use-close-on-outside-click";
import { changeBody, changeTotals, changeTree, type ChangeSet, type FileDiff } from "@kinu.run/core";
import { ChangeMark, count, Counts, fullTime, sinceLabel } from "./diff";

function Tag({ file }: { file: FileDiff }) {
  const body = changeBody(file);

  if (body.kind === "binary") return <span className="shrink-0 text-[11px] p-text-4">binary</span>;

  if (body.kind === "uncompared") return <span className="shrink-0 text-[11px] p-text-4">too large</span>;

  return <Counts added={file.added} removed={file.removed} />;
}

const INDENT = 14;

export function FileTree({ files, current, onOpen }: { files: readonly FileDiff[]; current: string | null; onOpen: (path: string) => void }) {
  return (
    <ul role="list" className="py-1.5" data-file-tree>
      {changeTree(files).map((row) => {
        const inset = { paddingLeft: `${String(14 + row.depth * INDENT)}px` };

        if (row.kind === "folder") {
          return (
            <li key={`d:${String(row.depth)}:${row.name}`} style={inset} className="flex h-7 items-center gap-1.5 pr-3.5 text-[12.5px] p-text-3" data-folder-row>
              <FolderSimpleIcon size={13} weight="fill" className="shrink-0 p-text-4 opacity-70" />
              <span className="min-w-0 truncate">{row.name}</span>
            </li>
          );
        }

        const selected = row.file.path === current;

        return (
          <li key={row.file.path}>
            <button type="button" onClick={() => onOpen(row.file.path)} style={inset} data-file-row={row.file.path} aria-current={selected ? "true" : undefined}
              className={`flex h-8 w-full items-center gap-2 pr-3.5 text-left transition-colors max-md:h-10 ${selected ? "bg-[var(--c-fill)] p-text" : "p-text-2 hover:bg-[var(--c-elevated)] hover:p-text"}`}>
              <ChangeMark status={row.file.status} />
              <span className={`min-w-0 flex-1 truncate p-row-text ${row.file.status === "removed" ? "line-through decoration-[color-mix(in_srgb,currentColor_45%,transparent)]" : ""}`}>
                {row.file.path.slice(row.file.path.lastIndexOf("/") + 1)}
              </span>
              <Tag file={row.file} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function Summary({ set }: { set: ChangeSet }) {
  const sum = changeTotals(set.files);

  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="truncate p-row-text font-medium p-text">
        {set.files.length === 0 ? "No changes" : `${count(set.files.length)} ${set.files.length === 1 ? "file" : "files"} changed`}
      </span>
      <Counts added={sum.added} removed={sum.removed} />
    </span>
  );
}

export function Since({ set, now }: { set: ChangeSet; now: number }) {
  if (set.mode === "git") return <span className="truncate">Uncommitted</span>;

  if (set.trackedSince === undefined) return null;

  return <span className="truncate" title={`Tracked since ${fullTime(set.trackedSince)}`}>Since {sinceLabel(set.trackedSince, now)}</span>;
}

function sourceNote(set: ChangeSet): string {
  if (set.error !== undefined) return "can't read";

  return `${count(set.files.length)} ${set.files.length === 1 ? "file" : "files"}`;
}

export function SourceMenu({ sets, source, initiallyOpen = false, onPick }: {
  sets: readonly ChangeSet[];
  source: string;
  initiallyOpen?: boolean;
  onPick: (source: string) => void;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const box = useRef<HTMLDivElement>(null);
  useCloseOnOutsideClick(open, box, () => setOpen(false));

  if (sets.length < 2) return null;

  return (
    <div ref={box} className="relative shrink-0">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-haspopup="menu" aria-expanded={open} data-source-menu
        className="flex items-center gap-1 rounded-md px-1.5 py-0.5 -mx-1.5 p-text-2 transition-colors hover:bg-[var(--c-elevated)] hover:p-text">
        {sets.find((set) => set.source === source)?.label}
        <CaretDownIcon size={10} />
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-7 z-30 w-56 p-card border p-border p-1 p-shadow-menu animate-fade-in">
          <p className="px-2.5 pb-1 pt-1.5 p-meta p-text-3">Show changes in</p>
          {sets.map((set) => (
            <button key={set.source} type="button" role="menuitemradio" aria-checked={set.source === source}
              onClick={() => { setOpen(false); onPick(set.source); }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left p-row-text p-text-2 transition-colors hover:bg-[var(--c-elevated)] hover:p-text">
              <span className="flex size-3.5 shrink-0 items-center justify-center p-accent">{set.source === source && <CheckIcon size={12} weight="bold" />}</span>
              <span className="min-w-0 flex-1 truncate">{set.label}</span>
              <span className={`shrink-0 p-meta ${set.error === undefined ? "p-text-3" : "p-warning"}`}>{sourceNote(set)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

export function IconButton({ label, onClick, disabled = false, children, className = "" }: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled}
      className={`flex size-7 shrink-0 items-center justify-center rounded-md p-text-3 transition-colors hover:bg-[var(--c-elevated)] hover:p-text disabled:opacity-35 disabled:hover:bg-transparent ${className}`}>
      {children}
    </button>
  );
}

export function MarkReviewed({ onClick, className = "" }: { onClick: () => void; className?: string }) {
  return (
    <button type="button" onClick={onClick} data-mark-reviewed
      className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border p-border px-2.5 text-xs font-medium p-text-2 transition-colors hover:border-[var(--c-border-strong)] hover:bg-[var(--c-elevated)] hover:p-text ${className}`}>
      <CheckIcon size={12} weight="bold" />
      Mark reviewed
    </button>
  );
}
