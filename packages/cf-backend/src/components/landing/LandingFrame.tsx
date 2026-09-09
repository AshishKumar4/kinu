/**
 * The landing page's mount for one workspace frame. The frame itself is a
 * separate chunk (`LandingWorkspaceFrame`): it carries the product's chat,
 * Work and plan renderers, and the landing's first paint must not. React
 * requests the chunk when the mount first renders, which is page load, so the
 * frame is normally in place before the reader scrolls to it.
 */
import { lazy, Suspense, type ReactElement } from 'react';

import type { LandingFrameKind } from './LandingWorkspaceFrame';

const LandingWorkspaceFrame = lazy(() => import('./LandingWorkspaceFrame'));

export function LandingFrame({ kind }: { kind: LandingFrameKind }): ReactElement {
  return (
    <Suspense fallback={<div aria-busy="true" className="h-[760px] rounded-2xl border p-border p-surface" />}>
      <LandingWorkspaceFrame kind={kind} />
    </Suspense>
  );
}
