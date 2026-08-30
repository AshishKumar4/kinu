/**
 * The landing's bug-fix demo: one workspace stage playing the timeline in
 * `bugfix-demo-timeline.ts` — transcript, plan review, candidate race, and an
 * independently animated cursor — as a movie the visitor can pause and replay.
 *
 * Playback lives in refs. React re-renders only at beat boundaries
 * (`cueCountAt`); the cursor, ripple, and progress attributes update
 * imperatively per animation frame, so a frame never re-parses markdown. The
 * stage body is `inert`: its controls are the story, not this page's UI. The
 * real controls (pause, replay) sit in the header outside the inert subtree.
 *
 * `window.__kinuBugfixDemo` exposes seek/play/pause. The public-page tests
 * and the README capture script drive the SAME timeline through it — the
 * shipped animation is a screenshot series of this component, never a copy.
 *
 * Plays once when scrolled into view, then holds the settled state; replay is
 * a deliberate click. Under `prefers-reduced-motion` it renders the settled
 * final state statically, with no playback and no cursor.
 */
import { Button } from '@cloudflare/kumo';
import {
  Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ReactElement,
} from 'react';
import { flushSync } from 'react-dom';

import { KinuLogo } from '@/components/ui/KinuLogo';
import { MessageView } from '@/components/MessageView';

import { diagnostics, toKinuError } from '@kinu.run/core/obs';
import { useAsyncResource } from '@/hooks/use-async-resource';

import {
  CURSOR_ENTER_AT, DEMO_ANNOTATION, DEMO_CUES, DEMO_END,
  captureFrames, cueCountAt, cursorAt, discreteAt,
  type BugFixDemoHandle, type DemoCandidate, type DemoTarget,
} from './bugfix-demo-timeline';

// Dynamic import on purpose: the plan surface (marked, katex, dompurify,
// web-highlighter) is code-split out of the landing's first paint. The two
// `import('./BugFixPlanPanel')` calls below reuse this same cached chunk.
const BugFixPlanPanel = lazy(() => import('./BugFixPlanPanel'));


function candidateChip(candidate: DemoCandidate): ReactElement {
  if (candidate.state === 'running') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full p-accent-subtle px-2 py-0.5 text-[10px] font-semibold p-gold">
        <span className="size-1.5 rounded-full p-dot-accent p-dot-pulse" />running
      </span>
    );
  }
  if (candidate.state === 'failed') {
    return <span className="p-badge-danger rounded-full px-2 py-0.5 text-[10px] font-semibold">{candidate.result}</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="p-badge-success rounded-full px-2 py-0.5 text-[10px] font-semibold">{candidate.result}</span>
      <span className="rounded-full p-accent-subtle px-2 py-0.5 text-[10px] font-semibold p-gold">selected</span>
    </span>
  );
}

export function BugFixDemo(): ReactElement {
  const [reduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const tRef = useRef(reduced ? DEMO_END : 0);
  const cueRef = useRef(cueCountAt(tRef.current));
  const [cueCount, setCueCount] = useState(cueRef.current);
  const [playing, setPlaying] = useState(false);
  const startedRef = useRef(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const rippleRef = useRef<HTMLDivElement | null>(null);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const pressedRef = useRef<HTMLElement | null>(null);

  const discrete = useMemo(() => discreteAt(tRef.current), [cueCount]);

  /** One target's center in stage coordinates, or null while it is unmounted
   *  (the plan chunk still loading, or the rail hidden on phones). */
  const resolveTarget = (target: DemoTarget): { x: number; y: number } | null => {
    const stage = stageRef.current;
    if (stage === null) return null;
    const box = stage.getBoundingClientRect();
    if (target === 'cursor-origin') return { x: box.width - 56, y: box.height - 44 };
    let element: Element | null = null;
    if (target === 'plan-line') {
      element = stage.querySelector('[data-demo-plan] .annotation-highlight');
      if (element === null) {
        for (const block of stage.querySelectorAll('[data-demo-plan] [data-block-id]')) {
          if (block.textContent?.includes(DEMO_ANNOTATION.anchor.slice(0, 13)) === true) {
            element = block;
            break;
          }
        }
      }
    } else {
      element = stage.querySelector(`[data-demo-target="${target}"]`);
    }
    if (element === null) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0) return null;
    return { x: rect.left - box.left + rect.width / 2, y: rect.top - box.top + rect.height / 2 };
  };

  /** Imperative per-frame paint: cursor, ripple, pressed state, progress
   *  attributes. Never triggers a React render. */
  const syncFrame = (): void => {
    const stage = stageRef.current;
    if (stage === null) return;
    const t = tRef.current;
    stage.dataset.demoT = String(Math.round(t));
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
      const pressed = stageRef.current?.querySelector(`[data-demo-target="${cursor.pressed}"]`);
      if (pressed instanceof HTMLElement) {
        pressed.style.transform = 'scale(.96)';
        pressedRef.current = pressed;
      }
    }
  };

  const syncDiscrete = (): void => {
    const count = cueCountAt(tRef.current);
    if (count !== cueRef.current) {
      cueRef.current = count;
      setCueCount(count);
    }
  };

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number): void => {
      // The first rAF timestamp can predate the performance.now() taken when
      // the effect ran; a negative delta would rewind a fresh replay.
      tRef.current = Math.min(DEMO_END, tRef.current + Math.max(0, now - last));
      last = now;
      syncFrame();
      syncDiscrete();
      if (tRef.current >= DEMO_END) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // The loop reads only refs; restarting it per beat would stall a frame,
    // so `playing` is deliberately the only dependency.
  }, [playing]);

  // Re-anchor the cursor whenever a beat re-renders the stage: targets move
  // when surfaces swap, so the pixel position is recomputed after commit.
  useLayoutEffect(() => {
    syncFrame();
  });

  // Play once when the stage becomes visible. Replays are deliberate clicks;
  // scrolling away and back never restarts the story.
  useEffect(() => {
    if (reduced) return;
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
  }, [reduced]);

  // The plan surface is its own chunk (marked, katex, dompurify); the resource
  // owns this independent preload as soon as the demo mounts, so the plan beat
  // never waits on the network.
  useAsyncResource(useCallback(async () => {
    try {
      await import('./BugFixPlanPanel');
    } catch (cause) {
      diagnostics.failure('landing.bugfix_plan_preload_failed', toKinuError({
        doing: 'preload the bug-fix plan demo', cause, otherwise: 'io',
      }));
    }
  }, []));

  useEffect(() => {
    const handle: BugFixDemoHandle = {
      duration: DEMO_END,
      cues: DEMO_CUES,
      seek: async (at: number) => {
        setPlaying(false);
        tRef.current = Math.min(DEMO_END, Math.max(0, at));
        startedRef.current = true;
        flushSync(() => {
          const count = cueCountAt(tRef.current);
          cueRef.current = count;
          setCueCount(count);
        });
        syncFrame();
        // Settle async fallout: the plan surface is a lazy chunk behind
        // Suspense, and the Viewer paints highlights on a zero timeout.
        // Neither re-runs this component's effects, so poll frames until the
        // beat's expectations hold, then re-anchor the cursor.
        const expected = discreteAt(tRef.current);
        const stage = stageRef.current;
        if (expected.plan?.open === true) await import('./BugFixPlanPanel');
        for (let tick = 0; tick < 60; tick += 1) {
          const planReady = expected.plan?.open !== true
            || stage?.querySelector('[data-demo-plan]') !== null;
          const highlightReady = expected.plan?.open !== true
            || (expected.plan.annotations.length === 0)
            || stage?.querySelector('[data-demo-plan] .annotation-highlight') !== null;
          if (planReady && highlightReady && tick > 1) break;
          const frame = Promise.withResolvers<void>();
          requestAnimationFrame(() => frame.resolve());
          await frame.promise;
          syncFrame();
        }
        syncFrame();
      },
      play: () => {
        startedRef.current = true;
        if (tRef.current >= DEMO_END) tRef.current = 0;
        syncDiscrete();
        setPlaying(true);
      },
      pause: () => setPlaying(false),
      state: () => ({ t: tRef.current, playing, settled: tRef.current >= DEMO_END }),
      captureFrames,
    };
    window.__kinuBugfixDemo = handle;
    return () => {
      if (window.__kinuBugfixDemo === handle) delete window.__kinuBugfixDemo;
    };
  });

  const replay = (): void => {
    startedRef.current = true;
    tRef.current = 0;
    syncDiscrete();
    syncFrame();
    setPlaying(true);
  };

  const tabClass = (active: boolean): string => (
    active
      ? 'border-b-2 border-[var(--c-accent)] px-3 py-2 text-[11.5px] font-semibold p-text'
      : 'px-3 py-2 text-[11.5px] p-text-4'
  );

  return (
    <div
      ref={stageRef}
      data-bugfix-demo
      data-demo-phase={discrete.phase}
      data-demo-surface={discrete.surface}
      data-demo-settled={discrete.settled ? 'true' : 'false'}
      aria-label="Kinu bug-fix demo"
      className="relative overflow-hidden rounded-2xl border p-border bg-[var(--c-bg)] shadow-[0_40px_110px_-50px_rgba(0,0,0,.95)]"
    >
      <p className="sr-only">
        A recorded workspace session. Kinu reproduces a SAVE20 coupon 500, reads the coupon rows,
        and submits a fix plan. The reviewer annotates the risky step and requests changes, then
        approves revision 2. Three candidate patches run in parallel, the focused suite selects
        the one that passes, and all seven tests go green.
      </p>
      <div className="flex min-h-[46px] flex-wrap items-center justify-between gap-3 border-b p-border p-recessed px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <KinuLogo compact />
          <span className="h-4 w-px p-fill" />
          <span className="text-[13px] font-semibold p-text">checkout-svc</span>
          <span className="hidden items-center gap-1.5 text-[11.5px] p-text-4 sm:inline-flex">
            <span className="size-[5px] rounded-full p-dot-accent" />scripted demo
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span
            data-demo-phase-label
            className="min-w-[8.5rem] text-right font-mono text-[10px] uppercase tracking-[.12em] p-gold"
          >
            {discrete.phaseLabel}
          </span>
          {!reduced && (
            <>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={playing ? 'Pause the demo' : 'Play the demo'}
                onClick={() => {
                  if (playing) { setPlaying(false); return; }
                  if (tRef.current >= DEMO_END) { replay(); return; }
                  startedRef.current = true;
                  setPlaying(true);
                }}
                className="!h-7 !rounded-full !px-2.5 !text-[10px]"
              >
                {playing ? 'Pause' : 'Play'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label="Replay the demo"
                onClick={replay}
                className="!h-7 !rounded-full !px-2.5 !text-[10px]"
              >
                Replay
              </Button>
            </>
          )}
        </div>
      </div>
      <div inert className="grid h-[560px] sm:h-[600px] md:grid-cols-[minmax(0,1fr)_300px]">
        <div className="relative min-w-0 p-border md:border-r">
          <div className="flex h-9 items-end gap-1 border-b p-border p-recessed px-3">
            <span className={tabClass(discrete.surface === 'chat')}>Conversation</span>
            {discrete.plan !== null && (
              <span data-demo-plan-tab className={tabClass(discrete.surface === 'plan')}>
                Plan · r{discrete.plan.revision}
              </span>
            )}
          </div>
          <div className="relative h-[calc(100%-36px)]">
            <div className="flex h-full min-w-0 flex-col justify-end gap-4 overflow-hidden px-4 py-4 sm:px-5 [&>*]:shrink-0">
              {discrete.messages.map((message, index) => (
                <MessageView
                  key={message.id}
                  message={message}
                  isLast={index === discrete.messages.length - 1}
                  isStreaming={false}
                />
              ))}
            </div>
            {discrete.plan?.open === true && (
              <div className="absolute inset-0 bg-[var(--c-bg)]">
                <Suspense fallback={null}>
                  <BugFixPlanPanel plan={discrete.plan} />
                </Suspense>
              </div>
            )}
          </div>
        </div>
        <aside className="hidden min-w-0 flex-col gap-3.5 overflow-hidden p-recessed p-3.5 md:flex">
          <div className="text-[11.5px] font-semibold p-text-4">Work</div>
          {discrete.needsYou !== 'hidden' && (
            <div
              data-demo-needsyou={discrete.needsYou}
              className="overflow-hidden rounded-xl border border-[color-mix(in_srgb,var(--c-accent)_30%,transparent)] p-surface"
            >
              {discrete.needsYou === 'pending' ? (
                <>
                  <div className="border-b border-dashed border-[var(--c-dash)] px-3.5 py-2 text-[11.5px] font-semibold p-gold">Needs you · 1</div>
                  <div className="flex items-center justify-between gap-3 px-3.5 py-3">
                    <span className="text-[12.5px] p-text-2">Fix plan ready for review</span>
                    <button
                      type="button"
                      data-demo-target="review-plan"
                      className="rounded-full border border-[color-mix(in_srgb,var(--c-accent)_35%,transparent)] px-2.5 py-0.5 text-[11px] p-gold"
                    >
                      Review plan
                    </button>
                  </div>
                </>
              ) : (
                <div className="px-3.5 py-3 text-[11.5px] p-success">Plan r2 approved · implementing</div>
              )}
            </div>
          )}
          {discrete.candidates !== null && (
            <div data-demo-target="candidates" data-demo-candidates className="overflow-hidden rounded-xl border p-border p-surface">
              <div className="flex items-center justify-between gap-2 border-b p-border p-sidebar px-3.5 py-2">
                <span className="text-[11.5px] font-semibold p-text-2">Candidate patches</span>
                <span className="font-mono text-[9.5px] p-text-4">the suite decides</span>
              </div>
              {discrete.candidates.map((candidate, index) => (
                <div
                  key={candidate.id}
                  data-demo-candidate={candidate.state}
                  className={`flex items-center justify-between gap-3 px-3.5 py-2.5 ${index > 0 ? 'border-t border-dashed border-[var(--c-dash)]' : ''}`}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-[11px] p-text">{candidate.name}</span>
                    <span className="block truncate text-[10.5px] p-text-4">{candidate.approach}</span>
                  </span>
                  {candidateChip(candidate)}
                </div>
              ))}
            </div>
          )}
          {discrete.candidates !== null && (
            <div data-demo-target="tests" data-demo-tests={discrete.testsSettled ? 'settled' : 'pending'} className="overflow-hidden rounded-xl border p-border p-surface">
              {discrete.patchLanded && (
                <div className="flex items-baseline gap-2 px-3.5 py-2.5">
                  <span className="text-[10px] p-gold">◈</span>
                  <span className="flex-1 text-xs p-text-2">Migration patched from the selected candidate</span>
                </div>
              )}
              {discrete.testsSettled
                ? (
                  <div className="flex items-baseline gap-2 border-t border-dashed border-[var(--c-dash)] px-3.5 py-2.5">
                    <span className="text-[10px] p-success">✓</span>
                    <span className="flex-1 text-xs p-text-2">bun test packages/checkout</span>
                    <span className="p-badge-success rounded-full px-2 py-0.5 text-[10px] font-semibold">7 pass</span>
                  </div>
                )
                : (
                  <div className="px-3.5 py-2.5 text-xs p-text-4">Focused suite queued</div>
                )}
            </div>
          )}
        </aside>
      </div>
      <div aria-hidden className="pointer-events-none absolute inset-0 z-30">
        <div
          ref={rippleRef}
          className="absolute left-0 top-0 size-10 rounded-full border-2 border-[var(--c-accent)] opacity-0"
        />
        <div ref={cursorRef} data-demo-cursor className="absolute left-0 top-0 opacity-0 drop-shadow-[0_1px_2px_rgba(0,0,0,.6)]">
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
    </div>
  );
}
