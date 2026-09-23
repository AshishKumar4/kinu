import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import {
  AppWindowIcon, ArrowSquareOutIcon, BookOpenIcon, CaretDownIcon, CaretRightIcon, CopyIcon, DownloadSimpleIcon,
  FileArchiveIcon, FolderPlusIcon, FolderSimpleIcon, GitForkIcon, HardDrivesIcon, PencilSimpleIcon, PlusIcon,
  ProhibitIcon, ShareNetworkIcon, SquaresFourIcon, TrashIcon, UploadSimpleIcon, UsersThreeIcon, XIcon,
} from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo";
import { FilledButton } from "@/components/ui/FilledButton";
import { useCloseOnOutsideClick } from "@/hooks/use-close-on-outside-click";
import { PreviewPicture, SkillPicture, type Preview } from "./previews";
import {
  AccessGlyph, fileIcon, FOLDER_ICON, FolderTile, GRID, KIND, LIST, SKILLS_ICON, SLATE_ICON, Tile,
  type Access, type MenuItem, type Person, type ShareKind,
} from "./tiles";
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

export const SKILLS_FOLDER = "/skills";

type Place = "slates" | "files" | "shared";

const PLACE_LABEL: Record<Place, string> = { slates: "Slates", files: "Files", shared: "Shared" };

const SHARE_PANE: Record<ShareKind, SharePane> = { live: "live", blueprint: "blueprint", workspace: "workspace" };

function entriesOf(data: DriveData, folder: string): readonly DriveEntry[] {
  const entries = data.folders[folder] ?? [];

  if (folder !== "/") return entries;

  const skills = data.folders[SKILLS_FOLDER] ?? [];

  return entries.filter((entry) => !(entry.kind === "folder" && entry.name === "skills" && skills.length === 0));
}

function placesOf(data: DriveData): Place[] {
  const places: Place[] = [];

  if (data.slates.length > 0) places.push("slates");
  places.push("files");

  if (data.received.length + data.given.length > 0) places.push("shared");

  return places;
}

function landingPlace(data: DriveData): Place {
  if (data.slates.length > 0) return "slates";

  if (entriesOf(data, "/").length > 0) return "files";

  if (data.received.length + data.given.length > 0) return "shared";

  return "files";
}

function joinPath(folder: string, name: string): string {
  return folder === "/" ? `/${name}` : `${folder}/${name}`;
}

function folderLabel(path: string): string {
  if (path === SKILLS_FOLDER) return "Skills";

  return path.split("/").at(-1) ?? path;
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

const PLACE_ICON: Record<Place, ReactNode> = {
  slates: <AppWindowIcon size={16} />,
  files: <FolderSimpleIcon size={16} />,
  shared: <UsersThreeIcon size={16} />,
};

const PLACE_ROW = "flex items-center gap-2.5 rounded-lg py-[7px] pl-2.5 pr-2 p-t-control transition-colors";

const ROW_ON = "bg-[color-mix(in_srgb,var(--c-text)_8%,transparent)]";

const ROW_HOVER = "hover:bg-[color-mix(in_srgb,var(--c-text)_5%,transparent)]";

function placeHref(place: Place): string {
  return `/drive/${place}`;
}

function folderHref(path: string): string {
  return path === "/" ? "/drive/files" : `/drive/files${path}`;
}

function FolderTree({ data, parent, current, depth }: { data: DriveData; parent: string; current: string; depth: number }) {
  const children = entriesOf(data, parent).filter((entry) => entry.kind === "folder");

  if (children.length === 0) return null;

  return (
    <ul>
      {children.map((child) => {
        const path = joinPath(parent, child.name);
        const active = path === current;
        const open = current === path || current.startsWith(`${path}/`);
        const hasChildren = entriesOf(data, path).some((entry) => entry.kind === "folder");
        const skills = path === SKILLS_FOLDER;

        return (
          <li key={path}>
            <Link to={folderHref(path)} style={{ paddingLeft: `${String(10 + depth * 14)}px` }}
              className={`flex items-center gap-1.5 rounded-lg py-[5px] pr-2 p-row-text transition-colors ${active ? `${ROW_ON} font-medium p-text` : `p-text-2 ${ROW_HOVER}`}`}>
              <span className="flex w-3 shrink-0 justify-center p-text-4">
                {hasChildren && (open ? <CaretDownIcon size={10} weight="bold" /> : <CaretRightIcon size={10} weight="bold" />)}
              </span>
              {skills
                ? <BookOpenIcon size={15} weight="fill" className="shrink-0 p-success" />
                : <FolderSimpleIcon size={15} weight="fill" className="shrink-0 p-info" />}
              <span className="truncate">{folderLabel(path)}</span>
            </Link>
            {open && hasChildren && <FolderTree data={data} parent={path} current={current} depth={depth + 1} />}
          </li>
        );
      })}
    </ul>
  );
}

function NewDot() {
  return <span className="size-1.5 shrink-0 rounded-full p-dot-accent" title="Something new" />;
}

function DriveColumn({ data, places, place, folder }: { data: DriveData; places: readonly Place[]; place: Place; folder: string }) {
  const unseen = data.received.some((item) => item.unseen);

  return (
    <aside aria-label="Drive" className="hidden w-52 shrink-0 flex-col overflow-y-auto border-r p-border px-3 pb-6 pt-8 lg:flex">
      <div className="flex h-8 items-center gap-2.5 px-2.5">
        <HardDrivesIcon size={22} className="shrink-0 p-text-3" />
        <h1 className="p-display text-2xl">Drive</h1>
      </div>
      <nav aria-label="Drive places" className="mt-6 space-y-0.5">
        {places.map((each) => {
          const active = each === place;
          const here = active && (each !== "files" || folder === "/");
          let tone = `p-text-2 ${ROW_HOVER}`;

          if (here) tone = `${ROW_ON} p-text`;
          else if (active) tone = `p-text ${ROW_HOVER}`;

          return (
            <div key={each}>
              <Link to={placeHref(each)} aria-current={here ? "page" : undefined} className={`${PLACE_ROW} ${tone}`}>
                <span className={`flex shrink-0 ${active ? "p-accent" : "p-text-3"}`}>{PLACE_ICON[each]}</span>
                <span className="flex-1">{PLACE_LABEL[each]}</span>
                {each === "shared" && unseen && !active && <NewDot />}
              </Link>
              {each === "files" && active && (
                <div className="mt-0.5 pl-3"><FolderTree data={data} parent="/" current={folder} depth={0} /></div>
              )}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

function PlaceStrip({ data, places, place }: { data: DriveData; places: readonly Place[]; place: Place }) {
  const navigate = useNavigate();
  const unseen = data.received.some((item) => item.unseen);

  return (
    <div role="tablist" aria-label="Drive places" className="flex w-fit items-center gap-0.5 rounded-lg p-recessed p-0.5">
      {places.map((each) => {
        const selected = each === place;

        return (
          <button key={each} type="button" role="tab" aria-selected={selected} onClick={() => void navigate(placeHref(each))}
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 p-t-control${selected ? " p-surface p-text shadow-[0_1px_2px_var(--c-shadow-drop)]" : " p-text-3 hover:p-text"}`}>
            {PLACE_LABEL[each]}
            {each === "shared" && unseen && !selected && <NewDot />}
          </button>
        );
      })}
    </div>
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
      <Link to={folderHref("/")} className="shrink-0 p-text-3 transition-colors hover:p-text">Files</Link>
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

function EmptyState({ icon, title, body, children }: { icon: ReactNode; title: string; body: ReactNode; children?: ReactNode }) {
  return (
    <div data-design-empty className="flex flex-col items-center px-6 py-16 text-center sm:py-24">
      <span className="flex size-14 items-center justify-center rounded-2xl p-text-3 bg-[color-mix(in_srgb,var(--c-text)_7%,transparent)]">{icon}</span>
      <h2 className="mt-5 p-heading text-[19px] p-text">{title}</h2>
      <p className="mt-2 max-w-[26rem] p-row-text p-text-3">{body}</p>
      {children !== undefined && <div className="mt-6 flex flex-wrap justify-center gap-2">{children}</div>}
    </div>
  );
}

function SlatesPlace({ data, onOpen, onShare, menuFor }: {
  data: DriveData;
  onOpen: (what: string) => void;
  onShare: (subject: ShareSubject) => void;
  menuFor: string | null;
}) {
  return (
    <ul className={GRID}>
      {data.slates.map((slate: SlateItem) => (
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

function FilesPlace({ data, folder, onOpen }: { data: DriveData; folder: string; onOpen: (what: string) => void }) {
  const entries = entriesOf(data, folder);
  const folders = entries.filter((entry) => entry.kind === "folder");
  const rest = entries.filter((entry) => entry.kind !== "folder");
  const both = folders.length > 0 && rest.length > 0;

  if (entries.length === 0) {
    return (
      <EmptyState icon={<FolderSimpleIcon size={26} />} title={folder === "/" ? "No files yet" : "This folder is empty"}
        body="Drop files here to add them, or use New." />
    );
  }

  return (
    <div className="space-y-7">
      {folders.length > 0 && (
        <section aria-label="Folders">
          {both && <h3 className="mb-2.5 p-meta font-medium p-text-3">Folders</h3>}
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
        </section>
      )}
      {rest.length > 0 && (
        <section aria-label="Files">
          {both && <h3 className="mb-2.5 p-meta font-medium p-text-3">Files</h3>}
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
                  onOpen={() => onOpen(`Opens a preview of ${entry.name}.`)}
                  menu={entry.preview.kind === "upload"
                    ? [{ label: "Cancel upload", icon: <XIcon size={15} />, danger: true, onSelect: () => onOpen("Stops the upload.") }]
                    : entryMenu(entry, onOpen, false)} />
              ))}
          </ul>
        </section>
      )}
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
    <div className="space-y-10">
      {data.received.length > 0 && (
        <section aria-label="Shared with you">
          <h3 className="mb-3 p-heading text-[15px] p-text">Shared with you</h3>
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
        </section>
      )}
      {data.given.length > 0 && (
        <section aria-label="Shared by you">
          <h3 className="mb-3 p-heading text-[15px] p-text">Shared by you</h3>
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
                    onSelect: () => onDialog({
                      kind: "stop", title: item.title,
                      who: whoLoses(item.access),
                    }),
                  },
                ]} />
            ))}
          </ul>
        </section>
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

export function DriveDesignPage({ data, initialDialog, menuFor, dropping = false }: {
  data: DriveData;
  initialDialog: Dialog | null;
  menuFor: string | null;
  dropping?: boolean;
}) {
  const params = useParams();
  const places = placesOf(data);
  const place = places.find((each) => each === params.place);
  const splat = params["*"] ?? "";
  const folder = splat === "" ? "/" : `/${splat.replace(/\/+$/u, "")}`;
  const [dialog, setDialog] = useState<Dialog | null>(initialDialog);
  const [toast, setToast] = useState<string | null>(null);
  const clearToast = useRef(() => setToast(null)).current;

  if (place === undefined) return <Navigate to={placeHref(landingPlace(data))} replace />;

  const column = places.length > 1;
  const inSkills = place === "files" && folder === SKILLS_FOLDER;
  const onOpen = (what: string): void => setToast(what);

  const crumbs = place === "files" && folder !== "/" ? <Crumbs folder={folder} /> : null;

  let subtitle: ReactNode = null;

  if (inSkills) subtitle = "Every workspace you own uses these skills.";
  else if (place === "files" && folder === "/") subtitle = <>Every workspace you own sees these files at <span className="font-mono p-text-2">/shared</span>.</>;

  const toolbar = crumbs !== null || subtitle !== null;

  const action = (compact: boolean): ReactNode => {
    if (place !== "files") return null;

    if (inSkills) {
      return compact
        ? <FilledButton className="!size-9 rounded-full !p-0" aria-label="New skill" onClick={() => onOpen("Opens the new-skill dialog.")}><PlusIcon size={16} weight="bold" /></FilledButton>
        : <FilledButton className="h-8 gap-1.5 px-3 text-sm" onClick={() => onOpen("Opens the new-skill dialog.")}><PlusIcon size={13} weight="bold" /> New skill</FilledButton>;
    }

    return <NewMenu compact={compact} onPick={(what) => onOpen(`${what}: opens the picker for ${folderLabel(folder) === "" ? "Files" : folderLabel(folder)}.`)} />;
  };

  const emptyDrive = !column && entriesOf(data, "/").length === 0;

  return (
    <div className="flex h-full min-h-0">
      {column && <DriveColumn data={data} places={places} place={place} folder={place === "files" ? folder : ""} />}
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="px-5 pb-20 pt-6 sm:px-8 lg:pt-8">
          <header className={`flex items-center gap-3 ${column ? "lg:hidden" : ""}`}>
            <HardDrivesIcon size={22} className="shrink-0 p-text-3" />
            <h1 className="p-display text-2xl">Drive</h1>
            {!emptyDrive && <div className={`ml-auto ${column ? "" : "lg:hidden"}`}>{action(true)}</div>}
          </header>
          {column && <div className="mt-4 lg:hidden"><PlaceStrip data={data} places={places} place={place} /></div>}

          {emptyDrive ? (
            <EmptyState icon={<HardDrivesIcon size={26} />} title="Your Drive is empty"
              body={<>Files you add here are in every workspace you own, at <span className="font-mono p-text-2">/shared</span>. Slates your workspaces build, and anything people share with you, show up here too.</>}>
              <FilledButton className="h-9 gap-1.5 px-4 text-sm" onClick={() => onOpen("Opens the file picker.")}><UploadSimpleIcon size={14} weight="bold" /> Upload files</FilledButton>
              <Button variant="secondary" size="sm" className="!h-9 px-4" icon={<FolderPlusIcon size={14} />} onClick={() => onOpen("Asks for a folder name.")}>New folder</Button>
            </EmptyState>
          ) : (
            <>
              {toolbar && (
                <div className={`mt-5 flex items-start gap-4 ${column ? "lg:mt-0" : ""}`}>
                  <div className="min-w-0 flex-1">
                    {crumbs !== null && <h2 className="p-heading text-[15px] lg:text-[18px] lg:leading-8">{crumbs}</h2>}
                    {subtitle !== null && <p className={crumbs === null ? "p-row-text p-text-3 lg:leading-8" : "mt-0.5 p-meta p-text-3"}>{subtitle}</p>}
                  </div>
                  <div className="hidden shrink-0 lg:block">{action(false)}</div>
                </div>
              )}
              <div className={toolbar || !column ? "mt-6" : "mt-6 lg:mt-0"}>
                {place === "slates" && <SlatesPlace data={data} onOpen={onOpen} menuFor={menuFor} onShare={(subject) => setDialog({ kind: "share", subject, pane: "live" })} />}
                {place === "files" && (
                  <div className="relative">
                    <FilesPlace data={data} folder={folder} onOpen={onOpen} />
                    {dropping && (
                      <div aria-hidden="true" className="pointer-events-none absolute -inset-3 z-20 flex items-center justify-center rounded-[18px] border-2 border-dashed border-[var(--c-accent)] bg-[color-mix(in_srgb,var(--c-bg)_74%,transparent)]">
                        <span className="flex items-center gap-2 rounded-full bg-[var(--c-accent)] px-4 py-2 text-sm font-semibold text-[var(--c-accent-on)] p-shadow-menu">
                          <UploadSimpleIcon size={15} weight="bold" /> Drop to add to {folder === "/" ? "Files" : folderLabel(folder)}
                        </span>
                      </div>
                    )}
                  </div>
                )}
                {place === "shared" && <SharedPlace data={data} onOpen={onOpen} onDialog={setDialog} menuFor={menuFor} />}
              </div>
            </>
          )}
        </div>
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
