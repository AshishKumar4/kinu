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
 * Three frames share the shell:
 *   checkout: a Build turn mid-fix, Work tab open, Run/Supervise live
 *   plan:     the walkthrough movie (`landing-movie-timeline.ts`) — typing,
 *             tool calls, plan review, approval, and the slate it builds,
 *             played over these same components
 *   slate:    a slate the agent wrote, open in its own tab, drawn in the page
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { MemoryRouter } from 'react-router-dom';
import type { UIMessage } from 'ai';
import { planReviewAwaitingDecision, type PlanReview } from '@kinu.run/core';

import { Composer, type ChatMode } from '@/components/Composer';
import { MessageView } from '@/components/MessageView';
import { ModelPicker } from '@/components/ModelPicker';
import { PreviewChrome } from '@/components/PreviewFrame';
import Sidebar from '@/components/Sidebar';
import { SubordinateTabs } from '@/components/SubordinateTabs';
import { WorkspaceBar, type Altitude } from '@/components/WorkspaceBar';
import { WorkSurface, type SurfaceKind } from '@/components/surfaces/WorkSurface';
import { SLATE_PREFIX } from '@/components/surfaces/presence';
import { SupervisePage } from '@/pages/SupervisePage';
import { WorkspaceRosterProvider } from '@/hooks/use-workspace-roster';
import type { ForkNode } from '@/lib/protocol';

import {
  CHECKOUT_MESSAGES, LANDING_MODEL, LANDING_MODELS, LANDING_SUBORDINATES, LANDING_WORKSPACE,
  SLATE_MESSAGES, SLATE_PREVIEW_URL, SLATE_SUMMARY,
  checkoutWorkFixture, planRpc, superviseRpc,
} from './landing-fixtures';
import {
  CURSOR_ENTER_AT, MOVIE_CUES, MOVIE_END,
  composerTextAt, cueCountAt, cursorAt, discreteAt,
  MOVIE_PLAN,
  type LandingMovieHandle, type MovieTarget,
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

/** The transcript behind a memo boundary: the movie's typing animation
 *  re-renders the frame per keystroke, and without this every frame would
 *  re-parse the Markdown the beats already built. Props are beat-stable, so
 *  typing renders touch only the composer. */
const Transcript = memo(function Transcript(
  { messages, streaming }: { messages: readonly UIMessage[]; streaming: boolean },
): ReactElement {
  return (
    <>
      {messages.map((message, index) => (
        <MessageView
          key={message.id}
          message={message}
          isLast={index === messages.length - 1}
          isStreaming={streaming && index === messages.length - 1}
        />
      ))}
    </>
  );
});

export default function LandingWorkspaceFrame({ kind }: { kind: LandingFrameKind }): ReactElement {
  const frame = FRAME[kind];
  // Only the plan frame carries the movie; the others keep their static story.
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

  // The movie's decision flows through the real `decidePlanReview` rpc: the
  // cursor's click lands on the product's Approve button, and the decided plan
  // it returns overrides the timeline's pending one from then on.
  const [decided, setDecided] = useState<PlanReview | null>(() => (
    reduced && isMovie
      ? { ...MOVIE_PLAN, status: 'approved', feedback: null, handoffAccepted: true, updatedAt: Date.now(), decidedAt: Date.now() }
      : null
  ));

  const decidePlan = useMemo(() => planRpc(setDecided, MOVIE_PLAN), []);
  const [, setWorkVersion] = useState(0);
  const work = useMemo(() => checkoutWorkFixture(() => setWorkVersion((version) => version + 1)), []);
  const rpc = kind === 'plan' ? decidePlan : work.rpc;
  const plan = isMovie ? (decided ?? discrete.plan) : null;
  const planLocked = planReviewAwaitingDecision(plan);
  const [mode, setMode] = useState<ChatMode>(frame.mode);
  useEffect(() => {
    if (planLocked) setMode('plan');
    else if (plan?.status === 'approved') setMode('build');
  }, [planLocked, plan?.status]);
  // The movie opens the slate tab by itself at the slate beat; between beats
  // the reader's own tab picks stand.
  useEffect(() => {
    if (isMovie) setSurface(discrete.surface);
  }, [isMovie, discrete.surface]);
  const onSurface = useCallback((next: SurfaceKind) => setSurface(next), []);

  const slates = useMemo(
    () => (isMovie ? discrete.slates : (kind === 'slate' ? [SLATE_SUMMARY] : [])),
    [isMovie, discrete.slates, kind],
  );

  const slateBody = useCallback(() => <SlateBody />, []);
  // A transcript opens at its latest turn, as the app opens it.
  const transcript = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = transcript.current;

    if (list !== null) list.scrollTop = list.scrollHeight;
  }, [altitude, cueCount]);

  /** One target's center in stage coordinates, or null while it is unmounted
   *  (the plan chunk still loading, or the slate tab not yet opened). */
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

  /** The cursor's click, landing on the product's own Approve button so the
   *  decision runs the product's `decidePlanReview` path, not a storyboard. */
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

  /** Imperative per-frame paint: cursor, ripple, pressed state, progress
   *  attributes. Never triggers a React render. */
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

  /** Beats rebuild the discrete story; the typing animation paints the draft
   *  per frame between them (the window holds no cues, so the two never fight). */
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
      // The first rAF timestamp can predate the performance.now() taken when
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
      } else if (!approveFiredRef.current && t >= MOVIE_CUES.approve) {
        if (clickApprove()) approveFiredRef.current = true;
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

  // Re-anchor the cursor whenever a beat re-renders the stage: targets move
  // when surfaces swap, so the pixel position is recomputed after commit.
  useLayoutEffect(() => {
    syncFrame();
  });

  // Play once when the stage becomes visible. Replays are deliberate clicks;
  // scrolling away and back never restarts the story.
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
        // Settle async fallout: the plan view is a lazy chunk behind
        // Suspense, and the approve click decides through the product's rpc.
        // Neither re-runs this component's effects, so poll frames until the
        // beat's expectations hold, then re-anchor the cursor.
        const settled = discreteAt(tRef.current);

        if (settled.plan !== null) {
          for (let tick = 0; tick < 90; tick += 1) {
            if (stageRef.current?.querySelector('[data-kinu-plan-review]') !== null) break;
            await nextFrame();
            syncFrame();
          }
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

        if (settled.slates.length > 0) {
          for (let tick = 0; tick < 90; tick += 1) {
            if (stageRef.current?.querySelector('[data-slate-dashboard]') !== null) break;
            await nextFrame();
          }
        }

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
      <WorkspaceRosterProvider>
      <div
        ref={stageRef}
        data-landing-frame={kind}
        data-workspace-mode={altitude}
        {...(isMovie
          ? { 'data-movie-phase': discrete.phase, 'data-movie-settled': discrete.settled ? 'true' : 'false' }
          : {})}
        aria-label={kind === 'checkout' ? 'Kinu workspace interface preview' : `Kinu ${kind} interface preview`}
        className="relative flex flex-col overflow-hidden rounded-2xl border p-border p-bg p-text text-left shadow-[0_40px_110px_-50px_rgba(0,0,0,.95)] md:flex-row"
      >
        {/* The app's own rail, as the harness rule requires: gallery.tsx:2370
            photographs this same surface for the same reason, and layout.tsx
            :51-54 renders it in the app. Below md the app shows a drawer
            summoned from its header (layout.tsx:57-63), not a rail — the frame
            has no app header, so it shows no rail there either. */}
        <aside className="hidden w-60 shrink-0 h-full p-sidebar border-r p-border md:block"><Sidebar /></aside>
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
                plan={plan} planRpc={rpc}
                snapshot={{ status: 'loading' }} onRetryLoad={() => {}} tools={[]} memory={[]} memoryContent="" onSearchMemory={() => {}}
                mctsTrees={EMPTY_TREES} headActivity={NO_HEAD_ACTIVITY} isStreaming={isMovie ? streaming : kind === 'checkout'}
                executors={[]} executorOutputs={new Map()} onExecute={async () => ({})}
                backgroundJobs={isMovie ? [] : work.jobs()} onRefreshJobs={() => setWorkVersion((version) => version + 1)}
                pendingActions={isMovie ? [] : work.pending()}
                slates={slates} slateBody={slateBody}
                rpc={rpc}
              />
            </div>
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
    </MemoryRouter>
  );
}
