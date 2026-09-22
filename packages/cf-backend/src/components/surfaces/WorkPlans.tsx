import { useEffect, useRef } from 'react';
import { Badge } from '@cloudflare/kumo';
import { NotePencilIcon } from '@phosphor-icons/react';
import type { OwnedPlan, WorkspaceWork } from '@kinu.run/core';
import { planTitle } from '@kinu.run/core';
import type { WorkspacePlanArrival } from '@/hooks/use-kinu';
import { Section } from './shared';
import { PlanProgress, TaskTree } from './work-tasks';

const keyOf = ({ owner, plan }: OwnedPlan) => `${owner.name}:${plan.id}:${plan.revision}`;

const arrivalOwner = (path: readonly string[]) => path.at(-1) ?? 'main';

/** Only this pane's own new pending plan auto-opens. Draws nothing until the shared `listWorkspaceWork` read answers. */
export function WorkPlans({ work, owner = 'main', arrival, onPresence, onNewPlan, onOpenReview }: {
  work: WorkspaceWork | null;
  owner?: string;
  arrival?: WorkspacePlanArrival | null;
  onPresence: (present: boolean) => void;
  onNewPlan: () => void;
  onOpenReview: (item: OwnedPlan) => void;
}) {
  const plans = work?.plans ?? [];
  const known = useRef<Set<string> | null>(null);
  const focus = arrival?.reference ?? null;

  useEffect(() => {
    if (work === null) return;

    const seen = known.current ?? new Set<string>();

    const fresh = known.current !== null
      ? plans.find((item) => item.plan.status === 'pending'
          && item.owner.name === owner && !seen.has(keyOf(item)))
      : undefined;

    for (const item of plans) seen.add(keyOf(item));
    known.current = seen;

    if (fresh) { onOpenReview(fresh); onNewPlan(); }
  }, [work, plans, owner, onNewPlan, onOpenReview]);

  // The claim is the connection's: a pane remounts per conversation switch and would replay the hint.
  // A hint landing while a review is open claims on the next mount.
  useEffect(() => {
    if (!arrival || !focus || work === null) return;

    const item = plans.find((candidate) =>
      candidate.plan.id === focus.id && candidate.plan.revision === focus.revision
        && candidate.owner.name === arrivalOwner(focus.path));

    if (!item || !arrival.claim(focus)) return;
    onOpenReview(item);
    onNewPlan();
  }, [arrival, focus, work, plans, onNewPlan, onOpenReview]);

  useEffect(() => { onPresence(plans.length > 0); }, [plans.length, onPresence]);

  if (work === null || plans.length === 0) return null;

  return (
    <div data-work-plans>
      <Section id="work-plans" title="Plans"
        icon={<NotePencilIcon size={14} className="p-text-2" />}
        badge={<Badge variant="secondary">{plans.length}</Badge>}>
        <div className="space-y-2">
          {plans.map((item) => <PlanCard key={keyOf(item)} item={item} onOpen={() => onOpenReview(item)} />)}
        </div>
      </Section>
    </div>
  );
}

function PlanCard({ item, onOpen }: { item: OwnedPlan; onOpen: () => void }) {
  const { owner, plan, tasks } = item;

  return (
    <div className="p-group">
      <button type="button" onClick={onOpen}
        className="w-full rounded-t-md px-3 pt-2.5 pb-2 text-left transition-colors hover:p-elevated">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="p-row-text p-text min-w-0 truncate">{planTitle(plan.content)}</span>
          <span className="p-meta p-text-3 shrink-0">r{plan.revision} · {plan.status}</span>
        </div>
        <div className="p-meta p-text-3 mt-0.5">{owner.name}{owner.retired ? " · retained" : ""}</div>
      </button>
      {tasks.length > 0 && (
        <div className="space-y-2 px-3 pb-2.5">
          <PlanProgress tasks={tasks} />
          {tasks.map((task) => <TaskTree key={task.id} task={task} grouped owner={owner.name} />)}
        </div>
      )}
    </div>
  );
}
