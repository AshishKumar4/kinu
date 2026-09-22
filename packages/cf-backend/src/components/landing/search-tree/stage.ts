import { useMediaQuery } from '@/hooks/use-media-query';
import type { ArtPalette, KeepOut, Rgb } from '@kinu.run/core/web/art';

function cssRgb(name: string): Rgb {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const hex = /^#([0-9a-f]{6})$/iu.exec(value)?.[1];

  if (hex !== undefined) {
    const number = Number.parseInt(hex, 16);

    return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
  }

  const channels = value.match(/[\d.]+/gu)?.slice(0, 3).map(Number);
  const [red, green, blue] = channels ?? [];

  return red === undefined || green === undefined || blue === undefined
    ? [224, 164, 88]
    : [red, green, blue];
}

export function readPalette(): ArtPalette {
  return {
    mode: document.documentElement.dataset.mode === 'light' ? 'light' : 'dark',
    accent: cssRgb('--c-accent'),
    bright: cssRgb('--c-accent-fg'),
    ash: cssRgb('--c-text-3'),
    ground: cssRgb('--c-bg'),
  };
}

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

/** Headline box in view units, or null without a headline or host size. */
export function keepOutOf(host: Rect, headline: Rect | null): KeepOut | null {
  if (headline === null || host.width <= 0 || host.height <= 0) return null;

  return {
    left: (headline.left - host.left) / host.width,
    top: (headline.top - host.top) / host.height,
    right: (headline.right - host.left) / host.width,
    bottom: (headline.bottom - host.top) / host.height,
  };
}

export interface Box {
  readonly width: number;
  readonly height: number;
  readonly ratio: number;
}

export function boxOf(host: HTMLElement): Box {
  const rect = host.getBoundingClientRect();

  return {
    width: Math.max(1, rect.width),
    height: Math.max(1, rect.height),
    ratio: Math.min(2, window.devicePixelRatio || 1),
  };
}

const MAX_STEP = 0.05;

const RING = 240;

function push(ring: number[], value: number): void {
  ring.push(value);

  if (ring.length > RING) ring.shift();
}

/** Tailwind `lg`: below it the hero copy stacks (LandingHero.tsx) and the tree would cross the paragraph. */
const WIDE_HERO_QUERY = '(min-width: 64rem)';

export function useWideHero(): boolean {
  return useMediaQuery(WIDE_HERO_QUERY);
}

export interface FrameTimes {
  readonly work: readonly number[];
  readonly interval: readonly number[];
}

export interface Playback {
  frameTimes(): FrameTimes;
  sync(): void;
  stop(): void;
  /** `stop()` and release the observers; not reusable. */
  dispose(): void;
}

/** rAF loop running only while `wanted()`, on screen and visible; elapsed time is clamped so a hidden tab never replays its gap. */
export function createPlayback(host: HTMLElement, wanted: () => boolean, advance: (step: number) => void): Playback {
  const work: number[] = [];
  const interval: number[] = [];
  let visible = false;
  let frameId = 0;
  let last = 0;

  const tick = (now: number): void => {
    frameId = 0;
    const step = last === 0 ? 1 / 60 : Math.min(MAX_STEP, (now - last) / 1_000);

    if (last !== 0) push(interval, now - last);
    last = now;
    const began = performance.now();
    advance(step);
    push(work, performance.now() - began);
    frameId = requestAnimationFrame(tick);
  };

  const sync = (): void => {
    const running = wanted() && visible && !document.hidden;

    if (running && frameId === 0) {
      last = 0;
      frameId = requestAnimationFrame(tick);
    } else if (!running && frameId !== 0) {
      cancelAnimationFrame(frameId);
      frameId = 0;
    }
  };

  const stop = (): void => {
    if (frameId !== 0) cancelAnimationFrame(frameId);
    frameId = 0;
    last = 0;
  };

  const intersection = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting === true;
    sync();
  });

  intersection.observe(host);
  document.addEventListener('visibilitychange', sync);

  return {
    frameTimes: () => ({ work: [...work], interval: [...interval] }),
    sync,
    stop,
    dispose() {
      stop();
      intersection.disconnect();
      document.removeEventListener('visibilitychange', sync);
    },
  };
}
