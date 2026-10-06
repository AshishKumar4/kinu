/** Read-only: the agent re-reads this plan every step, so an owner edit would swap it under a running turn. */
import { Badge } from "@cloudflare/kumo";
import { CircleIcon, CircleDashedIcon, CheckCircleIcon, ProhibitIcon, SparkleIcon } from "@phosphor-icons/react";
import type { AgentTask, AgentTaskTree, PanelAgent, TaskStatus, WorkspaceWorkOwner } from "@kinu.run/core";

const STATUS_META = {
  open: { icon: CircleDashedIcon, tone: "p-text-3", label: "Open", weight: "regular", text: "p-text-2" },
  active: { icon: CircleIcon, tone: "p-accent", label: "Active", weight: "fill", text: "p-text font-medium" },
  done: { icon: CheckCircleIcon, tone: "p-success", label: "Done", weight: "fill", text: "p-text-3 line-through" },
  dropped: { icon: ProhibitIcon, tone: "p-text-3", label: "Dropped", weight: "regular", text: "p-text-3 line-through" },
} satisfies Record<TaskStatus, { icon: typeof CircleIcon; tone: string; label: string; weight: "fill" | "regular"; text: string }>;

function isSettled(status: TaskStatus): boolean {
  return status === "done" || status === "dropped";
}

export function isClosedTree(task: AgentTaskTree): boolean {
  return isSettled(task.status) && task.subtasks.every((sub) => isSettled(sub.status));
}

interface TaskOwnership {
  owner?: WorkspaceWorkOwner;
  onOpenOwner?: ((name: string, actorId: string) => void | Promise<void>) | undefined;
}

function OwnerMark({ owner, onOpenOwner }: TaskOwnership) {
  if (owner === undefined) return null;

  const path = owner.path ?? [];

  if (onOpenOwner === undefined || path.length === 0) return <span className="p-meta p-text-3"> · {owner.title}</span>;

  return (
    <> · <button type="button" className="p-meta p-accent hover:underline" aria-label={`Open ${owner.title}'s conversation`}
      onClick={() => void onOpenOwner(path.join("/"), owner.actorId)}>{owner.title}</button></>
  );
}

function TaskRow({ task, depth, owner, onOpenOwner }: { task: AgentTask; depth: number } & TaskOwnership) {
  const meta = STATUS_META[task.status];
  const Icon = meta.icon;

  return (
    <div
      className={`flex items-start gap-2 py-1 ${depth > 0 ? "ml-4 pl-3 border-l p-border" : ""}`}
      title={meta.label}
    >
      <Icon
        size={13}
        weight={meta.weight}
        className={`${meta.tone} shrink-0 mt-0.5`}
      />
      <code className="p-annotation p-text-3 shrink-0 mt-[3px] w-7">{task.id}</code>
      <span className={`p-row-text min-w-0 break-words ${meta.text}`}>
        {task.title}
        <OwnerMark owner={owner} onOpenOwner={onOpenOwner} />
        {task.note && <span className="block p-meta p-text-3 mt-0.5">{task.note}</span>}
      </span>
    </div>
  );
}

export function TaskTree({ task, grouped = false, owner, onOpenOwner }: { task: AgentTaskTree; grouped?: boolean } & TaskOwnership) {
  return (
    <div className={grouped ? "px-3 py-2" : "p-group px-3 py-2"}>
      <TaskRow task={task} depth={0} owner={owner} onOpenOwner={onOpenOwner} />
      {task.subtasks.map((sub) => <TaskRow key={sub.id} task={sub} depth={1} owner={owner} onOpenOwner={onOpenOwner} />)}
    </div>
  );
}

export function PlanProgress({ tasks }: { tasks: AgentTaskTree[] }) {
  const rows = tasks.flatMap((task) => [task, ...task.subtasks]);
  const remaining = rows.filter((task) => !isSettled(task.status));
  const active = remaining.filter((task) => task.status === "active");
  // Dropped items are out of the denominator: neither outstanding nor done.
  const counted = rows.filter((task) => task.status !== "dropped").length;

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs p-text-2 font-medium">{remaining.length} of {counted} still to do</span>
      {active.length > 0 && <Badge variant="secondary">{active.length} active</Badge>}
    </div>
  );
}

const HELPER_ACTIVITY: Record<PanelAgent["activity"], string> = {
  working: "refining from recent turns",
  waiting: "waiting",
  idle: "answered",
  done: "answered",
  dismissed: "finished",
  stopped: "stopped",
  failed: "failed",
};

export function HelperRow({ agent, onOpen }: { agent: PanelAgent; onOpen?: (agent: PanelAgent) => void }) {
  const text = (
    <>
      <SparkleIcon size={14} className="mt-0.5 shrink-0 p-text-2" />
      <span className="p-row-text">{agent.label} <span className="p-text-3">· {HELPER_ACTIVITY[agent.activity]}</span></span>
    </>
  );

  if (!onOpen) return <div className="flex items-start gap-2 py-1" data-helper-row={agent.key}>{text}</div>;

  return (
    <button type="button" data-helper-row={agent.key} onClick={() => onOpen(agent)} className="flex w-full items-start gap-2 rounded-md py-1 text-left transition-colors hover:p-elevated">
      {text}
    </button>
  );
}
