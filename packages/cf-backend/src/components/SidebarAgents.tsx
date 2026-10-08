import { useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { fmtPct, fmtSpan, fmtTokens, fmtUsd, type PanelAgent } from "@kinu.run/core";
import type { WorkspaceAgentsPanel } from "@/hooks/use-agents-nav";
import { AgentStatusMark } from "./AgentStatus";
import { ChatMascot, mascotColour, mascotSeed } from "./Marks";
import { navRowCls } from "./nav";

/** Agents nobody talks to: listed apart, folded until asked for. */
const GROUPS: readonly { readonly category: PanelAgent["category"]; readonly title: string }[] = [
  { category: "swarm", title: "Swarms" },
  { category: "background", title: "Background" },
];

function figuresLine({ tokens, usd, activeMs, cacheEma }: PanelAgent["figures"]): string {
  return [
    tokens === undefined ? null : `${fmtTokens(tokens)} tokens`,
    usd === undefined ? null : fmtUsd(usd),
    activeMs > 0 ? fmtSpan(activeMs) : null,
    cacheEma === null ? null : `${fmtPct(cacheEma)} cached`,
  ].filter((part) => part !== null).join(" · ");
}

/** The person's chats, each with the agents it started nested under it; swarms and helpers in folded groups below. */
export function SidebarAgents({ panel, onBack }: { panel: WorkspaceAgentsPanel; onBack: () => void }) {
  const back = useRef<HTMLButtonElement>(null);
  const chats = panel.list.filter((agent) => agent.category === "main" || (agent.category === "user" && agent.parent === "main"));

  useEffect(() => { back.current?.focus({ preventScroll: true }); }, []);

  return (
    <div className="flex h-full min-h-0 flex-col" data-sidebar-agents={panel.workspace}>
      <div className="px-2 pb-1 pt-2">
        <button ref={back} type="button" onClick={onBack} data-agents-back
          className={`flex w-full items-center gap-2 rounded-lg px-3 py-[7px] p-row-text transition-colors ${navRowCls(false, "p-text-3")}`}>
          <ArrowLeftIcon size={14} aria-hidden="true" /> Workspaces
        </button>
      </div>
      <nav aria-label="Agents in this workspace" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-1">
        <ul className="space-y-px">
          {chats.map((chat) => <AgentBranch key={chat.key} agent={chat} panel={panel} />)}
        </ul>
      </nav>
      <div className="flex flex-col gap-px px-2 pb-2">
        {GROUPS.map(({ category, title }) => {
          const members = panel.list.filter((agent) => agent.category === category);

          return members.length === 0 ? null : <AgentGroup key={category} title={title} members={members} panel={panel} />;
        })}
      </div>
    </div>
  );
}

function AgentBranch({ agent, panel }: { agent: PanelAgent; panel: WorkspaceAgentsPanel }) {
  const children = panel.list.filter((child) => child.parent === agent.key && child.category === "hired");

  return (
    <li>
      <AgentRow agent={agent} panel={panel} />
      {children.length > 0 && (
        <ul className="p-nest ml-4">
          {children.map((child) => <AgentBranch key={child.key} agent={child} panel={panel} />)}
        </ul>
      )}
    </li>
  );
}

function AgentRow({ agent, panel }: { agent: PanelAgent; panel: WorkspaceAgentsPanel }) {
  const shown = panel.shown === agent.key;
  const figures = figuresLine(agent.figures);

  return (
    <button type="button" onClick={() => panel.open(agent)} data-agent-row={agent.key} data-status={agent.activity}
      aria-current={shown ? "page" : undefined} title={figures === "" ? undefined : figures}
      className={`p-halo relative flex w-full min-w-0 items-center gap-2 rounded-lg py-[6px] pl-2.5 pr-3 text-left transition-colors ${navRowCls(shown)}`}>
      {/* A chat and a hire each wear their own mascot; a swarm worker or a background helper, its state mark. */}
      {agent.tab || agent.category === "hired" || agent.category === "user"
        ? <ChatMascot seed={mascotSeed(panel.workspace, agent.key)} colour={mascotColour(panel.workspace, agent.colour)} activity={agent.activity} />
        : <span className="flex w-4 shrink-0 justify-center"><AgentStatusMark activity={agent.activity} /></span>}
      <span className="p-status-label min-w-0 flex-1 truncate p-row-text">{agent.label}</span>
    </button>
  );
}

function AgentGroup({ title, members, panel }: { title: string; members: readonly PanelAgent[]; panel: WorkspaceAgentsPanel }) {
  const [open, setOpen] = useState(() => members.some((agent) => agent.key === panel.shown));
  const busy = members.some((agent) => agent.activity === "working");

  return (
    <section aria-label={title}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className={`flex w-full items-center gap-2 rounded-lg py-[6px] pl-2.5 pr-3 text-left transition-colors ${navRowCls(false, "p-text-3")}`}>
        <CaretRightIcon size={11} className={`w-[13px] shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`} aria-hidden />
        <span className="min-w-0 flex-1 truncate p-t-control">{title}</span>
        {busy && <AgentStatusMark activity="working" />}
        <span className="p-meta tabular-nums p-text-4">{members.length}</span>
      </button>
      <div className="p-fold" data-folded={open ? undefined : ""}>
        <div inert={!open}>
          <ul className="p-nest ml-4 max-h-[40vh] overflow-y-auto">
            {members.map((agent) => <AgentBranch key={agent.key} agent={agent} panel={panel} />)}
          </ul>
        </div>
      </div>
    </section>
  );
}
