/**
 * The gate is a browser, so its test is a browser.
 *
 * Five defects the owner photographed on one 640px screen are all invisible to
 * `tsc`, `oxlint` and every source-reading test in this repo, because each one
 * is about where a rendered box lands:
 *
 *   - The run-count label broke over two lines, between two neighbours that
 *     could not give ground.
 *   - Node labels were clipped at a flat 20 characters with the rest of their
 *     column empty beside them.
 *   - A card of two short searches reserved the whole column and drew several
 *     hundred pixels of nothing under its trees.
 *   - The key and the controls floated OVER the branches they explain.
 *   - An unselected search receded to half opacity, which at 11px is not
 *     recession but illegibility.
 *
 * And one that is worse than any of them: `?frame=forkbig`, `?frame=forkfull`
 * and `?frame=forkswarmfull` rendered an EMPTY BODY. `scripts/computed-style.ts`
 * lists `forkfull` among the frames it audits, so that gate reported clean over
 * a blank page — a gate green because there was nothing to find. The first
 * assertion below is that the frame rendered at all.
 *
 * Every assertion is a measurement of the real components in a real cascade,
 * at the two widths and in the two palettes the surface has to survive. One
 * server, one browser, one pass: booting vite costs several seconds and every
 * assertion here reads from the same handful of frames.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer';

import { withGallery } from './gallery-harness';

/** One label, and the room the column it sits in actually leaves it. */
interface LabelFit {
  /** Where the label starts, relative to its node. */
  readonly x: number;
  /** What the browser laid the glyphs out to. */
  readonly width: number;
  /** Whether the node has children drawn in the next column. */
  readonly foldable: boolean;
  readonly text: string;
}

interface FrameGeometry {
  readonly mode: string | undefined;
  /** Node groups the scene drew. Zero means a blank frame. */
  readonly nodes: number;
  /** The depth pitch, read off the guides the ruler labels rather than off a
   *  constant this test would then have to keep in step with the component. */
  readonly pitch: number | null;
  readonly labels: readonly LabelFit[];
  /**
   * Line boxes the run-count label occupies — its height over its own
   * line-height, NOT `getClientRects().length`. A flex item is blockified, and
   * `getClientRects` on a block element answers one border box however many
   * lines are inside it: the pre-fix label measured 30px of 15px leading and
   * still reported a single rect, so the obvious probe was green over the
   * defect.
   */
  readonly countLines: number | null;
  /** Docked key and controls: its box, the scene's box, and the card's. */
  readonly legend: { top: number; right: number; bottom: number } | null;
  readonly scene: { bottom: number; right: number } | null;
  readonly card: { height: number; right: number } | null;
  /** The column the card lives in — never shrinks, so it is the budget. */
  readonly cellHeight: number | null;
  /** Every band's group opacity, selected band first. */
  readonly bandOpacity: readonly number[];
}

function readGeometry(page: Page): Promise<FrameGeometry> {
  return page.evaluate((): FrameGeometry => {
    const scene = document.querySelector('g.mcts-bands')?.closest('svg') ?? null;
    const legendEl = document.querySelector('[data-tree-legend]');
    const cardEl = legendEl?.closest('.rounded-lg') ?? null;
    const box = (el: Element | null) => (el === null ? null : el.getBoundingClientRect());
    const sceneBox = box(scene);
    const legendBox = box(legendEl);
    const cardBox = box(cardEl);
    const cellBox = box(cardEl?.parentElement ?? null);

    // The pitch, measured: two adjacent depth guides are exactly one column
    // apart, so the test never carries a copy of the component's constant.
    const guides = [...document.querySelectorAll('g.mcts-guides line')]
      .map((line) => Number(line.getAttribute('x1')))
      .filter((x) => Number.isFinite(x));
    const [firstGuide, secondGuide] = [...new Set(guides)].sort((a, b) => a - b);
    const pitch = firstGuide === undefined || secondGuide === undefined
      ? null
      : secondGuide - firstGuide;

    const labels: LabelFit[] = [];
    for (const group of document.querySelectorAll('g.mcts-label')) {
      const text = group.querySelector<SVGTextElement>('text');
      if (text === null) continue;
      labels.push({
        x: Number(text.getAttribute('x') ?? 0),
        width: text.getComputedTextLength(),
        foldable: group.querySelector('g.mcts-handle') !== null,
        text: text.textContent ?? '',
      });
    }

    const count = [...document.querySelectorAll('span')]
      .find((span) => /^\d+ (search|searches)$/.test((span.textContent ?? '').trim()));
    const leading = count === undefined ? 0 : Number.parseFloat(getComputedStyle(count).lineHeight);

    return {
      mode: document.documentElement.dataset.mode,
      nodes: document.querySelectorAll('g.mcts-node').length,
      pitch,
      labels,
      countLines: count === undefined || !Number.isFinite(leading) || leading <= 0
        ? null
        : Math.round(count.getBoundingClientRect().height / leading),
      legend: legendBox === null
        ? null
        : { top: legendBox.top, right: legendBox.right, bottom: legendBox.bottom },
      scene: sceneBox === null ? null : { bottom: sceneBox.bottom, right: sceneBox.right },
      card: cardBox === null ? null : { height: cardBox.height, right: cardBox.right },
      cellHeight: cellBox === null ? null : cellBox.height,
      bandOpacity: [...document.querySelectorAll('g.mcts-region')]
        .map((region) => Number(region.getAttribute('opacity'))),
    };
  });
}

/** `frame@width/mode` → what the browser laid out. */
type Observed = Record<string, FrameGeometry>;

const FRAMES = ['forks', 'forkmerge', 'forkbig'] as const;
const WIDTHS = [640, 1280] as const;
const MODES = ['dark', 'light'] as const;

function key(frame: string, width: number, mode: string): string {
  return `${frame}@${width}/${mode}`;
}

async function run(): Promise<Observed> {
  return withGallery(async ({ browser, origin }) => {
    const observed: Observed = {};
    for (const frame of FRAMES) {
      for (const width of WIDTHS) {
        for (const mode of MODES) {
          const page = await browser.newPage();
          try {
            await page.setViewport({ width, height: 1238 });
            await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: mode }]);
            await page.goto(`${origin}/gallery.html?frame=${frame}`, { waitUntil: 'networkidle0' });
            // The scene, not the document: a frame that threw during render
            // resolves `networkidle0` with an empty body, which is exactly the
            // state this file exists to stop being green.
            await page.waitForSelector('g.mcts-band');
            // The fit is a d3 TRANSITION and the docked row's height arrives
            // through a ResizeObserver, so the frame after mount is not the
            // laid-out one. Waiting on the settled condition rather than on a
            // duration: the scene's transform stops changing when both are
            // done, and a fixed sleep would either flake under load or pay for
            // itself on every run.
            await page.waitForFunction(async () => {
              const scene = document.querySelector('svg > g');
              if (scene === null) return false;
              const before = scene.getAttribute('transform') ?? '';
              if (before === '') return false;
              const { promise, resolve } = Promise.withResolvers<void>();
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
              await promise;
              return (scene.getAttribute('transform') ?? '') === before;
            });
            observed[key(frame, width, mode)] = await readGeometry(page);
          } finally {
            await page.close();
          }
        }
      }
    }
    return observed;
  });
}

let observed: Observed;
beforeAll(async () => { observed = await run(); }, 240_000);

const every = (): [string, FrameGeometry][] => Object.entries(observed);

describe('the swarm trees, as a browser lays them out', () => {
  test('every frame under test actually rendered a scene', () => {
    for (const [where, frame] of every()) {
      expect(frame.nodes, `${where}: no nodes drawn`).toBeGreaterThan(0);
      expect(frame.mode, `${where}: palette not pinned`).toBe(where.split('/')[1]);
    }
    // The scale probe is the one the view has to survive, and the frame that
    // was blank: name its size so a fixture shrinking to nothing cannot pass.
    for (const mode of MODES) {
      for (const width of WIDTHS) {
        expect(observed[key('forkbig', width, mode)]?.nodes).toBe(520);
      }
    }
  });

  test('a label stops before the column its node draws children in', () => {
    for (const [where, frame] of every()) {
      const pitch = frame.pitch;
      expect(pitch, `${where}: no depth guides to measure the pitch from`).not.toBeNull();
      if (pitch === null) continue;
      for (const label of frame.labels) {
        // A node WITH children shares its row with them, so its label has one
        // pitch. A leaf has the row to itself and is bounded by reading width,
        // which the component caps at two.
        const room = label.foldable ? pitch : pitch * 2;
        expect(
          label.x + label.width,
          `${where}: "${label.text}" runs ${Math.round(label.x + label.width - room)}px past its room`,
        ).toBeLessThanOrEqual(room);
      }
    }
  });

  test('the room a label has is spent, not thrown away at 20 characters', () => {
    // The flat clip cut 127 of the 178 labels on the 106-node search, most of
    // them with an empty column beside them. Any label past the old cap proves
    // the clip is now a width; the ceiling proves it is still a clip.
    for (const width of WIDTHS) {
      for (const mode of MODES) {
        const where = key('forks', width, mode);
        const frame = observed[where];
        expect(frame, `${where} missing`).toBeDefined();
        if (frame === undefined) continue;
        const longest = frame.labels.reduce((best, label) => Math.max(best, label.text.length), 0);
        expect(longest, `${where}: longest label is ${longest} characters`).toBeGreaterThan(24);
      }
    }
  });

  test('the run-count label holds one line at every width', () => {
    for (const [where, frame] of every()) {
      if (frame.countLines === null) continue;
      expect(frame.countLines, `${where}: the count label took two lines`).toBe(1);
    }
  });

  test('the key is docked under the scene and inside its card', () => {
    for (const [where, frame] of every()) {
      const { legend, scene, card } = frame;
      expect(legend, `${where}: no docked row`).not.toBeNull();
      if (legend === null || scene === null || card === null) continue;
      // Sub-pixel layout: a hairline of tolerance, not a gutter.
      expect(legend.top, `${where}: the key overlaps the scene`).toBeGreaterThanOrEqual(scene.bottom - 1);
      expect(legend.right, `${where}: the key overflows its card`).toBeLessThanOrEqual(card.right);
    }
  });

  test('a card of short searches hugs them instead of reserving the column', () => {
    // `forkmerge` focuses a journalled run: one band of five rows. It used to
    // hold the whole column and draw the rest as empty canvas with the key
    // stranded at the bottom of it.
    for (const width of WIDTHS) {
      for (const mode of MODES) {
        const where = key('forkmerge', width, mode);
        const frame = observed[where];
        expect(frame, `${where} missing`).toBeDefined();
        if (frame === undefined) continue;
        const { card, cellHeight } = frame;
        expect(card, `${where}: no card`).not.toBeNull();
        expect(cellHeight, `${where}: no column to measure against`).not.toBeNull();
        if (card === null || cellHeight === null) continue;
        expect(cellHeight).toBeGreaterThan(400);
        expect(
          card.height,
          `${where}: card reserves ${Math.round(card.height)} of ${Math.round(cellHeight)}`,
        ).toBeLessThan(cellHeight * 0.6);
      }
    }
  });

  test('an unselected search recedes without becoming illegible', () => {
    for (const [where, frame] of every()) {
      const [selected, ...rest] = frame.bandOpacity;
      if (selected !== undefined) expect(selected, `${where}: selected band dimmed`).toBe(1);
      for (const opacity of rest) {
        // Half opacity on 11px type is not recession. The floor is the contrast
        // at which an unselected band's labels are still readable, which is the
        // comparison one canvas exists for.
        expect(opacity, `${where}: unselected band at ${opacity}`).toBeGreaterThanOrEqual(0.7);
        expect(opacity, `${where}: unselected band not receding`).toBeLessThan(1);
      }
    }
  });
});
