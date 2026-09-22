/**
 * The agent's own plan, as the agent keeps it.
 *
 * Read-only, deliberately. The list is the agent's plan: it writes it with the
 * `tasks` tool and re-reads its open half out of the live context block at
 * every step, so an owner edit here would swap the plan underneath a running
 * turn with nothing to tell it so. Changing what the agent is doing already
 * has a channel — say so in chat — and one writer is what keeps this list and
 * the agent's own view of it the same list.
 *
 * These were a tab of their own beside Jobs, which split one glance ("what is
 * this thing working through?") across two mostly-empty columns. The rows live
 * in the Work surface now: the open half under Now, the closed half in the
 * journal.
 */
import { Badge } from "@cloudflare/kumo";
import { CircleIcon, CircleDashedIcon, CheckCircleIcon, ProhibitIcon } from "@phosphor-icons/react";
import type { AgentTask, AgentTaskTree, TaskStatus } from "@kinu.run/core";

const STATUS_META = {
  open: { icon: CircleDashedIcon, tone: "p-text-3", label: "Open", weight: "regular", text: "p-text-2" },
  active: { icon: CircleIcon, tone: "p-accent", label: "Active", weight: "fill", text: "p-text font-medium" },
  done: { icon: CheckCircleIcon, tone: "p-success", label: "Done", weight: "fill", text: "p-text-3 line-through" },
  dropped: { icon: ProhibitIcon, tone: "p-text-3", label: "Dropped", weight: "regular", text: "p-text-3 line-through" },
} satisfies Record<TaskStatus, { icon: typeof CircleIcon; tone: string; label: string; weight: "fill" | "regular"; text: string }>;

/** Settled items stay legible but stop competing with the work in hand. */
export function isSettled(status: TaskStatus): boolean {
  return status === "done" || status === "dropped";
}

/** A whole tree has closed only once every subtask has. */
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

/** How much of the plan is left — the one line the Now section leads with. */
export function PlanProgress({ tasks }: { tasks: AgentTaskTree[] }) {
  const rows = tasks.flatMap((task) => [task, ...task.subtasks]);
  const remaining = rows.filter((task) => !isSettled(task.status));
  const active = remaining.filter((task) => task.status === "active");
  // A dropped item is not work outstanding and was not work done, so it is out
  // of the denominator entirely — counting it would report a plan as bigger
  // than the agent ever committed to.
  const counted = rows.filter((task) => task.status !== "dropped").length;

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs p-text-2 font-medium">{remaining.length} of {counted} still to do</span>
      {active.length > 0 && <Badge variant="secondary">{active.length} active</Badge>}
    </div>
  );
}
