import { Badge } from '@cloudflare/kumo';
import { NotePencilIcon } from '@phosphor-icons/react';
import type { OwnedPlan, WorkspaceWork } from '@kinu.run/core';
import { planTitle } from '@kinu.run/core';
import { Section } from './shared';
import { PlanProgress, TaskTree } from './work-tasks';

const keyOf = ({ owner, plan }: OwnedPlan) => `${owner.name}:${plan.id}:${plan.revision}`;

/** Every plan of the workspace as a card that opens its page. Draws nothing until the shared `listWorkspaceWork` read
 *  answers. */
export function WorkPlans({ work, onOpen }: {
  work: WorkspaceWork | null;
  /** Shows the plan's own page. */
  onOpen: (item: OwnedPlan) => void;
}) {
  const plans = work?.plans ?? [];

  if (plans.length === 0) return null;

  return (
    <div data-work-plans>
      <Section id="work-plans" title="Plans"
        icon={<NotePencilIcon size={14} className="p-text-2" />}
        badge={<Badge variant="secondary">{plans.length}</Badge>}>
        <div className="space-y-2">
          {plans.map((item) => <PlanCard key={keyOf(item)} item={item} onOpen={() => onOpen(item)} />)}
        </div>
      </Section>
    </div>
  );
}

function PlanCard({ item, onOpen }: { item: OwnedPlan; onOpen: () => void }) {
  const { owner, plan, tasks } = item;

  return (
    <div className="p-group" data-plan-card={plan.revision}>
      <button type="button" onClick={onOpen}
        className="w-full rounded-t-md px-3 pt-2.5 pb-2 text-left transition-colors hover:p-elevated">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="p-row-text p-text min-w-0 truncate">{planTitle(plan.content)}</span>
          <span className="p-meta p-text-3 shrink-0">r{plan.revision} · {plan.status}</span>
        </div>
        {/* The workspace's own plans are its own: the root's registered name is the workspace's slug, never shown. */}
        {owner.path?.length !== 0 && <div className="p-meta p-text-3 mt-0.5">{owner.name}{owner.retired ? " · retained" : ""}</div>}
      </button>
      {tasks.length > 0 && (
        <div className="space-y-2 px-3 pb-2.5">
          <PlanProgress tasks={tasks} />
          {tasks.map((task) => <TaskTree key={task.id} task={task} grouped owner={owner} />)}
        </div>
      )}
    </div>
  );
}
