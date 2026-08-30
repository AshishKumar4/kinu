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
import type { Browser, Page } from 'puppeteer';

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
  /**
   * Each band's caption against the band it names: how far its right edge is
   * PAST the band's own right edge, in screen pixels.
   *
   * The captions are HTML pinned over the scene, and their width was capped to
   * the CANVAS rather than to the band — so a one-node search, whose band is as
   * wide as one node's label, wore a caption running the whole width of the
   * card. That is the "content leaks out of the box" in the owner's own
   * screenshot, and it is a comparison of two boxes, which is why it can only
   * be measured here.
   */
  readonly captionOverflow: readonly number[];
}

function readGeometry(page: Page): Promise<FrameGeometry> {
  return page.evaluate((): FrameGeometry => {
    const scene = document.querySelector('g.mcts-bands')?.closest('svg') ?? null;
    const legendEl = document.querySelector('[data-tree-legend]');
    const cardEl = legendEl?.closest('[data-tree-card]') ?? null;
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
      // Matched by RUN, never by index: the caption overlay and the band layer
      // are rebuilt from the same list, so an index pairing would silently
      // compare a caption against somebody else's band the day one of them is
      // filtered.
      captionOverflow: [...document.querySelectorAll<SVGGElement>('g.mcts-band[data-run]')]
        .flatMap((band) => {
          const runId = band.dataset.run ?? '';
          const caption = document.querySelector(`[data-band-title="${CSS.escape(runId)}"]`);
          const rect = band.querySelector('rect');
          if (caption === null || rect === null) return [];
          return [caption.getBoundingClientRect().right - rect.getBoundingClientRect().right];
        }),
    };
  });
}

/** `frame@width/mode` → what the browser laid out. */
type Geometry = Record<string, FrameGeometry>;

/** One beat of a live search: what the surface was showing. */
interface Beat {
  readonly stage: string | null;
  /** Rows in the run list. Zero means the ledger has no row for the search. */
  readonly rows: number;
  readonly nodes: number;
  /** Nodes currently marked as working. */
  readonly working: number;
  /**
   * What the RUN ROW says became of the run.
   *
   * Read off `[data-fork-run]` and not off `document.body.innerText`, which is
   * where this probe used to look. The swarm liveness notice sits above the run
   * list and says "23 head(s) across 6 fork run(s) were still marked running
   * from an activation that has ended", so a body-wide scan matched `running`
   * at character 1543 on EVERY stage — including the completed one, whose row
   * read `· completed` correctly two thousand characters further down. Both
   * liveness arms failed on that one word while the surface was right: the
   * completed assertion read the banner, and the watch loop, whose break is
   * `outcome === 'completed'`, never broke and ran on past the frame's wrap back
   * to stage 1, comparing 1 node against 1.
   *
   * Scoping it to the row is stricter, not looser: no prose anywhere else on
   * the page can satisfy this assertion or defeat it. `settle=search` in the
   * same row is not a false positive — the alternation needs `completed`.
   */
  readonly outcome: string | null;
}

interface Liveness {
  /** Each pinned stage, read on its own page load. */
  readonly pinned: readonly Beat[];
  /** One page load, watched while the search advanced itself. */
  readonly watched: readonly Beat[];
  /** Main-frame navigations during the watch. Anything but zero and the
   *  "without a refresh" claim is not being tested. */
  readonly navigations: number;
  /**
   * How long the run row took to appear AFTER the search reached stage 1, on a
   * page that was already open at stage 0.
   *
   * Measured on the watched page and nowhere else. A pinned stage cannot test
   * this: its very first read already carries the row, so the row is there
   * before any push could matter. The open page is the real condition — the
   * ledger gains a row under a surface that has already read it — and the fork
   * list is on its 15s idle cadence there, so a row that arrives inside the
   * budget did not arrive by the clock.
   */
  readonly rowAppearedMs: number;
  /** Working marks immediately after a stage landed, and after the decay
   *  window — the second number is what makes the first mean "working". */
  readonly workingOnArrival: number;
  readonly workingAfterDecay: number;
}

/**
 * Every control on the docked row, pressed, and whether the scene answered.
 *
 * Keyed by the control's own accessible name so a renamed button fails loudly
 * rather than going unwatched. `zoom`/`nodes` are what the press is allowed to
 * change; a control that moves neither did nothing, which is the whole claim.
 */
type ControlEffect = Record<string, { zoomChanged: boolean; nodesBefore: number; nodesAfter: number }>;

interface Observed {
  readonly geometry: Geometry;
  readonly live: Liveness;
  readonly controls: ControlEffect;
}

const FRAMES = ['forks', 'forkmerge', 'forkbig'] as const;
const WIDTHS = [640, 1280] as const;
const MODES = ['dark', 'light'] as const;
/** The frame's own stage count. Kept in step by the frame reading the same
 *  list; a stage added there and not here simply goes unwatched. */
const LIVE_STAGES = 5;
/**
 * What the push path is allowed, measured from the beat that wrote the ledger
 * row on a page that was already open.
 *
 * One stage of the frame is 1800ms and the fork list's idle cadence is 15s, so
 * this budget is comfortably inside one and nowhere near the other: a row that
 * lands here came from the activity signal forcing a re-read, and a row that
 * waited for the clock cannot.
 */
const PUSH_BUDGET_MS = 1_500;
/** `WORKING_MS` in the component is 2.5s. */
const DECAY_WAIT_MS = 3_200;

function key(frame: string, width: number, mode: string): string {
  return `${frame}@${width}/${mode}`;
}

function readBeat(page: Page): Promise<Beat> {
  return page.evaluate((): Beat => ({
    stage: document.querySelector('[data-live-stage]')?.getAttribute('data-live-stage') ?? null,
    rows: document.querySelectorAll('[data-fork-run]').length,
    nodes: document.querySelectorAll('g.mcts-node').length,
    working: document.querySelectorAll('g.mcts-node[data-working]').length,
    outcome: /completed|running|stopped without an answer/
      .exec(document.querySelector('[data-fork-run]')?.textContent ?? '')?.[0] ?? null,
  }));
}

/** Wait for the scene to stop moving: the fit is a d3 transition and the docked
 *  row's height arrives through a ResizeObserver, so the frame after mount is
 *  not the laid-out one. The settled CONDITION, never a duration — a fixed sleep
 *  either flakes under load or pays for itself on every run. */
async function settled(page: Page): Promise<void> {
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
}

async function readGeometryFrames(browser: Browser, origin: string): Promise<Geometry> {
  const observed: Geometry = {};
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
          await page.waitForSelector('[data-tree-legend]', { timeout: 20_000 });
          if (frame === 'forkmerge') {
            await page.waitForSelector('[data-tree-card]', { timeout: 20_000 });
          }
          await settled(page);
          observed[key(frame, width, mode)] = await readGeometry(page);
        } finally {
          await page.close();
        }
      }
    }
  }
  return observed;
}

/**
 * The live search, three ways.
 *
 * Pinned stages answer "does each state render". The WATCH answers the property
 * the owner actually asked for — that the surface grows without being reloaded —
 * and it can only be answered by holding one page open across two moments.
 */
async function readLiveness(browser: Browser, origin: string): Promise<Liveness> {
  const pinned: Beat[] = [];
  let workingOnArrival = 0;
  let workingAfterDecay = 0;
  for (let stage = 0; stage < LIVE_STAGES; stage += 1) {
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 1280, height: 1238 });
      await page.goto(`${origin}/gallery.html?frame=forklive&stage=${stage}`, {
        waitUntil: 'domcontentloaded',
      });
      if (stage > 0) {
        await page.waitForSelector('[data-fork-run]');
        await page.waitForSelector('g.mcts-node');
        await settled(page);
      }
      pinned.push(await readBeat(page));
      if (stage === LIVE_STAGES - 2) {
        workingOnArrival = (await readBeat(page)).working;
        await page.waitForFunction(
          () => document.querySelectorAll('g.mcts-node[data-working]').length === 0,
          { timeout: DECAY_WAIT_MS * 3 },
        );
        workingAfterDecay = (await readBeat(page)).working;
      }
    } finally {
      await page.close();
    }
  }

  const page = await browser.newPage();
  const watched: Beat[] = [];
  let navigations = 0;
  let rowAppearedMs = Number.POSITIVE_INFINITY;
  try {
    await page.setViewport({ width: 1280, height: 1238 });
    await page.goto(`${origin}/gallery.html?frame=forklive`, { waitUntil: 'domcontentloaded' });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations += 1;
    });
    // The surface is open and the ledger has nothing. Time the row from the beat
    // that writes it, on a list whose next scheduled read is 15 seconds away.
    await page.waitForSelector('[data-live-stage="0"]');
    await page.waitForFunction(
      () => document.querySelector('[data-live-stage="0"]') === null,
      { timeout: 20_000 },
    );
    const advanced = Date.now();
    await page.waitForSelector('[data-fork-run]', { timeout: 20_000 });
    rowAppearedMs = Date.now() - advanced;
    // Watched by the CONDITION, not by a clock: read a beat each time the node
    // count changes, until the whole tree has landed or the frame has cycled.
    for (let seen = 0; seen < LIVE_STAGES; seen += 1) {
      const before = watched.at(-1)?.nodes ?? 0;
      await page.waitForFunction(
        (previous: number) => document.querySelectorAll('g.mcts-node').length !== previous,
        { timeout: 20_000 },
        before,
      );
      watched.push(await readBeat(page));
      if ((watched.at(-1)?.outcome ?? null) === 'completed') break;
    }
  } finally {
    await page.close();
  }
  return { pinned, watched, navigations, rowAppearedMs, workingOnArrival, workingAfterDecay };
}

/**
 * Every control on the docked row, pressed, and whether the scene answered.
 *
 * On the 106-node search, because it is the only fixture where every control has
 * something to do. Each is pressed from a state where it HAS work: `Fit` after a
 * zoom, so it is asked to travel rather than to re-apply the transform it already
 * holds, and `Expand` after a fold. A control asked for what it has already done
 * cannot be observed either way — which is how the first version of this probe
 * passed `Fit` for the wrong reason, `Expand`'s own refit having already fitted
 * the scene.
 */
async function readControls(browser: Browser, origin: string): Promise<ControlEffect> {
  const effects: ControlEffect = {};
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 1238 });
    await page.goto(`${origin}/gallery.html?frame=forks`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('g.mcts-band');
    await settled(page);
    const scene = () => page.evaluate(() => ({
      zoom: document.querySelector('g.mcts-bands')?.parentElement?.getAttribute('transform') ?? '',
      nodes: document.querySelectorAll('g.mcts-node').length,
    }));
    const press = async (label: string) => {
      const before = await scene();
      await page.click(`button[aria-label="${label}"]`);
      await settled(page);
      const after = await scene();
      effects[label] = {
        zoomChanged: before.zoom !== after.zoom,
        nodesBefore: before.nodes,
        nodesAfter: after.nodes,
      };
      return after;
    };
    const fitted = (await scene()).zoom;
    // One zoom, then the refit, then the other zoom. Pressing both zooms first
    // would land exactly back on the fit — the factors are reciprocal and the
    // anchor is the same point — leaving `Fit` nothing to do and passing it for
    // the wrong reason.
    await press('Zoom in');
    await press('Fit the selected search to view');
    effects.refitted = {
      zoomChanged: (await scene()).zoom === fitted,
      nodesBefore: 0, nodesAfter: 0,
    };
    await press('Zoom out');
    await press('Fold abandoned branches');
    await press('Expand every branch');
  } finally {
    await page.close();
  }
  return effects;
}

async function run(): Promise<Observed> {
  return withGallery(async ({ browser, origin }) => ({
    geometry: await readGeometryFrames(browser, origin),
    live: await readLiveness(browser, origin),
    controls: await readControls(browser, origin),
  }));
}

let observed: Observed;
beforeAll(async () => { observed = await run(); }, 240_000);

const every = (): [string, FrameGeometry][] => Object.entries(observed.geometry);

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
        expect(observed.geometry[key('forkbig', width, mode)]?.nodes).toBe(520);
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
        const frame = observed.geometry[where];
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
        const frame = observed.geometry[where];
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

  test("a band's caption stops inside the band it names", () => {
    // The owner's words were "the content leaks out of the box", and the box he
    // meant is the band. A caption capped to the CANVAS instead of to its band
    // ran the full width of the card over a search one node wide.
    for (const [where, frame] of every()) {
      expect(frame.captionOverflow.length, `${where}: no caption paired to a band`).toBeGreaterThan(0);
      for (const past of frame.captionOverflow) {
        expect(Math.round(past), `${where}: a caption runs ${Math.round(past)}px past its band`)
          .toBeLessThanOrEqual(0);
      }
    }
  });
});

/**
 * The controls, pressed.
 *
 * A control that renders and does nothing is worse than an absent one: the reader
 * believes the view cannot do the thing. Both zoom buttons were in that state —
 * the transform was byte-identical at 0ms, 120ms, 240ms and 1700ms after the
 * press, so nothing was even scheduled — while fold, expand and fit on the same
 * row worked. So this is asserted per control and by NAME.
 */
describe('the controls on the docked row', () => {
  test('zooming in and out moves the scene', () => {
    for (const label of ['Zoom in', 'Zoom out']) {
      expect(observed.controls[label]?.zoomChanged, `${label} did not move the scene`).toBe(true);
    }
  });

  test('folding abandoned branches removes nodes, and expanding brings them back', () => {
    const fold = observed.controls['Fold abandoned branches'];
    const expand = observed.controls['Expand every branch'];
    expect(fold?.nodesAfter ?? 0, 'folding drew as many nodes as before').toBeLessThan(fold?.nodesBefore ?? 0);
    expect(expand?.nodesAfter).toBe(fold?.nodesBefore);
  });

  test('fit travels back to the fitted view after the scene has been moved', () => {
    expect(observed.controls['Fit the selected search to view']?.zoomChanged, 'fit did not move the scene')
      .toBe(true);
    // And it arrives where it started, which is the claim: a control that merely
    // moved the scene somewhere would satisfy the line above.
    expect(observed.controls.refitted?.zoomChanged, 'fit did not land on the fitted transform')
      .toBe(true);
  });
});

/**
 * Liveness — the property the owner asked for in as many words, and the one this
 * gallery could not photograph before there was a frame that MOVES.
 *
 * Every stage of a swarm run was poll-only: `SwarmRunDeps` carries no progress
 * seam, so `mcts-progress` cannot fire for one, and `head_activity` announced a
 * step only for a node hosted on a facet. A new search therefore sat invisible
 * for up to the fork list's 15s idle cadence while its nodes were already
 * working — which is exactly what the owner saw and reported as a dead swarm.
 */
describe('a search, as it happens', () => {
  test('every stage of a live run renders', () => {
    const { pinned } = observed.live;
    expect(pinned).toHaveLength(LIVE_STAGES);
    // Stage 0 is the state the surface used to be stuck in: a search is running
    // and the ledger has no row for it yet.
    expect(pinned[0]?.rows, 'stage 0 should have no ledger row').toBe(0);
    expect(pinned[0]?.nodes, 'stage 0 should draw no nodes').toBe(0);
    for (let stage = 1; stage < LIVE_STAGES; stage += 1) {
      const beat = pinned[stage];
      expect(beat?.rows, `stage ${stage}: no run row`).toBe(1);
      expect(beat?.nodes, `stage ${stage}: no nodes`).toBeGreaterThan(0);
    }
  });

  test('the tree grows a stage at a time and the run settles at the end', () => {
    const { pinned } = observed.live;
    for (let stage = 2; stage < LIVE_STAGES; stage += 1) {
      const before = pinned[stage - 1]?.nodes ?? 0;
      const after = pinned[stage]?.nodes ?? 0;
      expect(after, `stage ${stage} drew ${after} nodes, stage ${stage - 1} drew ${before}`)
        .toBeGreaterThan(before);
    }
    // Running while it runs, completed when it has. A run that reads
    // "completed" throughout is the defect the owner hit from the other side:
    // a dead-looking swarm and a live-looking one must not render the same.
    expect(pinned[1]?.outcome).toBe('running');
    expect(pinned[LIVE_STAGES - 1]?.outcome).toBe('completed');
  });

  test('the surface grows WITHOUT a reload — the whole claim', () => {
    const { watched, navigations } = observed.live;
    // Zero, or the rest of this test is measuring page loads.
    expect(navigations, 'the watched page navigated').toBe(0);
    expect(watched.length, 'nothing changed while watching').toBeGreaterThan(1);
    const first = watched[0];
    const last = watched.at(-1);
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    if (first === undefined || last === undefined) return;
    expect(last.nodes, `nodes went ${first.nodes} -> ${last.nodes} in one page`)
      .toBeGreaterThan(first.nodes);
    expect(last.rows, 'the run row never appeared').toBeGreaterThan(0);
  });

  test('a search the list has never heard of appears at once, not on the idle clock', () => {
    // The canvas builds its bands by walking the POLLED list, so a live tree for
    // an unlisted root draws nothing at all. With no streaming turn and no
    // background job the list is on its 15s cadence — so a row that appears
    // inside this budget can only have come from the activity signal forcing a
    // re-read. Remove that effect and this is the assertion that goes red.
    expect(
      observed.live.rowAppearedMs,
      `the run row took ${Math.round(observed.live.rowAppearedMs)}ms after the ledger gained it`,
    ).toBeLessThan(PUSH_BUDGET_MS);
  });

  test('a working node is marked while it works and stops when it stops', () => {
    const { workingOnArrival, workingAfterDecay } = observed.live;
    // The pulse is the only motion on this canvas and it has to mean something:
    // marked while the node's ledger is moving, and NOT marked once it is not.
    // Without the second number the first would be satisfied by a mark that is
    // simply always on, which is a decoration rather than a reading.
    expect(workingOnArrival, 'no node was marked as working').toBeGreaterThan(0);
    expect(workingAfterDecay, 'the working mark never expired').toBe(0);
  });
});
