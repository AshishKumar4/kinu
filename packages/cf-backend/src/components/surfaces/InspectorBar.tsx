/**
 * The inspector's bar on the column's flat rule: the open pages a quiet chip row on the left, the open one raised, and
 * the workspace's tools one switch at the right with the open tool named. The pages that do not fit beside the tools
 * wait behind one count; a column too narrow for a page's name beside the count holds them all in one picker.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  CaretDownIcon, CheckIcon, FolderSimpleIcon, GaugeIcon, GitDiffIcon, ListChecksIcon, TerminalWindowIcon, TreeStructureIcon,
  type Icon,
} from "@phosphor-icons/react";
import { Tooltip } from "@cloudflare/kumo";
import { ACTIVITY_SURFACE, type SURFACES, type SurfaceKind } from "@kinu.run/core";
import { AgentFaceIcon } from "@/components/Marks";

interface ToolSpec { readonly name: string; readonly Icon: Icon | typeof AgentFaceIcon; readonly about?: string }

const TOOLS: Record<(typeof SURFACES)[number] | typeof ACTIVITY_SURFACE, ToolSpec> = {
  Work: { name: "Work", Icon: ListChecksIcon },
  Changes: { name: "Changes", Icon: GitDiffIcon },
  Files: { name: "Files", Icon: FolderSimpleIcon },
  Swarms: { name: "Swarms", Icon: TreeStructureIcon },
  Agent: { name: "Agent", Icon: AgentFaceIcon },
  Environment: { name: "Environment", Icon: TerminalWindowIcon },
  [ACTIVITY_SURFACE]: { name: "Activity", Icon: GaugeIcon, about: "Context, cost, and cache" },
};

type ToolKind = keyof typeof TOOLS;

/** A page's chip; `action` sits on it while it is open, as Share does on the open slate. */
export interface PageTab { readonly key: SurfaceKind; readonly title: string; readonly Icon: Icon; readonly action?: ReactNode }

export interface ToolTab { readonly key: ToolKind; readonly count?: { readonly value: number; readonly accent: boolean } | undefined }

/** Between chips, and the room the count of the rest takes. */
const GAP = 2;

const MORE = 40;

/** The open page keeps at least this much of its name beside the count, or the row becomes one picker. */
const MIN_OPEN = 96;

/** The pages shown: in order, as many as fit, the open one always among them, the count's room kept once any is out. */
function fitting(widths: readonly number[], open: number, room: number): ReadonlySet<number> {
  if (widths.reduce((sum, width) => sum + width + GAP, 0) <= room) return new Set(widths.keys());

  let left = room - MORE - GAP - (open < 0 ? 0 : (widths[open] ?? 0) + GAP);
  const shown = new Set<number>(open < 0 ? [] : [open]);

  for (const [index, width] of widths.entries()) {
    if (index === open) continue;

    if (width + GAP > left) break;
    shown.add(index);
    left -= width + GAP;
  }

  return shown;
}

/** What a pointer resting on the bar's opener reads: the pages behind it, by name. */
const titles = (pages: readonly PageTab[]): string => pages.map((page) => page.title).join(", ");

function PagesMenu({ pages, open, choose }: { readonly pages: readonly PageTab[]; readonly open: SurfaceKind | null; readonly choose: (key: SurfaceKind) => void }) {
  return (
    <div className="p-pages-menu p-overlay border p-border animate-fade-in" role="menu">
      {pages.map((page) => (
        <button key={page.key} type="button" role="menuitem" aria-current={page.key === open ? "true" : undefined} onClick={() => choose(page.key)}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left p-row-text p-text-2 hover:bg-[var(--c-elevated)] hover:p-text">
          <page.Icon size={14} className="shrink-0 p-text-3" aria-hidden /><span className="min-w-0 flex-1 truncate">{page.title}</span>
          {page.key === open && <CheckIcon size={12} className="shrink-0 p-accent" aria-hidden />}
        </button>
      ))}
    </div>
  );
}

function Pages({ surface, pages, choose }: { readonly surface: SurfaceKind | null; readonly pages: readonly PageTab[]; readonly choose: (next: SurfaceKind) => void }) {
  const strip = useRef<HTMLElement>(null);
  const sizes = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState<ReadonlySet<number>>(() => new Set(pages.keys()));
  const [picker, setPicker] = useState(false);
  const [menu, setMenu] = useState(false);
  const opened = pages.findIndex((page) => page.key === surface);
  const layout = pages.map((page) => `${page.key}:${page.title}`).join("|");

  useLayoutEffect(() => {
    const place = (): void => {
      const room = (strip.current?.clientWidth ?? 0) - 16;
      const widths = [...(sizes.current?.children ?? [])].map((chip) => chip.getBoundingClientRect().width);
      const fits = fitting(widths, opened, room);

      setShown(fits);
      setPicker(fits.size < widths.length && room - MORE - GAP < Math.min(MIN_OPEN, widths[opened] ?? MIN_OPEN));
    };

    place();
    const observer = new ResizeObserver(place);

    if (strip.current !== null) observer.observe(strip.current);

    return () => observer.disconnect();
  }, [layout, opened]);

  // A choice from the menu closes it; so does any page opening another way.
  useLayoutEffect(() => { setMenu(false); }, [surface]);

  const hidden = pages.filter((_page, index) => !shown.has(index));
  const current = pages[opened];
  const picked = picker && current !== undefined;

  return (
    <nav ref={strip} className="p-pages" aria-label="Pages">
      <span ref={sizes} className="p-pages-sizes" aria-hidden>
        {pages.map((page) => (
          <span key={page.key} className="p-page" data-open={page.key === surface ? "" : undefined}>
            <span className="p-page-link"><page.Icon size={14} />{page.title}</span>
            {/* The action's room, not the action: a measure mounts no second control. */}
            {page.key === surface && page.action !== undefined && <span className="w-[23px] shrink-0" />}
          </span>
        ))}
      </span>
      {picked ? (
        <span className="relative flex min-w-0">
          <button type="button" aria-expanded={menu} aria-haspopup="menu" aria-label={current.title} title={titles(pages)}
            className="p-page p-page-picker" data-open="" aria-current="true" onClick={() => setMenu(!menu)}>
            <current.Icon size={14} weight="fill" className="shrink-0" aria-hidden />
            <span className="truncate">{current.title}</span>
            <CaretDownIcon size={10} weight="bold" className="shrink-0 p-text-3" aria-hidden />
          </button>
          {current.action}
          {menu && <PagesMenu pages={pages} open={surface} choose={choose} />}
        </span>
      ) : (
        <ul className="p-pages-row">
          {pages.map((page, index) => shown.has(index) && (
            <li key={page.key} className="p-page" data-open={page.key === surface ? "" : undefined}>
              <button type="button" className="p-page-link" onClick={() => choose(page.key)} title={page.title} aria-label={page.title}
                aria-current={page.key === surface ? "true" : undefined}>
                <page.Icon size={14} weight={page.key === surface ? "fill" : "regular"} className="shrink-0" aria-hidden />
                <span className="truncate">{page.title}</span>
              </button>
              {page.key === surface && page.action}
            </li>
          ))}
        </ul>
      )}
      {!picked && hidden.length > 0 && (
        <span className="relative flex shrink-0">
          {/* With none beside the tools, the count says what it counts. */}
          <button type="button" aria-expanded={menu} aria-haspopup="menu" aria-label={`${String(hidden.length)} more pages`} title={titles(hidden)}
            className="p-bar-more" onClick={() => setMenu(!menu)}>
            {shown.size === 0 ? <>{hidden.length} {hidden.length === 1 ? "page" : "pages"}<CaretDownIcon size={10} weight="bold" aria-hidden /></> : `+${String(hidden.length)}`}
          </button>
          {menu && <PagesMenu pages={hidden} open={surface} choose={choose} />}
        </span>
      )}
    </nav>
  );
}

export function InspectorBar({ surface, pages, tools, choose, trailing }: {
  surface: SurfaceKind | null;
  pages: readonly PageTab[];
  tools: readonly ToolTab[];
  choose: (next: SurfaceKind) => void;
  trailing: ReactNode;
}) {
  return (
    <div className="p-bar p-bar-inspector @container">
      {pages.length > 0 ? <Pages surface={surface} pages={pages} choose={choose} /> : <span className="flex-1" />}
      <div className="p-bar-trailing">{trailing}</div>
      <nav className="p-tools" aria-label="Workspace">
        <ul className="p-tools-list">
          {tools.map(({ key, count }) => {
            const { name, Icon: ToolIcon, about } = TOOLS[key];
            const current = key === surface;
            const counted = count === undefined ? name : `${name} · ${String(count.value)}`;

            return (
              <li key={key}>
                <Tooltip side="bottom" content={about === undefined ? counted : <><span>{counted}</span><span className="p-text-3">{about}</span></>}
                  render={<button type="button" className="p-tool" onClick={() => choose(key)} aria-label={name}
                    aria-current={current ? "true" : undefined} />}>
                  <ToolIcon size={15} weight={current ? "fill" : "regular"} className="shrink-0" aria-hidden />
                  {current && <span className="p-tool-name">{name}</span>}
                  {count !== undefined && <span className="p-tool-count" data-accent={count.accent ? "" : undefined}>{count.value}</span>}
                </Tooltip>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
