/** The inspector's bar: the open pages on the left, the workspace's own tools pinned at the right. */
import { useRef, type ReactNode } from "react";
import {
  BrainIcon, FolderSimpleIcon, GaugeIcon, GitDiffIcon, ListChecksIcon, TerminalWindowIcon, TreeStructureIcon, type Icon,
} from "@phosphor-icons/react";
import { Tooltip } from "@cloudflare/kumo";
import { ACTIVITY_SURFACE, type SURFACES, type SurfaceKind } from "@kinu.run/core";
import { TabOutline, useTabOutline } from "@/components/ui/TabOutline";
import { useWheelScrollsSideways } from "@/hooks/use-wheel-scrolls-sideways";

interface ToolSpec { readonly name: string; readonly Icon: Icon; readonly about?: string }

/** The workspace's own tools, pinned at the bar's right as icon tabs: the name is the tooltip and the accessible name. */
const TOOLS: Record<(typeof SURFACES)[number] | typeof ACTIVITY_SURFACE, ToolSpec> = {
  Work: { name: "Work", Icon: ListChecksIcon },
  Changes: { name: "Changes", Icon: GitDiffIcon },
  Files: { name: "Files", Icon: FolderSimpleIcon },
  Swarms: { name: "Swarms", Icon: TreeStructureIcon },
  Agent: { name: "Agent", Icon: BrainIcon },
  Environment: { name: "Environment", Icon: TerminalWindowIcon },
  [ACTIVITY_SURFACE]: { name: "Activity", Icon: GaugeIcon, about: "Context, cost, and cache" },
};

type ToolKind = keyof typeof TOOLS;

/** A page's tab; `action` sits on it as a chat tab's rename does, shown on hover and on the open tab. */
export interface PageTab { readonly key: SurfaceKind; readonly title: string; readonly Icon: Icon; readonly action?: ReactNode }

export interface ToolTab { readonly key: ToolKind; readonly count?: { readonly value: number; readonly accent: boolean } | undefined }

/** The column's bar, in the chat bar's grammar: the pages (Slates and previews) are tabs on the left, and the workspace's
 *  own tools are pinned at the right as icon tabs, so no number of pages pushes a tool out of reach. */
export function InspectorBar({ surface, pages, tools, choose, trailing }: {
  surface: SurfaceKind | null;
  pages: readonly PageTab[];
  tools: readonly ToolTab[];
  choose: (next: SurfaceKind) => void;
  trailing: ReactNode;
}) {
  const pageList = useRef<HTMLUListElement>(null);
  const toolList = useRef<HTMLUListElement>(null);
  // Each list draws the open tab's outline only when the tab is its own; the other runs flat.
  const openPage = pages.some((page) => page.key === surface) ? surface : null;
  const openTool = tools.some((tool) => tool.key === surface) ? surface : null;
  const pageOutline = useTabOutline(pageList, openPage, pages.map((page) => `${page.key}:${page.title}`).join("|"));
  const toolOutline = useTabOutline(toolList, openTool, tools.map((tool) => `${tool.key}:${String(tool.count?.value ?? "")}`).join("|"));

  useWheelScrollsSideways(pageList);

  return (
    <div className="p-bar p-bar-inspector">
      <nav className="p-bar-strip" data-overflow={pageOutline.overflow} aria-label="Pages">
        <ul ref={pageList} className="p-bar-tabs">
          {pages.map((page, index) => (
            <li key={page.key} className="p-bar-tab" data-key={page.key} data-active={page.key === surface ? "" : undefined}
              data-after-active={index > 0 && pages[index - 1]?.key === surface ? "" : undefined}>
              <span className="p-bar-sizer" aria-hidden><page.Icon size={14} />{page.title}</span>
              <button type="button" className="p-bar-link" onClick={() => choose(page.key)} title={page.title} aria-label={page.title}
                aria-current={page.key === surface ? "true" : undefined}>
                <page.Icon size={14} className="shrink-0" /><span className="truncate">{page.title}</span>
              </button>
              {page.action !== undefined && <span className="p-bar-actions">{page.action}</span>}
            </li>
          ))}
          <TabOutline outline={pageOutline} />
        </ul>
      </nav>
      <div className="p-bar-trailing">{trailing}</div>
      <nav className="p-bar-strip p-bar-tools" aria-label="Workspace">
        <ul ref={toolList} className="p-bar-tabs">
          {tools.map(({ key, count }) => {
            const { name, Icon: ToolIcon, about } = TOOLS[key];
            const badge = count === undefined ? null : <span className={`p-t-status ${count.accent ? "p-accent" : ""}`}>{count.value}</span>;

            return (
              <li key={key} className="p-bar-tab" data-key={key} data-active={key === surface ? "" : undefined}>
                <span className="p-bar-sizer" aria-hidden><ToolIcon size={16} />{badge}</span>
                <Tooltip side="bottom" content={about === undefined ? name : <><span>{name}</span><span className="p-text-3">{about}</span></>}
                  render={<button type="button" className="p-bar-link" onClick={() => choose(key)} aria-label={name}
                    aria-current={key === surface ? "true" : undefined} />}>
                  <ToolIcon size={16} className="shrink-0" aria-hidden />{badge}
                </Tooltip>
              </li>
            );
          })}
          <TabOutline outline={toolOutline} />
        </ul>
      </nav>
    </div>
  );
}
