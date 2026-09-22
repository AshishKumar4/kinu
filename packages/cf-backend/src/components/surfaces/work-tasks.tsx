/** Read-only: the agent re-reads this plan every step, so an owner edit would swap it under a running turn. */
import { Badge } from "@cloudflare/kumo";
import { CircleIcon, CircleDashedIcon, CheckCircleIcon, ProhibitIcon } from "@phosphor-icons/react";
import type { AgentTask, AgentTaskTree, TaskStatus } from "@kinu.run/core";

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

function TaskRow({ task, depth, owner }: { task: AgentTask; depth: number; owner?: string }) {
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
        {owner && <span className="p-meta p-text-3"> · {owner}</span>}
        {task.note && <span className="block p-meta p-text-3 mt-0.5">{task.note}</span>}
      </span>
    </div>
  );
}

export function TaskTree({ task, grouped = false, owner }: { task: AgentTaskTree; grouped?: boolean; owner?: string }) {
  return (
    <div className={grouped ? "px-3 py-2" : "p-group px-3 py-2"}>
      <TaskRow task={task} depth={0} owner={owner} />
      {task.subtasks.map((sub) => <TaskRow key={sub.id} task={sub} depth={1} owner={owner} />)}
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
