/**
 * The frame is a separate chunk (`LandingWorkspaceFrame`) so the landing's first paint does not
 * carry the product's renderers. The window bar is landing chrome beside the mock, not in it.
 */
import { lazy, Suspense, useState, type ReactElement } from 'react';

import type { LandingFrameKind } from './LandingWorkspaceFrame';

const LandingWorkspaceFrame = lazy(() => import('./LandingWorkspaceFrame'));

const WINDOW_TITLE = {
  checkout: 'Kinu · Workspace',
  plan: 'Kinu · Plan mode',
  slate: 'Kinu · Slate',
} satisfies Record<LandingFrameKind, string>;

/** Hidden under `prefers-reduced-motion`, where there is no playback to restart. */
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
          <span className="hidden sm:inline" data-landing-caption>{caption}</span>
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
