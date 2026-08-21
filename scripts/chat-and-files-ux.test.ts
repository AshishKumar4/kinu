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

/** One chat row, as the browser placed and drew it. */
interface ChatRow {
  /** The owner's bubble, by the class only the user branch draws. */
  readonly userBubbles: number;
  /** The generic harness-event card's event name, or null when there is none. */
  readonly systemEvent: string | null;
  /** The card body clipped to one line — "collapsed by default", measured as
   *  content that does not fit rather than as a class name. */
  readonly folded: boolean;
  /** Row centre minus column centre, in px. The owner's bubble is pushed right;
   *  an event card is centred. Sign and size are the whole difference a reader
   *  sees at a glance, so they are what is measured. */
  readonly offsetFromCentrePx: number;
}

/** One Exploration run-node row, as the browser drew it. */
interface RunNode {
  /** What the row TELLS a reader the node's ending was, read off the row rather
   *  than inferred from the prose it happens to carry. */
  readonly reason: string | null;
  /** The reason line as rendered. */
  readonly reasonText: string;
  /** The status dot's tone — the at-a-glance half of the same fact. A dot that
   *  says fault beside a line that says rate limit is the contradiction the
   *  classification exists to remove. */
  readonly dot: string;
}

interface Observed {
  readonly tails: TailFrame[];
  readonly chat: Record<string, ChatRow>;
  readonly forkInterruptedAfterClick: ChatRow;
  /** The failed-turn card's headline, keyed by whether it is a replay. */
  readonly chatErrorHeadings: Record<string, string>;
  readonly filesHome: string;
  readonly filesAfterUp: string;
  readonly filesAfterUpEntries: string[];
  readonly capabilityChips: string[];
  readonly capabilityAbsences: string;
  /** Exploration's run-node rows on the mixed-status run, by node id. */
  readonly runNodes: Record<string, RunNode>;
}

/** The gallery ids the provenance assertions address (gallery.tsx MESSAGES). */
const LEGACY_FORK_ROW = 'f8798675-5e9a-4d13-aac2-293f4557f1c1';
const STAMPED_GATE_ROW = 'programmatic:completion-gate-1';
const TYPED_ROW = 'u1';
const DRAIN_ROW = 'd1';

/** The two endings the node rows are read for (gallery.tsx RUNNING_RUN): one
 *  turn the provider rate-limited, one the operator stopped. */
const RATE_LIMITED_NODE = 'lv008';
const ABORTED_NODE = 'lv005';

async function readChatRows(page: Page): Promise<Record<string, ChatRow>> {
  return page.$$eval('[data-chat-row]', (rows) => {
    const measured: Record<string, {
      userBubbles: number; systemEvent: string | null; folded: boolean; offsetFromCentrePx: number;
    }> = {};
    for (const row of rows) {
      const card = row.querySelector('[data-system-event]');
      // The drawn box, not the full-width row: a centred card and a
      // right-pushed bubble both live inside a full-width block.
      const drawn = card ?? row.querySelector('.p-user-bubble') ?? row.firstElementChild ?? row;
      const column = row.parentElement ?? row;
      const drawnBox = drawn.getBoundingClientRect();
      const columnBox = column.getBoundingClientRect();
      const body = card?.querySelector('.truncate, .whitespace-pre-wrap') ?? null;
      measured[row.getAttribute('data-chat-row') ?? ''] = {
        userBubbles: row.querySelectorAll('.p-user-bubble').length,
        systemEvent: card?.getAttribute('data-system-event') ?? null,
        folded: body === null ? false : body.scrollWidth > body.clientWidth,
        offsetFromCentrePx: Math.round(
          (drawnBox.left + drawnBox.width / 2) - (columnBox.left + columnBox.width / 2),
        ),
      };
    }
    return measured;
  });
}

async function readRunNodes(page: Page): Promise<Record<string, RunNode>> {
  return page.$$eval('[data-run-node]', (rows) => {
    const measured: Record<string, { reason: string | null; reasonText: string; dot: string }> = {};
    for (const row of rows) {
      const line = row.querySelector('[data-node-reason]');
      const dot = row.querySelector('span.rounded-full');
      measured[row.getAttribute('data-run-node') ?? ''] = {
        reason: line === null ? null : line.getAttribute('data-node-reason'),
        reasonText: line?.textContent ?? '',
        dot: [...(dot?.classList ?? [])].find((name) => name.startsWith('p-dot-')) ?? '',
      };
    }
    return measured;
  });
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

    const chatPage = await browser.newPage();
    await chatPage.setViewport({ width: 1280, height: 1600 });
    await chatPage.goto(`${origin}/gallery.html?frame=chat`, { waitUntil: 'networkidle0' });
    await chatPage.reload({ waitUntil: 'networkidle0' });
    await chatPage.waitForSelector(`[data-chat-row="${LEGACY_FORK_ROW}"]`);
    const chat = await readChatRows(chatPage);
    // Folded by DEFAULT, not folded permanently: the words are still reachable,
    // which is what makes hiding them by default honest rather than lossy.
    //
    // Guarded, because a regression that puts this row back in the owner's
    // bubble removes the button too, and a `beforeAll` that throws on a missing
    // selector reports the whole file red — including the streaming and file
    // panes, which such a regression does not touch. The named assertions below
    // carry the failure instead, and say which wire broke.
    const toggle = `[data-chat-row="${LEGACY_FORK_ROW}"] [data-system-event] button`;
    if (await chatPage.$(toggle) !== null) {
      await chatPage.click(toggle);
      await chatPage.waitForFunction(
        (selector: string) => document.querySelector(selector)?.getAttribute('aria-expanded') === 'true',
        { timeout: 10_000 }, toggle,
      );
    }
    const forkInterruptedAfterClick = (await readChatRows(chatPage))[LEGACY_FORK_ROW]!;
    const chatErrorHeadings = Object.fromEntries(await chatPage.$$eval(
      '[data-chat-error]',
      (cards) => cards.map((card) => [
        card.getAttribute('data-chat-error') ?? '',
        card.querySelector('.font-medium')?.textContent ?? '',
      ]),
    ));
    await chatPage.close();

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

    const explore = await browser.newPage();
    await explore.setViewport({ width: 1280, height: 1100 });
    await explore.goto(`${origin}/gallery.html?frame=forkrunning`, { waitUntil: 'networkidle0' });
    await explore.reload({ waitUntil: 'networkidle0' });
    await explore.waitForSelector(`[data-run-node="${RATE_LIMITED_NODE}"]`, { timeout: 20_000 });
    const runNodes = await readRunNodes(explore);
    await explore.close();

    return {
      tails, chat, forkInterruptedAfterClick, chatErrorHeadings,
      filesHome, filesAfterUp, filesAfterUpEntries,
      capabilityChips, capabilityAbsences, runNodes,
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

describe('a turn the harness wrote, as the browser attributes it', () => {
  test('it measures something — every addressed row is on the page', () => {
    for (const id of [LEGACY_FORK_ROW, STAMPED_GATE_ROW, TYPED_ROW, DRAIN_ROW]) {
      expect(observed.chat[id]).toBeDefined();
    }
  });

  test('the owner\'s own message is still the owner\'s bubble, pushed right', () => {
    // The denominator. Without it, a change that turned EVERY row into an event
    // card would satisfy every assertion below.
    const typed = observed.chat[TYPED_ROW]!;
    expect(typed.userBubbles).toBe(1);
    expect(typed.systemEvent).toBeNull();
    expect(typed.offsetFromCentrePx).toBeGreaterThan(20);
  });

  test('the fork-interrupted row wears an event card, never the owner\'s bubble', () => {
    // THE INCIDENT, as a browser draws it. This row is the production shape:
    // a bare UUID id and `kinuEvent: fork_interrupted`, no author stamp,
    // which is what five rows in the owner's live workspaces look like. Under
    // the four-name allowlist this rendered right-aligned in `.p-user-bubble`.
    const fork = observed.chat[LEGACY_FORK_ROW]!;
    expect(fork.userBubbles).toBe(0);
    expect(fork.systemEvent).toBe('fork_interrupted');
    expect(Math.abs(fork.offsetFromCentrePx)).toBeLessThan(20);
  });

  test('a stamped harness turn lands the same way, without its event name mattering', () => {
    const gate = observed.chat[STAMPED_GATE_ROW]!;
    expect(gate.userBubbles).toBe(0);
    expect(gate.systemEvent).toBe('completion_gate');
    expect(Math.abs(gate.offsetFromCentrePx)).toBeLessThan(20);
  });

  test('the harness\'s words are folded away, and open when asked', () => {
    // Collapsed by default is a measurement here, not a class name: the body
    // holds more than it shows. Clicking it makes the row taller and stops it
    // overflowing, which is the difference between folded and truncated.
    expect(observed.chat[LEGACY_FORK_ROW]!.folded).toBe(true);
    expect(observed.forkInterruptedAfterClick.folded).toBe(false);
  });

  test('an event kind that HAS a card keeps it — the fallback did not swallow them', () => {
    // `event_drain` renders its parsed events, not the generic card. A fallback
    // that captured everything would read as green here while erasing four
    // purpose-built renderings.
    const drain = observed.chat[DRAIN_ROW]!;
    expect(drain.systemEvent).toBeNull();
    expect(drain.userBubbles).toBe(0);
  });

  test('a replayed failure does not claim to be a live one', () => {
    // `sunlit-stone-4a20` still answers a resume ACK with
    // {"body":"Unauthorized","done":true,"error":true} from a turn that ended
    // 2026-08-17. Both states are on the page, and they must not read alike.
    expect(observed.chatErrorHeadings.live).toBe('The last turn failed and produced no answer');
    expect(observed.chatErrorHeadings.replayed).toBe('This workspace was last left on a failed turn');
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

describe('a node the provider rate-limited, as the run list reads it', () => {
  test('the row says rate limit, not fault', () => {
    // The seam this reads through is `isRateLimitedTurnError`. Before it was
    // wired here the row rendered `errorMessage` verbatim in the failure tone,
    // so a node the provider told us to wait for was indistinguishable from a
    // wedged one — the distinction the classifier was built for.
    expect(observed.runNodes[RATE_LIMITED_NODE]?.reason).toBe('rate-limited');
    expect(observed.runNodes[RATE_LIMITED_NODE]?.reasonText).toContain('Rate limited');
  });

  test('its dot agrees with its line', () => {
    expect(observed.runNodes[RATE_LIMITED_NODE]?.dot).toBe('p-dot-warning');
  });

  test('a turn that ended some other way is still a fault', () => {
    // The guard on the classification: the operator stopped this one, nothing
    // declared a wait, and a refactor that blames the provider for every ending
    // fails here rather than passing quietly.
    expect(observed.runNodes[ABORTED_NODE]?.reason).toBe('failed');
    expect(observed.runNodes[ABORTED_NODE]?.reasonText).not.toContain('Rate limited');
    expect(observed.runNodes[ABORTED_NODE]?.dot).toBe('p-dot-danger');
  });
});

/**
 * A STUBBED FIXTURE MUST NOT RENDER A FAILURE STATE.
 *
 * The sidebar footer read "Profile unavailable" in every gallery capture any
 * agent took, while `/api/user/profile` sat in the stub table with a payload.
 * The cause was not the fetch racing the stub — the stub is installed at module
 * scope, before React mounts. The payload simply did not satisfy the schema the
 * CLIENT parses it with: `UserProfileSchema` requires `displayName`, the stub
 * omitted it, valibot threw, and the component's own catch rendered the failure.
 *
 * So the assertion is over the RENDERED state rather than over the table: a
 * table that type-checks and still fails the client's parse is exactly what
 * happened, and only a browser can see the difference.
 */
describe('the gallery shell photographs a healthy neighbour', () => {
  test('a frame whose stub carries a profile never renders "Profile unavailable"', async () => {
    await withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=forks`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('aside');
      // The footer settles once the profile call resolves either way, so the
      // read waits for the loading word to leave rather than for a fixed delay.
      await page.waitForFunction(
        () => !(document.querySelector('aside')?.textContent ?? '').includes('loading...'),
        { timeout: 8000 },
      );
      const footer = await page.evaluate(() => document.querySelector('aside')?.textContent ?? '');
      await page.close();
      expect(footer).not.toContain('Profile unavailable');
      expect(footer).toContain('@');
    });
  }, 120_000);
});
