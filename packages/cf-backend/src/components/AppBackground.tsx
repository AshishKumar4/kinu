/**
 * The living background behind the signed-in shell: a connectome, fixed
 * behind the rail and the page, that breathes while nothing runs, fires
 * toward one lobe while a workspace is working, and flashes a lobe once
 * when a decision arrives. Its whole input is the overview read model of the
 * recent workspaces, watched through `useRosterActivity`; nothing in it is a
 * decoration loop disconnected from the product.
 *
 * It mounts through the hero's living canvas: WebGPU where there is an
 * adapter, Canvas2D otherwise or after a GPU fault, one evolved still under
 * `prefers-reduced-motion` and on a phone, the tab hidden or the host off
 * screen means no work at all. It is lightly blurred, and a mask keeps it
 * faintest over the page's column and whole at the edges, on top of the
 * tissue's own falloff to nothing across the middle. The copy
 * itself never has tissue under it: every run of text on the ground
 * (`ground-text.ts`) is a keep-out box the picture fades under, re-read
 * when the page's contents change, scroll or resize.
 *
 * It shows on the home page only; every other route is a working surface.
 */
import { useEffect, useRef, type ReactElement } from 'react';
import { useLocation } from 'react-router-dom';

import { APP_ROUTES, routeTemplateOf, type ReportedRoute } from '@kinu.run/core';
import type { ArtFrame, KeepOut } from '@kinu.run/core/web/art';
import { CANVAS_SEGMENTS, Connectome, type ConnectomeActivity, type ConnectomeMode, MESH_SEGMENTS } from '@kinu.run/core/web/connectome';
import { groundTextElements } from '@kinu.run/core/web/ground-text';
import { useMediaQuery } from '@/hooks/use-media-query';
import { useRosterActivity } from '@/hooks/use-workspace-overviews';
import { mountLivingCanvas, type LivingCanvas, type RendererKind } from './landing/search-tree/living-canvas';
import { keepOutOf, type FrameTimes } from './landing/search-tree/stage';

/** Seeded apart from the landing hero's on purpose: the two artworks never rhyme. */
const BACKGROUND_SEED = 1729;

/** The still a visitor without motion sees: the tissue this far in, mid-breath, a signal or two in flight. */
const STILL_SECONDS = 7;

const STILL_STEP = 1 / 30;

/** Physical pixels per CSS pixel as a share of the device's own: the rim
 *  draws at the device's own resolution, as the hero does, with a light
 *  blur on top; the copy never has tissue under it, so nothing sharp sits
 *  behind text either way. */
const RESOLUTION = 1;

/** Tailwind's `md`: the width at which the shell shows its rail
 *  (`md:block` on the aside in layout.tsx). Narrower is a phone, and a phone
 *  gets the still, the hero's rule. */
const RAIL_QUERY = '(min-width: 48rem)';

/** The tissue is the home page's alone; every other surface is a working
 *  view and reads flat. */
const SHOWN_ROUTES: Partial<Record<ReportedRoute, true>> = {
  [APP_ROUTES.home]: true,
};

/** What a gate can read off the live background: which renderer took the
 *  canvas, the last frames' cost, the picture's clock, what the tissue is
 *  doing, and how strongly the pointer holds it. */
export interface AppBackgroundHandle {
  renderer(): 'webgpu' | 'canvas' | 'static' | 'pending';
  frameTimes(): FrameTimes;
  time(): number;
  mode(): ConnectomeMode;
  pointer(): number;
}

/** The stepping controls a GALLERY page adds to the handle: freeze the rAF
 *  loop, step the picture by hand, let it run again — how a pixel readback
 *  is taken off a picture that is not moving under it. Never on the shipped
 *  handle: the gallery declares itself before the shell mounts
 *  (`__kinuGalleryStepping`), and only then are these attached. */
export interface AppBackgroundStepping {
  advance(dt: number): void;
  freeze(): void;
  thaw(): void;
}

declare global {
  interface Window {
    __kinuAppBackground?: AppBackgroundHandle & Partial<AppBackgroundStepping>;
    /** Set by the gallery's own page script, never by the shipped app. */
    __kinuGalleryStepping?: true;
  }
}

/** `known` outlives the tissue: it is what the shell last saw, carried
 *  across the routes that hide the canvas, so a decision that arrived while
 *  the chat was open flashes on the way back and one seen before does not. */
function Tissue({ known }: { readonly known: { current: ConnectomeActivity } }): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const wide = useMediaQuery(RAIL_QUERY);
  // The pointer answers only where a cursor can hover and motion is wanted:
  // touch screens and reduced-motion visitors keep the undisturbed picture.
  const hoverable = useMediaQuery('(hover: hover)');
  const calm = useMediaQuery('(prefers-reduced-motion: reduce)');
  const { working, decisions } = useRosterActivity();
  const living = useRef<LivingCanvas<ArtFrame, Connectome> | null>(null);

  useEffect(() => {
    known.current = { working, decisions };
    living.current?.art().setActivity(known.current);
  }, [known, working, decisions]);

  useEffect(() => {
    const host = hostRef.current;
    const shell = host?.parentElement ?? null;

    if (host === null || shell === null) return;
    let picture: Connectome | null = null;
    let copy: Element[] = [];
    let stale = true;
    let scheduled = 0;

    /** The copy's boxes in the host's view units, re-listing the elements only after the page changed. */
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

    // The full mat for the GPU half; Canvas2D — the fallback and every
    // still — strokes a sparser one from the same seed, and a GPU fault
    // mid-run hands the sparser one over rather than stroking the full mat.
    const mat = (aspect: number, renderer: RendererKind): Connectome => {
      picture = new Connectome({ seed: BACKGROUND_SEED, aspect, segments: renderer === 'webgpu' ? MESH_SEGMENTS : CANVAS_SEGMENTS, activity: known.current });

      return picture;
    };

    const mounted = mountLivingCanvas(host, {
      create: mat,
      rebind: (_art, aspect) => mat(aspect, 'canvas'),
      still: { seconds: STILL_SECONDS, step: STILL_STEP },
      holdStill: () => !wide,
      resolution: RESOLUTION,
      fit: (art) => art.setKeepOut(keepOut()),
      shown: (_frame, canvas) => {
        const mode = picture?.mode() ?? 'idle';

        if (canvas.dataset.mode !== mode) canvas.dataset.mode = mode;
      },
      events: { failed: 'app.background_webgpu_failed', faulted: 'app.background_webgpu_faulted', fallbackFailed: 'app.background_fallback_failed' },
      canvasClassName: 'absolute inset-0 size-full',
    });

    // The copy moves when the page scrolls, and changes when it renders; one
    // frame later the picture learns the new boxes. A scroll re-reads boxes
    // only; a mutation re-lists the elements too.
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

    const changes = new MutationObserver(onMutation);
    changes.observe(shell, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    shell.addEventListener('scroll', onScroll, { capture: true, passive: true });

    // The pointer feeds the simulation, never the renderer: viewport units,
    // null when it leaves. The host itself is pointer-transparent, so the
    // window hears what the picture cannot. Stills never listen.
    const toView = (clientX: number, clientY: number): readonly [number, number] => {
      const box = host.getBoundingClientRect();

      return [(clientX - box.left) / box.width, (clientY - box.top) / box.height];
    };

    const onMove = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') return;
      const [x, y] = toView(event.clientX, event.clientY);
      mounted.art().setPointer(x, y);
    };

    const onLeave = (): void => {
      mounted.art().clearPointer();
    };

    if (hoverable && !calm) {
      window.addEventListener('pointermove', onMove, { passive: true });
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
      window.removeEventListener('pointermove', onMove);
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
      className="pointer-events-none fixed inset-0 -z-10 [filter:blur(.6px)] [mask-image:radial-gradient(ellipse_55%_55%_at_58%_50%,rgba(0,0,0,.7),black_100%)]"
    />
  );
}

export function AppBackground(): ReactElement | null {
  const { pathname } = useLocation();
  const known = useRef<ConnectomeActivity>({ working: false, decisions: 0 });

  return SHOWN_ROUTES[routeTemplateOf(pathname)] === true ? <Tissue known={known} /> : null;
}
