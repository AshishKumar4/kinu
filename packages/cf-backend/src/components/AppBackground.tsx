/** Home-page background driven by the roster's counts via `useRosterActivity`. */
import { useEffect, useRef, type ReactElement } from 'react';
import { useLocation } from 'react-router-dom';

import { APP_ROUTES, routeTemplateOf, type ReportedRoute } from '@kinu.run/core';
import type { ArtFrame, KeepOut } from '@kinu.run/core/web/art';
import { type Field, type MeshActivity, type MeshMode, NeuralMesh } from '@kinu.run/core/web/neural-mesh';
import { groundTextElements } from '@kinu.run/core/web/ground-text';
import { useMediaQuery } from '@/hooks/use-media-query';
import { useRosterActivity } from '@/hooks/use-workspace-roster';
import { mountLivingCanvas, type LivingCanvas } from './landing/search-tree/living-canvas';
import { keepOutOf, type FrameTimes } from './landing/search-tree/stage';

/** Seeded apart from the landing hero's on purpose: the two artworks never rhyme. */
const BACKGROUND_SEED = 1729;

const STILL_SECONDS = 7;

const STILL_STEP = 1 / 30;

const RESOLUTION = 1;

/** Tailwind's `md` (the shell's rail breakpoint); narrower gets the still. */
const RAIL_QUERY = '(min-width: 48rem)';

const SHOWN_ROUTES: Partial<Record<ReportedRoute, true>> = {
  [APP_ROUTES.home]: true,
  [APP_ROUTES.newWorkspace]: true,
};

interface AppBackgroundHandle {
  renderer(): 'webgpu' | 'canvas' | 'static' | 'pending';
  frameTimes(): FrameTimes;
  time(): number;
  mode(): MeshMode;
  pointer(): number;
}

/** Gallery-only stepping controls; attached only when `__kinuGalleryStepping` is set before the shell mounts. */
interface AppBackgroundStepping {
  advance(dt: number): void;
  freeze(): void;
  thaw(): void;
}

declare global {
  interface Window {
    __kinuAppBackground?: AppBackgroundHandle & Partial<AppBackgroundStepping>;
    /** Set by the gallery's own page script, never by the shipped app. */
    __kinuGalleryStepping?: true;
    /** Start frozen at the seed so a readback depends only on the test's `advance` steps. */
    __kinuGalleryFrozen?: true;
  }
}

/** `known` outlives the tissue so a decision that arrived on another route still flashes on return. */
function Tissue({ known }: { readonly known: { current: MeshActivity } }): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const wide = useMediaQuery(RAIL_QUERY);
  const hoverable = useMediaQuery('(hover: hover)');
  const calm = useMediaQuery('(prefers-reduced-motion: reduce)');
  const { working, decisions } = useRosterActivity();
  const living = useRef<LivingCanvas<ArtFrame, NeuralMesh> | null>(null);

  useEffect(() => {
    known.current = { working, decisions };
    living.current?.art().setActivity(known.current);
  }, [known, working, decisions]);

  useEffect(() => {
    const host = hostRef.current;
    const shell = host?.parentElement ?? null;

    if (host === null || shell === null) return;
    let picture: NeuralMesh | null = null;
    let copy: Element[] = [];
    let stale = true;
    let scheduled = 0;

    const keepOut = (): KeepOut[] => {
      if (stale) {
        copy = groundTextElements(shell, host);
        stale = false;
      }

      const box = host.getBoundingClientRect();
      const boxes: KeepOut[] = [];

      for (const element of copy) {
        const rect = element.getBoundingClientRect();
        const kept = rect.width > 0 && rect.height > 0 ? keepOutOf(box, rect) : null;

        if (kept !== null) boxes.push(kept);
      }

      return boxes;
    };

    // The rail is opaque: the mesh frames the page beside it, and grows again when the rail folds.
    const field = (): Field => {
      const box = host.getBoundingClientRect();
      const page = shell.querySelector('main')?.getBoundingClientRect();

      return page === undefined || box.width <= 0 ? { left: 0, right: 1 } : { left: (page.left - box.left) / box.width, right: (page.right - box.left) / box.width };
    };

    const tissue = (aspect: number): NeuralMesh => {
      picture = new NeuralMesh({ seed: BACKGROUND_SEED, aspect, width: host.getBoundingClientRect().width, field: field(), activity: known.current });

      return picture;
    };

    const mounted = mountLivingCanvas(host, {
      create: tissue,
      still: { seconds: STILL_SECONDS, step: STILL_STEP },
      holdStill: () => !wide,
      startFrozen: () => window.__kinuGalleryStepping === true && window.__kinuGalleryFrozen === true,
      resolution: RESOLUTION,
      fit: (art) => {
        art.setField(field());
        art.setKeepOut(keepOut());
      },
      shown: (_frame, canvas) => {
        const mode = picture?.mode() ?? 'idle';

        if (canvas.dataset.mode !== mode) canvas.dataset.mode = mode;
      },
      events: { failed: 'app.background_webgpu_failed', faulted: 'app.background_webgpu_faulted', fallbackFailed: 'app.background_fallback_failed' },
      canvasClassName: 'absolute inset-0 size-full',
    });

    const align = (): void => {
      scheduled = 0;
      mounted.align();
    };

    const onScroll = (): void => {
      if (scheduled === 0) scheduled = requestAnimationFrame(align);
    };

    const onMutation = (): void => {
      stale = true;
      onScroll();
    };

    // The rail folds over a width transition: the page beside it has its final width only once that ends.
    const onTransition = (event: TransitionEvent): void => {
      if (event.propertyName === 'width') onScroll();
    };

    const changes = new MutationObserver(onMutation);
    changes.observe(shell, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    shell.addEventListener('scroll', onScroll, { capture: true, passive: true });
    shell.addEventListener('transitionend', onTransition);

    // The host is pointer-transparent, so the window listens instead.
    const toView = (clientX: number, clientY: number): readonly [number, number] => {
      const box = host.getBoundingClientRect();

      return [(clientX - box.left) / box.width, (clientY - box.top) / box.height];
    };

    const onPointer = (press: boolean) => (event: PointerEvent): void => {
      if (event.pointerType === 'touch') return;
      const [x, y] = toView(event.clientX, event.clientY);

      if (press) mounted.art().click(x, y);
      else mounted.art().setPointer(x, y);
    };

    const onMove = onPointer(false);
    const onPress = onPointer(true);

    const onLeave = (): void => {
      mounted.art().clearPointer();
    };


    if (hoverable && !calm) {
      window.addEventListener('pointermove', onMove, { passive: true });
      window.addEventListener('pointerdown', onPress, { passive: true });
      window.addEventListener('pointerleave', onLeave);
      window.addEventListener('blur', onLeave);
      document.documentElement.addEventListener('pointerleave', onLeave);
    }

    const handle: AppBackgroundHandle & Partial<AppBackgroundStepping> = {
      renderer: () => mounted.renderer(),
      frameTimes: () => mounted.frameTimes(),
      time: () => mounted.time(),
      mode: () => mounted.art().mode(),
      pointer: () => mounted.art().pointerHold(),
    };

    if (window.__kinuGalleryStepping === true) {
      Object.assign(handle, {
        advance: (dt: number) => mounted.advance(dt),
        freeze: () => mounted.freeze(),
        thaw: () => mounted.thaw(),
      } satisfies AppBackgroundStepping);
    }

    living.current = mounted;
    window.__kinuAppBackground = handle;

    return () => {
      changes.disconnect();
      shell.removeEventListener('scroll', onScroll, { capture: true });
      shell.removeEventListener('transitionend', onTransition);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onPress);
      window.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('blur', onLeave);
      document.documentElement.removeEventListener('pointerleave', onLeave);

      if (scheduled !== 0) cancelAnimationFrame(scheduled);
      mounted.dispose();
      living.current = null;

      if (window.__kinuAppBackground === handle) delete window.__kinuAppBackground;
    };
  }, [known, wide, hoverable, calm]);

  return (
    <div
      ref={hostRef}
      data-app-background
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 [filter:blur(.4px)] [mask-image:radial-gradient(ellipse_55%_55%_at_58%_50%,rgba(0,0,0,.7),black_100%)]"
    />
  );
}

export function AppBackground(): ReactElement | null {
  const { pathname } = useLocation();
  const known = useRef<MeshActivity>({ working: false, decisions: 0 });

  return SHOWN_ROUTES[routeTemplateOf(pathname)] === true ? <Tissue known={known} /> : null;
}
