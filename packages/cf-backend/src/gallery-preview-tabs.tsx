import { useMemo, useRef, useState } from 'react';
import { Effect } from 'effect';
import { KinuError } from '@kinu.run/core/obs';
import { JsonValueSchema, WorkspacePlanReferenceSchema, type ChangeNote, type ExecutorDiffResult, type FileDiff, type JsonValue, type PlanReview, type SlateSummary, type WorkspaceWorkOwner } from '@kinu.run/core';
import * as v from 'valibot';
import type { ExecutorInfo } from '@kinu.run/core';
import { answeringRpc, type WorkspaceAnswer, type WorkspaceAnswers } from '@/lib/workspace-rpc';
import { INSPECTOR_DEFAULT_PX } from '@kinu.run/core/web/inspector-layout';
import { useKinu } from '@/hooks/use-kinu';
import { WorkspacePlanUpdatedFrameSchema } from '@kinu.run/core';
import { galleryServerPush } from '@/gallery-agent-stub';
import type { SurfaceKind } from '@kinu.run/core';
import { WorkSurface } from '@/components/surfaces/WorkSurface';
import { PreviewFrame } from '@/components/PreviewFrame';
import { SLATE_GALLERY_URL } from '@/gallery-slate-fallback';

const ROOT_PLAN: PlanReview = { id: 'plan-dashboard', sessionId: 'default', revision: 2, content: '# Dashboard delivery\n\nImplement the dashboard and verify its refresh action.', status: 'pending', annotations: [], feedback: null, handoffAccepted: false, createdAt: 1, updatedAt: 2 };

/** Plan of an actor outside the budgeted plan walk's frontier: only the arrival hint reaches it. */
const ARRIVAL_PLAN: PlanReview = { id: 'plan-courier', sessionId: 'default', revision: 3, content: '# Courier rollout\n\nStage the rollout and verify the receipt.', status: 'pending', annotations: [], feedback: null, handoffAccepted: false, createdAt: 30, updatedAt: 30 };

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

const SLATES: SlateSummary[] = [{ id: 'dashboard', title: 'Dashboard', port: 8789 }];

const SANDBOX_URL = 'https://8080-sandbox-aaaaaaaaaaaaaaaa.preview.example.test/';

const DEVICE_URL = 'https://3000-device-aaaaaaaaaaaaaaaa.preview.example.test/';

const NOTHING = () => {};

/** A connected machine, raised by `data-add-machine`; its git diff is one added line. */
const MACHINE: ExecutorInfo = { name: 'device', kind: 'device', capabilities: [], available: true, configured: true, active: true, status: 'active' };

/** A sandbox that could run but is asleep, raised by `data-add-idle-sandbox`: reading it would wake it. */
const IDLE_COMPUTER: ExecutorInfo = { name: 'computer', kind: 'computer', capabilities: [], available: true, configured: true, active: false, status: 'idle' };

const MACHINE_DIFF: ExecutorDiffResult = { mode: 'git', files: [{ path: 'src/device.ts', status: 'added', added: 1, removed: 0,
  lines: [{ kind: 'hunk', text: '@@ -0,0 +1 @@' }, { kind: 'add', text: 'export const onDevice = true;' }] }] };

const EDITED: FileDiff[] = [
  { path: 'src/app.ts', status: 'changed', added: 1, removed: 0, lines: [{ kind: 'add', text: 'export const ready = true;' }] },
  {
    path: 'src/ready.ts', status: 'added', added: 2, removed: 0,
    lines: [{ kind: 'add', text: 'export const shown = true;' }, { kind: 'add', text: 'export const hidden = false;' }],
  },
];

const EDITED_AGAIN: FileDiff[] = EDITED.map((file, at) => (at === 0 ? { ...file, lines: [{ kind: 'add', text: 'export const ready = isReady();' }] } : file));

/** An actor as the Work tab names it; the root has no path to inspect it by. */
const ownerOf = (name: string, retired = false): WorkspaceWorkOwner => ({ actorId: `actor-${name}`, name, title: name, retired, path: name === 'main' ? null : [name] });

/** Every actor's plans the Work tab lists: the root's (and its superseded revision), the courier's, a worker's, a nested
 *  delivery and an archived one. */
function workspaceWork(plan: PlanReview | null, workerPlan: PlanReview): WorkspaceAnswer<'listWorkspaceWork'> {
  const rootPlans = plan ? [
    { owner: ownerOf('main'), plan, tasks: [] },
    { owner: ownerOf('main'), plan: { ...ROOT_PLAN, revision: 1, status: 'superseded' as const, content: '# Earlier dashboard plan' }, tasks: [] },
  ] : [];

  return {
    plans: [
      ...rootPlans,
      { owner: ownerOf('courier'), plan: ARRIVAL_PLAN, tasks: [] },
      {
        owner: ownerOf('worker'), plan: workerPlan,
        tasks: [{ id: 't1', parentId: null, title: 'Deliver worker', status: 'active', updatedAt: 1, note: null, subtasks: [] }],
      },
      {
        owner: ownerOf('nested'), plan: { ...ROOT_PLAN, revision: 1, content: '# Nested delivery', status: 'approved' as const, handoffAccepted: true },
        tasks: [{ id: 't2', parentId: null, title: 'Deliver nested', status: 'done', updatedAt: 1, note: null, subtasks: [] }],
      },
      { owner: ownerOf('archive', true), plan: { ...ROOT_PLAN, revision: 1, content: '# Archived delivery', status: 'approved' as const, handoffAccepted: true }, tasks: [] },
    ],
    tasks: [{ owner: ownerOf('main'), plan: null, tasks: [] }],
  };
}

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
  const [edited, setEdited] = useState<FileDiff[] | null>(null);
  const [broken, setBroken] = useState(false);
  const [machine, setMachine] = useState(false);
  const [idleSandbox, setIdleSandbox] = useState(false);
  const [starting, setStarting] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const keptNotes = useRef<readonly ChangeNote[]>([]);
  const [failHistory, setFailHistory] = useState(false);
  const [workerPlan, setWorkerPlan] = useState<PlanReview>({ ...ROOT_PLAN, revision: 1, content: "# Worker plan", status: "approved", handoffAccepted: true, createdAt: 10 });
  const [owner, setOwner] = useState("main");
  // Real root connection, for the arrival hint only.
  const { workspacePlanArrival } = useKinu('preview-tabs');

  const answers = useMemo((): WorkspaceAnswers => ({
    previewSlate: () => ({ ok: true, value: { url: SLATE_GALLERY_URL, port: 8789, sized: false } }),
    getExecutorDiff: (executor) => {
      document.documentElement.dataset.galleryDiffReads = `${document.documentElement.dataset.galleryDiffReads ?? ''} ${executor}`.trim();

      if (broken) return { mode: 'vfs-baseline', files: [], error: 'the change-set read failed' };

      return executor === MACHINE.name ? MACHINE_DIFF : { mode: 'vfs-baseline', trackedSince: Date.now() - 36e5, files: edited ?? [] };
    },
    getExecutorChangeCount: (executor) => {
      if (broken) return { files: 0, error: 'the change-set read failed' };

      return { files: executor === MACHINE.name ? MACHINE_DIFF.files.length : (edited ?? []).length };
    },
    getChangeNotes: () => [...keptNotes.current],
    saveChangeNotes: (_executor, notes) => {
      keptNotes.current = notes;

      return { ok: true, notes };
    },
    sendChangeNotes: () => {
      keptNotes.current = [];

      return { ok: true, notes: [] };
    },
    resetWorkspaceBaseline: () => {
      setEdited(null);

      return { ok: true, capturedAt: 0, cleanupFailures: [] };
    },
    restoreWorkspaceBaseline: () => {
      setEdited(EDITED);

      return { ok: true, capturedAt: 0 };
    },
    // The courier plan is already listed, so the arrival hint is the auto-open trigger, not a discovery read.
    listWorkspaceWork: () => (failHistory
      ? Effect.fail(new KinuError('unavailable', 'Plan history temporarily unavailable'))
      : Effect.succeed(workspaceWork(plan, workerPlan))),
    decidePlanReview: () => {
      const next: PlanReview = { ...ROOT_PLAN, status: 'approved', handoffAccepted: true, updatedAt: 3 };

      setPlan(next);

      return { ok: true, plan: next, queued: true };
    },
    savePlanReviewAnnotations: () => (plan === null ? { ok: false, error: 'No plan to annotate', plan: null } : { ok: true, plan }),
    getEvolutionChangelog: () => ({ entries: [], unseenCount: 0, seenAt: 0 }),
    markChangelogSeen: () => ({ ok: true, seenAt: 0 }),
  }), [plan, edited, broken, failHistory, workerPlan]);

  const rpc = useMemo(() => answeringRpc(answers), [answers]);

  const workerRpc = useMemo(() => answeringRpc({
    ...answers,
    decidePlanReview: () => {
      const next: PlanReview = { ...workerPlan, status: 'approved', handoffAccepted: true };

      setWorkerPlan(next);

      return { ok: true, plan: next, queued: true };
    },
    savePlanReviewAnnotations: () => ({ ok: true, plan: workerPlan }),
  }), [answers, workerPlan]);

  return <div className="h-screen p-bg flex flex-col">
    <div className="flex gap-2 p-2 t-meta shrink-0 flex-wrap" data-plan-owner={owner}>
      <button data-break-plans onClick={() => setFailHistory(value => !value)}>Toggle history failure</button>
      <button data-worker-plan onClick={() => setWorkerPlan({ ...workerPlan, revision: 2, createdAt: 20, status: "pending", handoffAccepted: false, content: "# Worker revision two" })}>Submit worker plan</button>
      <button data-open-workspace onClick={() => setOwner('main')}>Back to workspace conversation</button>
      <button data-new-preview onClick={() => { setSlates([...SLATES, { id: 'report', title: 'Report' }]); setFocus('slate:report'); }}>New preview</button>
      <button data-new-plan onClick={() => { setPlan(ROOT_PLAN); setPlanFocus('plan-dashboard:2'); }}>Submit plan</button>
      <button data-refresh-preview onClick={() => setReload(n => n + 1)}>Refresh source</button>
      <button data-add-diff onClick={() => setEdited(EDITED)}>Edit file</button>
      <button data-edit-again onClick={() => setEdited(EDITED_AGAIN)}>Edit it again</button>
      <button data-revert-diff onClick={() => setEdited(null)}>Revert file</button>
      <button data-break-diff onClick={() => setBroken(true)}>Break read</button>
      <button data-add-machine onClick={() => setMachine(true)}>Connect a machine</button>
      <button data-add-idle-sandbox onClick={() => setIdleSandbox(true)}>Idle sandbox</button>
      <button data-narrow-pane onClick={() => setNarrow(on => !on)}>Narrow pane</button>
      <button data-sandbox-starting onClick={() => setStarting(on => !on)}>Sandbox starting</button>
      <button data-notify-plan onClick={() => notify(ARRIVAL_REFERENCE)}>Notify courier plan</button>
      <button data-notify-stale onClick={() => notify(STALE_REFERENCE)}>Notify stale plan</button>
      <button data-notify-malformed onClick={() => notify(MALFORMED_REFERENCE)}>Notify malformed plan</button>
    </div>
    <div data-preview-surface className="flex-1 min-h-0" style={narrow ? { width: INSPECTOR_DEFAULT_PX } : undefined}>
      <WorkSurface planRpc={owner === "main" ? rpc : workerRpc} planOwner={owner} onReviewActor={setOwner} surface={surface} onSurface={setSurface} previewFocus={focus} planFocus={planFocus}
        workspacePlanArrival={workspacePlanArrival}
        pinnedPorts={[{ executor: 'workspace', port: 8789, url: SLATE_GALLERY_URL, name: 'Duplicate dashboard port' }, { executor: 'computer', port: 8080, url: SANDBOX_URL, name: 'Sandbox app' }, { executor: 'device', port: 3000, url: DEVICE_URL, name: 'Device app' }]}
        slates={slates} slateReloads={new Map(slates.map(item => [item.id, reload]))}
        previewError={null} previewStarting={starting ? ['computer'] : []} onRefreshPorts={NOTHING} plan={owner === "main" ? plan : workerPlan} snapshot={{ status: 'loading' }} onRetryLoad={NOTHING}
        memory={[]} memoryContent="" onSearchMemory={NOTHING} mctsTrees={new Map()} headActivity={new Map()} isStreaming={false}
        executors={[...machine ? [MACHINE] : [], ...idleSandbox ? [IDLE_COMPUTER] : []]} executorOutputs={new Map()} onExecute={async () => ({})} backgroundJobs={[]} inspectedWork={[]} onRefreshJobs={NOTHING} pendingActions={[]}
        tabPresence={{ explorations: false, work: true }} rpc={rpc} />
    </div>
  </div>;
}

export function CompactPreviewGallery() {
  return <div className="p-6"><div data-chat-preview className="h-64"><PreviewFrame url={SLATE_GALLERY_URL} label="Chat preview" /></div></div>;
}
