/** The workspace's page: where things stand, its GitHub work, and every agent's tasks; each section reads a real
 *  source or says none exists yet. */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import type { AgentTaskTree, PanelAgent, Rpc, WorkspaceWork, WorkspaceWorkOwner } from "@kinu.run/core";
import type { ForkLineage, ReadMoves } from "@/hooks/use-kinu";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { AgentStatusMark } from "@/components/AgentStatus";
import { GitHubSection } from "@/components/workspaces/GitHubSection";
import { WorkspaceLogo } from "@/components/Marks";

type Lane = "todo" | "doing" | "waiting" | "done";

const LANES: readonly { readonly lane: Lane; readonly title: string }[] = [
  { lane: "todo", title: "To do" },
  { lane: "doing", title: "In progress" },
  { lane: "waiting", title: "Waiting on you" },
  { lane: "done", title: "Done" },
];

interface Card {
  readonly id: string;
  readonly title: string;
  readonly owner: WorkspaceWorkOwner;
  readonly agent: PanelAgent | undefined;
  readonly progress: { readonly done: number; readonly total: number } | null;
  readonly lane: Lane;
}

/** A task's lane: its own status, except that open work held by an agent waiting on the person waits with it. */
function laneOf(task: AgentTaskTree, agent: PanelAgent | undefined): Lane | null {
  if (task.status === "dropped") return null;

  if (task.status === "done") return "done";

  if (agent?.activity === "waiting") return "waiting";

  return task.status === "active" ? "doing" : "todo";
}

function cardsOf(work: WorkspaceWork, agents: readonly PanelAgent[]): Card[] {
  const agentOf = (owner: WorkspaceWorkOwner) => agents.find((agent) => agent.actorId === owner.actorId);

  const tasks = [...work.tasks, ...work.plans].flatMap(({ owner, tasks: trees }) => trees.flatMap((task) => {
    const agent = agentOf(owner);
    const lane = laneOf(task, agent);
    const live = task.subtasks.filter((sub) => sub.status !== "dropped");

    return lane === null ? [] : [{
      id: `${owner.actorId}/${task.id}`, title: task.title, owner, agent, lane,
      progress: live.length === 0 ? null : { done: live.filter((sub) => sub.status === "done").length, total: live.length },
    }];
  }));

  const reviews = work.plans.filter(({ plan }) => plan.status === "pending").map(({ owner, plan }) => ({
    id: `${owner.actorId}/plan/${plan.id}`, title: `Review the plan: ${(plan.content.match(/^#\s+(.+)$/m)?.[1] ?? "untitled").replaceAll("`", "")}`,
    owner, agent: agentOf(owner), lane: "waiting" as const, progress: null,
  }));

  return [...reviews, ...tasks];
}

function summaryOf(agents: readonly PanelAgent[], cards: readonly Card[]): string {
  const chats = agents.filter((agent) => agent.tab).length;
  const working = agents.filter((agent) => agent.activity === "working").length;
  const waiting = agents.filter((agent) => agent.activity === "waiting").length;
  const done = cards.filter((card) => card.lane === "done").length;

  return [
    `${chats} ${chats === 1 ? "chat" : "chats"}`,
    working > 0 ? `${working} ${working === 1 ? "agent" : "agents"} working` : "nothing running",
    ...(waiting > 0 ? [`${waiting} waiting on you`] : []),
    cards.length === 0 ? "no tasks yet" : `${done} of ${cards.length} tasks done`,
  ].join(" · ");
}

export function WorkspaceOverview({ workspace, title, logo, rpc, readMoves, lineage, agents, open }: {
  workspace: string;
  title: string;
  logo: string | null | undefined;
  rpc: Rpc;
  readMoves: ReadMoves;
  lineage: ForkLineage | null;
  agents: readonly PanelAgent[];
  open: (agent: PanelAgent) => void;
}) {
  const load = useCallback(() => rpc<WorkspaceWork>("listWorkspaceWork", []), [rpc]);
  const { resource, reload } = useAsyncResource(load);
  const work = lastValue(resource);
  const moves = readMoves.listWorkspaceWork ?? 0;
  const seen = useRef(moves);

  useEffect(() => {
    if (seen.current === moves) return;
    seen.current = moves;
    reload();
  }, [moves, reload]);

  const cards = useMemo(() => (work === null ? [] : cardsOf(work, agents)), [work, agents]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-workspace-overview>
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-10 px-5 pb-16 pt-9 sm:px-8">
        <header className="flex items-center gap-4">
          <WorkspaceLogo title={title} logo={logo} size={44} />
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="p-display text-[26px] font-semibold leading-tight p-text">{title}</h1>
            <p className="text-[13.5px] p-text-3" data-overview-summary>
              {work === null ? "Reading the workspace…" : summaryOf(agents, cards)}
              {lineage && <> · forked from <Link to={`/workspace/${lineage.sourceWorkspaceName}`} className="p-accent hover:underline">its parent</Link></>}
            </p>
          </div>
        </header>

        <section aria-labelledby="overview-github" className="flex flex-col gap-3">
          <h2 id="overview-github" className="p-eyebrow">GitHub</h2>
          <GitHubSection rpc={rpc} readMoves={readMoves} agents={agents} />
        </section>

        <section aria-labelledby="overview-tasks" className="flex flex-col gap-3">
          <h2 id="overview-tasks" className="p-eyebrow">Tasks</h2>
          {resource.status === "error" && work === null
            ? <LoadFailure what="this workspace's tasks" message={resource.message} onRetry={reload} />
            : <Board cards={cards} workspace={workspace} loaded={work !== null} open={open} />}
        </section>
      </div>
    </div>
  );
}

function Board({ cards, workspace, loaded, open }: { cards: readonly Card[]; workspace: string; loaded: boolean; open: (agent: PanelAgent) => void }) {
  if (loaded && cards.length === 0) {
    return <p className="rounded-xl border border-dashed p-border px-4 py-6 text-center p-meta p-text-3">No tasks yet. When an agent plans its work with the tasks tool, each task lands here.</p>;
  }

  return (
    <div className="-mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
      <div className="grid min-w-[760px] grid-cols-4 gap-3">
        {LANES.map(({ lane, title }) => {
          const shown = cards.filter((card) => card.lane === lane);

          return (
            <div key={lane} className="flex min-w-0 flex-col gap-2 rounded-2xl bg-[var(--c-neutral-tint)] p-2" data-lane={lane}>
              <div className="flex items-baseline justify-between px-2 pb-0.5 pt-1.5">
                <span className={`text-[13px] font-medium ${lane === "waiting" && shown.length > 0 ? "p-accent" : "p-text-2"}`}>{title}</span>
                <span className="p-meta tabular-nums p-text-4">{shown.length}</span>
              </div>
              {shown.map((card) => <TaskCard key={card.id} card={card} workspace={workspace} open={open} />)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const CARD_CLASS = "group flex flex-col gap-2.5 rounded-xl border p-border bg-[var(--c-bg)] px-3 py-2.5 text-left transition-colors hover:border-[var(--c-border-strong)]";

function TaskCard({ card, workspace, open }: { card: Card; workspace: string; open: (agent: PanelAgent) => void }) {
  const { agent } = card;

  if (agent !== undefined) {
    return <button type="button" data-task-card onClick={() => open(agent)} className={CARD_CLASS}><TaskBody card={card} /></button>;
  }

  const path = card.owner.path;
  const to = path === null || path.length === 0 ? `/workspace/${workspace}` : `/workspace/${workspace}/agents/${path.map(encodeURIComponent).join("/")}`;

  return <Link to={to} data-task-card className={CARD_CLASS}><TaskBody card={card} /></Link>;
}

function TaskBody({ card }: { card: Card }) {
  return (
    <>
      <span className={`text-[13.5px] leading-snug ${card.lane === "done" ? "p-text-3 line-through decoration-[var(--c-border-strong)]" : "p-text"}`}>{card.title}</span>
      <span className="flex items-center gap-2 text-[12px] p-text-3">
        {card.agent && <AgentStatusMark activity={card.agent.activity} />}
        <span className="min-w-0 truncate">{card.agent?.label ?? card.owner.title}</span>
        {card.progress && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 tabular-nums" aria-label={`${card.progress.done} of ${card.progress.total} steps done`}>
            <span className="relative h-1 w-10 overflow-hidden rounded-full bg-[var(--c-neutral-tint)]">
              <span className="absolute inset-y-0 left-0 rounded-full bg-[var(--c-accent-mark)]" style={{ width: `${(100 * card.progress.done) / card.progress.total}%` }} />
            </span>
            {card.progress.done}/{card.progress.total}
          </span>
        )}
      </span>
    </>
  );
}
