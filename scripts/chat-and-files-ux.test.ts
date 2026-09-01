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
import { TimeoutError, type Browser, type Page } from 'puppeteer';

import { diagnosticsSettled, recordDiagnostics, withGallery } from './gallery-harness';
import { parseJsonValue, redactPayload } from '@kinu.run/core';

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
  /** The animated label a call in flight carries on its own row. */
  readonly runningIndicators: number;
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
  readonly tails: Record<string, TailFrame>;
  readonly chat: Record<string, ChatRow>;
  readonly forkInterruptedAfterClick: ChatRow;
  /** The failed-turn card's headline, keyed by whether it is a replay. */
  readonly chatErrorHeadings: Record<string, string>;
  /** The drive at its root: crumb text, row names, and the origin badges the
   *  mounted folders wear. */
  readonly filesRoot: { crumbs: string; entries: string[]; badges: string[] };
  /** The drive after crossing into the /pc mount, which must land inside the
   *  device's consented directory rather than on the device root. */
  readonly filesInMount: { crumbs: string; entries: string[] };
  readonly filesAfterUp: string;
  /** File names the TREE pane carries — it used to carry only folders. */
  readonly treeFileNames: string[];
  /** Markdown opens rendered, through the app's one markdown renderer. */
  readonly filesMarkdownRendered: { heading: string; showsSource: boolean };
  /** The source the Source toggle shows for a workspace file. */
  readonly filesPreviewText: string;
  /** The edit buffer a whole file opens with. */
  readonly filesEditorSeedsFromTheFile: string;
  /** /home/user rows after renaming SOUL.md → CREDO.md, then after deleting
   *  AGENTS.md — both against the frame's stateful fixture. */
  readonly filesAfterRename: string[];
  readonly filesAfterDelete: string[];
  /** Rows visible while the filter says "credo". */
  readonly filesFiltered: string[];
  /** The stated-absence row for a disconnected device, on &offline=laptop. */
  readonly filesOfflineRow: string;
  /** The Environment tab, reworked: cards, and NO capability doctrine. */
  readonly envCards: Array<{ name: string; status: string; durability: string }>;
  readonly envCapabilityChips: number;
  readonly envCapabilityAbsences: number;
  /** An Environment card's Files action lands the Files surface. */
  readonly envFilesJumpLandsOnDrive: boolean;
  /** Exploration's run-node rows on the mixed-status run, by node id. */
  readonly runNodes: Record<string, RunNode>;
  readonly toolActivity: {
    total: number;
    collapsedRows: number;
    expandedRows: number;
    mutationRows: number;
    compactHeight: number;
    mutationHeight: number;
    ground: string;
    pageGround: string;
  };
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
/** A node simply at work on the same run — the state a rate-limited node has to
 *  be distinguishable FROM. */
const RUNNING_NODE = 'lv003';

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

async function readTails(page: Page): Promise<Record<string, TailFrame>> {
  return page.$$eval('[data-stream-id]', (rows) => {
    const measured: Record<string, TailFrame> = {};
    for (const row of rows) {
      const streaming = row.querySelector('.p-streaming');
      const last = streaming?.lastElementChild ?? null;
      let heightCostPx = 0;
      if (streaming !== null) {
        const withCaret = streaming.getBoundingClientRect().height;
        streaming.classList.remove('p-streaming');
        heightCostPx = Math.round(withCaret - streaming.getBoundingClientRect().height);
        streaming.classList.add('p-streaming');
      }
      measured[row.getAttribute('data-stream-id') ?? ''] = {
        caretWidth: last === null ? 'none' : getComputedStyle(last, '::after').width,
        heightCostPx,
        thinkingRows: row.querySelectorAll('[aria-live="polite"]').length,
        shimmerLabels: row.querySelectorAll('.p-shimmer').length,
        // Tool styling can change; the semantic state is the contract.
        runningIndicators: row.querySelectorAll('[data-tool-state="running"]').length,
      };
    }
    return measured;
  });
}

async function run(): Promise<Observed> {
  return withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
    const stream = await browser.newPage();
    await stream.setViewport({ width: 1280, height: 1400 });
    await stream.goto(`${origin}/gallery.html?frame=streaming`, { waitUntil: 'networkidle0' });
    await stream.reload({ waitUntil: 'networkidle0' });
    await stream.waitForSelector('[data-gallery-stream] .p-streaming');
    await stream.waitForSelector('[data-stream-id="st-tool"] [data-tool-state="running"]', { timeout: 20_000 });
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

    const tools = await browser.newPage();
    await tools.setViewport({ width: 1280, height: 1600 });
    await tools.evaluateOnNewDocument(() => localStorage.setItem('kinu-mode', 'light'));
    await tools.goto(`${origin}/gallery.html?frame=toolrun`, { waitUntil: 'networkidle0' });
    await tools.reload({ waitUntil: 'networkidle0' });
    await tools.waitForSelector('[data-tool-group]');
    const collapsedActivity = await tools.$eval('[data-tool-group]', (group) => {
      const rows = [...group.querySelectorAll<HTMLElement>('[data-tool-state]')];
      const mutation = rows.find((row) => row.dataset.toolEffect === 'mutate');
      const compact = rows.find((row) => row.dataset.toolEffect === 'observe');
      return {
        total: Number(group.getAttribute('data-tool-count') ?? 0),
        collapsedRows: rows.length,
        mutationRows: rows.filter((row) => row.dataset.toolEffect === 'mutate').length,
        compactHeight: Math.round(compact?.getBoundingClientRect().height ?? 0),
        mutationHeight: Math.round(mutation?.getBoundingClientRect().height ?? 0),
        ground: getComputedStyle(group).backgroundColor,
        pageGround: getComputedStyle(document.body).backgroundColor,
      };
    });
    await tools.click('[data-tool-group-toggle]');
    await tools.waitForFunction(
      () => document.querySelector('[data-tool-group-toggle]')?.getAttribute('aria-expanded') === 'true',
    );
    const expandedRows = await tools.$$eval(
      '[data-tool-group] [data-tool-state]',
      (rows) => rows.length,
    );
    const toolActivity = { ...collapsedActivity, expandedRows };
    await tools.close();

    const files = await browser.newPage();
    await files.setViewport({ width: 1280, height: 1100 });
    await files.goto(`${origin}/gallery.html?frame=files`, { waitUntil: 'networkidle0' });
    // A first load can trip vite's dependency optimizer, which answers with a
    // full page reload and destroys the execution context of anything waiting.
    // The second load has the deps already, so every wait below is on a page
    // that will not vanish under it.
    await files.reload({ waitUntil: 'networkidle0' });

    const crumbs = () => files.$$eval(
      '[data-files-crumb]',
      (bs) => bs.map((b) => b.textContent ?? '').join('/'),
    );
    const rowNames = () => files.$$eval(
      '[data-files-entry]',
      (rows) => rows.map((r) => r.getAttribute('title') ?? ''),
    );
    const rowSelector = (name: string) => `[data-files-entry][title="${name}"]`;
    const waitForRow = (name: string) => files.waitForSelector(rowSelector(name), { timeout: 20_000 });
    const waitForRowGone = (name: string) => files.waitForFunction(
      (sel: string) => document.querySelector(sel) === null,
      { timeout: 20_000 }, rowSelector(name),
    );

    // The drive opens at the plane's root: the workspace tree beside the
    // mounted folders, each mount wearing its origin badge.
    await waitForRow('sandbox');
    const filesRoot = {
      crumbs: await crumbs(),
      entries: await rowNames(),
      badges: await files.$$eval('[data-files-entry] [data-mount-badge]', (els) => els.map((el) => el.textContent ?? '')),
    };

    // Crossing into a mount is ordinary navigation, and it lands INSIDE the
    // device's consented directory. Landing on the mount point itself was the
    // reported failure: `/pc` strips to the device's `/`, which its consent
    // boundary refuses, so the first click answered EACCES.
    await files.click(rowSelector('pc'));
    await waitForRow('quarterly-report.txt');
    await files.waitForFunction(
      () => document.querySelectorAll('[data-files-crumb]').length === 4,
      { timeout: 20_000 },
    );
    const filesInMount = { crumbs: await crumbs(), entries: await rowNames() };

    // Back to the drive root through the crumb bar, then into the workspace's
    // own tree for the parent row, preview, rename and delete.
    await files.click('[data-files-crumb]');
    await waitForRow('sandbox');
    await files.click(rowSelector('home'));
    await waitForRow('user');
    await files.click(rowSelector('user'));
    await waitForRow('notes.md');

    // The parent row goes UP ONE LEVEL — to /home, never straight to the root.
    await files.waitForSelector('[data-files-up-row]');
    await files.click('[data-files-up-row]');
    await waitForRow('user');
    const filesAfterUp = await crumbs();

    // The tree carries FILES, not only folders — it used to drop every file
    // entry when it recursed, so the sidebar could never reach one. Each level
    // is expanded through its own caret.
    await files.click(rowSelector('user'));
    await waitForRow('notes.md');
    await files.click('[data-files-tree-node="/home"] button');
    await files.waitForSelector('[data-files-tree-node="/home/user"]', { timeout: 20_000 });
    await files.click('[data-files-tree-node="/home/user"] button');
    await files.waitForSelector('[data-files-tree-file]', { timeout: 20_000 });
    const treeFileNames = await files.$$eval(
      '[data-files-tree-file]', (els) => els.map((el) => el.getAttribute('title') ?? ''),
    );

    // Markdown opens RENDERED through the app's one markdown renderer, and the
    // Source toggle shows the bytes it was rendered from.
    await files.click(rowSelector('notes.md'));
    await files.waitForSelector('[data-files-preview-body] h1', { timeout: 20_000 });
    const filesMarkdownRendered = await files.$eval('[data-files-preview-body]', (el) => ({
      heading: el.querySelector('h1')?.textContent ?? '',
      showsSource: el.querySelector('pre') !== null,
    }));
    await files.click('[data-files-render-toggle]');
    await files.waitForSelector('[data-files-preview-body] pre', { timeout: 20_000 });
    const filesPreviewText = await files.$eval('[data-files-preview-body] pre', (el) => el.textContent ?? '');

    // A whole file can be edited in place; a truncated read cannot, because
    // writing that prefix back would delete the rest of the file.
    await files.waitForSelector('[data-files-edit]', { timeout: 20_000 });
    await files.click('[data-files-edit]');
    await files.waitForSelector('[data-files-editor]', { timeout: 20_000 });
    const filesEditorSeedsFromTheFile = await files.$eval(
      '[data-files-editor]', (el) => el instanceof HTMLTextAreaElement ? el.value : '',
    );

    await files.click('[aria-label="Close preview"]');
    await files.waitForFunction(
      () => document.querySelector('[data-files-preview]') === null,
      { timeout: 20_000 },
    );

    // Rename rides the real RPC against the frame's stateful fixture.
    await files.hover(rowSelector('SOUL.md'));
    await files.click(`${rowSelector('SOUL.md')} [data-files-rename]`);
    await files.waitForSelector('[data-files-rename-input]');
    const renameInput = await files.$('[data-files-rename-input]');
    await renameInput!.evaluate((el) => { if (el instanceof HTMLInputElement) el.value = ''; });
    await renameInput!.type('CREDO.md');
    await renameInput!.press('Enter');
    await waitForRow('CREDO.md');
    const filesAfterRename = await rowNames();

    // Delete asks inline, then the row is gone.
    await files.hover(rowSelector('AGENTS.md'));
    await files.click(`${rowSelector('AGENTS.md')} [data-files-delete]`);
    await files.click(`${rowSelector('AGENTS.md')} [data-files-delete-confirm]`);
    await waitForRowGone('AGENTS.md');
    const filesAfterDelete = await rowNames();

    // The search box is a filter over the folder in view.
    await files.type('[data-files-filter]', 'credo');
    await waitForRowGone('notes.md');
    const filesFiltered = await rowNames();
    await files.close();

    // A disconnected device is a stated absence, not a missing row.
    const offline = await browser.newPage();
    await offline.setViewport({ width: 1280, height: 1100 });
    await offline.goto(`${origin}/gallery.html?frame=files&offline=laptop`, { waitUntil: 'networkidle0' });
    await offline.reload({ waitUntil: 'networkidle0' });
    await offline.waitForSelector('[data-files-offline-mount]', { timeout: 20_000 });
    const filesOfflineRow = await offline.$eval('[data-files-offline-mount]', (el) => el.textContent ?? '');
    await offline.close();

    // The Environment tab, reworked: user cards, no capability doctrine, and
    // a Files action that lands the drive.
    const env = await browser.newPage();
    await env.setViewport({ width: 1280, height: 1100 });
    await env.goto(`${origin}/gallery.html?frame=environment`, { waitUntil: 'networkidle0' });
    await env.reload({ waitUntil: 'networkidle0' });
    await env.waitForSelector('[data-env-card]', { timeout: 20_000 });
    const envCards = await env.$$eval('[data-env-card]', (cards) => cards.map((card) => ({
      name: card.querySelector('.font-medium')?.textContent ?? '',
      status: card.querySelector('[data-env-status]')?.textContent ?? '',
      durability: card.querySelector('[data-env-durability]')?.textContent ?? '',
    })));
    const envCapabilityChips = await env.$$eval('[data-capability-chip]', (els) => els.length);
    const envCapabilityAbsences = await env.$$eval('[data-capability-absences]', (els) => els.length);
    await env.click('[data-env-card="workspace"] [data-env-files]');
    // Tolerate exactly the timeout (the boolean under test); anything else is
    // a broken instrument, not a "did not land" — plan-review-ux.test.ts idiom.
    let envFilesJumpLandsOnDrive: boolean;
    try {
      await env.waitForSelector('[data-files-surface]', { timeout: 20_000 });
      envFilesJumpLandsOnDrive = true;
    } catch (cause) {
      if (!(cause instanceof TimeoutError)) throw cause;
      envFilesJumpLandsOnDrive = false;
    }
    await env.close();

    const explore = await browser.newPage();
    await explore.setViewport({ width: 1280, height: 1100 });
    await explore.goto(`${origin}/gallery.html?frame=forkrunning`, { waitUntil: 'networkidle0' });
    await explore.reload({ waitUntil: 'networkidle0' });
    await explore.waitForSelector(`[data-run-node="${RATE_LIMITED_NODE}"]`, { timeout: 20_000 });
    const runNodes = await readRunNodes(explore);
    await explore.close();

    return {
      tails, chat, forkInterruptedAfterClick, chatErrorHeadings, toolActivity,
      filesRoot, filesInMount, filesAfterUp, treeFileNames,
      filesMarkdownRendered, filesPreviewText, filesEditorSeedsFromTheFile,
      filesAfterRename, filesAfterDelete, filesFiltered, filesOfflineRow,
      envCards, envCapabilityChips, envCapabilityAbsences, envFilesJumpLandsOnDrive,
      runNodes,
    };
  });
}
/** Stable fixture identities from `STREAMING_MESSAGES` (gallery.tsx). */
const TEXT = 'st-text';
const AFTER_TOOLS = 'st-after-tools';
const TOOL_IN_FLIGHT = 'st-tool';
const REASONING = 'st-reasoning';
const CODE_FENCE = 'st-fence';
const NO_PARTS = 'st-empty';

let observed: Observed;
beforeAll(async () => { observed = await run(); }, 240_000);

describe('the streaming turn, as a browser lays it out', () => {
  test('it measures something — six live tails, not an empty denominator', () => {
    expect(Object.keys(observed.tails)).toHaveLength(6);
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

  test('a call in flight owns the running state — no second claim under it', () => {
    // One stream position reports one current activity.
    expect(observed.tails[TOOL_IN_FLIGHT]!.thinkingRows).toBe(0);
    expect(observed.tails[TOOL_IN_FLIGHT]!.runningIndicators).toBe(1);
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

describe('large tool runs, as the activity timeline draws them', () => {
  test('the default stays bounded and expansion restores every call', () => {
    const activity = observed.toolActivity;
    expect(activity.total).toBeGreaterThan(50);
    expect(activity.collapsedRows).toBeLessThanOrEqual(8);
    expect(activity.expandedRows).toBe(activity.total);
  });

  test('mutations remain more prominent than observations', () => {
    const activity = observed.toolActivity;
    expect(activity.mutationRows).toBeGreaterThanOrEqual(2);
    expect(activity.mutationHeight).toBeGreaterThan(activity.compactHeight);
  });

  test('light mode uses a recessed activity ground instead of white cards', () => {
    const activity = observed.toolActivity;
    expect(activity.ground).not.toBe(activity.pageGround);
    expect(activity.ground).not.toBe('rgb(255, 255, 255)');
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

describe('the drive, browsing the one composite plane', () => {
  test('the root is the workspace tree beside the mounts, badges on the mounted folders', () => {
    expect(observed.filesRoot.crumbs).toBe('/');
    expect(observed.filesRoot.entries).toEqual(expect.arrayContaining(['home', 'pc', 'sandbox']));
    // The origin badge names the machine, not the executor id — the laptop
    // wears the user's own device name, per the consent naming contract.
    expect(observed.filesRoot.badges).toEqual(expect.arrayContaining(["Ashish's MacBook", 'Sandbox']));
  });

  test('crossing into /pc lands inside the consented device directory', () => {
    // `/pc` strips to the DEVICE's `/`, which its consent boundary refuses, so
    // the first click used to answer EACCES. The mount point lands on the
    // directory the owner consented to instead.
    expect(observed.filesInMount.crumbs).toBe('//pc/home/dev');
    expect(observed.filesInMount.entries).toEqual(
      expect.arrayContaining(['quarterly-report.txt', 'shot.png']),
    );
  });

  test('the parent row goes UP ONE LEVEL, not straight to the root', () => {
    expect(observed.filesAfterUp).toBe('//home');
  });

  test('the tree carries files, not only folders', () => {
    expect(observed.treeFileNames).toEqual(expect.arrayContaining(['notes.md', 'AGENTS.md']));
  });

  test('Markdown opens rendered, and the Source toggle shows what it rendered', () => {
    expect(observed.filesMarkdownRendered.heading).toBe('Checkout coupon regression');
    expect(observed.filesMarkdownRendered.showsSource).toBe(false);
    expect(observed.filesPreviewText).toContain('Checkout coupon regression');
  });

  test('a whole file opens in an editor seeded from its own bytes', () => {
    expect(observed.filesEditorSeedsFromTheFile).toContain('Checkout coupon regression');
  });

  test('rename and delete land on the plane and the listing says so', () => {
    expect(observed.filesAfterRename).toContain('CREDO.md');
    expect(observed.filesAfterRename).not.toContain('SOUL.md');
    expect(observed.filesAfterDelete).not.toContain('AGENTS.md');
  });

  test('the search box filters the folder in view', () => {
    expect(observed.filesFiltered).toEqual(['CREDO.md']);
  });

  test('a disconnected device is a stated absence with its reason, not a missing row', () => {
    expect(observed.filesOfflineRow).toContain('pc');
    expect(observed.filesOfflineRow).toContain('no device connected');
  });
});

describe('the Environment tab, as a user reads it', () => {
  test('one card per environment: status, durability, and the device wears its own name', () => {
    const byName = Object.fromEntries(observed.envCards.map((card) => [card.name, card]));
    expect(byName["Ashish's MacBook"]?.status).toBe('active');
    expect(byName["Ashish's MacBook"]?.durability).toContain('Your machine');
    expect(byName['Workspace']?.durability).toContain('Durable');
    expect(byName['Sandbox']?.durability).toContain('Ephemeral');
  });

  test('capability doctrine is model-facing and renders NOWHERE in user UI', () => {
    // The chips block ("Sandbox can: Runs JavaScript … Not here: Runs Python")
    // was the agent's routing vocabulary leaked into the owner's surface. It
    // stays in the execution-status block the model reads, and only there.
    expect(observed.envCapabilityChips).toBe(0);
    expect(observed.envCapabilityAbsences).toBe(0);
  });

  test("a card's Files action lands the drive", () => {
    expect(observed.envFilesJumpLandsOnDrive).toBe(true);
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

  test('its dot agrees with its line, and no longer collides with a working node', () => {
    // Both halves matter. `warning` is the pacing tone — and while a RUNNING node
    // wore it too, the one signal that the provider asked us to wait rather than
    // that the node broke was invisible on the row. Working states wear the
    // accent, here as everywhere else in the product.
    expect(observed.runNodes[RATE_LIMITED_NODE]?.dot).toBe('p-dot-warning');
    expect(observed.runNodes[RUNNING_NODE]?.dot).toBe('p-dot-accent');
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
  test('the real shell shares identity, width, and one settings action', async () => {
    await withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1568, height: 1000 });
      await page.goto(`${origin}/gallery.html?frame=shell`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('aside');
      await page.waitForFunction(
        () => !(document.querySelector('aside')?.textContent ?? '').includes('loading...'),
        { timeout: 8000 },
      );
      const shell = await page.evaluate(() => ({
        footer: document.querySelector('aside')?.textContent ?? '',
        chatWidth: Math.round(document.querySelector('[data-gallery-chat] > *')?.getBoundingClientRect().width ?? 0),
        composerWidth: Math.round(document.querySelector('[data-composer-root] > .p-composer')?.getBoundingClientRect().width ?? 0),
        headerSettings: document.querySelectorAll('[aria-label="Workspace settings"]').length,
        rosterSettings: document.querySelectorAll('[aria-label^="Workspace settings for"]').length,
      }));
      await page.close();
      expect(shell.footer).not.toContain('Profile unavailable');
      expect(shell.footer).toContain('@');
      expect(shell.chatWidth).toBe(780);
      expect(shell.composerWidth).toBe(780);
      expect(shell.headerSettings).toBe(0);
      expect(shell.rosterSettings).toBeGreaterThan(0);
    });
  }, 120_000);

  test('mobile gives Chat and Workspace the full viewport in turn', async () => {
    await withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-composer-root]');
      const chatPanels = await page.evaluate(
        () => [...document.querySelectorAll('[data-panel]')].map((panel) => Math.round(panel.getBoundingClientRect().width)),
      );
      const workspaceButton = await page.$('button[aria-pressed="false"]');
      await workspaceButton?.click();
      await page.waitForFunction(
        () => [...document.querySelectorAll('[data-panel]')].some((panel, index) => (
          index === 1 && Math.round(panel.getBoundingClientRect().width) === 390
        )),
      );
      const workspacePanels = await page.evaluate(
        () => [...document.querySelectorAll('[data-panel]')].map((panel) => Math.round(panel.getBoundingClientRect().width)),
      );
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      await page.close();
      expect(chatPanels).toEqual([390, 0]);
      expect(workspacePanels).toEqual([0, 390]);
      expect(overflow).toBe(0);
    });
  }, 120_000);
});

/**
 * Agent conversations, as a browser drives them.
 *
 * `?frame=agentchats` mounts the real pieces — the tab strip's one-click
 * create, the rename editor, the composer's Auto/Plan segment, and the
 * per-conversation draft/mode/scroll store — over a scripted roster whose only
 * behaviours are the wire's: a zero-input create answers a blank name, and a
 * first message titles the roster row a beat later. `?frame=workspacepage`
 * then proves the REAL page wires the same flow: its own hook, its own
 * navigation, its own facet column.
 */
describe('an additional agent, as an ordinary conversation', () => {
  const MISSION = 'Audit the checkout flow end to end and fix what breaks';
  const SEED_ROLE = 'Fixture-role QA lead';

  interface RigDriver {
    page: Page;
    activeTab(): Promise<string>;
    clickTab(label: string): Promise<void>;
    draft(): Promise<string>;
    bodyText(): Promise<string>;
  }

  async function openRig(
    browser: Browser, origin: string, viewport: { width: number; height: number }, query = '',
  ): Promise<RigDriver> {
    const page = await browser.newPage();
    await page.setViewport(viewport);
    await page.goto(`${origin}/gallery.html?frame=agentchats${query}`, { waitUntil: 'networkidle0' });
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-agentchats] nav[aria-label="Workspace agents"]');
    return {
      page,
      activeTab: () => page.$eval(
        'nav[aria-label="Workspace agents"] [aria-current="page"]',
        (el) => (el.textContent ?? '').trim(),
      ),
      clickTab: async (label: string) => {
        for (const link of await page.$$('nav[aria-label="Workspace agents"] a')) {
          const text = await link.evaluate((el) => el.textContent ?? '');
          if (text.includes(label)) {
            await link.click();
            return;
          }
        }
        throw new Error(`no tab labelled ${label}`);
      },
      // Puppeteer types the handle from the selector's trailing tag, so the
      // value read needs no assertion.
      draft: () => page.$eval('[data-agent-pane] textarea', (el) => el.value),
      bodyText: () => page.evaluate(() => document.body.innerText),
    };
  }

  test('create is one click; the title, mode, draft, and scroll stay with their conversation', async () => {
    await withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
      const rig = await openRig(browser, origin, { width: 1280, height: 900 });
      const { page } = rig;

      // The inherited mission is internal, and the roster's role string is
      // machinery — neither may render, before or after any interaction.
      expect(await rig.bodyText()).not.toContain(MISSION);
      expect(await rig.bodyText()).not.toContain(SEED_ROLE);

      // One click. No dialog, no role field, no mission field — the click
      // lands directly in the new agent's conversation, titled provisionally.
      await page.click('[aria-label="New agent"]');
      await page.waitForFunction(() => (
        (document.querySelector('nav[aria-label="Workspace agents"] [aria-current="page"]')?.textContent ?? '').includes('New agent')
      ), { timeout: 10_000 });
      const afterCreate = await rig.bodyText();
      expect(afterCreate).not.toContain('Add a subordinate');
      expect(afterCreate).not.toContain('Role');
      expect(afterCreate).not.toContain('Mission');
      expect(afterCreate).not.toContain(MISSION);
      expect(await page.$eval('[data-agent-pane]', (el) => el.getAttribute('data-agent-pane')))
        .toBe('checkout-fixes/agents/agent-1');
      expect(afterCreate).toContain("This agent's conversation starts here.");

      // Plan is THIS conversation's mode.
      await page.evaluate(() => {
        for (const button of document.querySelectorAll('[data-agent-pane] [aria-label="Turn mode"] button')) {
          if (button instanceof HTMLButtonElement && button.textContent === 'Plan') button.click();
        }
      });
      await page.waitForFunction(() => (
        [...document.querySelectorAll('[data-agent-pane] [aria-label="Turn mode"] button')]
          .some((button) => button.textContent === 'Plan' && button.getAttribute('aria-pressed') === 'true')
      ));

      // First message: sent in Plan, attributed to THIS agent, and the
      // auto-title lands on the roster a beat later.
      await page.type('[data-agent-pane] textarea', 'Fix the coupon flow properly');
      await page.click('[aria-label="Send"]');
      await page.waitForFunction(() => (
        (document.querySelector('nav[aria-label="Workspace agents"] [aria-current="page"]')?.textContent ?? '')
          .includes('Fix the coupon flow properly')
      ), { timeout: 10_000 });
      const sentLogAfterFirst = await page.$eval(
        '[data-sent-log]',
        (el) => el.getAttribute('data-sent-log') ?? '[]',
      );
      const sentAfterFirst: unknown = JSON.parse(sentLogAfterFirst);
      expect(sentAfterFirst).toEqual([{ agent: 'agent-1', mode: 'plan', text: 'Fix the coupon flow properly' }]);

      // A draft typed here stays here; Main keeps its own draft and its own
      // Auto mode; coming back finds both the draft and Plan untouched.
      await page.type('[data-agent-pane] textarea', 'half a thought');
      await rig.clickTab('Main');
      await page.waitForSelector('[data-agent-pane="checkout-fixes/main"]');
      expect(await rig.draft()).toBe('');
      expect(await page.$$eval(
        '[data-agent-pane] [aria-label="Turn mode"] button',
        (buttons) => buttons.map((button) => `${button.textContent}:${button.getAttribute('aria-pressed')}`),
      )).toEqual(['Auto:true', 'Plan:false']);
      await page.type('[data-agent-pane] textarea', 'main draft');
      await rig.clickTab('Fix the coupon flow properly');
      await page.waitForSelector('[data-agent-pane="checkout-fixes/agents/agent-1"]');
      expect(await rig.draft()).toBe('half a thought');
      expect(await page.$$eval(
        '[data-agent-pane] [aria-label="Turn mode"] button',
        (buttons) => buttons.map((button) => `${button.textContent}:${button.getAttribute('aria-pressed')}`),
      )).toEqual(['Auto:false', 'Plan:true']);

      // Rename through the header — the same editor the workspace bar uses —
      // and the roster follows.
      await page.click('[title="Rename agent"]');
      await page.waitForSelector('[aria-label="Agent name"]');
      await page.type('[aria-label="Agent name"]', 'Coupon fixer');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => (
        (document.querySelector('nav[aria-label="Workspace agents"] [aria-current="page"]')?.textContent ?? '').includes('Coupon fixer')
      ), { timeout: 10_000 });

      // The reader's position belongs to the conversation: leave an existing
      // transcript at its top, visit another tab, come back to the same spot
      // (without the restore, an "up" scroller pins to the bottom on mount).
      await rig.clickTab('Checkout scout');
      await page.waitForSelector('[data-agent-pane="checkout-fixes/agents/scout"]');
      const geometry = await page.$eval('[data-agent-scroll]', (el) => ({
        scrollable: el.scrollHeight > el.clientHeight,
        atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 60,
      }));
      expect(geometry.scrollable).toBe(true);
      expect(geometry.atBottom).toBe(true);
      await page.$eval('[data-agent-scroll]', (el) => { el.scrollTop = 0; });
      // The passive scroll listener records the position on its own tick.
      await page.waitForFunction(() => (document.querySelector('[data-agent-scroll]')?.scrollTop ?? -1) === 0);
      await rig.clickTab('Main');
      await page.waitForSelector('[data-agent-pane="checkout-fixes/main"]');
      await rig.clickTab('Checkout scout');
      await page.waitForSelector('[data-agent-pane="checkout-fixes/agents/scout"]');
      const restored = await page.$eval('[data-agent-scroll]', (el) => ({
        scrollTop: el.scrollTop,
        scrollable: el.scrollHeight > el.clientHeight,
      }));
      expect(restored.scrollable).toBe(true);
      expect(restored.scrollTop).toBeLessThan(60);

      // Main's own draft survived the whole excursion.
      await rig.clickTab('Main');
      await page.waitForSelector('[data-agent-pane="checkout-fixes/main"]');
      expect(await rig.draft()).toBe('main draft');

      // After every interaction the machinery stayed internal.
      expect(await rig.bodyText()).not.toContain(MISSION);
      expect(await rig.bodyText()).not.toContain(SEED_ROLE);
      await page.close();
    });
  }, 240_000);

  test('mobile: one-click create and per-conversation drafts at 375px, with no overflow', async () => {
    await withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
      const rig = await openRig(browser, origin, { width: 375, height: 812 });
      const { page } = rig;
      await page.click('[aria-label="New agent"]');
      await page.waitForSelector('[data-agent-pane="checkout-fixes/agents/agent-1"]');
      expect(await rig.activeTab()).toContain('New agent');
      expect(await rig.bodyText()).not.toContain('Add a subordinate');
      expect(await rig.bodyText()).not.toContain(MISSION);

      await page.type('[data-agent-pane] textarea', 'thumb-typed draft');
      await rig.clickTab('Main');
      await page.waitForSelector('[data-agent-pane="checkout-fixes/main"]');
      expect(await rig.draft()).toBe('');
      await rig.clickTab('New agent');
      await page.waitForSelector('[data-agent-pane="checkout-fixes/agents/agent-1"]');
      expect(await rig.draft()).toBe('thumb-typed draft');

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(overflow).toBe(0);
      await page.close();
    });
  }, 240_000);

  /** The chain `?createFails=1` makes the first create reject with. Spelled
   *  here as well so a chain the gallery stopped chaining fails the equality
   *  instead of passing a weaker containment. */
  const CREATE_REFUSAL_CHAIN = 'the workspace refused the new agent: subordinate quota exhausted';

  test('a create the workspace refuses is recorded once, classified, and the strip keeps working', async () => {
    // The strip owns its own click: `onCreate` may reject, and the void on it
    // must not become an unhandled rejection with no context. The parent's
    // banner is WorkspacePage's; the bare rig has no parent, so the record is
    // the whole observable outcome here.
    await withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
      const rig = await openRig(browser, origin, { width: 1280, height: 900 }, '&createFails=1');
      const { page } = rig;
      const diagnostics = recordDiagnostics(page);
      const unhandled: string[] = [];
      page.on('pageerror', (error) => { unhandled.push(String(error)); });

      await page.click('[aria-label="New agent"]');
      await diagnosticsSettled(diagnostics, 1);
      expect(diagnostics).toEqual([{
        event: 'subordinates.create_failed', code: 'io',
        cause: `create a subordinate agent: ${CREATE_REFUSAL_CHAIN}`, fields: {},
      }]);
      // The refused click navigated nowhere.
      expect(await rig.activeTab()).toContain('Main');

      // The affordance is intact: the next click creates and opens the agent.
      await page.click('[aria-label="New agent"]');
      await page.waitForFunction(() => (
        (document.querySelector('nav[aria-label="Workspace agents"] [aria-current="page"]')?.textContent ?? '').includes('New agent')
      ), { timeout: 10_000 });
      // Exactly one record for exactly one failure — the create that landed
      // added nothing, and nothing was ever unhandled.
      expect(diagnostics).toHaveLength(1);
      expect(unhandled).toEqual([]);
      await page.close();
    });
  }, 240_000);

  test('the real WorkspacePage shows a refused create and the next click still lands', async () => {
    await withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      const diagnostics = recordDiagnostics(page);
      await page.goto(`${origin}/gallery.html?frame=workspacepage&createFails=1`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('nav[aria-label="Workspace agents"]');

      // The page's own catch turns the refusal into its banner, whole chain
      // shown, with a way out.
      await page.click('[aria-label="New agent"]');
      await page.waitForSelector('[role="alert"]', { timeout: 15_000 });
      const banner = await page.$eval('[role="alert"]', (node) => node.textContent ?? '');
      expect(banner).toContain("Couldn't create an agent");
      expect(banner).toContain(CREATE_REFUSAL_CHAIN);
      // The + button is not stuck in `creating`.
      expect(await page.$eval('[aria-label="New agent"]', (node) => node.hasAttribute('disabled'))).toBe(false);

      // The parent absorbed the rejection, so the strip's own net — the
      // record for a parent that LEAKS — stays silent: one owner per failure.
      expect(diagnostics.filter((line) => line.event === 'subordinates.create_failed')).toEqual([]);

      // Retry lands: the banner clears and the new conversation opens.
      await page.click('[aria-label="New agent"]');
      await page.waitForFunction(() => (
        (document.querySelector('nav[aria-label="Workspace agents"] [aria-current="page"]')?.textContent ?? '').includes('New agent')
      ), { timeout: 15_000 });
      expect(await page.evaluate(() => document.body.innerText)).not.toContain("Couldn't create an agent");
      await page.close();
    });
  }, 240_000);

  test('the real WorkspacePage creates, opens, and renames an agent through its own wiring', async () => {
    await withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('nav[aria-label="Workspace agents"]');

      // One click on the page's own strip: the hook's zero-argument RPC, the
      // navigate, the facet column — all the page's real wiring.
      await page.click('[aria-label="New agent"]');
      await page.waitForFunction(() => (
        (document.querySelector('nav[aria-label="Workspace agents"] [aria-current="page"]')?.textContent ?? '').includes('New agent')
      ), { timeout: 15_000 });
      const body = await page.evaluate(() => document.body.innerText);
      expect(body).not.toContain('Add a subordinate');
      expect(body).not.toContain('Mission');

      // The facet conversation carries the full composer contract — the same
      // Auto/Plan segment the main column has.
      await page.waitForSelector('[aria-label="Turn mode"]', { timeout: 15_000 });
      await page.waitForSelector('[title="Rename agent"]', { timeout: 15_000 });

      // Rename lands on the parent roster the tabs read.
      await page.click('[title="Rename agent"]');
      await page.waitForSelector('[aria-label="Agent name"]');
      await page.type('[aria-label="Agent name"]', 'Payments triage');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => (
        (document.querySelector('nav[aria-label="Workspace agents"] [aria-current="page"]')?.textContent ?? '').includes('Payments triage')
      ), { timeout: 15_000 });
      await page.close();
    });
  }, 240_000);
});

/**
 * KINU-071. The fixture mounts the exact ConversationStartBoundary used by both
 * WorkspacePage columns over the real paged-scroll hook. Its first page is held
 * by a fixture promise, then rejects once; Retry returns status:end. This is a
 * browser test because the defect was which mutually-exclusive surface painted
 * during that interleaving. Blind spot: the agent socket is not involved; its
 * delivered-empty distinction is the startFrom("newest") input stated here.
 */
describe('an empty transcript waits for the history store to speak', () => {
  test('held → skeleton; failed → Retry; status:end → authoritative empty', async () => {
    await withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 560, height: 800 });
      await page.goto(`${origin}/gallery.html?frame=historyauthority`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid="conversation-skeleton"]');
      expect((await page.content()).includes('Send the first message to start.')).toBe(false);

      await page.click('[data-history-release]');
      try {
        await page.waitForSelector('aria/Retry');
      } catch (cause) {
        const state = await page.$eval('[data-history-authority]', (root) => root.textContent ?? '');
        throw new Error(`History authority never exposed Retry: ${state}`, { cause });
      }
      expect(await page.$eval('[data-history-authority]', (root) => root.textContent ?? ''))
        .toContain('Could not load earlier messages.');
      expect((await page.content()).includes('Send the first message to start.')).toBe(false);

      await page.click('aria/Retry');
      await page.waitForFunction(
        () => document.querySelector('[data-history-authority]')?.textContent?.includes('Send the first message to start.') === true,
        { timeout: 10_000 },
      );
      const final = await page.$eval('[data-history-probe]', (probe) => probe.textContent ?? '');
      expect(final).toContain('"exhausted":true');
      expect(await page.$('[data-testid="conversation-skeleton"]')).toBeNull();
      await page.close();
    });
  }, 240_000);
});

/**
 * KINU-046. This mounts the real WorkspacePage, Composer, useKinu and send
 * latch. The gallery stub holds only the TRANSPORT promise and exposes how many
 * times it was entered; the two clicks occur in ONE browser task, before React
 * can render submitted/streaming state. A policy copy could only prove itself.
 */
describe('chat send admission at the actual WorkspacePage boundary', () => {
  test('two same-task Send clicks enter the transport once', async () => {
    await withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      const textarea = await page.waitForSelector('[data-composer-root] textarea');
      await textarea!.type('admit exactly one turn');
      await page.evaluate(() => {
        document.documentElement.dataset.galleryChatSends = '0';
        document.documentElement.dataset.galleryChatHold = '1';
        const send = document.querySelector<HTMLButtonElement>('[aria-label="Send"]');
        if (send === null) throw new Error('gallery WorkspacePage has no Send button');
        // Same JavaScript task, which is the old failure window.
        send.click();
        send.click();
      });
      await page.waitForFunction(
        () => document.documentElement.dataset.galleryChatSends === '1',
        { timeout: 10_000 },
      );
      expect(await page.evaluate(() => document.documentElement.dataset.galleryChatSends)).toBe('1');
      await page.close();
    });
  }, 240_000);
});

/**
 * KINU-074. The gallery transport supplies only SDK-shaped terminal inputs:
 * connectionError plus a matching 1008 CloseEvent, with snapshot deliberately
 * held so the real WorkspacePage has no agentStatus. Real useKinu and
 * WorkspacePage must render the terminal path instead of reconnecting.
 */
describe('terminal workspace denial at the actual WorkspacePage boundary', () => {
  test('1008 names denial, preserves SDK reason, and never promises reconnect', async () => {
    await withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
      const page = await browser.newPage();
      await page.goto(`${origin}/gallery.html?frame=workspacepage&terminal=denied`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(
        () => document.body.textContent?.includes('Access to this workspace was denied') === true,
        { timeout: 10_000 },
      );
      const text = await page.evaluate(() => document.body.innerText);
      expect(text).toContain('Access to this workspace was denied');
      expect(text).toContain('workspace access denied by fixture');
      expect(text).toContain('Try again');
      expect(text).toContain('Back to your workspaces');
      expect(text).not.toContain('Reconnecting...');
      await page.close();
    });
  }, 240_000);
});

/**
 * KINU-060. The real FilesSurface opens a preview whose FIRST RPC is held by
 * the fixture transport. A fixture mutation changes the listing's revision;
 * actual Refresh causes FileViewer/useAsyncResource to start its new request,
 * then the old request resolves. The current preview must stay current.
 */
describe('file preview request generation at the actual FilesSurface boundary', () => {
  test('a stale preview response cannot reclaim a refreshed file', async () => {
    await withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 1000 });
      await page.goto(`${origin}/gallery.html?frame=files&wide=1&deferpreview=1`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      const row = (name: string) => `[data-files-entry][title="${name}"]`;
      await page.waitForSelector(row('home'));
      await page.click(row('home'));
      await page.waitForSelector(row('user'));
      await page.click(row('user'));
      await page.waitForSelector(row('notes.md'));
      await page.click(row('notes.md'));
      await page.waitForSelector('[data-files-preview-body] [class*="Loader"], [data-files-preview-body]');
      await page.click('[data-files-fixture-mutate]');
      await page.click('[aria-label="Refresh"]');
      await page.waitForFunction(
        () => document.querySelector('[data-files-preview-body]')?.textContent?.includes('Fresh after refresh') === true,
        { timeout: 10_000 },
      );
      await page.click('[data-files-fixture-release]');
      // The held first reply was old checkout content. Once it settles it must
      // not overwrite the fresh resource identity selected by the listing.
      const preview = await page.$eval('[data-files-preview-body]', (body) => body.textContent ?? '');
      expect(preview).toContain('Fresh after refresh');
      expect(preview).not.toContain('Checkout coupon regression');
      await page.close();
    });
  }, 240_000);
});

/**
 * KINU-060, remaining two authorities. The frames mount the shipped
 * usePagedScroll and WorkspaceRosterProvider; controls only hold/release their
 * network transport. Clear/reset and local rename are public transitions, not
 * fixture copies of the generations they exercise.
 */
describe('history and roster request generations at actual hook boundaries', () => {
  test('a held history page released after Clear cannot reseed the walk', async () => {
    await withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
      const page = await browser.newPage();
      await page.goto(`${origin}/gallery.html?frame=historyauthority`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid="conversation-skeleton"]');
      await page.click('[data-history-reset]');
      await page.click('[data-history-release]');
      await page.waitForFunction(() => {
        const raw = document.querySelector('[data-history-probe]')?.textContent ?? '';
        return raw.includes('"loading":false') && raw.includes('"error":null') && raw.includes('"exhausted":false');
      }, { timeout: 10_000 });
      expect(await page.$('[data-testid="conversation-skeleton"]')).not.toBeNull();
      expect(await page.$('aria/Retry')).toBeNull();
      await page.close();
    });
  }, 240_000);

  test('a held roster list released after local rename cannot undo the rename', async () => {
    await withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
      const page = await browser.newPage();
      await page.goto(`${origin}/gallery.html?frame=rosterauthority`, { waitUntil: 'networkidle0' });
      await page.click('[data-roster-local-rename]');
      await page.waitForFunction(
        () => document.querySelector('[data-roster-probe]')?.textContent === 'checkout-fixes:Renamed locally',
        { timeout: 10_000 },
      );
      await page.click('[data-roster-release]');
      // The old server row spells "Checkout coupon bug". Once released it must
      // remain stale and cannot reclaim the public local transition.
      await page.waitForFunction(
        () => document.querySelector('[data-roster-probe]')?.textContent === 'checkout-fixes:Renamed locally',
        { timeout: 10_000 },
      );
      await page.close();
    });
  }, 240_000);
});

/**
 * KINU-073. User settings mounts the shipped page and its eight real
 * useAsyncResource branches. Codex fails until the browser heals the fixture;
 * gateways remain unresolved until a separate release. QualityView uses the
 * same held/failing split through its Rpc prop. The assertions run while work
 * is held, not only after final settlement. Blind spot: the sourced 30-second
 * deadline is not slept through here; the explicit failure proves its visible
 * terminal state and the held requests prove siblings do not wait for it.
 *
 * The page is sectioned now, so the walk crosses one: the profile is read on
 * Account and the three connection cards on Providers. That crossing is the
 * second thing this proves — the reads belong to the PAGE, so a section switch
 * neither re-reads a settled card nor releases a held one.
 */
describe('independent settings and quality reads publish independently', () => {
  test('one account card fails and retries while ready and held siblings remain visible', async () => {
    await withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1000, height: 1200 });
      await page.goto(`${origin}/gallery.html?frame=usersettingsstate`, { waitUntil: 'networkidle0' });

      // No hash: the first section, and the rail says so.
      expect(await page.$eval(
        '[data-settings-section="account"]',
        (entry) => entry.getAttribute('aria-current'),
      )).toBe('true');
      expect(await page.$eval(
        '[data-settings-resource="your profile"]',
        (resource) => resource.getAttribute('data-resource-state'),
      )).toBe('ready');
      expect(await page.$eval('body', (body) => body.textContent ?? '')).toContain('owner@example.com');
      // Scoped: the connection cards are not on this section at all.
      expect(await page.$('[data-settings-resource="your ChatGPT connection"]')).toBeNull();

      await page.click('[data-settings-section="providers"]');
      await page.waitForSelector('[data-settings-resource="your ChatGPT connection"][data-resource-state="error"]');
      expect(await page.$eval(
        '[data-settings-section="providers"]',
        (entry) => entry.getAttribute('aria-current'),
      )).toBe('true');
      expect(await page.$eval(
        '[data-settings-resource="your AI gateways"]',
        (resource) => resource.getAttribute('data-resource-state'),
      )).toBe('loading');

      await page.evaluate(() => window.dispatchEvent(new Event('gallery:settings-heal')));
      await page.click('[data-settings-resource="your ChatGPT connection"] button');
      await page.waitForSelector(
        '[data-settings-resource="your ChatGPT connection"][data-resource-state="ready"]',
        { timeout: 10_000 },
      );
      expect(await page.$eval(
        '[data-settings-resource="your AI gateways"]',
        (resource) => resource.getAttribute('data-resource-state'),
      )).toBe('loading');

      await page.evaluate(() => window.dispatchEvent(new Event('gallery:settings-release')));
      await page.waitForSelector(
        '[data-settings-resource="your AI gateways"][data-resource-state="ready"]',
        { timeout: 10_000 },
      );

      // Back on Account, the profile is still ready: the section switch was a
      // render, not a reload.
      await page.click('[data-settings-section="account"]');
      await page.waitForSelector('[data-settings-resource="your profile"][data-resource-state="ready"]');
      await page.close();
    });
  }, 240_000);

  test('a failed replay branch retries while alignment remains held, then both render', async () => {
    await withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 900, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=qualitybranches`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-quality-branch="replay"] button');
      expect(await page.$('[data-quality-branch="alignment"] [role="status"]')).not.toBeNull();

      await page.evaluate(() => window.dispatchEvent(new Event('gallery:quality-heal')));
      await page.click('[data-quality-branch="replay"] button');
      await page.waitForFunction(
        () => document.querySelector('[data-quality-branch="replay"]')?.textContent?.includes('Latest score') === true,
        { timeout: 10_000 },
      );
      expect(await page.$('[data-quality-branch="alignment"] [role="status"]')).not.toBeNull();

      await page.evaluate(() => window.dispatchEvent(new Event('gallery:quality-release')));
      await page.waitForFunction(
        () => document.querySelector('[data-quality-branch="alignment"]')?.textContent?.includes('K_align') === true,
        { timeout: 10_000 },
      );
      await page.close();
    });
  }, 240_000);
});

/**
 * N021. This drives the real DevicesCard revoke response, durable-list refresh
 * and acknowledgement endpoint. Reload is the non-vacuity arm: the immediate
 * count is process-local, while the warning itself must return from listDevices
 * until the explicit DELETE succeeds.
 *
 * `&section=devices` is the deep link every work surface has always carried,
 * `/user/settings#devices`, and the reload arm re-enters through it — so this
 * also proves the deep link keeps working now that the hash picks a section
 * rather than scrolling to one.
 */
describe('a revoked device whose command may still run', () => {
  test('shows the count immediately, survives reload without reconnect controls, and disappears only after acknowledgement', async () => {
    await withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1000, height: 1200 });
      await page.goto(`${origin}/gallery.html?frame=usersettingsstate&section=devices`, { waitUntil: 'networkidle0' });
      expect(await page.$eval(
        '[data-settings-section="devices"]',
        (entry) => entry.getAttribute('aria-current'),
      )).toBe('true');
      await page.waitForSelector('[title="Revoke device"]');
      let dialogAccepted: Promise<void> | undefined;
      page.once('dialog', (dialog) => {
        dialogAccepted = dialog.accept();
      });
      await page.click('[title="Revoke device"]');
      await page.waitForSelector('[data-device-incident="dev-1"]', { timeout: 10_000 });
      await dialogAccepted;

      const immediate = await page.$eval('[data-device-incident="dev-1"]', (row) => row.textContent ?? '');
      expect(immediate).toContain('A command could not be confirmed stopped when you revoked this device.');
      expect(immediate).toContain('2 commands have no confirmed termination and may still run.');
      expect(await page.$('[data-device-incident="dev-1"] [title="Rename this device"]')).toBeNull();
      expect(await page.$('[data-device-incident="dev-1"] [title="Revoke device"]')).toBeNull();

      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-device-incident="dev-1"]', { timeout: 10_000 });
      const persisted = await page.$eval('[data-device-incident="dev-1"]', (row) => row.textContent ?? '');
      expect(persisted).toContain('A command could not be confirmed stopped when you revoked this device.');
      expect(persisted).toContain('Commands may still run.');

      await page.click('[data-device-incident="dev-1"] button');
      await page.waitForFunction(
        () => document.querySelector('[data-device-incident="dev-1"]') === null,
        { timeout: 10_000 },
      );
      await page.close();
    });
  }, 240_000);
});

/**
 * Connecting a machine from the surface that asked for it.
 *
 * The report: "when I want to connect my desktop from my Workspace → Env →
 * connect, it takes me to the settings page instead of a modal or something."
 * Both affordances were `<Link to="/user/settings#devices">`, and a link is
 * invisible to every source-reading test in this repo — the component compiled,
 * type-checked and navigated away.
 *
 * So the assertion is where the panel LANDS: the workspace surface is still
 * behind it, the dialog is over it, and the surface is still there when the
 * dialog closes itself. The command is read back off the page and compared to
 * the string the server fixture handed over, because a client that rebuilt it
 * from `location.origin` would render something that looks right.
 */
describe('linking a machine happens on the surface that asked for it', () => {
  test('the Environment card opens the panel in place, and the arriving machine closes it', async () => {
    await withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1100, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=environment&offline=laptop&connect=1`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-env-card="laptop"] [data-env-connect]');

      await page.click('[data-env-card="laptop"] [data-env-connect]');
      await page.waitForSelector('[role="dialog"] [data-connect-state="ready"]');
      // In place: the Environment surface is still mounted behind the dialog,
      // and the URL never moved.
      expect(await page.$('[data-env-card="workspace"]')).not.toBeNull();
      expect(new URL(page.url()).pathname).toBe('/gallery.html');
      // The disclosure is on screen BEFORE anything is installed.
      expect(await page.$eval('[role="dialog"]', (d) => d.textContent ?? ''))
        .toContain('The daemon dials out over one WebSocket; it opens no inbound ports.');

      await page.click('[role="dialog"] [data-connect-start]');
      await page.waitForSelector('[data-connect-command]');
      expect(await page.$eval('[data-connect-command]', (code) => code.textContent ?? '')).toBe(
        "curl -fsSL 'https://kinu.run/install.sh' | KINU_PARENT_ACTIVATES=1 bash -s -- --no-setup --connect"
        + ' && export PATH="${KINU_HOME:-$HOME/.kinu}/bin:$PATH"',
      );
      expect(await page.$('[data-connect-waiting]')).not.toBeNull();

      // The roster poll finds the machine and the panel closes itself, leaving
      // the surface the owner was working on.
      await page.waitForFunction(
        () => document.querySelector('[role="dialog"]') === null,
        { timeout: 30_000 },
      );
      expect(await page.$('[data-env-card="workspace"]')).not.toBeNull();
      // One registration got us here. The fixture counts its own POSTs, so a
      // second one — a double click, a re-render, an effect that re-fired —
      // shows up as a number rather than as a device row nobody notices.
      expect(await page.evaluate(
        () => document.documentElement.dataset.galleryRegistrations,
      )).toBe('1');
      await page.close();
    });
  }, 240_000);

  test('a machine that never dials in leaves the panel open and waiting', async () => {
    // The non-vacuity arm for the close above: same flow, same clicks, and a
    // roster whose row stays `connected: false`. A panel that closed on any
    // roster tick would pass the first test and fail this one.
    await withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1100, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=environment&offline=laptop&connect=stall`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-env-card="laptop"] [data-env-connect]');
      await page.click('[data-env-card="laptop"] [data-env-connect]');
      await page.waitForSelector('[role="dialog"] [data-connect-start]');
      await page.click('[role="dialog"] [data-connect-start]');
      await page.waitForSelector('[data-connect-waiting]');

      // Wait for polls to have HAPPENED rather than for a clock: three roster
      // reads after the registration is three chances to close wrongly.
      const readsAtHandover = await page.evaluate(
        () => Number(document.documentElement.dataset.galleryRosterReads ?? '0'),
      );
      await page.waitForFunction(
        (base: number) => Number(document.documentElement.dataset.galleryRosterReads ?? '0') >= base + 3,
        { timeout: 60_000 },
        readsAtHandover,
      );
      expect(await page.$('[role="dialog"] [data-connect-waiting]')).not.toBeNull();
      expect(await page.$('[data-connect-command]')).not.toBeNull();
      await page.close();
    });
  }, 240_000);

  test('the drive opens the same panel from its offline row', async () => {
    await withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1100, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=files&offline=laptop&connect=1`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-files-connect]');
      await page.click('[data-files-connect]');
      await page.waitForSelector('[role="dialog"] [data-connect-state="ready"]');
      // Still the drive underneath: the row it was opened from is right there.
      expect(await page.$('[data-files-offline-mount]')).not.toBeNull();
      await page.close();
    });
  }, 240_000);
});

interface ContinuityProbe {
  readonly draft: string;
  readonly sends: number;
  readonly files: string;
  readonly tokenLength: number;
}

async function continuityProbe(page: Page): Promise<ContinuityProbe> {
  return page.$eval('[data-continuity-probe]', (probe) => ({
    draft: probe.getAttribute('data-draft') ?? '',
    sends: Number(probe.getAttribute('data-sends') ?? 0),
    files: probe.getAttribute('data-files') ?? '',
    tokenLength: Number(probe.getAttribute('data-token-length') ?? 0),
  }));
}

/**
 * KINU-075/077/078/079. One shipped-component rig takes real browser keyboard,
 * clipboard, layout and resource-load events. The clipboard's text+file case
 * asserts non-prevention because synthetic ClipboardEvent does not execute the
 * browser's native default insertion; HTML-only takes the component's manual
 * insertion path and proves visible text. That boundary is the one blind spot.
 */
describe('composer and message continuity at browser boundaries', () => {
  test('IME commit Enter and keyCode 229 never submit; the next Enter does; Shift+Enter remains a newline', async () => {
    await withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 760, height: 1000 });
      await page.goto(`${origin}/gallery.html?frame=clientcontinuity`, { waitUntil: 'networkidle0' });
      const textarea = await page.waitForSelector('[data-composer-root] textarea');
      await textarea!.focus();

      await textarea!.evaluate((input) => {
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '変換' }));
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', bubbles: true, cancelable: true, isComposing: true,
        }));
      });
      expect((await continuityProbe(page)).sends).toBe(0);

      await textarea!.evaluate((input) => {
        input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '変換' }));
        const legacy = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        Object.defineProperty(legacy, 'keyCode', { value: 229 });
        input.dispatchEvent(legacy);
      });
      expect((await continuityProbe(page)).sends).toBe(0);

      await page.keyboard.press('Enter');
      await page.waitForFunction(
        () => document.querySelector('[data-continuity-probe]')?.getAttribute('data-sends') === '1',
      );

      await page.click('[data-continuity-reset]');
      await textarea!.focus();
      await page.keyboard.type('two lines');
      await page.waitForFunction(
        () => document.querySelector('[data-continuity-probe]')?.getAttribute('data-draft') === 'two lines',
        { timeout: 5_000 },
      );
      await page.keyboard.down('Shift');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Shift');
      await page.waitForFunction(
        () => document.querySelector('[data-continuity-probe]')?.getAttribute('data-draft')?.includes('\n') === true,
        { timeout: 5_000 },
      );
      expect((await continuityProbe(page)).sends).toBe(0);
      await page.close();
    });
  }, 240_000);

  test('mixed clipboard strings survive beside deduplicated files; file-only is prevented', async () => {
    await withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 760, height: 1000 });
      await page.goto(`${origin}/gallery.html?frame=clientcontinuity`, { waitUntil: 'networkidle0' });
      const textarea = await page.waitForSelector('[data-composer-root] textarea');

      const paste = (kind: 'plain' | 'html' | 'file' | 'same-metadata') => textarea!.evaluate((input, flavor) => {
        const data = new DataTransfer();
        const file = new File(['abc'], 'notes.txt', {
          type: 'text/plain', lastModified: 7,
        });
        data.items.add(file);
        // Repeating the SAME object is the clipboard duplication the component
        // removes. Two separate File objects with the same metadata are not
        // identity-equal and must both survive.
        if (flavor === 'same-metadata') {
          data.items.add(new File(['xyz'], 'notes.txt', {
            type: 'text/plain', lastModified: 7,
          }));
        } else {
          data.items.add(file);
        }
        if (flavor === 'plain') data.items.add('notes.txt', 'text/plain');
        if (flavor === 'html') data.items.add('<strong>Rich note</strong>', 'text/html');
        input.focus();
        const event = new ClipboardEvent('paste', {
          clipboardData: data, bubbles: true, cancelable: true,
        });
        input.dispatchEvent(event);
        return {
          defaultPrevented: event.defaultPrevented,
          plain: data.getData('text/plain'),
          html: data.getData('text/html'),
        };
      }, kind);

      await page.click('[data-continuity-reset]');
      const plain = await paste('plain');
      await page.waitForFunction(
        () => document.querySelector('[data-continuity-probe]')?.getAttribute('data-files') === 'notes.txt:3',
      );
      expect(plain).toEqual({ defaultPrevented: false, plain: 'notes.txt', html: '' });

      await page.click('[data-continuity-reset]');
      const html = await paste('html');
      await page.waitForFunction(
        () => document.querySelector('[data-continuity-probe]')?.getAttribute('data-draft')?.includes('Rich note') === true,
      );
      expect(html.defaultPrevented).toBe(true);
      expect(html.html).toContain('Rich note');
      expect((await continuityProbe(page)).files).toBe('notes.txt:3');

      await page.click('[data-continuity-reset]');
      const fileOnly = await paste('file');
      await page.waitForFunction(
        () => document.querySelector('[data-continuity-probe]')?.getAttribute('data-files') === 'notes.txt:3',
      );
      expect(fileOnly).toEqual({ defaultPrevented: true, plain: '', html: '' });
      expect((await continuityProbe(page)).draft).toBe('');

      await page.click('[data-continuity-reset]');
      const sameMetadata = await paste('same-metadata');
      await page.waitForFunction(
        () => document.querySelector('[data-continuity-probe]')?.getAttribute('data-files') === 'notes.txt:3|notes.txt:3',
      );
      expect(sameMetadata.defaultPrevented).toBe(true);
      expect((await continuityProbe(page)).files).toBe('notes.txt:3|notes.txt:3');
      await page.close();
    });
  }, 240_000);

  test('long user and steer tokens stay inside bubbles at desktop and mobile widths', async () => {
    await withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
      const page = await browser.newPage();
      await page.goto(`${origin}/gallery.html?frame=clientcontinuity`, { waitUntil: 'networkidle0' });
      for (const viewport of [{ width: 1280, height: 1000 }, { width: 360, height: 800 }]) {
        await page.setViewport(viewport);
        const measured = await page.evaluate(() => {
          const read = (selector: string) => {
            const bubble = document.querySelector<HTMLElement>(`${selector} .p-user-bubble`);
            return {
              clientWidth: bubble?.clientWidth ?? 0,
              scrollWidth: bubble?.scrollWidth ?? 0,
            };
          };
          return {
            user: read('[data-wrap-user]'),
            steer: read('[data-wrap-steer]'),
            tokenLength: Number(document.querySelector('[data-continuity-probe]')?.getAttribute('data-token-length') ?? 0),
          };
        });
        expect(measured.tokenLength).toBeGreaterThan(500);
        expect(measured.user.clientWidth).toBeGreaterThan(0);
        expect(measured.user.scrollWidth).toBeLessThanOrEqual(measured.user.clientWidth);
        expect(measured.steer.clientWidth).toBeGreaterThan(0);
        expect(measured.steer.scrollWidth).toBeLessThanOrEqual(measured.steer.clientWidth);
      }
      await page.close();
    });
  }, 240_000);

  test('a failed Markdown image becomes a diagnostic with its raw link; a loaded image remains an image', async () => {
    await withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 760, height: 1000 });
      await page.goto(`${origin}/gallery.html?frame=clientcontinuity`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-image-failure] [data-markdown-image-error]');
      await page.waitForFunction(() => {
        const image = document.querySelector<HTMLImageElement>('[data-image-success] [data-markdown-image]');
        return image?.complete === true && image.naturalWidth > 0;
      });

      const failed = await page.$eval('[data-image-failure] [data-markdown-image-error]', (note) => ({
        role: note.getAttribute('role'),
        text: note.textContent ?? '',
        href: note.querySelector('a')?.getAttribute('href') ?? '',
      }));
      expect(failed.role).toBe('note');
      expect(failed.text).toContain('Image failed to load: Checkout diagram');
      expect(failed.href).toBe('/assets/missing-continuity-image.png');
      expect(await page.$('[data-image-failure] img')).toBeNull();
      expect(await page.$('[data-image-success] [data-markdown-image-error]')).toBeNull();
      await page.close();
    });
  }, 240_000);
});

/**
 * KINU-011. The generic tool preview renders a credential.
 *
 * WHY A BROWSER. The preview lives behind `ToolCallBlock`'s `expanded` state,
 * which is local component state with no prop and no exported seam. There is no
 * DOM implementation in this repository and adding one to render a component
 * that ships to a real browser would measure the wrong thing. So the oracle is
 * the rendered text after the click an operator makes.
 *
 * THE ORACLE, AND WHY IT NEEDS NO COPY OF THE FIXTURE. `redactPayload` is
 * idempotent: applying it to already-redacted JSON changes nothing. So the
 * rendered preview must be a FIXED POINT of the canonical policy. If the
 * component grew its own weaker secret list, some credential-shaped field would
 * survive rendering, the canonical policy would still mask it, and the fixed
 * point would break. That is the "one list, two consumers" claim in
 * `core/src/events/hub/visibility.ts`, asserted from the consumer end, with no
 * second copy of the fixture and nothing to drift.
 *
 * Two non-vacuity guards go with it, because an empty preview is also a fixed
 * point: the masked marker must be present, and the literal secret must appear
 * nowhere in the document.
 *
 * BLIND SPOT, and it is the ledger's own residual. `redactPayload` is a
 * FIELD-NAME heuristic. The `run` and `execute_tools` inputs do not go through
 * it at all: they render as a code block, because pretty-printed JSON turns
 * every quote and newline in a command into an escape sequence. A credential
 * written inside a shell command is therefore still shown, and the last
 * assertion here states that on purpose, so the gap is visible and cannot widen
 * quietly into the structured path.
 */
describe('the tool preview redacts through the one canonical policy', () => {
  test('structured input and output are a fixed point of redactPayload', async () => {
    await withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 1600 });
      await page.goto(`${origin}/gallery.html?frame=toolrun&secrets=1`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-tool-state]');

      // A group's own toggle mounts its members' toggles a render later, so the
      // pass repeats until nothing is left collapsed.
      for (let pass = 0; pass < 3; pass += 1) {
        const collapsed = await page.$$('button[aria-expanded="false"]');
        if (collapsed.length === 0) break;
        for (const toggle of collapsed) await toggle.click();
        await page.waitForFunction(() => document.querySelectorAll('pre').length > 0, { timeout: 8000 });
      }

      const rendered = await page.evaluate(() => ({
        previews: [...document.querySelectorAll('pre')].map((node) => node.textContent ?? ''),
        body: document.body.textContent ?? '',
      }));
      await page.close();

      // Every preview that is JSON must already be what the canonical policy
      // would produce. Non-JSON previews are the code-block path, covered below.
      //
      // Selected by SHAPE rather than by catching a parse error. A caught error
      // returning a sentinel cannot tell "this preview is a code block" from
      // "this preview is JSON and is corrupt", and the second is a defect that
      // must fail rather than be skipped. `JSON.stringify(value, null, 2)` of an
      // object or an array always opens with a brace or a bracket, so the shape
      // is the selector and `parseJsonValue` is then required to succeed.
      const structured = rendered.previews
        .filter((text) => text.startsWith('{') || text.startsWith('['))
        .map((text) => parseJsonValue(text));
      expect(structured.length, 'no structured preview rendered, so the oracle read nothing')
        .toBeGreaterThan(0);
      for (const preview of structured) {
        expect(redactPayload(preview), 'a rendered preview is not a fixed point of redactPayload')
          .toEqual(preview);
      }

      // Non-vacuity: masking really happened, at both nesting depths.
      expect(rendered.body).toContain('<redacted:authorization>');
      expect(rendered.body).toContain('<redacted:apiKey>');
      // Not a blanket mask: an ordinary sibling of a secret survives.
      expect(rendered.body).toContain('visible');
      // The value itself reaches no pixel of the structured path.
      const secretsInStructured = structured
        .filter((preview) => JSON.stringify(preview).includes('sk-live-REDACTME'));
      expect(secretsInStructured, 'a credential value survived into a structured preview').toEqual([]);

      // THE RESIDUAL, asserted rather than described. `run` renders its command
      // as free text, so a credential inside the command is still shown. The day
      // this stops being true, delete this assertion and the residual note in
      // `docs/research/triage-ledger.md`.
      expect(rendered.body, 'the free-text residual closed; update the ledger')
        .toContain('curl -s https://api.stripe.example/v1/charges');
    });
  }, 240_000);
});
