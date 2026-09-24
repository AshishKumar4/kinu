import { useCallback, useState } from 'react';
import { WorkspacePlanReferenceSchema, JsonValueSchema, type JsonValue, type PlanReview, type SlateSummary } from '@kinu.run/core';
import * as v from 'valibot';
import type { Rpc } from '@kinu.run/core';
import { useKinu, WorkspacePlanUpdatedFrameSchema } from '@/hooks/use-kinu';
import { galleryServerPush } from '@/gallery-agent-stub';
import type { SurfaceKind } from '@kinu.run/core';
import { WorkSurface } from '@/components/surfaces/WorkSurface';
import { PreviewFrame } from '@/components/PreviewFrame';
import { SLATE_GALLERY_URL } from '@/gallery-slate-fallback';

const ROOT_PLAN: PlanReview = { id: 'plan-dashboard', sessionId: 'default', revision: 2, content: '# Dashboard delivery\n\nImplement the dashboard and verify its refresh action.', status: 'pending', annotations: [], feedback: null, handoffAccepted: false, createdAt: 1, updatedAt: 2, decidedAt: null };

/** Plan of an actor outside the budgeted plan walk's frontier: only the arrival hint reaches it. */
const ARRIVAL_PLAN: PlanReview = { id: 'plan-courier', sessionId: 'default', revision: 3, content: '# Courier rollout\n\nStage the rollout and verify the receipt.', status: 'pending', annotations: [], feedback: null, handoffAccepted: false, createdAt: 30, updatedAt: 30, decidedAt: null };

/** Built through the wire schema so fixture drift fails here, not as a later timeout. */
const ARRIVAL_REFERENCE = v.parse(WorkspacePlanReferenceSchema, {
  path: ['courier'], id: ARRIVAL_PLAN.id, revision: ARRIVAL_PLAN.revision,
});

/** Valid shape, never issued: only the authorized read can tell it apart. */
const STALE_REFERENCE = v.parse(WorkspacePlanReferenceSchema, { ...ARRIVAL_REFERENCE, revision: 99 });

/** Must stay rejected by the wire schema, or the malformed path goes untested. */
const MALFORMED_REFERENCE = v.parse(
  v.pipe(JsonValueSchema, v.check(
    value => !v.safeParse(WorkspacePlanReferenceSchema, value).success,
    'the malformed reference fixture parses as a valid plan reference',
  )),
  { path: ['courier'], id: '', revision: 0 },
);

const SLATES: SlateSummary[] = [{ id: 'dashboard', title: 'Dashboard', bindings: [], port: 8789 }];

const SANDBOX_URL = 'https://8080-sandbox-aaaaaaaaaaaaaaaa.preview.example.test/';

const DEVICE_URL = 'https://3000-device-aaaaaaaaaaaaaaaa.preview.example.test/';

const NOTHING = () => {};

type ReplyValue = JsonValue | PlanReview | readonly ReplyValue[] | { readonly [key: string]: ReplyValue };

/** Push a server frame through the stubbed `agents/react` socket so `useKinu` parses, gates and de-duplicates it. */
function notify(reference: JsonValue): void {
  const frame = { type: WorkspacePlanUpdatedFrameSchema.entries.type.literal, reference };
  const parsed = v.safeParse(WorkspacePlanUpdatedFrameSchema, frame);
  galleryServerPush(JSON.stringify(parsed.success ? parsed.output : frame));
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
  const [workerPlan, setWorkerPlan] = useState<PlanReview>({ ...ROOT_PLAN, revision: 1, content: "# Worker plan", status: "approved", handoffAccepted: true, createdAt: 10 });
  const [owner, setOwner] = useState("main");
  // Real root connection, for the arrival hint only.
  const { workspacePlanArrival } = useKinu('preview-tabs');

  const rpc: Rpc = useCallback(async <T,>(method: string, _args?: unknown[]): Promise<T> => {
    const reply = (value: ReplyValue): Promise<T> => new Response(JSON.stringify(value)).json<T>();

    if (method === 'previewSlate') return reply({ ok: true, value: { url: SLATE_GALLERY_URL, port: 8789, inline: { height: 240 } } });
    else if (method === 'getExecutorDiff') return reply({ mode: 'vfs-baseline', files: diff ? [{ path: 'src/app.ts', status: 'changed', additions: 1, deletions: 0, diff: '+export const ready = true;' }] : [] });
    else if (method === 'listWorkspaceWork') {
      // The courier plan is already listed, so the arrival hint is the auto-open trigger, not a discovery read.
      if (failHistory) throw new Error('Plan history temporarily unavailable');

      const ownerOf = (name: string, retired = false) => ({ actorId: `actor-${name}`, name, retired });

      const rootPlans = plan ? [
        { owner: ownerOf('main'), plan, tasks: [] },
        { owner: ownerOf('main'), plan: { ...ROOT_PLAN, revision: 1, status: 'superseded' as const, content: '# Earlier dashboard plan' }, tasks: [] },
      ] : [];

      return reply({
        plans: [
          ...rootPlans,
          { owner: ownerOf('courier'), plan: ARRIVAL_PLAN, tasks: [] },
          {
            owner: ownerOf('worker'), plan: workerPlan,
            tasks: [{ id: 't1', parentId: null, title: 'Deliver worker', status: 'active', createdAt: 1, updatedAt: 1, note: null, subtasks: [] }],
          },
          {
            owner: ownerOf('nested'), plan: { ...ROOT_PLAN, revision: 1, content: '# Nested delivery', status: 'approved' as const, handoffAccepted: true },
            tasks: [{ id: 't2', parentId: null, title: 'Deliver nested', status: 'done', createdAt: 1, updatedAt: 1, note: null, subtasks: [] }],
          },
          { owner: ownerOf('archive', true), plan: { ...ROOT_PLAN, revision: 1, content: '# Archived delivery', status: 'approved' as const, handoffAccepted: true }, tasks: [] },
        ],
        tasks: [{ owner: ownerOf('main'), plan: null, tasks: [] }],
      });
    }
    else if (method === 'decidePlanReview') {
      const next = { ...ROOT_PLAN, status: 'approved' as const, handoffAccepted: true, updatedAt: 3 };
      setPlan(next);

      return reply({ ok: true, plan: next, queued: true });
    }
    else if (method === 'savePlanReviewAnnotations') return reply({ ok: true, plan });
    else if (method === 'listAgentTasks') return reply([]);
    else if (method === 'getEvolutionChangelog') return reply({ entries: [], unseenCount: 0, seenAt: 0 });
    else if (method === 'markChangelogSeen') return reply({ seenAt: 0 });

    throw new Error('Unexpected preview gallery RPC: ' + method);
  }, [plan, diff, failHistory, workerPlan]);

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
      <button data-worker-plan onClick={() => setWorkerPlan({ ...workerPlan, revision: 2, createdAt: 20, status: "pending", handoffAccepted: false, content: "# Worker revision two" })}>Submit worker plan</button>
      <button data-open-workspace onClick={() => setOwner('main')}>Back to workspace conversation</button>
      <button data-new-preview onClick={() => { setSlates([...SLATES, { id: 'report', title: 'Report', bindings: [] }]); setFocus('slate:report'); }}>New preview</button>
      <button data-new-plan onClick={() => { setPlan(ROOT_PLAN); setPlanFocus('plan-dashboard:2'); }}>Submit plan</button>
      <button data-refresh-preview onClick={() => setReload(n => n + 1)}>Refresh source</button>
      <button data-add-diff onClick={() => setDiff(true)}>Edit file</button>
      <button data-notify-plan onClick={() => notify(ARRIVAL_REFERENCE)}>Notify courier plan</button>
      <button data-notify-stale onClick={() => notify(STALE_REFERENCE)}>Notify stale plan</button>
      <button data-notify-malformed onClick={() => notify(MALFORMED_REFERENCE)}>Notify malformed plan</button>
    </div>
    <div data-preview-surface className="flex-1 min-h-0">
      <WorkSurface planRpc={owner === "main" ? rpc : workerRpc} planOwner={owner} onReviewActor={setOwner} surface={surface} onSurface={setSurface} previewFocus={focus} planFocus={planFocus}
        workspacePlanArrival={workspacePlanArrival}
        pinnedPorts={[{ executor: 'workspace', port: 8789, url: SLATE_GALLERY_URL, name: 'Duplicate dashboard port' }, { executor: 'sandbox', port: 8080, url: SANDBOX_URL, name: 'Sandbox app' }, { executor: 'device', port: 3000, url: DEVICE_URL, name: 'Device app' }]}
        slates={slates} slateReloads={new Map(slates.map(item => [item.id, reload]))}
        previewError={null} onRefreshPorts={NOTHING} plan={owner === "main" ? plan : workerPlan} snapshot={{ status: 'loading' }} onRetryLoad={NOTHING}
        tools={[]} memory={[]} memoryContent="" onSearchMemory={NOTHING} mctsTrees={new Map()} headActivity={new Map()} isStreaming={false}
        executors={[]} executorOutputs={new Map()} onExecute={async () => ({})} backgroundJobs={[]} onRefreshJobs={NOTHING} pendingActions={[]}
        tabPresence={{ releases: false, explorations: false, work: true }} rpc={rpc} />
    </div>
  </div>;
}

export function CompactPreviewGallery() {
  return <div className="p-6"><div data-chat-preview className="h-64"><PreviewFrame url={SLATE_GALLERY_URL} label="Chat preview" /></div></div>;
}
