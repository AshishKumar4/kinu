/** Read-only: the agent re-reads this plan every step, so an owner edit would swap it under a running turn. */
import { Badge } from "@/components/ui/Badge";
import { CircleIcon, CircleDashedIcon, CheckCircleIcon, ProhibitIcon, SparkleIcon } from "@phosphor-icons/react";
import { taskSettled, type AgentTask, type AgentTaskTree, type PanelAgent, type TaskStatus, type WorkspaceWorkOwner } from "@kinu.run/core";
import { toneInk } from "@/components/ui/Status";
import { Pressable } from "@/components/ui/Pressable";
import { InlineAction } from "@/components/ui/InlineAction";
import { GroupBlock } from "@/components/ui/Group";

const STATUS_META = {
  open: { icon: CircleDashedIcon, tone: toneInk("neutral"), label: "Open", weight: "regular", text: "p-text-2" },
  active: { icon: CircleIcon, tone: toneInk("live"), label: "Active", weight: "fill", text: "t-item p-text" },
  done: { icon: CheckCircleIcon, tone: toneInk("success"), label: "Done", weight: "fill", text: "p-text-3 line-through" },
  dropped: { icon: ProhibitIcon, tone: toneInk("neutral"), label: "Dropped", weight: "regular", text: "p-text-3 line-through" },
} satisfies Record<TaskStatus, { icon: typeof CircleIcon; tone: string; label: string; weight: "fill" | "regular"; text: string }>;

interface TaskOwnership {
  owner?: WorkspaceWorkOwner;
  onOpenOwner?: ((name: string, actorId: string) => void | Promise<void>) | undefined;
}

function OwnerMark({ owner, onOpenOwner }: TaskOwnership) {
  if (owner === undefined) return null;

  const path = owner.path ?? [];

  if (onOpenOwner === undefined || path.length === 0) return <span className="t-meta p-text-3"> · {owner.title}</span>;

  return (
    <> · <InlineAction aria-label={`Open ${owner.title}'s conversation`} onClick={() => void onOpenOwner(path.join("/"), owner.actorId)}>{owner.title}</InlineAction></>
  );
}

function TaskRow({ task, depth, owner, onOpenOwner }: { task: AgentTask; depth: number } & TaskOwnership) {
  const meta = STATUS_META[task.status];
  const Icon = meta.icon;

  return (
    <div
      className={`flex items-start gap-2 py-1 ${depth > 0 ? "ml-4 pl-3 border-l p-border" : ""}`}
      title={meta.label}
      data-task-depth={depth}
    >
      <Icon
        size={14}
        weight={meta.weight}
        className={`${meta.tone} shrink-0 mt-px`}
      />
      <span className="flex h-5 shrink-0 items-center"><code className="t-meta t-mono p-text-3 w-7">{task.id}</code></span>
      <span className={`t-body min-w-0 break-words ${meta.text}`} data-task-title>
        {task.title}
        <OwnerMark owner={owner} onOpenOwner={onOpenOwner} />
        {task.note && <span className="t-meta block p-text-3 mt-px">{task.note}</span>}
      </span>
    </div>
  );
}

export function TaskTree({ task, grouped = false, owner, onOpenOwner }: { task: AgentTaskTree; grouped?: boolean } & TaskOwnership) {
  return (
    <GroupBlock grouped={grouped} className="px-3 py-2">
      <TaskRow task={task} depth={0} owner={owner} onOpenOwner={onOpenOwner} />
      {task.subtasks.map((sub) => <TaskRow key={sub.id} task={sub} depth={1} owner={owner} onOpenOwner={onOpenOwner} />)}
    </GroupBlock>
  );
}

export function PlanProgress({ tasks }: { tasks: AgentTaskTree[] }) {
  const rows = tasks.flatMap((task) => [task, ...task.subtasks]);
  const remaining = rows.filter((task) => !taskSettled(task.status));
  const active = remaining.filter((task) => task.status === "active");
  // Dropped items are out of the denominator: neither outstanding nor done.
  const counted = rows.filter((task) => task.status !== "dropped").length;

  return (
    <div className="flex items-center gap-2">
      <span className="t-status p-text-2">{remaining.length} of {counted} still to do</span>
      {active.length > 0 && <Badge>{active.length} active</Badge>}
    </div>
  );
}

const SUBAGENT_ACTIVITY: Record<PanelAgent["activity"], string> = {
  working: "refining from recent turns",
  waiting: "waiting",
  idle: "answered",
  done: "answered",
  dismissed: "finished",
  stopped: "stopped",
  failed: "failed",
};

export function SubagentRow({ agent, onOpen }: { agent: PanelAgent; onOpen?: (agent: PanelAgent) => void }) {
  const text = (
    <>
      <SparkleIcon size={14} className="mt-px shrink-0 p-text-2" />
      <span className="t-body">{agent.label} <span className="p-text-3">· {SUBAGENT_ACTIVITY[agent.activity]}</span></span>
    </>
  );

  if (!onOpen) return <div className="flex items-start gap-2 py-1" data-subagent-row={agent.key}>{text}</div>;

  return (
    <Pressable className="flex items-start gap-2 py-1" data-subagent-row={agent.key} onClick={() => onOpen(agent)}>
      {text}
    </Pressable>
  );
}
