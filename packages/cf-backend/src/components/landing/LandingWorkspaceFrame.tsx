/**
 * The workspace as the landing page shows it: the product's own components,
 * fed fixture state (`landing-fixtures.ts`) the way `gallery.tsx` feeds its
 * frames. WorkspaceBar, SubordinateTabs, MessageView, Composer, WorkSurface,
 * SupervisePage and PlanReviewView are the shipped ones; nothing here is a
 * drawing of them.
 *
 * Loaded lazily from `LandingFrame`: the first paint of the landing page does
 * not pay for the workspace's renderers (Markdown, code highlighting, the plan
 * viewer), which arrive with this chunk.
 *
 * ENROLLED IN `scripts/wired.lock.json`. `gate:wired` cannot see this
 * module's consumer, and the absence is the gate's, not the code's:
 * `LandingFrame` reaches it through `lazy(() => import('./LandingWorkspaceFrame'))`,
 * and a dynamic `import()` is an expression that binds no name, so there is
 * no named edge to follow. The split is deliberate, for the reason above.
 *
 * Three frames share the shell:
 *   checkout: a Build turn mid-fix, Work tab open, Run/Supervise live
 *   plan:     a Plan turn: the plan sits in Output, one annotation on it
 *   slate:    a slate the agent wrote, open in its own tab, drawn in the page
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { UIMessage } from 'ai';
import { planReviewAwaitingDecision, type PlanReview } from '@kinu.run/core';

import { Composer, type ChatMode } from '@/components/Composer';
import { MessageView } from '@/components/MessageView';
import { ModelPicker } from '@/components/ModelPicker';
import { PreviewChrome } from '@/components/PreviewFrame';
import { SubordinateTabs } from '@/components/SubordinateTabs';
import { WorkspaceBar, type Altitude } from '@/components/WorkspaceBar';
import { WorkSurface, type SurfaceKind } from '@/components/surfaces/WorkSurface';
import { SLATE_PREFIX } from '@/components/surfaces/presence';
import { SupervisePage } from '@/pages/SupervisePage';
import type { ForkNode } from '@/lib/protocol';

import {
  CHECKOUT_MESSAGES, LANDING_MODEL, LANDING_MODELS, LANDING_SUBORDINATES, LANDING_WORKSPACE,
  PLAN_FIXTURE, PLAN_MESSAGES, SLATE_MESSAGES, SLATE_PREVIEW_URL, SLATE_SUMMARY,
  checkoutWorkFixture, planRpc, superviseRpc,
} from './landing-fixtures';
import { SlateDashboard } from './SlateDashboard';

export type LandingFrameKind = 'checkout' | 'plan' | 'slate';

const EMPTY_TREES: ReadonlyMap<string, ForkNode> = new Map();
const NO_HEAD_ACTIVITY: ReadonlyMap<string, number> = new Map();

interface FrameSpec {
  readonly title: string;
  readonly messages: readonly UIMessage[];
  readonly surface: SurfaceKind;
  readonly mode: ChatMode;
}

const FRAME = {
  checkout: { title: 'Checkout coupon bug', messages: CHECKOUT_MESSAGES, surface: 'Work', mode: 'build' },
  plan: { title: 'Checkout coupon bug', messages: PLAN_MESSAGES, surface: 'Output', mode: 'plan' },
  slate: { title: 'Support queue', messages: SLATE_MESSAGES, surface: `${SLATE_PREFIX}${SLATE_SUMMARY.id}`, mode: 'build' },
} satisfies Record<LandingFrameKind, FrameSpec>;

/**
 * The app's surfaces keep their selected tab in view with `scrollIntoView`.
 * Inside the app nothing else can move; on a page that scrolls, a frame
 * mounting below the fold would carry the document down to itself. The layout
 * effect reads the position before any child effect runs, and the passive
 * effect, which runs after every child's, puts it back.
 */
function useHeldDocumentScroll(): void {
  const held = useRef(0);
  useLayoutEffect(() => { held.current = window.scrollY; });
  useEffect(() => {
    if (window.scrollY !== held.current) window.scrollTo(0, held.current);
  });
}

function SlateBody(): ReactElement {
  const [reload, setReload] = useState(0);
  return (
    <div className="flex h-[480px] flex-col overflow-hidden rounded-lg border p-border">
      <PreviewChrome url={SLATE_PREVIEW_URL} label={SLATE_SUMMARY.id} onReload={() => setReload((count) => count + 1)} />
      <SlateDashboard key={reload} />
    </div>
  );
}

export default function LandingWorkspaceFrame({ kind }: { kind: LandingFrameKind }): ReactElement {
  const frame = FRAME[kind];
  useHeldDocumentScroll();
  const [altitude, setAltitude] = useState<Altitude>('run');
  const [surface, setSurface] = useState<SurfaceKind>(frame.surface);
  const [draft, setDraft] = useState('');
  const [model, setModel] = useState(LANDING_MODEL);
  const [plan, setPlan] = useState<PlanReview | null>(kind === 'plan' ? PLAN_FIXTURE : null);
  const [, setWorkVersion] = useState(0);
  const work = useMemo(() => checkoutWorkFixture(() => setWorkVersion((version) => version + 1)), []);
  const decidePlan = useMemo(() => planRpc(setPlan), []);
  const rpc = kind === 'plan' ? decidePlan : work.rpc;
  const planLocked = planReviewAwaitingDecision(plan);
  const [mode, setMode] = useState<ChatMode>(frame.mode);
  useEffect(() => {
    if (planLocked) setMode('plan');
    else if (plan?.status === 'approved') setMode('build');
  }, [planLocked, plan?.status]);
  const onSurface = useCallback((next: SurfaceKind) => setSurface(next), []);
  const slates = useMemo(() => (kind === 'slate' ? [SLATE_SUMMARY] : []), [kind]);
  const slateBody = useCallback(() => <SlateBody />, []);
  // A transcript opens at its latest turn, as the app opens it.
  const transcript = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = transcript.current;
    if (list !== null) list.scrollTop = list.scrollHeight;
  }, [altitude]);

  return (
    <MemoryRouter initialEntries={[`/workspace/${LANDING_WORKSPACE}`]}>
      <div
        data-landing-frame={kind}
        data-workspace-mode={altitude}
        aria-label={kind === 'checkout' ? 'Kinu workspace interface preview' : `Kinu ${kind} interface preview`}
        className="flex flex-col overflow-hidden rounded-2xl border p-border p-bg p-text text-left shadow-[0_40px_110px_-50px_rgba(0,0,0,.95)]"
      >
        <WorkspaceBar
          title={frame.title}
          onRename={async (name) => name}
          connectionStatus="connected"
          working={kind === 'checkout'}
          model={LANDING_MODEL}
          altitude={altitude}
          onAltitude={setAltitude}
        />
        {altitude === 'supervise' ? (
          <div data-workspace-panel="supervise" className="h-[760px] min-h-0 overflow-hidden">
            <SupervisePage rpc={superviseRpc} onRunTask={() => {}} />
          </div>
        ) : (
          <div data-workspace-panel="run" className="grid md:h-[760px] md:grid-cols-[minmax(0,1fr)_430px] md:grid-rows-[minmax(0,1fr)]">
            <div className="@container flex h-[520px] min-w-0 flex-col border-b p-border md:h-full md:border-b-0 md:border-r">
              <SubordinateTabs
                workspace={LANDING_WORKSPACE}
                subordinates={LANDING_SUBORDINATES}
                activeName={undefined}
                onCreate={async () => {}}
                creating={false}
                onDismiss={async () => {}}
              />
              <div ref={transcript} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-7 lg:px-8 [&>*]:mx-auto [&>*]:max-w-[780px]">
                {frame.messages.map((message, index) => (
                  <MessageView key={message.id} message={message} isLast={index === frame.messages.length - 1} isStreaming={false} />
                ))}
              </div>
              <div className="border-t p-border p-sidebar">
                <Composer
                  value={draft}
                  onValueChange={setDraft}
                  onSend={() => setDraft('')}
                  onStop={() => {}}
                  placeholder="Send a message..."
                  disabled={false}
                  streaming={false}
                  mode={{ value: mode, onChange: setMode, locked: planLocked }}
                  attachments={{ parts: [], onAdd: () => {}, onRemove: () => {} }}
                  modelPicker={<ModelPicker models={LANDING_MODELS} value={model} onChange={setModel} size="xs" />}
                />
              </div>
            </div>
            <div className="h-[620px] min-w-0 md:h-full">
              <WorkSurface
                surface={surface} onSurface={onSurface}
                pinnedPorts={[]} previewError={null} onRefreshPorts={() => {}}
                plan={plan} planRpc={decidePlan}
                snapshot={{ status: 'loading' }} onRetryLoad={() => {}} tools={[]} memory={[]} memoryContent="" onSearchMemory={() => {}}
                mctsTrees={EMPTY_TREES} headActivity={NO_HEAD_ACTIVITY} isStreaming={kind === 'checkout'}
                executors={[]} executorOutputs={new Map()} onExecute={async () => ({})}
                backgroundJobs={work.jobs()} onRefreshJobs={() => setWorkVersion((version) => version + 1)}
                pendingActions={work.pending()}
                slates={slates} slateBody={slateBody}
                rpc={rpc}
              />
            </div>
          </div>
        )}
      </div>
    </MemoryRouter>
  );
}
