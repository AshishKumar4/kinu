/**
 * The gate is a browser, so its test is a browser.
 *
 * Four defects the owner hit are all invisible to `tsc`, `oxlint` and every
 * source-reading test in this repo, because each one is about where a rendered
 * box lands or which of two lines a browser puts it on:
 *
 *   - The streaming caret sat on a line of its OWN below the paragraph. It was
 *     a `<span>` after `<MarkdownContent>`, and markdown emits block elements.
 *     Valid TSX, valid CSS, wrong line.
 *   - A turn that finished its prose and went quiet between steps rendered no
 *     live affordance at all, because the "Thinking" row existed only while a
 *     message had no parts.
 *   - "Go to the parent directory" landed on the filesystem root instead of the
 *     directory above, because every environment reported its working directory
 *     as the literal `'.'` and the pane did string arithmetic on it.
 *   - The capability row was raw snake_case ids with no reading and no
 *     absences, so it could not answer the question it existed for.
 *
 * Every assertion below is a measurement of the real components in a real
 * cascade. Cut any of the four wires and the corresponding test fails while the
 * rest of the repo stays green — which is precisely what did not happen before.
 *
 * One server, one browser, one pass: booting vite costs several seconds and
 * every assertion here reads from the same two frames.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, Page } from 'puppeteer';

import { withGallery } from './gallery-harness';

/** One live-tail message, as the browser laid it out. */
interface TailFrame {
  /**
   * `::after` width on the LAST BLOCK the markdown emitted.
   *
   * A pseudo-element belongs to that block's own inline flow, so a caret with
   * a width here is a caret after the final character. The shape this replaced
   * could not satisfy it at all: the caret was a `<span>` SIBLING of the
   * rendered markdown, which is why it drew on a line of its own.
   */
  readonly caretWidth: string;
  /**
   * Pixels of height the caret costs the text block's container, measured by
   * withdrawing `p-streaming` from the live cascade and re-measuring.
   *
   * Zero is the property: an in-flow caret rides the last line and occupies no
   * vertical space of its own. Anything that starts a new line — a sibling
   * element, or a pseudo-element that cannot fit — shows up here as a line box.
   * Measured rather than asserted from a constant, and no file is edited to
   * measure it.
   */
  readonly heightCostPx: number;
  /** The tail "Thinking" row, addressed by the live region it announces on. */
  readonly thinkingRows: number;
  /** A shimmering label — the live reasoning block wears one. */
  readonly shimmerLabels: number;
  /** The pulsing dot a call in flight carries on its own row. */
  readonly runningDots: number;
}

interface Observed {
  readonly tails: TailFrame[];
  readonly filesHome: string;
  readonly filesAfterUp: string;
  readonly filesAfterUpEntries: string[];
  readonly capabilityChips: string[];
  readonly capabilityAbsences: string;
}

async function readTails(page: Page): Promise<TailFrame[]> {
  return page.$$eval('[data-gallery-stream] > *', (rows) => rows.map((row) => {
    const streaming = row.querySelector('.p-streaming');
    const last = streaming?.lastElementChild ?? null;
    let heightCostPx = 0;
    if (streaming !== null) {
      const withCaret = streaming.getBoundingClientRect().height;
      streaming.classList.remove('p-streaming');
      heightCostPx = Math.round(withCaret - streaming.getBoundingClientRect().height);
      streaming.classList.add('p-streaming');
    }
    return {
      caretWidth: last === null ? 'none' : getComputedStyle(last, '::after').width,
      heightCostPx,
      thinkingRows: row.querySelectorAll('[aria-live="polite"]').length,
      shimmerLabels: row.querySelectorAll('.p-shimmer').length,
      runningDots: row.querySelectorAll('.animate-pulse').length,
    };
  }));
}

async function run(): Promise<Observed> {
  return withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
    const stream = await browser.newPage();
    await stream.setViewport({ width: 1280, height: 1400 });
    await stream.goto(`${origin}/gallery.html?frame=streaming`, { waitUntil: 'networkidle0' });
    await stream.reload({ waitUntil: 'networkidle0' });
    await stream.waitForSelector('[data-gallery-stream] .p-streaming');
    const tails = await readTails(stream);
    await stream.close();

    const files = await browser.newPage();
    await files.setViewport({ width: 1280, height: 1100 });
    await files.goto(`${origin}/gallery.html?frame=environment`, { waitUntil: 'networkidle0' });
    // A first load can trip vite's dependency optimizer, which answers with a
    // full page reload and destroys the execution context of anything waiting.
    // The second load has the deps already, so every wait below is on a page
    // that will not vanish under it.
    await files.reload({ waitUntil: 'networkidle0' });

    const crumbs = () => files.$$eval(
      '[data-files-crumb]',
      (bs) => bs.map((b) => b.textContent ?? '').join('/'),
    );
    // The pane opens by asking for nothing and is TOLD where it is, so the
    // breadcrumb only fills in once that answer has landed.
    await files.waitForFunction(
      () => document.querySelectorAll('[data-files-crumb]').length === 3,
      { timeout: 20_000 },
    );
    const filesHome = await crumbs();

    await files.waitForSelector('[data-files-up-row]');
    await files.click('[data-files-up-row]');
    // The breadcrumb flips on click; the LISTING lands when the environment
    // answers. Reading between the two would assert the old directory.
    await files.waitForFunction(
      () => document.querySelectorAll('[data-files-crumb]').length === 2
        && !document.body.innerText.includes('SOUL.md'),
      { timeout: 20_000 },
    );
    const filesAfterUp = await crumbs();
    const filesAfterUpEntries = await files.$$eval(
      '[data-files-entry]',
      (rows) => rows.map((r) => r.getAttribute('title') ?? ''),
    );

    const capabilityChips = await files.$$eval(
      '[data-capability-chip]',
      (chips) => chips.map((c) => c.textContent ?? ''),
    );
    const capabilityAbsences = await files.$$eval(
      '[data-capability-absences]',
      (els) => els.map((el) => el.textContent ?? '').join(' '),
    );
    await files.close();

    return {
      tails, filesHome, filesAfterUp, filesAfterUpEntries,
      capabilityChips, capabilityAbsences,
    };
  });
}

/** Frame order in `STREAMING_MESSAGES` (gallery.tsx). */
const TEXT = 0;
const AFTER_TOOLS = 1;
const TOOL_IN_FLIGHT = 2;
const REASONING = 3;
const CODE_FENCE = 4;
const NO_PARTS = 5;

let observed: Observed;
beforeAll(async () => { observed = await run(); }, 240_000);

describe('the streaming turn, as a browser lays it out', () => {
  test('it measures something — six live tails, not an empty denominator', () => {
    expect(observed.tails).toHaveLength(6);
  });

  test('the caret is drawn, and drawn INSIDE the last block of the streamed text', () => {
    const tail = observed.tails[TEXT]!;
    // Cut `p-streaming` off the text block, or delete the CSS rule, and the
    // pseudo-element stops having a width.
    expect(tail.caretWidth).toBe('2px');
    // The whole reported defect: a sibling span after a <p> starts a new line.
    expect(tail.heightCostPx).toBe(0);
  });

  test('a code fence carries the caret inside the fence', () => {
    const tail = observed.tails[CODE_FENCE]!;
    // `::after` on the <pre> puts it in the code block's own flow. No height
    // assertion here, and the reason is not a concession: remark terminates a
    // fence's text with a newline, `white-space: pre` keeps it, so the caret
    // correctly sits at column 0 of the next code line — where an editor's
    // caret would be. The misplacement being tested for is prose, above.
    expect(tail.caretWidth).toBe('2px');
  });

  test('a turn that went quiet between steps says so at its tail', () => {
    // Prose closed, both calls settled, request still open. This is the state
    // that used to render nothing at all.
    expect(observed.tails[AFTER_TOOLS]!.thinkingRows).toBe(1);
    expect(observed.tails[AFTER_TOOLS]!.caretWidth).toBe('none');
  });

  test('a turn before its first token says so', () => {
    expect(observed.tails[NO_PARTS]!.thinkingRows).toBe(1);
  });

  test('a call in flight owns the indicator — no second claim under it', () => {
    // The honesty property. Its row already pulses; adding a "Thinking" row
    // below would assert two concurrent activities from one stream position.
    expect(observed.tails[TOOL_IN_FLIGHT]!.thinkingRows).toBe(0);
    expect(observed.tails[TOOL_IN_FLIGHT]!.runningDots).toBeGreaterThan(0);
    expect(observed.tails[TOOL_IN_FLIGHT]!.caretWidth).toBe('none');
  });

  test('streaming reasoning marks its own block live instead of adding a row', () => {
    expect(observed.tails[REASONING]!.thinkingRows).toBe(0);
    expect(observed.tails[REASONING]!.shimmerLabels).toBeGreaterThan(0);
  });

  test('a turn actively writing text is never also announced as thinking', () => {
    expect(observed.tails[TEXT]!.thinkingRows).toBe(0);
  });
});

describe('the file pane, navigating a real tree', () => {
  test('the pane opens where the environment says it starts, and says so', () => {
    // It asked for nothing and was told. Stop `getExecutorFiles` returning the
    // path it listed and this breadcrumb never leaves the root.
    expect(observed.filesHome).toBe('//home/user');
  });

  test('the parent row goes UP ONE LEVEL, not to the filesystem root', () => {
    // The reported bug, measured. With every environment reporting its working
    // directory as `'.'`, the pane's own breadcrumb held the single segment
    // `['.']` and this computed `/`.
    expect(observed.filesAfterUp).toBe('//home');
    expect(observed.filesAfterUpEntries).toEqual(['user']);
  });
});

describe('the capability row, as something to act on', () => {
  test('every chip reads as English, and none is a raw identifier', () => {
    expect(observed.capabilityChips.length).toBeGreaterThan(0);
    for (const chip of observed.capabilityChips) {
      expect(chip).not.toMatch(/^[a-z]+(_[a-z]+)+$/);
    }
  });

  test('what this environment cannot do names the environment that can', () => {
    // The workspace mock declares javascript/typescript/shell/fs_shared; the
    // sandbox and the laptop both declare docker. An absence with nowhere to
    // go is omitted, so naming one is the whole point of the line.
    expect(observed.capabilityAbsences).toContain('Docker');
    expect(observed.capabilityAbsences).toMatch(/Sandbox|Your PC/);
  });
});
