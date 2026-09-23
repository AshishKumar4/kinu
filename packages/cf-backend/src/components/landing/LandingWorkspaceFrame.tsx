/** Product components fed fixture state; loaded lazily so the landing first paint skips the workspace renderers. */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { MemoryRouter } from 'react-router-dom';
import type { UIMessage } from 'ai';
import { planReviewAwaitingDecision, threadLiveTail, type PlanReview } from '@kinu.run/core';

import { Composer, type ChatMode } from '@/components/Composer';
import { ChatLiveTail, MessageView } from '@/components/MessageView';
import { ModelPicker } from '@/components/ModelPicker';
import { PreviewChrome } from '@/components/PreviewFrame';
import { SidebarRail } from '@/components/SidebarRail';
import { SubordinateTabs } from '@/components/SubordinateTabs';
import { WorkspaceBar, type Altitude } from '@/components/WorkspaceBar';
import { WorkSurface } from '@/components/surfaces/WorkSurface';
import { InspectorToggle, WorkbenchPanels } from '@/components/WorkbenchPanels';
import { SLATE_PREFIX, type SurfaceKind } from '@kinu.run/core';
import { SupervisePage } from '@/pages/SupervisePage';
import { AccountProvider } from '@/hooks/use-account';
import { WorkspaceRosterProvider } from '@/hooks/use-workspace-roster';
import type { ForkNode } from '@kinu.run/core';

import {
  CHECKOUT_MESSAGES, LANDING_MODEL, LANDING_MODELS, LANDING_SUBORDINATES, LANDING_TAB_PRESENCE, LANDING_WORKSPACE,
  SLATE_MESSAGES, SLATE_PREVIEW_URL, SLATE_SUMMARY,
  checkoutWorkFixture, planRpc, superviseRpc,
} from './landing-fixtures';
import { MOVIE_CUES, MOVIE_END, type LandingMovieHandle } from '@kinu.run/core';
import {
  CURSOR_ENTER_AT,
  composerTextAt, cueCountAt, cursorAt, discreteAt,
  MOVIE_PLAN,
  type MovieTarget,
} from './landing-movie-timeline';
import { SlateDashboard } from './SlateDashboard';

export type LandingFrameKind = 'checkout' | 'plan' | 'slate';

const EMPTY_TREES: ReadonlyMap<string, ForkNode> = new Map();

const NO_HEAD_ACTIVITY: ReadonlyMap<string, number> = new Map();

interface FrameSpec {
  readonly title: string;
  readonly surface: SurfaceKind;
  readonly mode: ChatMode;
}

const FRAME = {
  checkout: { title: 'Checkout coupon bug', surface: 'Work', mode: 'build' },
  plan: { title: 'Checkout coupon bug', surface: 'Work', mode: 'plan' },
  slate: { title: 'Support queue', surface: `${SLATE_PREFIX}${SLATE_SUMMARY.id}`, mode: 'build' },
} satisfies Record<LandingFrameKind, FrameSpec>;

const STATIC_MESSAGES = {
  checkout: CHECKOUT_MESSAGES,
  slate: SLATE_MESSAGES,
} as const;

function SlateBody(): ReactElement {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <PreviewChrome url={SLATE_PREVIEW_URL} />
      <SlateDashboard />
    </div>
  );
}

/** Memoized: the typing animation re-renders per keystroke; props are beat-stable, so only the composer re-renders. */
const Transcript = memo(function Transcript(
  { messages, streaming }: { messages: readonly UIMessage[]; streaming: boolean },
): ReactElement {
  const tail = threadLiveTail({
    last: messages.at(-1),
    liveness: streaming ? { kind: 'live', turnId: null } : { kind: 'idle' },
  });

  return (
    <>
      {messages.map((message, index) => (
        <MessageView
          key={message.id}
          message={message}
          liveTail={index === messages.length - 1 ? tail : null}
        />
      ))}
      <ChatLiveTail tail={tail} />
    </>
  );
});

export default function LandingWorkspaceFrame({ kind }: { kind: LandingFrameKind }): ReactElement {
  const frame = FRAME[kind];
  const isMovie = kind === 'plan';
  const [reduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const tRef = useRef(reduced && isMovie ? MOVIE_END : 0);
  const cueRef = useRef(cueCountAt(tRef.current));
  const [cueCount, setCueCount] = useState(cueRef.current);
  const [playing, setPlaying] = useState(false);
  const startedRef = useRef(false);
  const approveFiredRef = useRef(false);
  const lastTypedRef = useRef('');
  const stageRef = useRef<HTMLDivElement | null>(null);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const rippleRef = useRef<HTMLDivElement | null>(null);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const pressedRef = useRef<HTMLElement | null>(null);

  const discrete = useMemo(() => discreteAt(tRef.current), [cueCount]);
  const messages = kind === 'plan' ? discrete.messages : STATIC_MESSAGES[kind];
  const streaming = isMovie && discrete.streaming;

  const [altitude, setAltitude] = useState<Altitude>('run');

  const [surface, setSurface] = useState<SurfaceKind>(
    reduced && isMovie ? discreteAt(MOVIE_END).surface : frame.surface,
  );

  const [draft, setDraft] = useState('');
  const [model, setModel] = useState(LANDING_MODEL);

  // The movie's decision flows through the real `decidePlanReview` rpc; the decided plan then
  // overrides the timeline's pending one.
  const [decided, setDecided] = useState<PlanReview | null>(() => (
    reduced && isMovie
      ? { ...MOVIE_PLAN, status: 'approved', feedback: null, handoffAccepted: true, updatedAt: Date.now(), decidedAt: Date.now() }
      : null
  ));

  // The rpc serves this same plan, so a workspace with no submitted plan answers [].
  const plan = isMovie ? (decided ?? discrete.plan) : null;
  const decidePlan = useMemo(() => planRpc(setDecided, plan), [plan]);
  const [, setWorkVersion] = useState(0);
  const work = useMemo(() => checkoutWorkFixture(() => setWorkVersion((version) => version + 1)), []);
  const rpc = kind === 'plan' ? decidePlan : work.rpc;
  const planLocked = planReviewAwaitingDecision(plan);
  const [mode, setMode] = useState<ChatMode>(frame.mode);
  useEffect(() => {
    if (planLocked) setMode('plan');
    else if (plan?.status === 'approved') setMode('build');
  }, [planLocked, plan?.status]);
  useEffect(() => {
    if (isMovie) setSurface(discrete.surface);
  }, [isMovie, discrete.surface]);
  const onSurface = useCallback((next: SurfaceKind) => setSurface(next), []);

  const slates = useMemo(
    () => {
      if (isMovie) return discrete.slates;

      return kind === 'slate' ? [SLATE_SUMMARY] : [];
    },
    [isMovie, discrete.slates, kind],
  );

  const slateBody = useCallback(() => <SlateBody />, []);
  const transcript = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = transcript.current;

    if (list !== null) list.scrollTop = list.scrollHeight;
  }, [altitude, cueCount]);

  /** Null while unmounted (plan chunk loading, or slate tab not opened). */
  const resolveTarget = (target: MovieTarget): { x: number; y: number } | null => {
    const stage = stageRef.current;

    if (stage === null) return null;
    const box = stage.getBoundingClientRect();

    if (target === 'cursor-origin') return { x: box.width - 56, y: box.height - 44 };
    let element: Element | null = null;

    if (target === 'composer') {
      element = stage.querySelector('[data-movie-target="composer"]');
    } else if (target === 'approve') {
      element = [...stage.querySelectorAll<HTMLButtonElement>('[data-plan-decisions] button')]
        .find((button) => !button.disabled && /approve/i.test(button.textContent ?? '')) ?? null;
    } else if (target === 'slate-tab') {
      element = stage.querySelector('[aria-label="Support queue"]');
    }

    if (element === null) return null;
    const rect = element.getBoundingClientRect();

    if (rect.width === 0) return null;

    return { x: rect.left - box.left + rect.width / 2, y: rect.top - box.top + rect.height / 2 };
  };

  const clickApprove = (): boolean => {
    const stage = stageRef.current;

    if (stage === null) return false;

    const approve = [...stage.querySelectorAll<HTMLButtonElement>('[data-plan-decisions] button')]
      .find((button) => !button.disabled && /approve/i.test(button.textContent ?? ''));

    if (approve instanceof HTMLButtonElement) {
      approve.click();

      return true;
    }

    return false;
  };

  /** Imperative per-frame paint; never triggers a React render. */
  const syncFrame = (): void => {
    const stage = stageRef.current;

    if (stage === null || !isMovie) return;
    const t = tRef.current;
    stage.dataset.movieT = String(Math.round(t));
    const cursor = cursorAt(t);
    const cursorNode = cursorRef.current;
    const rippleNode = rippleRef.current;

    if (pressedRef.current !== null) {
      pressedRef.current.style.transform = '';
      pressedRef.current = null;
    }

    if (cursorNode === null || rippleNode === null) return;

    if (reduced || !cursor.visible) {
      cursorNode.style.opacity = '0';
      rippleNode.style.opacity = '0';

      return;
    }

    const from = resolveTarget(cursor.from);
    const to = resolveTarget(cursor.to);

    const point = from !== null && to !== null
      ? { x: from.x + (to.x - from.x) * cursor.progress, y: from.y + (to.y - from.y) * cursor.progress }
      : (to ?? from ?? lastPointRef.current);

    if (point === null) {
      cursorNode.style.opacity = '0';
      rippleNode.style.opacity = '0';

      return;
    }

    lastPointRef.current = point;
    cursorNode.style.opacity = String(Math.min(1, Math.max(0, (t - CURSOR_ENTER_AT) / 400)));
    cursorNode.style.transform = `translate(${String(point.x - 2)}px, ${String(point.y - 1)}px)`;

    if (cursor.ripple !== null) {
      rippleNode.style.opacity = String(0.55 * (1 - cursor.ripple));
      rippleNode.style.transform
        = `translate(${String(point.x - 20)}px, ${String(point.y - 20)}px) scale(${String(0.35 + 0.85 * cursor.ripple)})`;
    } else {
      rippleNode.style.opacity = '0';
    }

    if (cursor.pressed !== null) {
      const pressed = stageRef.current?.querySelector(`[data-movie-target="${cursor.pressed}"]`)
        ?? [...(stageRef.current?.querySelectorAll<HTMLButtonElement>('[data-plan-decisions] button') ?? [])]
          .find((button) => !button.disabled && /approve/i.test(button.textContent ?? ''));

      if (pressed instanceof HTMLElement) {
        pressed.style.transform = 'scale(.96)';
        pressedRef.current = pressed;
      }
    }
  };

  /** The typing window holds no cues, so beats and the per-frame draft paint never fight. */
  const syncBeats = (): void => {
    const count = cueCountAt(tRef.current);

    if (count !== cueRef.current) {
      cueRef.current = count;
      setCueCount(count);
      const typed = composerTextAt(tRef.current);
      lastTypedRef.current = typed;
      setDraft(typed);
    }
  };

  useEffect(() => {
    if (!isMovie || reduced || !playing) return;
    let raf = 0;
    let last = performance.now();

    const step = (now: number): void => {
      // The first rAF timestamp can predate the `performance.now()` above, hence the clamp.
      tRef.current = Math.min(MOVIE_END, tRef.current + Math.max(0, now - last));
      last = now;
      const t = tRef.current;

      if (t < MOVIE_CUES.sent) {
        const typed = composerTextAt(t);

        if (typed !== lastTypedRef.current) {
          lastTypedRef.current = typed;
          setDraft(typed);
        }
      }

      const stage = stageRef.current;

      if (!approveFiredRef.current && stage?.querySelector('[data-plan-status]')?.textContent === 'Approved') {
        approveFiredRef.current = true;
      } else if (!approveFiredRef.current && t >= MOVIE_CUES.approve && clickApprove()) {
        approveFiredRef.current = true;
      }

      syncFrame();
      syncBeats();

      if (tRef.current >= MOVIE_END) {
        setPlaying(false);

        return;
      }

      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);

    return () => cancelAnimationFrame(raf);
  }, [isMovie, reduced, playing]);

  useLayoutEffect(() => {
    syncFrame();
  });

  // Plays once when visible; scrolling away and back never restarts it.
  useEffect(() => {
    if (!isMovie || reduced) return;
    const stage = stageRef.current;

    if (stage === null) return;

    const observer = new IntersectionObserver((entries) => {
      if (startedRef.current) return;

      for (const entry of entries) {
        if (entry.intersectionRatio >= 0.3) {
          startedRef.current = true;
          setPlaying(true);
          observer.disconnect();

          return;
        }
      }
    }, { threshold: [0.3] });

    observer.observe(stage);

    return () => observer.disconnect();
  }, [isMovie, reduced]);

  useEffect(() => {
    if (!isMovie) return;

    const nextFrame = (): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>();
      requestAnimationFrame(() => resolve());

      return promise;
    };

    /** Awaits the inserting mutation, not a frame count; resolves at once when already present. */
    const mounted = (selector: string): Promise<void> => {
      const stage = stageRef.current;

      if (stage === null || stage.querySelector(selector) !== null) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();

      const observer = new MutationObserver(() => {
        if (stage.querySelector(selector) === null) return;

        observer.disconnect();
        resolve();
      });

      observer.observe(stage, { childList: true, subtree: true });

      return promise;
    };

    const handle: LandingMovieHandle = {
      duration: MOVIE_END,
      cues: MOVIE_CUES,
      seek: async (at: number) => {
        setPlaying(false);
        approveFiredRef.current = false;
        tRef.current = Math.min(MOVIE_END, Math.max(0, at));
        const t = tRef.current;
        const typed = composerTextAt(t);
        lastTypedRef.current = typed;
        flushSync(() => {
          const count = cueCountAt(t);
          cueRef.current = count;
          setCueCount(count);
          setDraft(typed);
          setSurface(discreteAt(t).surface);

          if (t < MOVIE_CUES.approve) setDecided(null);
        });
        syncFrame();
        // Async fallout (lazy plan chunk, approve rpc) does not re-run this component's effects.
        const settled = discreteAt(tRef.current);

        if (settled.plan !== null) {
          // Awaits the same module specifier `WorkTab`'s `lazy()` holds, so it resolves when React can
          // render it; a static import would pull the plan renderer into the landing first paint.
          await import('@/components/surfaces/PlanReviewView');
          await mounted('[data-kinu-plan-review]');
          syncFrame();
        }

        if (tRef.current >= MOVIE_CUES.approve) {
          for (let tick = 0; tick < 90; tick += 1) {
            if (stageRef.current?.querySelector('[data-plan-status]')?.textContent === 'Approved') {
              approveFiredRef.current = true;
              break;
            }

            clickApprove();
            await nextFrame();
            syncFrame();
          }
        }

        if (settled.slates.length > 0) await mounted('[data-slate-dashboard]');

        syncFrame();
      },
      play: () => {
        if (tRef.current >= MOVIE_END) {
          approveFiredRef.current = false;
          tRef.current = 0;
          lastTypedRef.current = '';
          setDecided(null);
          setSurface('Work');
          setDraft('');
          syncBeats();
        }

        startedRef.current = true;
        setPlaying(true);
      },
      pause: () => setPlaying(false),
      state: () => ({ t: tRef.current, playing, settled: tRef.current >= MOVIE_END }),
    };

    window.__kinuLandingMovie = handle;

    return () => {
      if (window.__kinuLandingMovie === handle) delete window.__kinuLandingMovie;
    };
  });

  return (
    <MemoryRouter initialEntries={[`/workspace/${LANDING_WORKSPACE}`]}>
      <AccountProvider>
      <WorkspaceRosterProvider>
      <div
        ref={stageRef}
        data-landing-frame={kind}
        data-workspace-mode={altitude}
        {...(isMovie
          ? { 'data-movie-phase': discrete.phase, 'data-movie-settled': discrete.settled ? 'true' : 'false' }
          : {})}
        aria-label={kind === 'checkout' ? 'Kinu workspace interface preview' : `Kinu ${kind} interface preview`}
        className="p-workbench relative flex flex-col overflow-hidden rounded-b-2xl border p-border p-bg p-text text-left shadow-[0_40px_110px_-50px_rgba(0,0,0,.95)] md:flex-row"
      >
        {/* Below md the app summons a drawer from its header; the frame has no header, so no rail there. */}
        <SidebarRail />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
            <SupervisePage rpc={superviseRpc} />
          </div>
        ) : (
          <div data-workspace-panel="run" className="flex h-[620px] min-h-0 flex-col md:h-[760px]">
            <WorkbenchPanels
              scope={kind}
              workspace={undefined}
              contents={{
                pendingActions: isMovie ? [] : work.pending(),
                pendingConsents: [],
                slates,
                previewFocus: null,
                pinnedPorts: [],
                activePlan: plan,
              }}
              chat={(inspectorControl) => <>
                <SubordinateTabs
                  workspace={LANDING_WORKSPACE}
                  subordinates={LANDING_SUBORDINATES}
                  activeName={undefined}
                  onCreate={async () => {}}
                  creating={false}
                  onDismiss={async () => {}}
                  onRename={async (_name, displayName) => displayName}
                  trailing={inspectorControl && <InspectorToggle control={inspectorControl} />}
                />
                <div className="@container flex min-h-0 flex-1 flex-col">
                  <div ref={transcript} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-7 lg:px-8 [&>*]:mx-auto [&>*]:max-w-[780px]">
                    <Transcript messages={messages} streaming={streaming} />
                  </div>
                  <div data-movie-target="composer" className="border-t p-border p-sidebar">
                    <Composer
                      value={draft}
                      onValueChange={setDraft}
                      onSend={() => setDraft('')}
                      onStop={() => {}}
                      placeholder="Send a message..."
                      disabled={false}
                      liveness={{ kind: 'idle' }}
                      mode={{ value: mode, onChange: setMode, locked: planLocked }}
                      attachments={{ parts: [], onAdd: () => {}, onRemove: () => {} }}
                      modelPicker={<ModelPicker models={LANDING_MODELS} value={model} onChange={setModel} size="xs" />}
                    />
                  </div>
                </div>
              </>}
              inspector={(
                <WorkSurface
                  surface={surface} onSurface={onSurface}
                  pinnedPorts={[]} previewError={null} onRefreshPorts={() => {}}
                  plan={plan} planRpc={rpc}
                  snapshot={{ status: 'loading' }} onRetryLoad={() => {}} tools={[]} memory={[]} memoryContent="" onSearchMemory={() => {}}
                  mctsTrees={EMPTY_TREES} headActivity={NO_HEAD_ACTIVITY} isStreaming={isMovie ? streaming : kind === 'checkout'}
                  executors={[]} executorOutputs={new Map()} onExecute={async () => ({})}
                  backgroundJobs={isMovie ? [] : work.jobs()} onRefreshJobs={() => setWorkVersion((version) => version + 1)}
                  pendingActions={isMovie ? [] : work.pending()}
                  slates={slates} slateBody={slateBody}
                  tabPresence={LANDING_TAB_PRESENCE}
                  rpc={rpc}
                />
              )}
            />
          </div>
        )}
        </div>
        {isMovie && !reduced && (
          <div aria-hidden className="pointer-events-none absolute inset-0 z-30">
            <div
              ref={rippleRef}
              className="absolute left-0 top-0 size-10 rounded-full border-2 border-[var(--c-accent)] opacity-0"
            />
            <div ref={cursorRef} data-movie-cursor className="absolute left-0 top-0 opacity-0 drop-shadow-[0_1px_2px_rgba(0,0,0,.6)]">
              <svg width="20" height="22" viewBox="0 0 20 22">
                <path
                  d="M2 1 L2 17 L6.5 13.5 L9.5 20 L12.5 18.7 L9.6 12.4 L15.5 12 Z"
                  fill="var(--c-text)"
                  stroke="var(--c-bg)"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
          </div>
        )}
      </div>
      </WorkspaceRosterProvider>
      </AccountProvider>
    </MemoryRouter>
  );
}
