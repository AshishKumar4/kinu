/**
 * The frame is a separate chunk (`LandingWorkspaceFrame`) so the landing's first paint does not
 * carry the product's renderers, and it mounts once the prerendered page is hydrated: it draws
 * only in a browser. The window bar is landing chrome beside the mock, not in it.
 */
import { lazy, Suspense, type ReactElement } from 'react';

import { useHydrated } from '@/hooks/use-hydrated';
import { useMediaQuery } from '@/hooks/use-media-query';

const LandingWorkspaceFrame = lazy(() => import('./LandingWorkspaceFrame'));

/** Hidden under `prefers-reduced-motion`, where there is no playback to restart. */
function LandingMovieReplay(): ReactElement | null {
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');

  if (reduced) return null;

  return (
    <button
      type="button"
      onClick={() => window.__kinuLandingMovie?.play()}
      className="font-sans text-xs font-semibold p-accent-fg"
    >
      Replay
    </button>
  );
}

export function LandingFrame(): ReactElement {
  const hydrated = useHydrated();
  const waiting = <div aria-busy="true" className="h-[620px] rounded-b-2xl border p-border p-surface md:h-[760px]" />;

  return (
    <div>
      <div className="flex items-center gap-3 rounded-t-2xl border border-b-0 p-border p-sunken px-4 py-2.5 font-mono text-[11px] p-text-3 sm:px-5">
        <span aria-hidden="true" className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-[var(--c-danger)] opacity-70" />
          <span className="size-2.5 rounded-full bg-[var(--c-warning)] opacity-70" />
          <span className="size-2.5 rounded-full bg-[var(--c-success)] opacity-70" />
        </span>
        <span className="uppercase tracking-[.12em]">Kinu · Sample workspace</span>
        <span className="ml-auto"><LandingMovieReplay /></span>
      </div>
      <Suspense fallback={waiting}>
        {hydrated ? <LandingWorkspaceFrame /> : waiting}
      </Suspense>
    </div>
  );
}
