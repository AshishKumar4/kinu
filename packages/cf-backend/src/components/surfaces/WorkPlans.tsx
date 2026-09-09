import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Loader } from '@cloudflare/kumo';
import * as v from 'valibot';
import { SubordinateInspectionResultSchema, type SubordinateInspectionRequest, type PlanReview, type AgentTaskTree, type SeekCursor } from '@kinu.run/core';
import type { WorkspacePlanArrival } from '@/hooks/use-kinu';
import type { Rpc } from '@/lib/protocol';
import { lastValue, useAsyncResource } from '@/hooks/use-async-resource';
import { LoadFailure } from '@/components/ui/LoadFailure';
import { renderThrownChain } from '@kinu.run/core/obs';
import { PlanProgress, TaskTree } from './work-tasks';

const PlanReviewView = lazy(() => import('./PlanReviewView'));
interface OwnedPlan { plan: PlanReview; path: string[]; active: boolean }
interface ReadPage { path: string[]; active: boolean; view: 'plans' | 'children'; cursor?: SeekCursor }
const keyOf = ({ plan, path }: OwnedPlan) => JSON.stringify([path, plan.id, plan.revision]);
const ownerOf = (path: readonly string[]) => path.length ? path.join(' / ') : 'Main';

/**
 * ONE presentation policy, derived once for every row, because the dropdown
 * label, the read-only banner and the review affordance all answer the same
 * question. They used to disagree: a priority record arrives with no scanned
 * status, so a label read off the record said "retained" about an actor the
 * selection had already decided was live. A direct actor is live exactly when
 * the root's roster still lists it; deeper history keeps what the traversal
 * observed; the root itself always is.
 *
 * The selection rides with the rows for the same reason: which row is picked,
 * and whether it belongs to THIS pane, are read off the merged list and cannot
 * be asked before it exists.
 */
function planSelection(
  held: { readonly plans: readonly OwnedPlan[] } | null,
  current: OwnedPlan | null,
  activeActors: readonly string[],
  selected: string | null,
  owner: string,
) {
  const merged = held?.plans.slice() ?? [];
  if (current) {
    const index = merged.findIndex(item => keyOf(item) === keyOf(current));
    if (index < 0) merged.unshift(current); else merged[index] = current;
  }
  const plans = merged.map(item => ({
    ...item,
    active: item.path.length === 0
      || (item.path.length === 1 ? activeActors.includes(item.path[0] ?? '') : item.active),
  }));
  const picked = plans.find(candidate => keyOf(candidate) === selected) ?? plans[0] ?? null;
  return {
    plans,
    picked,
    inline: picked !== null
      && (picked.path.length === 0 || (picked.path.length === 1 && picked.path[0] === owner)),
  };
}

/** Read existing actors, including retained descendants. Each user page permits
 * four sequential inspection reads; the remaining frontier is explicit. */
export function WorkPlans({ active, rpc, rootRpc, owner = 'main', arrival, activeActors = [], onPresence, onNewPlan, onReviewActor }: {
  active: PlanReview | null; rpc: Rpc; rootRpc: Rpc; owner?: string;
  arrival?: WorkspacePlanArrival | null; activeActors?: readonly string[];
  onPresence: (present: boolean) => void;
  onNewPlan: () => void;
  onReviewActor?: (name: string) => void | Promise<void>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [pages, setPages] = useState(1);
  const known = useRef<Map<string, Set<string>>>(new Map());
  const seenPageCount = useRef(pages);
  const focus = arrival?.reference ?? null;
  const focusKey = focus ? JSON.stringify([focus.path, focus.id, focus.revision]) : null;
  const load = useCallback(async () => {
    const plans: OwnedPlan[] = [];
    const warnings: string[] = [];
    const scannedActors = new Set<string>();
    const queue: ReadPage[] = [{ path: [], active: true, view: 'plans' }, { path: [], active: true, view: 'children' }];
    const queuedActors = new Set(['[]']);
    if (focus) {
      const result = v.parse(SubordinateInspectionResultSchema, await rootRpc('inspectSubordinate', [{ ...focus, view: 'plan' }]));
      if (result.view === 'plan') plans.push({ plan: result.plan, path: result.path, active: false });
      // A notification is only a hint, and this read is the authority that
      // decides. A reference it cannot resolve is reported where every other
      // unreadable actor is and focuses nothing; throwing would let one stale
      // hint take the whole retained history down on every poll, for as long as
      // the reference is held.
      else if (result.view === 'missing') warnings.push(`${ownerOf(focus.path)}: ${result.error}`);
      else throw new Error('Plan inspection returned a different view.');
    }
    if (owner !== 'main') {
      queue.unshift({ path: [owner], active: true, view: 'plans' }, { path: [owner], active: true, view: 'children' });
      queuedActors.add(JSON.stringify([owner]));
    }
    for (let index = 0; index < pages * 4 && queue.length; index++) {
      const next = queue.shift(); if (!next) break;
      const request: SubordinateInspectionRequest = { path: next.path, view: next.view, page: { limit: 20, cursor: next.cursor } };
      const result = v.parse(SubordinateInspectionResultSchema, await rootRpc('inspectSubordinate', [request]));
      if (result.view === 'missing') { warnings.push(`${ownerOf(next.path)}: ${result.error}`); continue; }
      if (result.view !== next.view) throw new Error('Plan inspection returned a different view.');
      if (result.view === 'plans') {
        scannedActors.add(JSON.stringify(next.path));
        plans.push(...result.page.items.map(plan => ({ plan, path: next.path, active: next.active })));
      }
      if (result.view === 'children') for (const child of result.page.items) {
        const path = [...next.path, child.name];
        const actorKey = JSON.stringify(path);
        if (queuedActors.has(actorKey)) continue;
        queuedActors.add(actorKey);
        const childActive = next.active && child.status !== 'dismissed';
        queue.push({ path, active: childActive, view: 'plans' }, { path, active: childActive, view: 'children' });
      }
      if ((result.view === 'plans' || result.view === 'children') && result.page.status === 'more') queue.push({ ...next, cursor: result.page.next });
    }
    const unique = [...new Map(plans.map(item => [keyOf(item), item])).values()];
    unique.sort((a, b) => b.plan.createdAt - a.plan.createdAt || b.plan.revision - a.plan.revision);
    return { plans: unique, more: queue.length > 0, warnings, scannedActors, pageCount: pages, focusKey };
  }, [rootRpc, pages, owner, focusKey, active?.id, active?.revision, active?.updatedAt]);
  const { resource, reload } = useAsyncResource(load, useCallback(() => 4000, []));
  const held = lastValue(resource);
  const current: OwnedPlan | null = active ? { plan: active, path: owner === 'main' ? [] : [owner], active: true } : null;
  const { plans, picked, inline } = planSelection(held, current, activeActors, selected, owner);
  const reviewRpc = picked?.path.length === 0 ? rootRpc : rpc;
  const openReview = async () => {
    const name = picked?.path[0];
    if (!name || !onReviewActor) return;
    setNavigationError(null);
    try { await onReviewActor(name); }
    catch (cause) { setNavigationError(renderThrownChain({ cause })); }
  };

  useEffect(() => {
    if (!held) return;
    const expanding = seenPageCount.current !== held.pageCount;
    const fresh = expanding ? undefined : held.plans.find(item => {
      const previous = known.current.get(JSON.stringify(item.path));
      return item.plan.status === 'pending' && previous !== undefined && !previous.has(keyOf(item));
    });
    for (const actor of held.scannedActors) if (!known.current.has(actor)) known.current.set(actor, new Set());
    for (const item of held.plans) known.current.get(JSON.stringify(item.path))?.add(keyOf(item));
    seenPageCount.current = held.pageCount;
    if (fresh) { setSelected(keyOf(fresh)); onNewPlan(); }
  }, [held, onNewPlan]);
  useEffect(() => {
    if (!current) return;
    // A conversation's pane opens on ITS actor's plan, decided or not: the row
    // this pane answers for is the reason the reader is here. The root pane
    // keeps the pending-only rule, so its "newest plan anywhere" default — and
    // any older revision the reader picked through it — still stands once its
    // own plan is decided. Both matter now that an arrival from an unscanned
    // actor can be the newest plan in the workspace.
    if (owner === 'main' && current.plan.status !== 'pending') return;
    setSelected(keyOf(current));
  }, [active?.id, active?.revision, owner]);
  useEffect(() => {
    if (!arrival || focusKey === null || held?.focusKey !== focusKey) return;
    // Only an AUTHORIZED reference reaches here: the exact read has answered
    // and its plan is in the merged history. A hint the workspace cannot
    // resolve never moves the user off whatever they were looking at.
    if (!held.plans.some(item => keyOf(item) === focusKey)) return;
    // Claimed LAST, and by the connection rather than by this pane. Last,
    // because a reference the read has not authorized yet must stay claimable.
    // By the connection, because this pane is remounted on every conversation
    // switch: a claim that lived here would make an honoured hint arrive all
    // over again on the fresh mount.
    if (!arrival.claim(arrival.reference)) return;
    setSelected(focusKey);
    onNewPlan();
  }, [arrival, focusKey, held, onNewPlan]);
  useEffect(() => { onPresence(plans.length > 0); }, [plans.length, onPresence]);

  if (plans.length === 0 && resource.status !== 'error' && !held?.more && !held?.warnings.length) return null;
  return <section data-work-plans className="space-y-3">
    {navigationError && <LoadFailure what="actor review" message={navigationError} onRetry={openReview} />}
    {resource.status === 'error' && <LoadFailure what="workspace plan history" message={resource.message} onRetry={reload} />}
    <div className="flex items-center gap-3 flex-wrap">
      <h2 className="p-text text-sm font-semibold">Plans</h2>
      {plans.length > 0 && <select aria-label="Plan history" className="min-w-0 flex-1 p-bg p-text text-xs border p-border rounded px-2 py-1.5"
        value={picked ? keyOf(picked) : ''} onChange={event => setSelected(event.target.value)}>
        {plans.map(item => <option key={keyOf(item)} value={keyOf(item)}>
          {ownerOf(item.path)} · {item.plan.content.split('\n').find(line => line.trim())?.replace(/^#+\s*/, '') || 'Plan'} · r{item.plan.revision} · {item.plan.status}{item.active ? '' : ' · retained'}
        </option>)}
      </select>}
      {held?.more && <button type="button" className="text-xs p-accent" onClick={() => setPages(count => count + 1)}>Older plans / more actors</button>}
      {resource.status === 'loading' && <Loader size="sm" />}
    </div>
    {held?.warnings.map(message => <p key={message} className="p-meta p-text-3">{message}</p>)}
    {picked && <>
      {!inline && <p className="p-meta p-text-3">{picked.active ? 'Read-only workspace overview.' : 'Retained actor history — read-only.'}
        {picked.active && picked.path.length === 1 && onReviewActor && <button type="button" className="ml-2 p-accent" onClick={openReview}>Review in {ownerOf(picked.path)} conversation</button>}
      </p>}
      <PlanTasks key={keyOf(picked)} item={picked} rpc={rootRpc} />
      <Suspense fallback={<Loader size="sm" />}><PlanReviewView key={keyOf(picked)} plan={picked.plan} rpc={reviewRpc} readOnly={!inline || !picked.active} /></Suspense>
    </>}
  </section>;
}

function PlanTasks({ item, rpc }: { item: OwnedPlan; rpc: Rpc }) {
  const { plan, path } = item;
  const actorKey = JSON.stringify(path);
  const load = useCallback(async (): Promise<AgentTaskTree[]> => {
    const request: SubordinateInspectionRequest = { path, view: 'planTasks', id: plan.id, revision: plan.revision };
    const result = v.parse(SubordinateInspectionResultSchema, await rpc('inspectSubordinate', [request]));
    if (result.view === 'missing') throw new Error(result.error);
    if (result.view !== 'planTasks') throw new Error('Plan inspection returned a different view.');
    return result.tasks;
  }, [rpc, actorKey, plan.id, plan.revision]);
  const { resource, reload } = useAsyncResource(load, useCallback(() => 4000, []));
  const tasks = lastValue(resource) ?? [];
  return <div className="space-y-2">
    {resource.status === 'error' && <LoadFailure what="plan tasks" message={resource.message} onRetry={reload} />}
    {tasks.length > 0 && <><PlanProgress tasks={tasks} />{tasks.map(task => <TaskTree key={task.id} task={task} />)}</>}
  </div>;
}
