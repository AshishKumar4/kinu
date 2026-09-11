/**
 * The landing page's mount for one workspace frame. The frame itself is a
 * separate chunk (`LandingWorkspaceFrame`): it carries the product's chat,
 * Work and plan renderers, and the landing's first paint must not. React
 * requests the chunk when the mount first renders, which is page load, so the
 * frame is normally in place before the reader scrolls to it.
 *
 * Every frame wears the same window bar the terminal and CLI previews wear:
 * the mark, what the window is, and the one honest line about what it is not.
 * The bar is landing chrome beside the mock, not in it: the mock itself stays
 * exactly what the app renders.
 *
 * The plan frame carries the walkthrough movie, which plays once on scroll
 * into view and then holds its settled state. Its replay lives in the bar,
 * where a window's controls belong.
 */
import { lazy, Suspense, useState, type ReactElement } from 'react';

import type { LandingFrameKind } from './LandingWorkspaceFrame';

const LandingWorkspaceFrame = lazy(() => import('./LandingWorkspaceFrame'));

const WINDOW_TITLE = {
  checkout: 'Kinu · Workspace',
  plan: 'Kinu · Plan mode',
  slate: 'Kinu · Slate',
} satisfies Record<LandingFrameKind, string>;

/** The movie's deliberate-click replay. Hidden under `prefers-reduced-motion`,
 *  where the frame renders its settled state with no playback to restart. */
function LandingMovieReplay(): ReactElement | null {
  const [reduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  if (reduced) return null;

  return (
    <button
      type="button"
      onClick={() => window.__kinuLandingMovie?.play()}
      className="font-sans text-xs font-semibold p-accent"
    >
      Replay the walkthrough →
    </button>
  );
}

export function LandingFrame({ kind, caption }: { kind: LandingFrameKind; caption: string }): ReactElement {
  return (
    <div>
      <div className="flex items-center gap-3 rounded-t-2xl border border-b-0 p-border p-recessed px-4 py-2.5 font-mono text-[11px] p-text-4 sm:px-5">
        <span aria-hidden="true" className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-[var(--c-danger)] opacity-70" />
          <span className="size-2.5 rounded-full bg-[var(--c-warning)] opacity-70" />
          <span className="size-2.5 rounded-full bg-[var(--c-success)] opacity-70" />
        </span>
        <span className="uppercase tracking-[.12em]">{WINDOW_TITLE[kind]}</span>
        <span className="ml-auto flex items-center gap-4">
          <span className="hidden sm:inline">{caption}</span>
          {kind === 'plan' && <LandingMovieReplay />}
        </span>
      </div>
      <Suspense fallback={<div aria-busy="true" className="h-[760px] rounded-b-2xl border p-border p-surface" />}>
        <LandingWorkspaceFrame kind={kind} />
      </Suspense>
      <p className="px-1 pt-3 text-[11px] leading-relaxed p-text-4 sm:hidden">{caption}</p>
    </div>
  );
}
