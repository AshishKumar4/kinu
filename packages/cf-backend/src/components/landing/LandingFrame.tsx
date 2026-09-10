/**
 * The landing page's mount for one workspace frame. The frame itself is a
 * separate chunk (`LandingWorkspaceFrame`): it carries the product's chat,
 * Work and plan renderers, and the landing's first paint must not. React
 * requests the chunk when the mount first renders, which is page load, so the
 * frame is normally in place before the reader scrolls to it.
 *
 * The plan frame carries the walkthrough movie, which plays once on scroll
 * into view and then holds its settled state. The replay below is landing
 * chrome beside the mock, not in it: the mock itself stays exactly what the
 * app renders.
 */
import { lazy, Suspense, useState, type ReactElement } from 'react';

import type { LandingFrameKind } from './LandingWorkspaceFrame';

const LandingWorkspaceFrame = lazy(() => import('./LandingWorkspaceFrame'));

/** The movie's deliberate-click replay. Hidden under `prefers-reduced-motion`,
 *  where the frame renders its settled state with no playback to restart. */
function LandingMovieReplay(): ReactElement | null {
  const [reduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (reduced) return null;
  return (
    <div className="px-1 pt-3">
      <button
        type="button"
        onClick={() => window.__kinuLandingMovie?.play()}
        className="text-sm font-semibold p-accent"
      >
        Replay the walkthrough →
      </button>
    </div>
  );
}

export function LandingFrame({ kind }: { kind: LandingFrameKind }): ReactElement {
  return (
    <>
      <Suspense fallback={<div aria-busy="true" className="h-[760px] rounded-2xl border p-border p-surface" />}>
        <LandingWorkspaceFrame kind={kind} />
      </Suspense>
      {kind === 'plan' && <LandingMovieReplay />}
    </>
  );
}
