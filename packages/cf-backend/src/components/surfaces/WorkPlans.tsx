import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Loader } from '@cloudflare/kumo';
import type { Page, PageRequest, PlanReview, AgentTaskTree } from '@kinu.run/core';
import type { Rpc } from '@/lib/protocol';
import { lastValue, useAsyncResource } from '@/hooks/use-async-resource';
import { LoadFailure } from '@/components/ui/LoadFailure';

import { PlanProgress, TaskTree } from './work-tasks';

const PlanReviewView = lazy(() => import('./PlanReviewView'));
const keyOf = (plan: PlanReview) => `${plan.id}:${plan.revision}`;

/** Every revision comes from the selected actor's durable plan store. */
export function WorkPlans({ active, rpc, onPresence }: {
  active: PlanReview | null;
  rpc: Rpc;
  onPresence: (present: boolean) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [pages, setPages] = useState(1);
  const load = useCallback(async () => {
    const plans: PlanReview[] = [];
    let cursor: { after: string } | undefined;
    for (let index = 0; index < pages; index++) {
      const request: PageRequest = { limit: 20 };
      if (cursor) request.cursor = cursor;
      const page = await rpc<Page<PlanReview>>('listPlanReviews', [request]);
      plans.push(...page.items);
      if (page.status === 'end') return { plans, more: false };
      cursor = page.next;
    }
    return { plans, more: true };
  }, [rpc, pages, active?.id, active?.revision, active?.updatedAt]);
  const { resource, reload } = useAsyncResource(load);
  const held = lastValue(resource);
  const plans = held?.plans ?? (active ? [active] : []);
  const plan = plans.find(candidate => keyOf(candidate) === selected) ?? plans[0] ?? null;

  useEffect(() => { setSelected(null); setPages(1); }, [rpc]);
  useEffect(() => { if (active?.status === "pending") setSelected(keyOf(active)); }, [active?.id, active?.revision]);
  useEffect(() => { onPresence(plans.length > 0); }, [plans.length, onPresence]);
  if (resource.status === 'error') return <LoadFailure what="plan history" message={resource.message} onRetry={reload} />;
  if (plans.length === 0) return null;
  return <section data-work-plans className="space-y-3">
    <div className="flex items-center gap-3">
      <h2 className="p-text text-sm font-semibold">Plans</h2>
      <select aria-label="Plan history" className="min-w-0 flex-1 p-bg p-text text-xs border p-border rounded px-2 py-1.5"
        value={plan ? keyOf(plan) : ''} onChange={event => setSelected(event.target.value)}>
        {plans.map(item => <option key={keyOf(item)} value={keyOf(item)}>
          {item.content.split('\n').find(line => line.trim())?.replace(/^#+\s*/, '') || 'Plan'} · r{item.revision} · {item.status}
        </option>)}
      </select>
      {held?.more && <button type="button" className="text-xs p-accent" onClick={() => setPages(count => count + 1)}>Older plans</button>}
    </div>
    {plan && <PlanTasks key={keyOf(plan)} plan={plan} rpc={rpc} />}
    <Suspense fallback={<Loader size="sm" />}>
      <PlanReviewView plan={active && plan && keyOf(active) === keyOf(plan) ? active : plan} rpc={rpc} />
    </Suspense>
  </section>;
}

function PlanTasks({ plan, rpc }: { plan: PlanReview; rpc: Rpc }) {
  const load = useCallback(() => rpc<AgentTaskTree[]>("listPlanTasks", [plan.id, plan.revision]), [rpc, plan.id, plan.revision]);
  const { resource, reload } = useAsyncResource(load, useCallback(() => 4000, []));
  const tasks = lastValue(resource) ?? [];
  return <div className="space-y-2">
    {resource.status === "error" && <LoadFailure what="plan tasks" message={resource.message} onRetry={reload} />}
    {tasks.length > 0 && <><PlanProgress tasks={tasks} />{tasks.map(task => <TaskTree key={task.id} task={task} />)}</>}
  </div>;
}

