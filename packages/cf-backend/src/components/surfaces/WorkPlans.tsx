import { useEffect, useRef } from 'react';
import { Badge } from '@cloudflare/kumo';
import { NotePencilIcon } from '@phosphor-icons/react';
import type { OwnedPlan, WorkspaceWork } from '@kinu.run/core';
import { planTitle } from '@kinu.run/core';
import type { WorkspacePlanArrival } from '@/hooks/use-kinu';
import { Section } from './shared';
import { PlanProgress, TaskTree } from './work-tasks';

const keyOf = ({ owner, plan }: OwnedPlan) => `${owner.name}:${plan.id}:${plan.revision}`;

/** The actor name a `workspacePlanArrival` path resolves to: the path's last
 *  hop is the actor's own name, and the empty path is the root's. */
const arrivalOwner = (path: readonly string[]) => path.at(-1) ?? 'main';

/**
 * The workspace's plans as one list, newest first — the workspace-wide work
 * read, so a subordinate's plan and its tasks render beside the root's with
 * the actor that owns them named on both. A row opens the review over the
 * whole tab; the open state lives in WorkTab because the queue's
 * `plan_review` rows open the same view.
 *
 * "This pane's own plan" is the one auto-open rule: the review belongs to
 * whoever's conversation this is, so a foreign actor's new pending plan shows
 * in the list (and in the needs-you queue) without hijacking the tab.
 *
 * The list draws nothing until the read has answered once: the plans read and
 * the Now tasks read are the same `listWorkspaceWork`, so its spinner and its
 * retry already have a home there — a second one here would photograph the
 * same failure twice.
 */
export function WorkPlans({ work, owner = 'main', arrival, onPresence, onNewPlan, onOpenReview }: {
  /** The workspace-wide read's plans — shared with the tab's task list, so
   *  one `listWorkspaceWork` feeds both. Null while it is still out. */
  work: WorkspaceWork | null;
  /** The conversation's own actor name — 'main' at the root pane. */
  owner?: string;
  arrival?: WorkspacePlanArrival | null;
  /** Whether the list holds anything — the empty tab's "Nothing yet" reads it. */
  onPresence: (present: boolean) => void;
  /** A fresh pending plan of this pane's own actor just auto-opened. */
  onNewPlan: () => void;
  onOpenReview: (item: OwnedPlan) => void;
}) {
  const plans = work?.plans ?? [];
  const known = useRef<Set<string> | null>(null);
  const focus = arrival?.reference ?? null;

  // First read seeds what was already there; after it, a PENDING plan owned by
  // this pane's actor that the read had never seen is fresh and takes the tab.
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

  // An arrival names the plan it points at — by id and revision, both unique
  // inside an actor's stream — and the read is the authority that it exists.
  // The claim is the connection's, not this pane's: a pane remounts on every
  // conversation switch, and a claim held here would replay the honoured hint
  // on the fresh mount.
  // A hint that lands while a review is open never claims: this list is
  // unmounted then, by design — an arrival does not open a review over the
  // reader's head. It claims on the next mount (Back), which is what this
  // effect already does for a fresh reference.
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
