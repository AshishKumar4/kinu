/**
 * The Drive's places: My stuff (`/drive`, `/drive/<path>`), Slates (`/slates`) and Shared (`/shared`), in a column
 * with My stuff's folder tree from `lg`, or below it in a switch at the top. Nothing empty is drawn: Slates and Shared
 * are placed once they hold something, and the column holds the title even when My stuff is the only place.
 */
import { Effect, Result } from 'effect';
import { startTransition, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Loader } from "@cloudflare/kumo";
import {
  AppWindowIcon, ArrowSquareOutIcon, BookOpenIcon, CaretDownIcon, CaretRightIcon, CopyIcon, DownloadSimpleIcon, FolderSimpleIcon, GitForkIcon, GlobeIcon, HardDrivesIcon,
  PencilSimpleIcon, ProhibitIcon, ShareNetworkIcon, SquaresFourIcon, TrashIcon, UploadSimpleIcon, UsersIcon, UsersThreeIcon, WarningIcon, XIcon,
} from "@phosphor-icons/react";
import * as v from "valibot";
import {
  APP_ROUTES, BUILTIN_SKILL_FILES, DRIVE_SKILLS_DIR, blueprintPagePath, compareCodeUnits, liveSharePagePath, entryRevision, formatBytes, joinDir, parseSkillFile, shortAge,
  skillViewPath, workspaceDisplayTitle,
  type DriveEntry, type DriveListing, type FileText, type LiveShareVisibility, type OwnedSlate, type SharedLibrary, type SharedRow,
  type SkillFileRefusal,
} from "@kinu.run/core";
import { detach, diagnostics, showing, toKinuError, settle } from "@kinu.run/core/obs";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  downloadUrl, inlineUrl, listDrive, markAsSkill, readDriveText, uploadFile, uploadFolder, uploadZip, type PickedFile, type UploadWatch,
} from "@/lib/drive-api";
import { getSharedLibrary, markSharedSeen } from "@/lib/shared-api";
import { useAsyncResource, lastValue, type AsyncResource, type AsyncResourceControl } from "@/hooks/use-async-resource";
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

export type DriveTab = "slates" | "mine" | "shared";

function folderHref(path: string): string {
  return path === "/" ? APP_ROUTES.drive : `${APP_ROUTES.drive}${path}`;
}

function slateHref(slate: OwnedSlate): string {
  return `/workspace/${encodeURIComponent(slate.workspace)}?slate=${encodeURIComponent(slate.id)}`;
}

const IMAGE = /\.(?:png|jpe?g|gif|webp|svg)$/iu;

/** A tab or crumb press chose My stuff; a first visit lands on what holds something. */
const ChosenState = v.object({ chosen: v.literal(true) });

const PLACES: readonly { id: DriveTab; label: string; to: string; icon: ReactNode }[] = [
  { id: "mine", label: "My stuff", to: APP_ROUTES.drive, icon: <FolderSimpleIcon size={16} /> },
  { id: "slates", label: "Slates", to: APP_ROUTES.slates, icon: <AppWindowIcon size={16} /> },
  { id: "shared", label: "Shared", to: APP_ROUTES.shared, icon: <UsersThreeIcon size={16} /> },
];

/** The places that hold something: My stuff always, Slates once there is a slate, Shared once there is a share. */
function placesOf(library: SharedLibrary | null): DriveTab[] {
  return PLACES.map((each) => each.id).filter((id) => {
    if (id === "slates") return (library?.slates.length ?? 0) > 0;

    return id === "mine" || (library !== null && !isEmptyLibrary(library));
  });
}

function NewDot() {
  return <span data-drive-unseen className="size-1.5 shrink-0 rounded-full p-dot-accent" title="Something new" />;
}

/** Below `lg`, the places as a switch at the top. */
function PlaceSwitch({ tab, places, unseen }: { tab: DriveTab; places: readonly DriveTab[]; unseen: boolean }) {
  return (
    <nav aria-label="Drive" className="flex w-fit items-center gap-0.5 rounded-lg p-recessed p-0.5">
      {PLACES.filter((each) => places.includes(each.id)).map((each) => (
        <Link key={each.id} to={each.to} state={{ chosen: true }} aria-current={each.id === tab ? "page" : undefined} data-drive-tab={each.id}
          className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-3.5 py-1.5 p-t-control ${each.id === tab ? "p-surface p-text shadow-[0_1px_2px_var(--c-shadow-drop)]" : "p-text-3 hover:p-text"}`}>
          {each.label}
          {each.id === "shared" && unseen && each.id !== tab && <NewDot />}
        </Link>
      ))}
    </nav>
  );
}

const PLACE_ROW = "flex items-center gap-2.5 rounded-lg py-[7px] pl-2.5 pr-2 p-t-control transition-colors";

const ROW_ON = "bg-[color-mix(in_srgb,var(--c-text)_8%,transparent)]";

const ROW_HOVER = "hover:bg-[color-mix(in_srgb,var(--c-text)_5%,transparent)]";

/** A folder's own folders, Skills first: the tree draws only what can be walked into. */
function subfolders(entries: readonly DriveEntry[] | undefined, parent: string): DriveEntry[] {
  const isSkills = (entry: DriveEntry): boolean => joinDir(parent, entry.name) === DRIVE_SKILLS_DIR;

  return (entries ?? []).filter((entry) => entry.kind === "folder").sort((a, b) => Number(isSkills(b)) - Number(isSkills(a)));
}

/**
 * My stuff's folders, opened along the way to `current`. A folder read on the way shows a caret only when it holds
 * folders; one not yet opened is not read, and its caret says it can be.
 */
function FolderTree({ listings, parent, current, depth }: {
  listings: ReadonlyMap<string, readonly DriveEntry[]>; parent: string; current: string; depth: number;
}) {
  const children = subfolders(listings.get(parent), parent);

  if (children.length === 0) return null;

  return (
    <ul>
      {children.map((child) => {
        const path = joinDir(parent, child.name);
        const open = current === path || current.startsWith(`${path}/`);
        const read = listings.get(path);
        const skills = path === DRIVE_SKILLS_DIR || child.skill;
        let caret: ReactNode = <CaretRightIcon size={10} weight="bold" />;

        if (read !== undefined && subfolders(read, path).length === 0) caret = null;
        else if (open) caret = <CaretDownIcon size={10} weight="bold" />;

        return (
          <li key={path}>
            <Link to={folderHref(path)} aria-current={path === current ? "page" : undefined} data-drive-tree={path}
              style={{ paddingLeft: `${String(10 + depth * 14)}px` }}
              className={`flex items-center gap-1.5 rounded-lg py-[5px] pr-2 p-row-text transition-colors ${path === current ? `${ROW_ON} font-medium p-text` : `p-text-2 ${ROW_HOVER}`}`}>
              <span className="flex w-3 shrink-0 justify-center p-text-4">{caret}</span>
              {skills
                ? <BookOpenIcon size={15} weight="fill" className="shrink-0 p-success" />
                : <FolderSimpleIcon size={15} weight="fill" className="shrink-0 p-info" />}
              <span className="truncate">{path === DRIVE_SKILLS_DIR ? "Skills" : child.name}</span>
            </Link>
            {open && <FolderTree listings={listings} parent={path} current={current} depth={depth + 1} />}
          </li>
        );
      })}
    </ul>
  );
}

/** From `lg`, the Drive's places in a column: My stuff with its folder tree, Slates, then Shared. */
function DriveColumn({ tab, path, shown, places, unseen }: {
  tab: DriveTab; path: string; shown: DriveListing | null; places: readonly DriveTab[]; unseen: boolean;
}) {
  // Drawn only from `lg`; the tree in it reads nothing while it is not drawn.
  const drawn = useMediaQuery("(min-width: 1024px)");
  const listings = useFolderWay(drawn && tab === "mine", path, shown);

  if (!drawn) return null;

  return (
    <aside aria-label="Drive" className="hidden w-52 shrink-0 flex-col overflow-y-auto border-r p-border px-3 pb-6 pt-8 lg:flex">
      <div className="flex h-8 items-center gap-2.5 px-2.5">
        <HardDrivesIcon size={22} className="shrink-0 p-text-3" />
        <h1 className="p-display text-2xl">Drive</h1>
      </div>
      <nav aria-label="Drive places" className="mt-6 space-y-0.5">
        {PLACES.filter((each) => places.includes(each.id)).map((each) => {
          const active = each.id === tab;
          const here = active && (each.id !== "mine" || path === "/");
          let tone = `p-text-2 ${ROW_HOVER}`;

          if (here) tone = `${ROW_ON} p-text`;
          else if (active) tone = `p-text ${ROW_HOVER}`;

          return (
            <div key={each.id}>
              <Link to={each.to} state={{ chosen: true }} aria-current={here ? "page" : undefined} data-drive-place={each.id}
                className={`${PLACE_ROW} ${tone}`}>
                <span className={`flex shrink-0 ${active ? "p-accent" : "p-text-3"}`}>{each.icon}</span>
                <span className="flex-1">{each.label}</span>
                {each.id === "shared" && unseen && !active && <NewDot />}
              </Link>
              {each.id === "mine" && active && (
                <div className="mt-0.5 pl-3"><FolderTree listings={listings} parent="/" current={path} depth={0} /></div>
              )}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

/**
 * The page's head, one tree laid out twice: below `lg` the title, the switch, the search and the crumbs stack; from
 * `lg` the title and the places are the column's, and the crumbs share a row with New or the search.
 */
function DriveHead({ tab, path, subtitle, places, unseen, search, action }: {
  tab: DriveTab; path: string; subtitle: ReactNode; places: readonly DriveTab[]; unseen: boolean;
  search: { readonly query: string; readonly set: (query: string) => void }; action: ReactNode;
}) {
  const isRoot = path === "/";

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center lg:grid-cols-[minmax(0,1fr)_auto_auto] [grid-template-areas:'title_action'_'places_places'_'search_search'_'crumbs_crumbs'] lg:[grid-template-areas:'crumbs_action_search']">
      <header className="flex items-center gap-3 [grid-area:title] lg:hidden">
        <HardDrivesIcon size={22} className="shrink-0 p-text-3" />
        <h1 className="p-display text-2xl">Drive</h1>
      </header>
      {action && <div className="ml-3 [grid-area:action]">{action}</div>}
      {places.length > 1 && <div className="mt-5 [grid-area:places] lg:hidden"><PlaceSwitch tab={tab} places={places} unseen={unseen} /></div>}
      {tab === "shared" && (
        <input value={search.query} onChange={(event) => search.set(event.target.value)} placeholder="Search shared" aria-label="Search shared"
          data-drive-search className={`${inputCls} mt-3 w-full [grid-area:search] sm:w-60 lg:mt-0`} />
      )}
      {(!isRoot || subtitle !== null) && (
        <div className={`min-w-0 [grid-area:crumbs] lg:mt-0 ${isRoot ? "mt-4" : "mt-6"}`}>
          {tab === "mine" && !isRoot && <Crumbs path={path} />}
          {subtitle !== null && <p className={`p-meta p-text-3 lg:leading-8 ${isRoot ? "" : "mt-1"}`}>{subtitle}</p>}
        </div>
      )}
    </div>
  );
}

/** Opening Shared with something new in it sees it, on every device; the library is read again so the dot goes. */
function useSeeingShared(seeing: boolean, reread: () => void, fail: (chain: string) => void): void {
  useEffect(() => {
    if (!seeing) return;
    startTransition(() => settle(Effect.catchCause(Effect.gen(function* () {
      yield* Effect.promise(markSharedSeen);
      reread();
    }), showing(fail))));
  }, [seeing, reread, fail]);
}

/**
 * What the folder tree draws: each folder on the way to `path`, read once a visit and kept, the page's own listings
 * among them. Nothing is read while the tree is not drawn, and a folder off the way is not read until it is opened.
 */
function useFolderWay(drawn: boolean, path: string, here: DriveListing | null): ReadonlyMap<string, readonly DriveEntry[]> {
  const [kept, setKept] = useState<ReadonlyMap<string, readonly DriveEntry[]>>(() => new Map());
  const parts = path.split("/").filter(Boolean);
  const missing = drawn ? parts.map((_, index) => `/${parts.slice(0, index).join("/")}`).filter((folder) => !kept.has(folder)) : [];
  const asked = missing.join("\n");

  if (here !== null && kept.get(here.path) !== here.entries) setKept(new Map(kept).set(here.path, here.entries));

  useEffect(() => {
    if (asked === "") return;
    detach(Effect.gen(function* () {
      const read = yield* Effect.promise(() => Promise.all(asked.split("\n").map(listDrive)));

      setKept((held) => new Map([...held, ...read.map((listing): [string, readonly DriveEntry[]] => [listing.path, listing.entries])]));
    }));
  }, [asked]);

  return kept;
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

/** A heading that names a kind of thing in a place is quiet; one that names who a share came from or went to leads. */
const SECTION_HEADING = { quiet: "mb-2.5 p-meta font-medium p-text-3", lead: "mb-3 p-heading text-[15px] p-text" } as const;

function Section({ label, titled = true, heading = "quiet", children }: {
  label: string; titled?: boolean; heading?: keyof typeof SECTION_HEADING; children: ReactNode;
}) {
  return (
    <section aria-label={label} data-drive-section={label}>
      {titled && <h2 className={SECTION_HEADING[heading]}>{label}</h2>}
      <ul className={GRID}>{children}</ul>
    </section>
  );
}

const TEXT = /\.(?:md|markdown|txt|csv|tsv|json|ya?ml|toml|ts|tsx|js|jsx|py|sh|css|html?)$/iu;

const PROSE = /\.(?:md|markdown|txt)$/iu;

const MARKDOWN = /\.(?:md|markdown)$/iu;

const SHEET = /\.(?:csv|tsv)$/iu;

interface CoverLine { readonly text: string; readonly heading: boolean }

const blank = (line: CoverLine): boolean => line.text.trim() === "";

/** A Markdown line as its page reads: marks gone, headings kept. */
function pageLine(line: string): CoverLine {
  const heading = /^#{1,6}\s+(.*)$/u.exec(line)?.[1];
  const text = (heading ?? line).replace(/^(\s*)[-*+]\s+/u, "$1• ").replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1").replace(/\*\*|__|`/gu, "");

  return { text, heading: heading !== undefined };
}

const pageLines = (markdown: string): CoverLine[] =>
  markdown.replace(/^---\n[\s\S]*?\n---\n/u, "").split("\n").filter((line) => !line.startsWith("```")).map(pageLine);

/** A skill's name over its description and steps, Markdown's first heading over the rest, else first lines. */
function coverLines(text: string, name: string): [string | null, CoverLine[]] {
  if (!MARKDOWN.test(name)) return [null, text.split("\n").slice(0, 14).map((line) => ({ text: line, heading: false }))];
  const parsed = parseSkillFile(text);

  if (Result.isSuccess(parsed)) {
    const { name: skill, description, body } = parsed.success;
    const steps = pageLines(body).filter((line) => !blank(line) && !(line.heading && line.text.toLowerCase() === skill.toLowerCase()));

    return [skill, [{ text: description, heading: false }, { text: "", heading: false }, ...steps].slice(0, 12)];
  }

  const lines = pageLines(text);
  const first = lines.findIndex((line) => !blank(line));
  const title = lines[first];

  if (title?.heading !== true) return [null, lines.slice(0, 14)];
  const rest = lines.slice(first + 1);
  const start = Math.max(0, rest.findIndex((line) => !blank(line)));

  return [title.text, rest.slice(start, start + 12)];
}

function sheetRows(text: string, name: string): string[][] {
  const separator = /\.tsv$/iu.test(name) ? "\t" : ",";

  return text.split("\n").filter((line) => line.trim() !== "").slice(0, 9).map((line) => {
    const cells: string[] = [];
    let cell = "";
    let quoted = false;

    for (const char of line) {
      if (char === '"') quoted = !quoted;
      else if (char === separator && !quoted) {
        cells.push(cell);
        cell = "";
      } else cell += char;
    }

    return [...cells, cell];
  });
}

const NUMERIC = /^-?[\d.,$%]+$/u;

function SheetCover({ rows }: { rows: readonly (readonly string[])[] }) {
  const columns = Math.min(4, rows[0]?.length ?? 1);
  const right = Array.from({ length: columns }, (_, column) => rows.slice(1).every((row) => NUMERIC.test(row[column]?.trim() ?? "")));
  const grid = { gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))` };

  return (
    <span className="absolute inset-0 overflow-hidden p-surface text-[8.5px] leading-[1.45]">
      {rows.map((row, index) => (
        <span key={index} data-drive-sheet-row style={grid}
          className={`grid gap-2 px-4 ${index === 0 ? "p-recessed py-2 font-semibold p-text-2" : "border-t p-border py-[5px] font-mono p-text-3"}`}>
          {row.slice(0, columns).map((cell, column) => <span key={column} className={`truncate ${right[column] === true ? "text-right" : ""}`}>{cell}</span>)}
        </span>
      ))}
    </span>
  );
}

function CodeCover({ lines }: { lines: readonly string[] }) {
  return (
    <span className="absolute inset-0 overflow-hidden p-recessed px-3 pt-3 font-mono text-[8.5px] leading-[1.6]">
      {lines.map((line, index) => (
        <span key={index} data-drive-code-line className="flex gap-2.5">
          <span className="min-w-3 shrink-0 text-right tabular-nums p-text-4">{index + 1}</span>
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-pre p-text-3">{line === "" ? "\u00a0" : line}</span>
        </span>
      ))}
    </span>
  );
}

function TextPage({ text, name }: { text: string | null; name: string }) {
  const rows = text !== null && SHEET.test(name) ? sheetRows(text, name) : [];

  if (rows.length > 0) return <SheetCover rows={rows} />;
  const [heading, lines] = text === null ? [null, []] : coverLines(text, name);

  if (heading === null && lines.length === 0) return <FileCover name={name} />;

  if (heading === null && !PROSE.test(name)) return <CodeCover lines={lines.map((line) => line.text)} />;

  return (
    <span className="absolute inset-0 overflow-hidden p-recessed px-[14%] pt-[5%]">
      <span className="block h-full overflow-hidden rounded-t-md border border-b-0 p-border p-surface px-3 pt-2.5 text-[8.5px] leading-[1.45] p-text-3">
        {heading !== null && <span data-drive-page-heading className="mb-1 block truncate text-[11px] font-semibold p-text">{heading}</span>}
        {lines.map((line, index) => (
          <span key={index} data-drive-page-line className={`block truncate ${line.heading ? "mt-0.5 font-semibold p-text-2" : ""}`}>
            {line.text === "" ? "\u00a0" : line.text}
          </span>
        ))}
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

/** What is sent: into which folder, under which name, how many bytes, and the entry it lands as. */
interface Sending {
  readonly folder: string;
  readonly name: string;
  readonly size: number;
  /** A file lands as itself, a folder as its name, a .zip as the folder it unpacks into. */
  readonly lands: string;
}

interface Transfer extends Sending {
  readonly id: number;
  readonly status: "uploading" | "landed" | "failed";
  /** The share of the upload that has gone, 0 to 1. */
  readonly progress: number;
  readonly error?: string;
  readonly stop: () => void;
}

function TransferPicture({ status, progress }: { status: Transfer["status"]; progress: number }) {
  if (status === "failed") {
    return <span className="absolute inset-0 flex items-center justify-center p-recessed"><WarningIcon size={24} className="p-danger" /></span>;
  }

  const percent = Math.round(progress * 100);

  return (
    <span className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 p-recessed">
      <span className="p-meta tabular-nums p-text-2">{percent}%</span>
      <span role="progressbar" aria-label="Uploading" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}
        className="h-1 w-1/2 overflow-hidden rounded-full bg-[var(--c-border-strong)]">
        <span className="block h-full rounded-full bg-[var(--c-accent-mark)] transition-[width]" style={{ width: `${String(percent)}%` }} />
      </span>
    </span>
  );
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
  return <span className="truncate p-warning" title={whyUnused(refusal)} data-drive-unused={refusal.reason}>Not used</span>;
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
  readonly folders: readonly DriveEntry[];
  readonly files: readonly DriveEntry[];
  readonly builtins: readonly string[];
}

const SKILLS_FOLDER = DRIVE_SKILLS_DIR.slice(1);

function mineContents(path: string, entries: readonly DriveEntry[]): MineContents {
  const isSkills = (entry: DriveEntry): boolean => path === "/" && entry.name === SKILLS_FOLDER;

  return {
    folders: entries.filter((entry) => entry.kind !== "file").sort((a, b) => Number(isSkills(b)) - Number(isSkills(a))),
    files: entries.filter((entry) => entry.kind === "file"),
    builtins: path === DRIVE_SKILLS_DIR ? Object.keys(BUILTIN_SKILL_FILES) : [],
  };
}

function isEmptyMine(contents: MineContents): boolean {
  return contents.folders.length + contents.files.length + contents.builtins.length === 0;
}

function ownsNothing(contents: MineContents): boolean {
  return contents.files.length === 0 && contents.folders.every((entry) => entry.name === SKILLS_FOLDER);
}

/**
 * A place with nothing in it goes back to My stuff. A first visit to the Drive lands on My stuff; only when My stuff
 * holds nothing of its own does it land on Slates, else on what is shared.
 */
/** Where the page is at: its place, whether it is a first visit to the Drive's root, and what its reads have said. */
interface Arrival {
  readonly tab: DriveTab;
  readonly firstVisit: boolean;
  /** The listing and the library have both answered. */
  readonly settled: boolean;
  readonly nothingOwned: boolean;
  readonly library: SharedLibrary | null;
}

function landing({ tab, firstVisit, settled, nothingOwned, library }: Arrival): ReactNode {
  // A first visit waits to know where it lands: My stuff is never drawn for a moment before another place replaces it.
  if (tab === "mine" && firstVisit && !settled) return <div className="flex h-full items-center justify-center" data-drive-landing><Loader size="base" /></div>;

  if (library === null) return null;
  const places = placesOf(library);

  if (!places.includes(tab)) return <Navigate to={APP_ROUTES.drive} replace state={{ chosen: true }} />;

  if (tab !== "mine" || !firstVisit || !nothingOwned) return null;

  if (places.includes("slates")) return <Navigate to={APP_ROUTES.slates} replace />;

  return places.includes("shared") ? <Navigate to={APP_ROUTES.shared} replace /> : null;
}

function subtitleOf(tab: DriveTab, path: string): ReactNode {
  if (tab !== "mine") return null;

  if (path === DRIVE_SKILLS_DIR) return "Every workspace you own uses these skills.";

  if (path !== "/") return null;

  return <>Files and folders here are in every workspace you own, at <span className="font-mono p-text-2">/shared</span>.</>;
}

function SectionList({ groups, titled = false, heading = "quiet" }: {
  groups: readonly { label: string; tiles: readonly ReactNode[] }[]; titled?: boolean; heading?: keyof typeof SECTION_HEADING;
}) {
  const shown = groups.filter((group) => group.tiles.length > 0);

  return (
    <div className={heading === "lead" ? "space-y-10" : "space-y-7"}>
      {shown.map((group) => <Section key={group.label} label={group.label} titled={titled || shown.length > 1} heading={heading}>{group.tiles}</Section>)}
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
    <SectionList titled heading="lead" groups={[
      { label: "Shared with you", tiles: received.map((row) => tile(row, false)) },
      { label: "Shared by you", tiles: mine.map((row) => tile(row, true)) },
    ]} />
  );
}

/** Every slate across the owner's workspaces, each labelled with its workspace. */
function SlatesBody({ slates, tile }: { slates: readonly OwnedSlate[] | null; tile: (slate: OwnedSlate) => ReactNode }) {
  if (slates === null) return <div className="flex justify-center py-16"><Loader size="base" /></div>;

  return <section aria-label="Slates" data-drive-section="Slates"><ul className={GRID}>{slates.map(tile)}</ul></section>;
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

function DriveNotices({ notice, onDismissNotice, listingPending, libraryResource, onRetryLibrary, copyStatus }: {
  notice: string | null;
  listingPending: boolean;
  onDismissNotice: () => void;
  libraryResource: AsyncResource<SharedLibrary>;
  onRetryLibrary: () => void;
  copyStatus: ReturnType<typeof useCopy>["status"];
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

/** The uploads this visit sent, and the tiles of those still to land in `path`. */
function useTransfers(path: string, listing: AsyncResourceControl<DriveListing>) {
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  // The listing last pruned against: its value, which keeps its identity, not the resource, a new object per render
  // while a path loads.
  const [prunedFor, setPrunedFor] = useState<DriveListing | null>(null);
  const nextTransfer = useRef(0);
  const { reload } = listing;

  const transfer = useCallback((sending: Sending, work: (watch: UploadWatch) => Promise<void>): void => {
    const id = ++nextTransfer.current;
    const abort = new AbortController();
    const change = (patch: Partial<Transfer>): void => setTransfers((rows) => rows.map((row) => row.id === id ? { ...row, ...patch } : row));
    const drop = (): void => setTransfers((rows) => rows.filter((row) => row.id !== id));

    setTransfers((rows) => [...rows, { ...sending, id, status: "uploading", progress: 0, stop: () => abort.abort() }]);
    startTransition(() => settle(Effect.catchCause(Effect.gen(function* () {
      yield* Effect.promise(async () => work({ signal: abort.signal, progress: (share) => change({ progress: share }) }));
      change({ status: "landed" });
      reload();
    }), showing((chain) => {
      if (abort.signal.aborted) drop();
      else change({ status: "failed", error: chain, stop: drop });
    }))));
  }, [reload]);

  // Landed: leaves once the listing holds what it landed as, and is forgotten then, so a later delete cannot bring it back.
  const shownListing = lastValue(listing.resource);
  const listed = new Set((shownListing?.entries ?? []).map((entry) => entry.name));
  const arrived = (row: Transfer): boolean => row.status === "landed" && row.folder === path && listed.has(row.lands);

  if (prunedFor !== shownListing) {
    setPrunedFor(shownListing);
    setTransfers((rows) => rows.some(arrived) ? rows.filter((row) => !arrived(row)) : rows);
  }

  return { transfer, uploads: transfers.filter((row) => row.folder === path && !arrived(row)) };
}

export default function DrivePage({ tab }: { tab: DriveTab }) {
  const splat = useParams()["*"] ?? "";
  const path = tab !== "mine" || splat === "" ? "/" : `/${splat.replace(/\/+$/u, "")}`;
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
  const [query, setQuery] = useState("");

  const titleOf = (workspace: string): string => {
    const entry = roster.find((each) => each.name === workspace);

    return entry === undefined ? workspace : workspaceDisplayTitle(entry);
  };

  const { transfer, uploads } = useTransfers(path, listing);

  const uploadFiles = (files: File[]): void => {
    for (const file of files) {
      transfer({ folder: path, name: file.name, size: file.size, lands: file.name }, (watch) => uploadFile(joinDir(path, file.name), file, watch));
    }
  };

  const uploadPicked = (picks: readonly PickedFile[]): void => {
    const name = pickedFolderName(picks) ?? "folder";
    const size = picks.reduce((sum, pick) => sum + pick.file.size, 0);

    transfer({ folder: path, name, size, lands: name }, (watch) => uploadFolder(path, picks, watch));
  };

  const background = (work: () => Promise<void>): void => {
    startTransition(() => settle(Effect.catchCause(Effect.promise(work), showing(setNotice))));
  };

  // Entered as its link's visitor enters it, through the page that hands this account its ticket.
  const openLive = (row: SharedRow): void => {
    if (row.workspace !== undefined) window.open(liveSharePagePath(row.workspace, row.share), "_blank", "noopener");
  };

  const afterSkillAdded = async (): Promise<void> => {
    listing.reload();

    if (path !== DRIVE_SKILLS_DIR) await navigate(folderHref(DRIVE_SKILLS_DIR));
  };

  // Kept with the place it was chosen from, so opening a file at My stuff's root is not a first visit to the Drive.
  const show = (key: "file" | "skill", name: string | null): void => {
    const next = new URLSearchParams(search);

    if (name === null) next.delete(key);
    else next.set(key, name);
    setSearch(next, { state: location.state });
  };

  const shared = lastValue(library.resource);
  const places = placesOf(shared);
  const unseen = shared?.received.some((row) => row.unseen === true) ?? false;

  useSeeingShared(tab === "shared" && unseen, library.reload, setNotice);
  const contents = mineContents(path, lastValue(listing.resource)?.entries ?? []);
  const settled = [listing.resource, library.resource].every((resource) => resource.status !== "loading");
  const inSkills = path === DRIVE_SKILLS_DIR;
  const firstVisit = isRoot && !v.safeParse(ChosenState, location.state).success;

  const redirect = landing({ tab, firstVisit, settled, nothingOwned: ownsNothing(contents), library: shared });

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
    const cover = <Cover title={row.title} />;
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
        fallback={<Cover title={slate.title} />} />}
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
    let icon = entry.kind === "symlink" ? LINK_ICON : FOLDER_ICON;

    if (entry.skill || full === DRIVE_SKILLS_DIR) icon = SKILLS_ICON;

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
  ].sort((a, b) => compareCodeUnits(a.name, b.name)).map((each) => each.tile);

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

  const uploadTile = (row: Transfer): ReactNode => (
    <Tile key={`upload:${String(row.id)}`} title={row.name} icon={fileIcon(row.name)} picture={<TransferPicture status={row.status} progress={row.progress} />}
      meta={row.status === "failed"
        ? <span className="truncate p-danger" title={row.error}>{row.error}</span>
        : <span className="truncate">{row.size > 0 ? `Uploading · ${formatBytes(row.size)}` : "Uploading"}</span>}
      menu={[row.status === "failed"
        ? { label: "Dismiss", icon: <XIcon size={15} />, marker: "data-drive-dismiss-upload", onSelect: row.stop }
        : { label: "Cancel upload", icon: <XIcon size={15} />, marker: "data-drive-cancel-upload", danger: true, onSelect: row.stop }]}
      attributes={{ "data-drive-transfer": row.status }} />
  );

  const opened = contents.files.find((entry) => entry.name === search.get("file"));
  const builtin = contents.builtins.find((name) => name === search.get("skill"));
  const subtitle = subtitleOf(tab, path);

  return (
    <div className="flex h-full min-h-0">
      <DriveColumn tab={tab} path={path} shown={lastValue(listing.resource)} places={places} unseen={unseen} />
      <div className="min-w-0 flex-1 overflow-y-auto">
      <div className="px-5 pb-20 pt-6 sm:px-8 lg:pt-8">
        <DriveHead tab={tab} path={path} subtitle={subtitle} places={places} unseen={unseen} search={{ query, set: setQuery }}
          action={tab === "mine" && (
            <PrimaryAction inSkills={inSkills} onFiles={uploadFiles}
              onFolder={(picks) => { if (picks.length > 0) uploadPicked(picks); }}
              onZip={(file) => {
                const unpacked = file.name.replace(/\.zip$/iu, "");

                transfer({ folder: path, name: file.name, size: file.size, lands: unpacked }, (watch) => uploadZip(joinDir(path, unpacked), file, watch));
              }}
              onNewFolder={() => setDialog({ kind: "new-folder" })} onNewSkill={() => setDialog({ kind: "add-skill" })} />
          )} />

        <DriveNotices notice={notice} onDismissNotice={() => setNotice(null)} listingPending={listingPending} libraryResource={library.resource} onRetryLibrary={library.reload}
          copyStatus={copier.status} />

        {tab === "mine" && (
          <DropZone label={isRoot ? "My stuff" : path.slice(path.lastIndexOf("/") + 1)} onFiles={uploadFiles}>
            <MineBody resource={listing.resource} onRetry={listing.reload} empty={isEmptyMine(contents) && uploads.length === 0}>
              <SectionList groups={[
                { label: inSkills ? "Skills" : "Folders", tiles: inSkills ? skillTiles() : contents.folders.map(folderTile) },
                { label: "Files", tiles: [...contents.files.map(fileTile), ...uploads.map(uploadTile)] },
              ]} />
            </MineBody>
          </DropZone>
        )}
        {/* From `lg` Slates has no head of its own: the column names the place. */}
        {tab === "slates" && <div className="mt-6 lg:mt-0"><SlatesBody slates={shared?.slates ?? null} tile={slateTile} /></div>}
        {tab === "shared" && <div className="mt-6"><SharedBody shared={shared} query={query} tile={shareTile} /></div>}
      </div>

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
