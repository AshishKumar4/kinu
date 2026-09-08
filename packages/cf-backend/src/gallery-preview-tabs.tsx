import { useCallback, useState } from 'react';
import { missingSubordinateHistory, SubordinateInspectionRequestSchema, type JsonValue, type PlanReview, type SlateSummary } from '@kinu.run/core';
import * as v from 'valibot';
import type { Rpc } from '@/lib/protocol';
import { useKinu } from '@/hooks/use-kinu';
import { WorkSurface, type SurfaceKind } from '@/components/surfaces/WorkSurface';
import { PreviewFrame } from '@/components/PreviewFrame';
import { SLATE_GALLERY_URL } from '@/gallery-slate-fallback';

const ROOT_PLAN: PlanReview = { id: 'plan-dashboard', sessionId: 'default', revision: 2, content: '# Dashboard delivery\n\nImplement the dashboard and verify its refresh action.', status: 'pending', annotations: [], feedback: null, handoffAccepted: false, createdAt: 1, updatedAt: 2, decidedAt: null };
/** The plan a WHOLLY UNSCANNED actor submits. `courier` is on the workspace's
 *  roster but never on a `children` page here: the plan walk is budgeted, so a
 *  live actor outside the frontier is exactly the case an arrival hint exists
 *  for — no amount of "Older plans / more actors" reaches this one. */
const ARRIVAL_PLAN: PlanReview = { id: 'plan-courier', sessionId: 'default', revision: 3, content: '# Courier rollout\n\nStage the rollout and verify the receipt.', status: 'pending', annotations: [], feedback: null, handoffAccepted: false, createdAt: 30, updatedAt: 30, decidedAt: null };
const ARRIVAL_REFERENCE = { path: ['courier'], id: ARRIVAL_PLAN.id, revision: ARRIVAL_PLAN.revision };
const SLATES: SlateSummary[] = [{ id: 'dashboard', title: 'Dashboard', bindings: [], port: 8789 }];
const SANDBOX_URL = 'https://8080-sandbox-aaaaaaaaaaaaaaaa.preview.example.test/';
const DEVICE_URL = 'https://3000-device-aaaaaaaaaaaaaaaa.preview.example.test/';
const NOTHING = () => {};

/** The one way this gate can make the SERVER speak. The payload crosses the
 *  real socket seam, so `use-kinu` does its own parse, root-only gate and
 *  de-duplication — a fixture that set the focus state directly would prove
 *  none of them. A reference is whatever a workspace can put on the wire,
 *  malformed ones included; deciding which are real is the hook's job here.  */
function notify(reference: JsonValue): void {
  window.dispatchEvent(new CustomEvent('gallery-broadcast', {
    detail: JSON.stringify({ type: 'workspace_plan_updated', reference }),
  }));
}

export function PreviewTabsGallery() {
  const [surface, setSurface] = useState<SurfaceKind>('Work');
  const [slates, setSlates] = useState(SLATES);
  const [focus, setFocus] = useState<string | null>(null);
  const [planFocus, setPlanFocus] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanReview | null>(null);
  const [reload, setReload] = useState(0);
  const [diff, setDiff] = useState(false);
  const [failHistory, setFailHistory] = useState(false);
  const [actors, setActors] = useState(false);
  const [workerPlan, setWorkerPlan] = useState<PlanReview>({ ...ROOT_PLAN, revision: 1, content: "# Worker plan", status: "approved", handoffAccepted: true, createdAt: 10 });
  const [owner, setOwner] = useState("main");
  // The REAL root connection, for one value: the arrival hint. Everything the
  // surfaces read still comes from the fixture props below, so this exercises
  // the hook's socket edge and nothing else.
  const { workspacePlanFocus } = useKinu('preview-tabs');
  const rpc: Rpc = useCallback(async <T,>(method: string, args?: unknown[]): Promise<T> => {
    const reply = <Value,>(value: Value): Promise<T> => new Response(JSON.stringify(value)).json<T>();
    if (method === 'previewSlate') return reply({ ok: true, value: { url: SLATE_GALLERY_URL, port: 8789 } });
    else if (method === 'getExecutorDiff') return reply({ mode: 'vfs-baseline', files: diff ? [{ path: 'src/app.ts', status: 'changed', additions: 1, deletions: 0, diff: '+export const ready = true;' }] : [] });
    else if (method === 'inspectSubordinate') {
      const request = v.parse(SubordinateInspectionRequestSchema, args?.[0]);
      const path = request.path;
      if (request.view === 'plans') {
        if (failHistory) throw new Error('Plan history temporarily unavailable');
        const items = path.length === 0 ? (plan ? [plan, { ...ROOT_PLAN, revision: 1, status: 'superseded', content: '# Earlier dashboard plan' }] : [])
          : path.length > 1 ? [{ ...ROOT_PLAN, revision: 1, content: '# Nested delivery', status: 'approved', handoffAccepted: true }]
          : path[0] === 'worker' ? [workerPlan] : [{ ...ROOT_PLAN, revision: 1, content: '# Archived delivery', status: 'approved', handoffAccepted: true }];
        return reply({ view: 'plans', path, page: { status: 'end', items } });
      }
      if (request.view === 'children') {
        const names = !actors ? [] : path.length === 0 ? ['worker', 'archive'] : path.length === 1 && path[0] === 'worker' ? ['nested'] : [];
        return reply({ view: 'children', path, page: { status: 'end', items: names.map(name => ({ name, createdBy: 'user', status: name === 'archive' ? 'dismissed' : 'idle', currentTask: null, createdAt: 1, dismissedAt: name === 'archive' ? 2 : null, lifetime: 'durable', taskEventId: null })) } });
      }
      // The exact reference read, which is the only thing that authorizes a
      // focus. Anything the workspace never issued is `missing`, so a stale or
      // invented hint resolves to nothing rather than to a neighbouring plan.
      if (request.view === 'plan') {
        return reply(path.length === 1 && path[0] === 'courier'
          && request.id === ARRIVAL_PLAN.id && request.revision === ARRIVAL_PLAN.revision
          ? { view: 'plan', path, plan: ARRIVAL_PLAN }
          : missingSubordinateHistory(path));
      }
      if (request.view === 'planTasks') return reply({ view: 'planTasks', path, tasks: request.revision === 2 || path.length > 0 ? [{ id: 't1', parentId: null, title: path.length > 0 ? 'Deliver ' + path.join(' / ') : 'Implement refresh action', status: 'active', createdAt: 1, updatedAt: 1, subtasks: [] }] : [] });
      throw new Error('Unexpected inspection view in preview gallery');
    }
    else if (method === 'decidePlanReview') { const next = { ...ROOT_PLAN, status: 'approved' as const, handoffAccepted: true, updatedAt: 3 }; setPlan(next); return reply({ ok: true, plan: next, queued: true }); }
    else if (method === 'savePlanReviewAnnotations') return reply({ ok: true, plan });
    else if (method === 'listAgentTasks') return reply([]);
    else if (method === 'getEvolutionChangelog') return reply({ entries: [], unseenCount: 0, seenAt: 0 });
    else if (method === 'markChangelogSeen') return reply({ seenAt: 0 });
    else throw new Error('Unexpected preview gallery RPC: ' + method);
  }, [plan, diff, failHistory, actors, workerPlan]);
  const workerRpc: Rpc = useCallback(async <T,>(method: string, args?: unknown[]): Promise<T> => {
    if (method === 'decidePlanReview') {
      const next: PlanReview = { ...workerPlan, status: 'approved', handoffAccepted: true };
      setWorkerPlan(next);
      return new Response(JSON.stringify({ ok: true, plan: next, queued: true })).json<T>();
    }
    if (method === 'savePlanReviewAnnotations') return new Response(JSON.stringify({ ok: true, plan: workerPlan })).json<T>();
    return rpc<T>(method, args);
  }, [rpc, workerPlan]);
  return <div className="h-screen p-bg flex flex-col">
    <div className="flex gap-2 p-2 text-xs shrink-0 flex-wrap" data-plan-owner={owner}>
      <button data-break-plans onClick={() => setFailHistory(value => !value)}>Toggle history failure</button>
      <button data-show-actors onClick={() => setActors(true)}>Show workspace actors</button>
      <button data-worker-plan onClick={() => setWorkerPlan({ ...workerPlan, revision: 2, createdAt: 20, status: "pending", handoffAccepted: false, content: "# Worker revision two" })}>Submit worker plan</button>
      <button data-new-preview onClick={() => { setSlates([...SLATES, { id: 'report', title: 'Report', bindings: [] }]); setFocus('slate:report'); }}>New preview</button>
      <button data-new-plan onClick={() => { setPlan(ROOT_PLAN); setPlanFocus('plan-dashboard:2'); }}>Submit plan</button>
      <button data-refresh-preview onClick={() => setReload(n => n + 1)}>Refresh source</button>
      <button data-add-diff onClick={() => setDiff(true)}>Edit file</button>
      <button data-notify-plan onClick={() => notify(ARRIVAL_REFERENCE)}>Notify courier plan</button>
      <button data-notify-stale onClick={() => notify({ ...ARRIVAL_REFERENCE, revision: 99 })}>Notify stale plan</button>
      <button data-notify-malformed onClick={() => notify({ path: ['courier'], id: '', revision: 0 })}>Notify malformed plan</button>
    </div>
    <div data-preview-surface className="flex-1 min-h-0">
      <WorkSurface planRpc={owner === "main" ? rpc : workerRpc} planOwner={owner} onReviewActor={setOwner} surface={surface} onSurface={setSurface} previewFocus={focus} planFocus={planFocus}
        workspacePlanFocus={workspacePlanFocus}
        // The root's own roster, which is pushed and therefore runs ahead of the
        // budgeted plan walk: `courier` is live here while no `children` page
        // has ever named it. `archive` is dismissed, so it is absent and its
        // history presents as retained.
        activePlanActors={actors ? ['worker', 'courier'] : ['courier']}
        pinnedPorts={[{ executor: 'workspace', port: 8789, url: SLATE_GALLERY_URL, name: 'Duplicate dashboard port' }, { executor: 'sandbox', port: 8080, url: SANDBOX_URL, name: 'Sandbox app' }, { executor: 'laptop', port: 3000, url: DEVICE_URL, name: 'Device app' }]}
        slates={slates} slateReloads={new Map(slates.map(item => [item.id, reload]))}
        previewError={null} onRefreshPorts={NOTHING} plan={owner === "main" ? plan : workerPlan} snapshot={{ status: 'loading' }} onRetryLoad={NOTHING}
        tools={[]} memory={[]} memoryContent="" onSearchMemory={NOTHING} mctsTrees={new Map()} headActivity={new Map()} isStreaming={false}
        executors={[]} executorOutputs={new Map()} onExecute={async () => ({})} backgroundJobs={[]} onRefreshJobs={NOTHING} pendingActions={[]}
        tabPresence={{ releases: false, explorations: false }} rpc={rpc} />
    </div>
  </div>;
}

export function CompactPreviewGallery() {
  return <div className="p-6"><div data-chat-preview className="h-64"><PreviewFrame url={SLATE_GALLERY_URL} label="Chat preview" /></div></div>;
}
