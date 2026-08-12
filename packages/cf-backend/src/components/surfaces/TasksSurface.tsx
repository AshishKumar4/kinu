/**
 * Tasks surface — the agent's own task list, as the agent keeps it.
 *
 * Read-only, deliberately. The list is the agent's plan: it writes it with the
 * `tasks` tool and re-reads its open half out of the live context block at
 * every step, so an owner edit here would swap the plan underneath a running
 * turn with nothing to tell it so. Changing what the agent is doing already
 * has a channel — say so in chat — and one writer is what keeps this list and
 * the agent's own view of it the same list.
 *
 * Background jobs used to live in this tab; they are their own surface now
 * (JobsSurface), because a detached tool call with a jobId and a result was
 * never a to-do item.
 */
import { useCallback } from "react";
import { Badge } from "@cloudflare/kumo";
import {
  ListChecksIcon, CircleIcon, CircleDashedIcon, CheckCircleIcon, ProhibitIcon,
} from "@phosphor-icons/react";
import type { AgentTask, AgentTaskTree, TaskStatus } from "@proteus/core";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import type { Rpc } from "@/lib/protocol";
import { EmptyState, Section } from "./shared";

const STATUS_META: Record<TaskStatus, { icon: typeof CircleIcon; tone: string; label: string }> = {
  open: { icon: CircleDashedIcon, tone: "p-text-3", label: "Open" },
  active: { icon: CircleIcon, tone: "p-accent", label: "Active" },
  done: { icon: CheckCircleIcon, tone: "p-success", label: "Done" },
  dropped: { icon: ProhibitIcon, tone: "p-text-3", label: "Dropped" },
};

/** Settled items stay legible but stop competing with the work in hand. */
function isSettled(status: TaskStatus): boolean {
  return status === "done" || status === "dropped";
}

function TaskRow({ task, depth }: { task: AgentTask; depth: number }) {
  const meta = STATUS_META[task.status];
  const Icon = meta.icon;
  return (
    <div
      className={`flex items-start gap-2 py-1 ${depth > 0 ? "ml-4 pl-3 border-l p-border" : ""}`}
      title={meta.label}
    >
      <Icon
        size={13}
        weight={task.status === "active" ? "fill" : task.status === "done" ? "fill" : "regular"}
        className={`${meta.tone} shrink-0 mt-0.5`}
      />
      <code className="text-[10px] p-text-3 shrink-0 mt-[3px] w-7">{task.id}</code>
      <span
        className={`text-xs min-w-0 break-words ${
          isSettled(task.status) ? "p-text-3 line-through" : task.status === "active" ? "p-text font-medium" : "p-text-2"
        }`}
      >
        {task.title}
      </span>
    </div>
  );
}

function TaskTree({ task }: { task: AgentTaskTree }) {
  return (
    <div className="p-card rounded-lg px-3 py-2">
      <TaskRow task={task} depth={0} />
      {task.subtasks.map((sub) => <TaskRow key={sub.id} task={sub} depth={1} />)}
    </div>
  );
}

export interface TasksSurfaceProps {
  rpc: Rpc;
}

export function TasksSurface({ rpc }: TasksSurfaceProps) {
  const load = useCallback(() => rpc<AgentTaskTree[]>("listAgentTasks", []), [rpc]);
  // The agent writes this list mid-turn and the server never pushes it, so the
  // view revalidates while anything is still open and stands down once
  // everything has settled.
  const revalidate = useCallback((tasks: AgentTaskTree[] | null) => {
    const open = (tasks ?? []).some((t) => !isSettled(t.status) || t.subtasks.some((s) => !isSettled(s.status)));
    return open ? 4000 : null;
  }, []);
  const { resource, reload } = useAsyncResource(load, revalidate);
  const tasks = lastValue(resource);

  if (resource.status === "error" && tasks === null) {
    return <LoadFailure what="the task list" message={resource.message} onRetry={reload} />;
  }
  if (tasks === null) return <div className="text-xs p-text-3">Loading…</div>;

  if (tasks.length === 0) {
    return (
      <EmptyState
        icon={<ListChecksIcon size={28} />}
        title="No tasks yet"
        hint="When the agent takes on work with more than a step or two, it writes the steps down here and marks them off as it goes."
      />
    );
  }

  const rows = tasks.flatMap((task) => [task, ...task.subtasks]);
  const remaining = rows.filter((task) => !isSettled(task.status));
  const active = remaining.filter((task) => task.status === "active");
  // A dropped item is not work outstanding and was not work done, so it is out
  // of the denominator entirely — counting it would report a plan as bigger
  // than the agent ever committed to.
  const counted = rows.filter((task) => task.status !== "dropped").length;
  const closed = tasks.filter((task) =>
    isSettled(task.status) && task.subtasks.every((sub) => isSettled(sub.status)));
  const open = tasks.filter((task) => !closed.includes(task));

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex items-center gap-2">
        <span className="text-xs p-text-2 font-medium">
          {remaining.length} of {counted} still to do
        </span>
        {active.length > 0 && <Badge variant="secondary">{active.length} active</Badge>}
        <div className="flex-1" />
        {resource.status === "error" && (
          <span className="text-[10px] p-text-3" title={resource.message}>last refresh failed</span>
        )}
      </div>

      {open.length > 0 && (
        // No badge: these cards are on screen and countable. The fold below
        // hides its contents, which is what a count is worth reading there.
        <Section id="tasks-open" title="Still to do" icon={<ListChecksIcon size={13} className="p-text-2" />}>
          <div className="space-y-2">
            {open.map((task) => <TaskTree key={task.id} task={task} />)}
          </div>
        </Section>
      )}

      {closed.length > 0 && (
        // "Closed" rather than "Finished": a dropped task ended up here too,
        // and it was never finished.
        <Section id="tasks-closed" title="Closed" icon={<CheckCircleIcon size={13} className="p-text-2" />}
          badge={<Badge variant="secondary">{closed.length}</Badge>} defaultOpen={false}>
          <div className="space-y-2">
            {closed.map((task) => <TaskTree key={task.id} task={task} />)}
          </div>
        </Section>
      )}
    </div>
  );
}
