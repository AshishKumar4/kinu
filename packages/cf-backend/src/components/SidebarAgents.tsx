import { useEffect, useRef } from "react";
import { ArrowLeftIcon, UsersThreeIcon } from "@phosphor-icons/react";
import { fmtPct, fmtSpan, fmtTokens, fmtUsd, workspaceDisplayTitle, type AgentCategory, type PanelAgent } from "@kinu.run/core";
import { useAgentsNav, useDrilledPanel, type WorkspaceAgentsPanel } from "@/hooks/use-agents-nav";
import { useWorkspaceRoster } from "@/hooks/use-workspace-roster";
import { navRowCls } from "./nav";

const SECTIONS: readonly { readonly category: AgentCategory; readonly title: string }[] = [
  { category: "main", title: "Main" },
  { category: "user", title: "Yours" },
  { category: "hired", title: "Hired" },
  { category: "swarm", title: "Swarm · view only" },
  { category: "background", title: "Background" },
];

const ACTIVITY = {
  working: { word: "Working", dot: "p-dot-accent p-dot-pulse" },
  waiting: { word: "Needs you", dot: "bg-[var(--c-warning)]" },
  idle: { word: "Idle", dot: "bg-[var(--c-text-3)] opacity-50" },
  done: { word: "Done", dot: "bg-[var(--c-success)]" },
  stopped: { word: "Stopped", dot: "bg-[var(--c-text-3)]" },
  failed: { word: "Failed", dot: "bg-[var(--c-danger)]" },
  dismissed: { word: "Dismissed", dot: "bg-[var(--c-text-3)] opacity-30" },
} satisfies Record<PanelAgent["activity"], { word: string; dot: string }>;

function agentFiguresLine({ tokens, usd, activeMs, cacheEma }: PanelAgent["figures"]): string {
  return [
    tokens === undefined ? null : `${fmtTokens(tokens)} tok`,
    usd === undefined ? null : fmtUsd(usd),
    activeMs === 0 ? null : fmtSpan(activeMs),
    cacheEma === null ? null : `${fmtPct(cacheEma)} cached`,
  ].filter((part) => part !== null).join(" · ");
}

function hiredDepth(agent: PanelAgent, hiredPaths: ReadonlySet<string>): number {
  if (agent.open.kind !== "chat" || agent.open.path === null) return 0;
  const segments = agent.open.path.split("/");

  return segments.slice(1).filter((_, index) => hiredPaths.has(segments.slice(0, index + 1).join("/"))).length;
}

function pathOf(agent: PanelAgent): string {
  return agent.open.kind === "chat" ? agent.open.path ?? "" : "";
}

export function SidebarAgents({ workspace }: { workspace: string | undefined }) {
  const panel = useDrilledPanel(workspace);

  return panel === null ? null : <AgentsList panel={panel} />;
}

function AgentsList({ panel }: { panel: WorkspaceAgentsPanel }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const { back } = useAgentsNav();
  const listed = useWorkspaceRoster().entries.find((entry) => entry.name === panel.workspace);
  const title = workspaceDisplayTitle(listed ?? { name: panel.workspace });

  useEffect(() => { heading.current?.focus(); }, []);

  const hired = panel.list.filter((agent) => agent.category === "hired");
  const hiredPaths = new Set(hired.map(pathOf));

  const sections = SECTIONS.map((section) => {
    const rows = panel.list.filter((agent) => agent.category === section.category);

    return { ...section, rows: section.category === "hired" ? [...rows].sort((a, b) => pathOf(a).localeCompare(pathOf(b))) : rows };
  }).filter((section) => section.rows.length > 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-sidebar-agents={panel.workspace}>
      <div className="px-2 pt-1">
        <button type="button" onClick={back} data-agents-back
          className={`flex w-full items-center gap-2 rounded-lg px-3 py-[7px] p-row-text transition-colors ${navRowCls(false)}`}>
          <ArrowLeftIcon size={14} aria-hidden="true" /> Workspaces
        </button>
      </div>
      <h2 ref={heading} tabIndex={-1} className="flex items-center gap-2 px-5 pb-1 pt-3 text-sm font-semibold p-text outline-none">
        <UsersThreeIcon size={15} aria-hidden="true" className="p-text-3" />
        <span className="min-w-0 truncate">{title}</span>
      </h2>
      <div className="flex-1 overflow-y-auto pb-3">
        {sections.map((section) => (
          <section key={section.category} aria-label={section.title}>
            <div className="px-5 pb-1.5 pt-3 p-eyebrow">{section.title}</div>
            <ul className="space-y-0.5 px-2">
              {section.rows.map((agent) => {
                const status = ACTIVITY[agent.activity];
                const depth = section.category === "hired" ? hiredDepth(agent, hiredPaths) : 0;
                const figures = agentFiguresLine(agent.figures);
                const topHired = section.category === "hired" && depth === 0;
                const from = agent.parent !== null && (section.category !== "hired" || topHired) && section.category !== "main" ? agent.parent : null;

                return (
                  <li key={agent.key}>
                    <button type="button" onClick={() => panel.open(agent)} data-agent-row={agent.key}
                      aria-current={panel.shown === agent.key ? "true" : undefined}
                      style={depth === 0 ? undefined : { paddingLeft: `${String(0.75 + depth)}rem` }}
                      className={`flex w-full items-start gap-2 rounded-lg px-3 py-[6px] text-left transition-colors ${navRowCls(panel.shown === agent.key)}`}>
                      <span aria-hidden="true" className={`mt-[7px] size-1.5 shrink-0 rounded-full ${status.dot}`} title={status.word} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate p-row-text">{agent.label}<span className="sr-only">, {status.word}</span></span>
                        {from !== null && <span className="block truncate p-meta p-text-3">from {from}</span>}
                        {figures !== "" && <span className="block p-meta tabular-nums p-text-3" data-agent-figures>{figures}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
