import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowSquareOutIcon, BookOpenIcon, CaretRightIcon, CopyIcon, DownloadSimpleIcon,
  FileArchiveIcon, FolderPlusIcon, FolderSimpleIcon, GitForkIcon, HardDrivesIcon, PencilSimpleIcon, PlusIcon,
  ProhibitIcon, ShareNetworkIcon, SquaresFourIcon, TrashIcon, UploadSimpleIcon, XIcon,
} from "@phosphor-icons/react";
import * as v from "valibot";
import { FilledButton } from "@/components/ui/FilledButton";
import { useCloseOnOutsideClick } from "@/hooks/use-close-on-outside-click";
import { PreviewPicture, SkillPicture, type Preview } from "./previews";
import {
  fileIcon, FOLDER_ICON, FolderTile, GRID, SKILLS_ICON, SLATE_ICON, Tile, type MenuItem,
} from "@/components/drive/DriveTiles";
import { AccessGlyph, KIND, LIST, type Access, type Person, type ShareKind } from "./tiles";
import { namedPeople, ShareDialog, StopSharingDialog, type ReachGroup, type SharePane, type ShareSubject } from "./ShareDialog";

export interface SlateItem {
  readonly id: string;
  readonly title: string;
  readonly workspace: string;
  readonly workspaceTitle: string;
  readonly updated: string;
  readonly preview: Preview;
  readonly access?: Access;
  readonly reach?: readonly ReachGroup[];
  readonly keyAt?: string;
}

export interface ReceivedItem {
  readonly id: string;
  readonly kind: ShareKind;
  readonly title: string;
  readonly from: Person;
  readonly when: string;
  readonly unseen: boolean;
  readonly preview: Preview;
}

export interface GivenItem {
  readonly id: string;
  readonly kind: ShareKind;
  readonly title: string;
  readonly access: Access;
  readonly preview: Preview;
  readonly status?: string;
}

export type DriveEntry =
  | { readonly kind: "folder"; readonly name: string }
  | { readonly kind: "file"; readonly name: string; readonly size: string; readonly updated: string; readonly preview: Preview }
  | { readonly kind: "skill"; readonly name: string; readonly description: string; readonly steps: readonly string[]; readonly updated: string };

export interface DriveData {
  readonly me: Person;
  readonly slates: readonly SlateItem[];
  readonly received: readonly ReceivedItem[];
  readonly given: readonly GivenItem[];
  readonly folders: Readonly<Record<string, readonly DriveEntry[]>>;
}

export type Dialog =
  | { readonly kind: "share"; readonly subject: ShareSubject; readonly pane: SharePane; readonly accessOpen?: boolean }
  | { readonly kind: "stop"; readonly title: string; readonly who: string };

export type DriveTab = "mine" | "shared";

export const SKILLS_FOLDER = "/skills";

const TAB_LABEL: Record<DriveTab, string> = { mine: "My stuff", shared: "Shared" };

const TAB_HREF: Record<DriveTab, string> = { mine: "/drive", shared: "/shared" };

const SHARE_PANE: Record<ShareKind, SharePane> = { live: "live", blueprint: "blueprint", workspace: "workspace" };

const ChosenState = v.object({ chosen: v.literal(true) });

function entriesOf(data: DriveData, folder: string): readonly DriveEntry[] {
  const entries = data.folders[folder] ?? [];

  if (folder !== "/") return entries;

  const skills = data.folders[SKILLS_FOLDER] ?? [];

  return entries.filter((entry) => !(entry.kind === "folder" && entry.name === "skills" && skills.length === 0));
}

function blueprintsOf(data: DriveData): readonly GivenItem[] {
  return data.given.filter((item) => item.kind === "blueprint");
}

function mineIsEmpty(data: DriveData): boolean {
  return data.slates.length === 0 && blueprintsOf(data).length === 0 && entriesOf(data, "/").length === 0;
}

function sharesAnything(data: DriveData): boolean {
  return data.received.length + data.given.length > 0;
}

function joinPath(folder: string, name: string): string {
  return folder === "/" ? `/${name}` : `${folder}/${name}`;
}

function folderLabel(path: string): string {
  if (path === SKILLS_FOLDER) return "Skills";

  return path.split("/").at(-1) ?? path;
}

function folderHref(path: string): string {
  return path === "/" ? "/drive" : `/drive${path}`;
}

function accessLabel(access: Access): string {
  if (access.kind === "link") return "Anyone with the link";

  if (access.kind === "private") return "Only you";

  return access.people.length === 1 ? access.people[0]?.name ?? "" : `${String(access.people.length)} people`;
}

function whoLoses(access: Access): string {
  if (access.kind === "link") return "Everyone with the link";

  return LIST.format(namedPeople(access).map((person) => person.name));
}

export function slateSubject(slate: SlateItem, owner: Person): ShareSubject {
  return {
    kind: "slate", title: slate.title, owner, access: slate.access ?? { kind: "people", people: [] },
    reach: slate.reach ?? [], keyAt: slate.keyAt,
  };
}

function NewDot() {
  return <span className="size-1.5 shrink-0 rounded-full p-dot-accent" title="Something new" />;
}

function TabStrip({ tab, unseen }: { tab: DriveTab; unseen: boolean }) {
  return (
    <nav aria-label="Drive" className="flex w-fit items-center gap-0.5 rounded-lg p-recessed p-0.5">
      {(["mine", "shared"] as const).map((each) => {
        const selected = each === tab;

        return (
          <Link key={each} to={TAB_HREF[each]} state={{ chosen: true }} aria-current={selected ? "page" : undefined}
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-3.5 py-1.5 p-t-control${selected ? " p-surface p-text shadow-[0_1px_2px_var(--c-shadow-drop)]" : " p-text-3 hover:p-text"}`}>
            {TAB_LABEL[each]}
            {each === "shared" && unseen && !selected && <NewDot />}
          </Link>
        );
      })}
    </nav>
  );
}

function NewMenu({ onPick, compact }: { onPick: (what: string) => void; compact: boolean }) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useCloseOnOutsideClick(open, menu, () => setOpen(false));

  const items: { label: string; icon: ReactNode; apart?: boolean }[] = [
    { label: "Upload files", icon: <UploadSimpleIcon size={15} /> },
    { label: "Upload a folder", icon: <FolderSimpleIcon size={15} /> },
    { label: "Unpack a .zip", icon: <FileArchiveIcon size={15} /> },
    { label: "New folder", icon: <FolderPlusIcon size={15} />, apart: true },
    { label: "New skill", icon: <BookOpenIcon size={15} /> },
  ];

  return (
    <div ref={menu} className="relative">
      <FilledButton className={compact ? "!size-9 rounded-full !p-0" : "h-8 gap-1.5 px-3 text-sm"} aria-label="New" onClick={() => setOpen((value) => !value)}>
        <PlusIcon size={compact ? 16 : 13} weight="bold" />{!compact && "New"}
      </FilledButton>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-52 p-card border p-border p-1.5 p-shadow-menu animate-fade-in">
          {items.map((item) => (
            <div key={item.label}>
              {item.apart === true && <div className="mx-1 my-1.5 border-t p-border" />}
              <button type="button" role="menuitem" onClick={() => { setOpen(false); onPick(item.label); }}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm p-text transition-colors hover:bg-[var(--c-elevated)]">
                <span className="flex shrink-0 p-text-3">{item.icon}</span>{item.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Crumbs({ folder }: { folder: string }) {
  const parts = folder.split("/").filter((part) => part !== "");

  return (
    <nav aria-label="Folder" className="flex min-w-0 items-center gap-1.5">
      <Link to={folderHref("/")} state={{ chosen: true }} className="shrink-0 p-text-3 transition-colors hover:p-text">My stuff</Link>
      {parts.map((_, index) => {
        const path = `/${parts.slice(0, index + 1).join("/")}`;
        const last = index === parts.length - 1;

        return (
          <span key={path} className="flex min-w-0 items-center gap-1.5">
            <CaretRightIcon size={12} className="shrink-0 p-text-4" />
            {last
              ? <span className="truncate p-text">{folderLabel(path)}</span>
              : <Link to={folderHref(path)} className="truncate p-text-3 transition-colors hover:p-text">{folderLabel(path)}</Link>}
          </span>
        );
      })}
    </nav>
  );
}

function EmptyState({ icon, title, body }: { icon: ReactNode; title: string; body: ReactNode }) {
  return (
    <div data-design-empty className="flex flex-col items-center px-6 py-16 text-center sm:py-24">
      <span className="flex size-14 items-center justify-center rounded-2xl p-text-3 bg-[color-mix(in_srgb,var(--c-text)_7%,transparent)]">{icon}</span>
      <h2 className="mt-5 p-heading text-[19px] p-text">{title}</h2>
      <p className="mt-2 max-w-[26rem] p-row-text p-text-3">{body}</p>
    </div>
  );
}

function Section({ label, titled = true, children }: { label: string; titled?: boolean; children: ReactNode }) {
  return (
    <section aria-label={label}>
      {titled && <h2 className="mb-2.5 p-row-text font-medium p-text-2">{label}</h2>}
      {children}
    </section>
  );
}

function entryMenu(entry: DriveEntry, onOpen: (what: string) => void, reserved: boolean): MenuItem[] {
  const items: MenuItem[] = [
    { label: entry.kind === "folder" ? "Download as .zip" : "Download", icon: <DownloadSimpleIcon size={15} />, onSelect: () => onOpen("Downloads it.") },
  ];

  if (reserved) return items;

  return [
    ...items,
    { label: "Rename", icon: <PencilSimpleIcon size={15} />, onSelect: () => onOpen("Renames it in place.") },
    { label: "Delete", icon: <TrashIcon size={15} />, danger: true, apart: true, onSelect: () => onOpen("Asks first, then deletes it.") },
  ];
}

function FileDrawer({ entry, onClose }: { entry: Extract<DriveEntry, { kind: "file" }>; onClose: () => void }) {
  return (
    <>
      <div aria-hidden="true" className="p-scrim fixed inset-0 z-40" onClick={onClose} />
      <aside aria-label={entry.name} className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l p-border p-bg p-shadow-overlay animate-fade-in sm:w-[min(640px,92vw)]">
        <div className="flex shrink-0 items-center gap-2 border-b p-border px-3 py-2">
          <span className="flex shrink-0 p-text-3">{fileIcon(entry.name)}</span>
          <span className="truncate font-mono text-xs p-text">{entry.name}</span>
          <span className="shrink-0 p-meta p-text-4">{entry.size}</span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button type="button" className="flex items-center gap-1 p-1 p-t-control p-text-2 hover:p-text"><DownloadSimpleIcon size={12} />Download</button>
            <button type="button" onClick={onClose} aria-label="Close preview" className="p-1 p-text-3 hover:p-text"><XIcon size={13} /></button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-5">
          <div className="relative mx-auto aspect-[16/10] w-full max-w-[560px] overflow-hidden rounded-lg border p-border">
            <PreviewPicture preview={entry.preview} />
          </div>
        </div>
      </aside>
    </>
  );
}

function MyStuff({ data, folder, onOpen, onShare, menuFor }: {
  data: DriveData;
  folder: string;
  onOpen: (what: string) => void;
  onShare: (subject: ShareSubject) => void;
  menuFor: string | null;
}) {
  const [search, setSearch] = useSearchParams();
  const entries = entriesOf(data, folder);
  const folders = entries.filter((entry) => entry.kind === "folder");
  const rest = entries.filter((entry) => entry.kind !== "folder");
  const root = folder === "/";
  const slates = root ? data.slates : [];
  const blueprints = root ? blueprintsOf(data) : [];
  const opened = rest.find((entry) => entry.kind === "file" && entry.name === search.get("file"));

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

  if (entries.length === 0 && slates.length === 0 && blueprints.length === 0) {
    return root
      ? <EmptyState icon={<FolderSimpleIcon size={26} />} title="Nothing here yet" body="Drop files here, or use New. Slates your workspaces build show up here too." />
      : <EmptyState icon={<FolderSimpleIcon size={26} />} title="This folder is empty" body="Drop files here, or use New." />;
  }

  const titled = [slates, blueprints, folders, rest].filter((group) => group.length > 0).length > 1;

  return (
    <div className="space-y-8">
      {slates.length > 0 && (
        <Section label="Slates" titled={titled}>
          <ul className={GRID}>
            {slates.map((slate: SlateItem) => (
              <Tile key={slate.id} title={slate.title} picture={<PreviewPicture preview={slate.preview} />} icon={SLATE_ICON}
                onOpen={() => onOpen(`Opens ${slate.title} in ${slate.workspaceTitle}.`)} menuOpen={menuFor === slate.id}
                meta={<><span className="truncate">{slate.workspaceTitle}</span><AccessGlyph access={slate.access} /></>}
                menu={[
                  { label: "Open", icon: <ArrowSquareOutIcon size={15} />, onSelect: () => onOpen(`Opens ${slate.title} in ${slate.workspaceTitle}.`) },
                  { label: "Share…", icon: <ShareNetworkIcon size={15} />, onSelect: () => onShare(slateSubject(slate, data.me)) },
                  { label: "Go to workspace", icon: <SquaresFourIcon size={15} />, onSelect: () => onOpen(`Opens ${slate.workspaceTitle}.`) },
                ]} />
            ))}
          </ul>
        </Section>
      )}
      {blueprints.length > 0 && (
        <Section label="Blueprints" titled={titled}>
          <ul className={GRID}>
            {blueprints.map((item) => (
              <Tile key={item.id} title={item.title} picture={<PreviewPicture preview={item.preview} />} icon={KIND.blueprint.icon}
                onOpen={() => onOpen(`Opens the ${item.title} blueprint page.`)}
                meta={<span className="truncate">{accessLabel(item.access)}</span>}
                menu={[
                  { label: "Open", icon: <ArrowSquareOutIcon size={15} />, onSelect: () => onOpen(`Opens the ${item.title} blueprint page.`) },
                  { label: "Copy link", icon: <CopyIcon size={15} />, onSelect: () => onOpen("Copies the link.") },
                ]} />
            ))}
          </ul>
        </Section>
      )}
      {folders.length > 0 && (
        <Section label="Folders" titled={titled}>
          <ul className={GRID}>
            {folders.map((entry) => {
              const path = joinPath(folder, entry.name);
              const reserved = path === SKILLS_FOLDER;

              return (
                <FolderTile key={path} href={folderHref(path)} name={folderLabel(path)} icon={reserved ? SKILLS_ICON : FOLDER_ICON}
                  menu={entryMenu(entry, onOpen, reserved)} />
              );
            })}
          </ul>
        </Section>
      )}
      {rest.length > 0 && (
        <Section label={folder === SKILLS_FOLDER ? "Skills" : "Files"} titled={titled}>
          <ul className={GRID}>
            {rest.map((entry) => entry.kind === "skill"
              ? (
                <Tile key={entry.name} title={entry.name} icon={<BookOpenIcon size={16} />}
                  picture={<SkillPicture name={entry.name} description={entry.description} steps={entry.steps} />}
                  meta={<span className="truncate">Updated {entry.updated}</span>}
                  onOpen={() => onOpen(`Opens ${entry.name}/SKILL.md.`)} menu={entryMenu(entry, onOpen, false)} />
              )
              : entry.kind === "file" && (
                <Tile key={entry.name} title={entry.name} icon={fileIcon(entry.name)} picture={<PreviewPicture preview={entry.preview} />}
                  meta={<span className="truncate">{entry.preview.kind === "upload" ? `Uploading · ${entry.size}` : `${entry.size} · ${entry.updated}`}</span>}
                  onOpen={() => { if (entry.preview.kind !== "upload") openFile(entry.name); }}
                  menu={entry.preview.kind === "upload"
                    ? [{ label: "Cancel upload", icon: <XIcon size={15} />, danger: true, onSelect: () => onOpen("Stops the upload.") }]
                    : [{ label: "Open", icon: <ArrowSquareOutIcon size={15} />, onSelect: () => openFile(entry.name) }, ...entryMenu(entry, onOpen, false)]} />
              ))}
          </ul>
        </Section>
      )}
      {opened?.kind === "file" && <FileDrawer entry={opened} onClose={closeFile} />}
    </div>
  );
}

function SharedPlace({ data, onOpen, onDialog, menuFor }: {
  data: DriveData;
  onOpen: (what: string) => void;
  onDialog: (dialog: Dialog) => void;
  menuFor: string | null;
}) {
  const navigate = useNavigate();

  const openReceived = async (item: ReceivedItem): Promise<void> => {
    if (item.kind === "workspace") {
      await navigate(`/shared/workspace/${item.id}`);

      return;
    }

    onOpen(item.kind === "live" ? `Opens ${item.title} in a new tab, running as ${item.from.name}.` : `Opens the ${item.title} blueprint page.`);
  };

  const manage = (item: GivenItem): Dialog => {
    const base = { title: item.title, owner: data.me, access: item.access };
    const slate = data.slates.find((each) => each.id === item.id);

    const subject: ShareSubject = item.kind === "workspace"
      ? { kind: "workspace", ...base }
      : { kind: "slate", ...base, reach: slate?.reach ?? [], keyAt: slate?.keyAt };

    return { kind: "share", subject, pane: SHARE_PANE[item.kind] };
  };

  return (
    <div className="space-y-8">
      {data.received.length > 0 && (
        <Section label="Shared with you">
          <ul className={GRID}>
            {data.received.map((item) => (
              <Tile key={item.id} title={item.title} picture={<PreviewPicture preview={item.preview} />} icon={KIND[item.kind].icon}
                unseen={item.unseen} onOpen={() => void openReceived(item)} menuOpen={menuFor === item.id}
                meta={<span className="truncate">{KIND[item.kind].label} · {item.from.name} · {item.when}</span>}
                menu={[
                  { label: "Open", icon: <ArrowSquareOutIcon size={15} />, onSelect: () => void openReceived(item) },
                  { label: "Fork…", icon: <GitForkIcon size={15} />, onSelect: () => onOpen(`Forks ${item.title} into a workspace you pick.`) },
                  { label: "Remove from Drive", icon: <XIcon size={15} />, apart: true, onSelect: () => onOpen(`Hides ${item.title}. ${item.from.name} can share it again.`) },
                ]} />
            ))}
          </ul>
        </Section>
      )}
      {data.given.length > 0 && (
        <Section label="Shared by you">
          <ul className={GRID}>
            {data.given.map((item) => (
              <Tile key={item.id} title={item.title} picture={<PreviewPicture preview={item.preview} />} icon={KIND[item.kind].icon}
                onOpen={() => onOpen(`Opens ${item.title}.`)} menuOpen={menuFor === `given:${item.id}`}
                meta={item.status === undefined
                  ? <span className="truncate">{accessLabel(item.access)}</span>
                  : <span className="truncate p-warning">{item.status}</span>}
                menu={[
                  { label: "Manage sharing…", icon: <ShareNetworkIcon size={15} />, onSelect: () => onDialog(manage(item)) },
                  { label: "Copy link", icon: <CopyIcon size={15} />, onSelect: () => onOpen("Copies the link.") },
                  {
                    label: "Stop sharing", icon: <ProhibitIcon size={15} />, danger: true, apart: true,
                    onSelect: () => onDialog({ kind: "stop", title: item.title, who: whoLoses(item.access) }),
                  },
                ]} />
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function Toast({ text, onDone }: { text: string; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, 2600);

    return () => clearTimeout(timer);
  }, [text, onDone]);

  return (
    <div role="status" className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
      <span className="rounded-full border p-border p-overlay px-4 py-2 p-meta p-text-2 p-shadow-menu animate-fade-in">{text}</span>
    </div>
  );
}

function subtitleOf(tab: DriveTab, folder: string, data: DriveData): ReactNode {
  if (tab !== "mine") return null;

  if (folder === SKILLS_FOLDER) return "Every workspace you own uses these skills.";

  if (folder !== "/" || mineIsEmpty(data)) return null;

  return <>Files and folders here are in every workspace you own, at <span className="font-mono p-text-2">/shared</span>.</>;
}

export function DriveDesignPage({ tab, data, initialDialog, menuFor, dropping = false, autoLanding = true }: {
  tab: DriveTab;
  data: DriveData;
  initialDialog: Dialog | null;
  menuFor: string | null;
  dropping?: boolean;
  autoLanding?: boolean;
}) {
  const splat = useParams()["*"] ?? "";
  const location = useLocation();
  const folder = splat === "" ? "/" : `/${splat.replace(/\/+$/u, "")}`;
  const [dialog, setDialog] = useState<Dialog | null>(initialDialog);
  const [toast, setToast] = useState<string | null>(null);
  const clearToast = useRef(() => setToast(null)).current;
  const shared = sharesAnything(data);
  const chosen = !autoLanding || v.safeParse(ChosenState, location.state).success;

  if (tab === "shared" && !shared) return <Navigate to="/drive" replace />;

  if (tab === "mine" && folder === "/" && !chosen && mineIsEmpty(data) && shared) return <Navigate to="/shared" replace />;

  const onOpen = (what: string): void => setToast(what);
  const inSkills = tab === "mine" && folder === SKILLS_FOLDER;
  const emptyDrive = mineIsEmpty(data) && !shared;
  const unseen = data.received.some((item) => item.unseen);

  const subtitle = subtitleOf(tab, folder, data);

  const action = (compact: boolean): ReactNode => {
    if (tab !== "mine") return null;

    if (inSkills) {
      return compact
        ? <FilledButton className="!size-9 rounded-full !p-0" aria-label="New skill" onClick={() => onOpen("Opens the new-skill dialog.")}><PlusIcon size={16} weight="bold" /></FilledButton>
        : <FilledButton className="h-8 gap-1.5 px-3 text-sm" onClick={() => onOpen("Opens the new-skill dialog.")}><PlusIcon size={13} weight="bold" /> New skill</FilledButton>;
    }

    return <NewMenu compact={compact} onPick={(what) => onOpen(`${what}: opens the picker for ${folder === "/" ? "My stuff" : folderLabel(folder)}.`)} />;
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-5 pb-20 pt-6 sm:px-8 lg:pt-8">
        <header className="flex items-center gap-3">
          <HardDrivesIcon size={22} className="shrink-0 p-text-3" />
          <h1 className="p-display text-2xl">Drive</h1>
          <div className="ml-auto">
            <span className="sm:hidden">{action(true)}</span>
            <span className="hidden sm:inline">{action(false)}</span>
          </div>
        </header>

        {emptyDrive ? (
          <EmptyState icon={<HardDrivesIcon size={26} />} title="Your Drive is empty"
            body={<>Drop files here, or use New. Every workspace you own sees them at <span className="font-mono p-text-2">/shared</span>, and the slates your workspaces build show up here too.</>} />
        ) : (
          <>
            {shared && <div className="mt-5"><TabStrip tab={tab} unseen={unseen} /></div>}
            {tab === "mine" && folder !== "/" && <h2 className="mt-6 p-heading text-[15px] sm:text-[17px]"><Crumbs folder={folder} /></h2>}
            {subtitle !== null && <p className={`p-meta p-text-3 ${folder === "/" ? "mt-4" : "mt-1"}`}>{subtitle}</p>}
            <div className="relative mt-6">
              {tab === "mine" && (
                <MyStuff data={data} folder={folder} onOpen={onOpen} menuFor={menuFor}
                  onShare={(subject) => setDialog({ kind: "share", subject, pane: "live" })} />
              )}
              {tab === "shared" && <SharedPlace data={data} onOpen={onOpen} onDialog={setDialog} menuFor={menuFor} />}
              {dropping && tab === "mine" && (
                <div aria-hidden="true" className="pointer-events-none absolute -inset-3 z-20 flex items-center justify-center rounded-[18px] border-2 border-dashed border-[var(--c-accent)] bg-[color-mix(in_srgb,var(--c-bg)_74%,transparent)]">
                  <span className="flex items-center gap-2 rounded-full bg-[var(--c-accent)] px-4 py-2 text-sm font-semibold text-[var(--c-accent-on)] p-shadow-menu">
                    <UploadSimpleIcon size={15} weight="bold" /> Drop to add to {folder === "/" ? "My stuff" : folderLabel(folder)}
                  </span>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {dialog?.kind === "share" && (
        <ShareDialog subject={dialog.subject} initialPane={dialog.pane} accessOpen={dialog.accessOpen} onClose={() => setDialog(null)}
          onStop={() => setDialog({ kind: "stop", title: dialog.subject.title, who: whoLoses(dialog.subject.access) })} />
      )}
      {dialog?.kind === "stop" && <StopSharingDialog title={dialog.title} who={dialog.who} onClose={() => setDialog(null)} />}
      {toast !== null && <Toast text={toast} onDone={clearToast} />}
    </div>
  );
}
