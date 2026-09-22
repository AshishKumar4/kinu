import { useEffect, useRef, type ReactElement } from 'react';

import { SearchTree, type SearchTreeFrame } from '@kinu.run/core/web/hero-art';
import { mountLivingCanvas, type LivingCanvas } from './living-canvas';
import { keepOutOf, type FrameTimes } from './stage';

/** Seeded apart from the app background's so the two artworks never rhyme. */
const HERO_SEED = 417;

const STATIC_SECONDS = 14;

const STATIC_STEP = 1 / 30;

const SETTLED_AT = 5;

/** `work`: ms one tick spent in simulation plus encode; `interval`: wall time between ticks. */
export interface SearchTreeHandle {
  renderer(): 'webgpu' | 'canvas' | 'static' | 'pending';
  frameTimes(): FrameTimes;
  time(): number;
}

declare global {
  interface Window {
    __kinuSearchTree?: SearchTreeHandle;
  }
}

function facts(frame: SearchTreeFrame, canvas: HTMLCanvasElement, still: boolean): void {
  const pruned = String(frame.pruned);
  const hidden = String(frame.hidden);
  const generation = String(frame.generation);

  if (canvas.dataset.pruned !== pruned) canvas.dataset.pruned = pruned;

  if (canvas.dataset.hidden !== hidden) canvas.dataset.hidden = hidden;

  if (canvas.dataset.generation !== generation) canvas.dataset.generation = generation;

  if ((still || frame.time >= SETTLED_AT) && canvas.dataset.settled !== 'true') canvas.dataset.settled = 'true';
}

function mountSearchTree(host: HTMLElement, stage: HTMLElement): () => void {
  let pressX = 0;
  let pressY = 0;
  let pressed = false;

  const living: LivingCanvas<SearchTreeFrame, SearchTree> = mountLivingCanvas(host, {
    create: (aspect) => new SearchTree({ seed: HERO_SEED, aspect }),
    still: { seconds: STATIC_SECONDS, step: STATIC_STEP },
    resolution: 1,
    fit: (tree) => tree.setKeepOut(keepOutOf(host.getBoundingClientRect(), stage.querySelector('h1')?.getBoundingClientRect() ?? null)),
    shown: facts,
    events: { failed: 'landing.hero_webgpu_failed', faulted: 'landing.hero_webgpu_faulted', fallbackFailed: 'landing.hero_fallback_failed' },
    canvasClassName: 'absolute inset-0 size-full',
  });

  const onPointerMove = (event: PointerEvent): void => {
    const rect = host.getBoundingClientRect();
    living.art().setPointer((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
  };

  const onPointerLeave = (): void => living.art().clearPointer();

  const onPointerDown = (event: PointerEvent): void => {
    pressed = true;
    pressX = event.clientX;
    pressY = event.clientY;
  };

  const onPointerUp = (event: PointerEvent): void => {
    const wasPressed = pressed;
    pressed = false;

    if (event.pointerType === 'touch') living.art().clearPointer();

    if (!wasPressed || Math.hypot(event.clientX - pressX, event.clientY - pressY) > 6) return;

    if (event.target instanceof Element && event.target.closest('a, button, input, textarea, select, [role="button"]') !== null) return;
    const rect = host.getBoundingClientRect();
    living.art().plant((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
  };

  const handle: SearchTreeHandle = {
    renderer: () => living.renderer(),
    frameTimes: () => living.frameTimes(),
    time: () => living.time(),
  };

  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerleave', onPointerLeave);
  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointerup', onPointerUp);
  stage.addEventListener('pointercancel', onPointerLeave);
  window.__kinuSearchTree = handle;

  return () => {
    stage.removeEventListener('pointermove', onPointerMove);
    stage.removeEventListener('pointerleave', onPointerLeave);
    stage.removeEventListener('pointerdown', onPointerDown);
    stage.removeEventListener('pointerup', onPointerUp);
    stage.removeEventListener('pointercancel', onPointerLeave);
    living.dispose();

    if (window.__kinuSearchTree === handle) delete window.__kinuSearchTree;
  };
}

/** Pointer input is read from the parent stage so the copy and its links stay clickable. */
export function SearchTreeHero(): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const stage = host?.parentElement ?? null;

    if (host === null || stage === null) return;

    return mountSearchTree(host, stage);
  }, []);

  return (
    <div
      ref={hostRef}
      data-hero-graph
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-0 -bottom-16 [mask-composite:intersect] [mask-image:linear-gradient(to_right,rgba(0,0,0,.05),rgba(0,0,0,.06)_42%,rgba(0,0,0,.5)_64%,black_80%),linear-gradient(to_bottom,transparent,black_14%,black_78%,transparent),radial-gradient(ellipse_36%_24%_at_50%_34%,rgba(0,0,0,.14),rgba(0,0,0,.14)_55%,black)]"
    >
      <div data-hero-veil className="absolute inset-0 z-10 [backdrop-filter:blur(6px)] [mask-image:linear-gradient(to_right,black,black_48%,transparent_76%)]" />
    </div>
  );
}
