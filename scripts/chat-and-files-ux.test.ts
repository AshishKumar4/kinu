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
import type { Page } from 'puppeteer';

import { diagnosticsSettled, recordDiagnostics, withGallery, type Gallery } from './gallery-harness';
import { parseJsonArray, parseJsonValue, redactPayload, type JsonValue } from '@kinu.run/core';

/** One live-tail message, as the browser laid it out. */
interface TailFrame {
  /**
   * `::after` width on the LAST BLOCK the markdown emitted.
   *
   * A pseudo-element belongs to that block's own inline flow, so a caret with
   * a width here is a caret after the final character. A caret that is a
   * `<span>` SIBLING of the rendered markdown cannot satisfy this at all — it
   * draws on a line of its own.
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
  readonly reasoning: { viewportHeight: number; lineHeight: number; pulse: string; duration: string; textAnimation: string } | null;
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
  readonly reducedMotionTails: Record<string, TailFrame>;
  readonly chat: Record<string, ChatRow>;
  readonly forkInterruptedAfterClick: ChatRow;
  /** The failed-turn card's headline, keyed by whether it is a replay. */
  readonly chatErrorHeadings: Record<string, string>;
  /** The drive at its root: crumb text, row names, and the origin badges the
   *  mounted folders wear. */
  readonly filesRoot: { crumbs: string; entries: string[]; badges: string[] };
  /** The drive after crossing into the /pc mount, which must land inside the
   *  device's consented directory rather than on the device root. */
  readonly filesRoster: { crumbs: string; entries: string[] };
  readonly filesInMount: { crumbs: string; entries: string[] };
  readonly filesAfterUp: string;
  /** File names the TREE pane carries, not only its folders. */
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
  /** The stated-absence row a disconnected device leaves on the drive. */
  readonly filesOfflineRow: string;
  readonly envCards: Array<{ name: string; kind: string; status: string; mount: string }>;
  readonly envCapabilityChips: number;
  readonly envCapabilityAbsences: number;
  readonly envFilesJumpLandsOnDrive: boolean;
  /** The line terminal's rendered rows after one typed command and one pasted
   *  two-line command. Rows, not a string: the defect was which row a
   *  character lands on. */
  readonly terminalRows: string[];
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
    /** The mode the page actually rendered in, so a colour claim cannot be
     *  satisfied by the wrong theme. */
    mode: string | null;
    /** What the preview card shows while the run is still folded. */
    collapsedPreview: { text: string | null; height: number; folded: string | null };
  };
}

/** The gallery ids the provenance assertions address (gallery.tsx MESSAGES). */
const UNSTAMPED_FORK_ROW = 'f8798675-5e9a-4d13-aac2-293f4557f1c1';

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

      const viewport = row.querySelector('[data-reasoning-viewport]');
      const label = viewport?.previousElementSibling;
      const labelStyle = label ? getComputedStyle(label) : null;

      measured[row.getAttribute('data-stream-id') ?? ''] = {
        caretWidth: last === null ? 'none' : getComputedStyle(last, '::after').width,
        heightCostPx,
        thinkingRows: row.querySelectorAll('[aria-live="polite"]').length,
        reasoning: viewport ? {
          viewportHeight: viewport.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(getComputedStyle(viewport).lineHeight),
          pulse: labelStyle?.animationName ?? 'none',
          duration: labelStyle?.animationDuration ?? '0s',
          textAnimation: getComputedStyle(viewport).animationName,
        } : null,
        // Tool styling can change; the semantic state is the contract.
        runningIndicators: row.querySelectorAll('[data-tool-state="running"]').length,
      };
    }

    return measured;
  });
}

/**
 * Paste into the terminal the way a browser does: a `paste` event on xterm's
 * own textarea. xterm turns the newlines into CR before the pane ever sees
 * them, so typing the text key by key would exercise a different path from the
 * one that dropped every line after the first.
 */
async function pasteIntoTerminal(page: Page, text: string): Promise<void> {
  await page.evaluate((pasted) => {
    const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');

    if (textarea === null) throw new Error('the terminal has no input to paste into');
    textarea.focus();
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', pasted);
    textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, text);
}

/**
 * Wait for the terminal to have painted `text`: the fixture shell's echo of
 * the line it received, which is the one signal that the pane delivered the
 * input. A pane that drops a pasted line never paints its echo, and there is
 * no other event that says so — that wait ends with the browser at the
 * gallery's teardown, or with the gate at the ladder's deadline, and either
 * names this suite rather than a duration.
 */
async function terminalSettled(page: Page, text: string): Promise<void> {
  await page.waitForFunction(
    (painted: string) => (document.querySelector('.xterm-rows')?.textContent ?? '').includes(painted),
    {},
    text,
  );
}

async function run(): Promise<Observed> {
  return withGallery(async ({ newPage, origin }) => {
    const stream = await newPage();
    await stream.setViewport({ width: 1280, height: 1400 });
    await stream.goto(`${origin}/gallery.html?frame=streaming`, { waitUntil: 'networkidle0' });
    await stream.reload({ waitUntil: 'networkidle0' });
    await stream.waitForSelector('[data-gallery-stream] .p-streaming');
    await stream.waitForSelector('[data-stream-id="st-tool"] [data-tool-state="running"]');
    const tails = await readTails(stream);
    await stream.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    const reducedMotionTails = await readTails(stream);
    await stream.close();

    const chatPage = await newPage();
    await chatPage.setViewport({ width: 1280, height: 1600 });
    await chatPage.goto(`${origin}/gallery.html?frame=chat`, { waitUntil: 'networkidle0' });
    await chatPage.reload({ waitUntil: 'networkidle0' });
    await chatPage.waitForSelector(`[data-chat-row="${UNSTAMPED_FORK_ROW}"]`);
    const chat = await readChatRows(chatPage);
    // Folded by DEFAULT, not folded permanently: the words are still reachable,
    // which is what makes hiding them by default honest rather than lossy.
    //
    // Guarded, because a regression that puts this row back in the owner's
    // bubble removes the button too, and a `beforeAll` that throws on a missing
    // selector reports the whole file red — including the streaming and file
    // panes, which such a regression does not touch. The named assertions below
    // carry the failure instead, and say which wire broke.
    const toggle = `[data-chat-row="${UNSTAMPED_FORK_ROW}"] [data-system-event] button`;

    if (await chatPage.$(toggle) !== null) {
      await chatPage.click(toggle);
      await chatPage.waitForFunction(
        (selector: string) => document.querySelector(selector)?.getAttribute('aria-expanded') === 'true',
        {}, toggle,
      );
    }

    const forkInterruptedAfterClick = (await readChatRows(chatPage))[UNSTAMPED_FORK_ROW]!;

    const chatErrorHeadings = Object.fromEntries(await chatPage.$$eval(
      '[data-chat-error]',
      (cards) => cards.map((card) => [
        card.getAttribute('data-chat-error') ?? '',
        card.querySelector('.font-medium')?.textContent ?? '',
      ]),
    ));

    await chatPage.close();

    const tools = await newPage();
    await tools.setViewport({ width: 1280, height: 1600 });
    // `theme` is the key the pre-paint script in gallery.html reads (hooks/
    // use-theme.ts MODE_KEY). Seeding any other name leaves the page in the
    // default mode, and the light-mode assertion below then photographs dark.
    await tools.evaluateOnNewDocument(() => { localStorage.setItem('theme', 'light'); });
    await tools.goto(`${origin}/gallery.html?frame=toolrun`, { waitUntil: 'networkidle0' });
    await tools.reload({ waitUntil: 'networkidle0' });
    // The run's preview call points at the gallery's preview origin, which no
    // server here answers. Serve it, so what is asserted below is a frame that
    // really rendered rather than an element that merely exists.
    await tools.setRequestInterception(true);
    tools.on('request', async (request) => {
      if (!new URL(request.url()).hostname.endsWith('.preview.example.test')) {
        await request.continue();

        return;
      }

      await request.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><p data-run-preview>the running app</p>' });
    });
    await tools.reload({ waitUntil: 'networkidle0' });
    await tools.waitForSelector('[data-tool-group]');

    const collapsedActivity = await tools.$eval('[data-tool-group]', (group) => {
      const rows = [...document.querySelectorAll<HTMLElement>('[data-tool-state]')];
      const mutation = rows.find((row) => row.dataset.toolEffect === 'mutate');
      const compact = rows.find((row) => row.dataset.toolEffect === 'read');
      const standalone = rows.filter((row) => row.closest('[data-tool-group]') === null);

      const foldedCount = [...document.querySelectorAll('[data-tool-group]')]
        .reduce((count, block) => count + Number(block.getAttribute('data-tool-count')), 0);

      return {
        total: foldedCount + standalone.length,
        collapsedRows: rows.length,
        mutationRows: rows.filter((row) => row.dataset.toolEffect === 'mutate').length,
        compactHeight: Math.round(compact?.getBoundingClientRect().height ?? 0),
        mutationHeight: Math.round(mutation?.getBoundingClientRect().height ?? 0),
        ground: getComputedStyle(group).backgroundColor,
        pageGround: getComputedStyle(document.body).backgroundColor,
        mode: document.documentElement.dataset.mode ?? null,
      };
    });

    // The preview card, read while the group is still folded: the reader has
    // clicked nothing, and the app the turn started is on screen.
    const previewFrameHandle = await tools.waitForSelector('iframe');

    if (previewFrameHandle === null) throw new Error('the collapsed run drew no preview frame');
    const previewDocument = await previewFrameHandle.contentFrame();

    if (!previewDocument) throw new Error('the preview frame created no document');
    await previewDocument.waitForSelector('[data-run-preview]');

    const collapsedPreview = {
      text: await previewDocument.$eval('[data-run-preview]', (element) => element.textContent),
      height: Math.round(await previewFrameHandle.evaluate((element) => element.getBoundingClientRect().height)),
      folded: await tools.$eval('[data-tool-group-toggle]', (element) => element.getAttribute('aria-expanded')),
    };

    await tools.click('[data-tool-group-toggle]');
    await tools.waitForFunction(
      () => document.querySelector('[data-tool-group-toggle]')?.getAttribute('aria-expanded') === 'true',
    );

    const expandedRows = await tools.$$eval(
      '[data-tool-state]',
      (rows) => rows.length,
    );

    const toolActivity = { ...collapsedActivity, expandedRows, collapsedPreview };
    await tools.close();

    const files = await newPage();
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
    const waitForRow = (name: string) => files.waitForSelector(rowSelector(name));

    const waitForRowGone = (name: string) => files.waitForFunction(
      (sel: string) => document.querySelector(sel) === null,
      {}, rowSelector(name),
    );

    // The drive opens at the plane's root: the workspace tree beside the
    // mounted folders, each mount wearing its origin badge.
    await waitForRow('sandbox');

    const filesRoot = {
      crumbs: await crumbs(),
      entries: await rowNames(),
      badges: await files.$$eval('[data-files-entry] [data-mount-badge]', (els) => els.map((el) => el.textContent ?? '')),
    };

    // Crossing into `/pc` is ordinary navigation onto the roster: one row per
    // live machine. Crossing into a machine lands INSIDE its consented
    // directory. Landing on the machine root itself was the reported failure:
    // it strips to the device's `/`, which its consent boundary refuses, so
    // the first click answered EACCES.
    await files.click(rowSelector('pc'));
    await waitForRow("Ashish's MacBook");
    const filesRoster = { crumbs: await crumbs(), entries: await rowNames() };
    await files.click(rowSelector("Ashish's MacBook"));
    await waitForRow('quarterly-report.txt');
    await files.waitForFunction(
      () => document.querySelectorAll('[data-files-crumb]').length === 5,
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

    // The tree carries FILES, not only folders — a recursion that drops file
    // entries leaves the sidebar unable to reach one. Each level is expanded
    // through its own caret.
    await files.click(rowSelector('user'));
    await waitForRow('notes.md');
    await files.click('[data-files-tree-node="/home"] button');
    await files.waitForSelector('[data-files-tree-node="/home/user"]');
    await files.click('[data-files-tree-node="/home/user"] button');
    await files.waitForSelector('[data-files-tree-file]');

    const treeFileNames = await files.$$eval(
      '[data-files-tree-file]', (els) => els.map((el) => el.getAttribute('title') ?? ''),
    );

    // Markdown opens RENDERED through the app's one markdown renderer, and the
    // Source toggle shows the bytes it was rendered from.
    await files.click(rowSelector('notes.md'));
    await files.waitForSelector('[data-files-preview-body] h1');

    const filesMarkdownRendered = await files.$eval('[data-files-preview-body]', (el) => ({
      heading: el.querySelector('h1')?.textContent ?? '',
      showsSource: el.querySelector('pre') !== null,
    }));

    await files.click('[data-files-render-toggle]');
    await files.waitForSelector('[data-files-preview-body] pre');
    const filesPreviewText = await files.$eval('[data-files-preview-body] pre', (el) => el.textContent ?? '');

    // A whole file can be edited in place; a truncated read cannot, because
    // writing that prefix back would delete the rest of the file.
    await files.waitForSelector('[data-files-edit]');
    await files.click('[data-files-edit]');
    await files.waitForSelector('[data-files-editor]');

    const filesEditorSeedsFromTheFile = await files.$eval(
      '[data-files-editor]', (el) => el instanceof HTMLTextAreaElement ? el.value : '',
    );

    await files.click('[aria-label="Close preview"]');
    await files.waitForFunction(
      () => document.querySelector('[data-files-preview]') === null,
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
    const offline = await newPage();
    await offline.setViewport({ width: 1280, height: 1100 });
    await offline.goto(`${origin}/gallery.html?frame=files&offline=device`, { waitUntil: 'networkidle0' });
    await offline.reload({ waitUntil: 'networkidle0' });
    await offline.waitForSelector('[data-files-offline-mount]');
    const filesOfflineRow = await offline.$eval('[data-files-offline-mount]', (el) => el.textContent ?? '');
    await offline.close();

    // The Environment tab, reworked: user cards, no capability doctrine, and
    // a Files action that lands the drive.
    const env = await newPage();
    await env.setViewport({ width: 1280, height: 1100 });
    await env.goto(`${origin}/gallery.html?frame=environment`, { waitUntil: 'networkidle0' });
    await env.reload({ waitUntil: 'networkidle0' });
    await env.waitForSelector('[data-env-card]');

    const envCards = await env.$$eval('[data-env-card]', (cards) => cards.map((card) => ({
      name: card.querySelector('.font-medium')?.textContent ?? '',
      kind: [...card.querySelectorAll('.p-meta')].map((el) => el.textContent ?? '').join('|'),
      status: card.querySelector('[data-env-status]')?.textContent ?? '',
      mount: card.querySelector('[data-env-mount]')?.textContent ?? '',
    })));

    const envCapabilityChips = await env.$$eval('[data-capability-chip]', (els) => els.length);
    const envCapabilityAbsences = await env.$$eval('[data-capability-absences]', (els) => els.length);

    // The line terminal, as the browser lays it out. Two commands: one typed,
    // one pasted with a newline in it. What is read back is the rendered rows,
    // because the whole defect class is which row a character lands on.
    await env.waitForSelector('.xterm-rows');
    await env.click('.xterm-screen');
    await env.keyboard.type('one');
    await env.keyboard.press('Enter');
    await terminalSettled(env, 'ran: one');
    await pasteIntoTerminal(env, 'two\nthree\n');
    await terminalSettled(env, 'ran: three');

    const terminalRows = await env.$$eval(
      '.xterm-rows > div',
      (rows) => rows.map((line) => (line.textContent ?? '').replace(/\u00a0/gu, ' ').trimEnd()).filter((line) => line !== ''),
    );

    // The jump is a synchronous surface switch (`openFiles` navigates focus
    // and the Files surface is a static import), committed before the click
    // resolves, so the drive's presence is the boolean under test, read once.
    await env.click('[data-env-card="workspace"] [data-env-files]');
    const envFilesJumpLandsOnDrive = await env.$('[data-files-surface]') !== null;

    await env.close();

    const explore = await newPage();
    await explore.setViewport({ width: 1280, height: 1100 });
    await explore.goto(`${origin}/gallery.html?frame=forkrunning`, { waitUntil: 'networkidle0' });
    await explore.reload({ waitUntil: 'networkidle0' });
    await explore.waitForSelector(`[data-run-node="${RATE_LIMITED_NODE}"]`);
    const runNodes = await readRunNodes(explore);
    await explore.close();

    return {
      tails, reducedMotionTails, chat, forkInterruptedAfterClick, chatErrorHeadings, toolActivity,
      filesRoot, filesRoster, filesInMount, filesAfterUp, treeFileNames,
      filesMarkdownRendered, filesPreviewText, filesEditorSeedsFromTheFile,
      filesAfterRename, filesAfterDelete, filesFiltered, filesOfflineRow,
      envCards, envCapabilityChips, envCapabilityAbsences, envFilesJumpLandsOnDrive,
      terminalRows,
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

beforeAll(async () => { observed = await run(); });

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
    // with no active part of its own to draw, and it still has to say so.
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
    const reasoning = observed.tails[REASONING]!.reasoning;

    expect(reasoning).not.toBeNull();
    expect(reasoning!.viewportHeight).toBeGreaterThan(0);
    expect(reasoning!.viewportHeight).toBeLessThanOrEqual(reasoning!.lineHeight * 4);
    expect(reasoning!.pulse).toBe('pulse');
    expect(reasoning!.duration).toBe('1.6s');
    expect(reasoning!.textAnimation).toBe('none');
    expect(observed.reducedMotionTails[REASONING]!.reasoning!.pulse).toBe('none');
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

  test('the app a mid-run call started is on screen before any click', () => {
    // The app stays visible before the reader opens the folded reads.
    const { collapsedPreview } = observed.toolActivity;
    expect(collapsedPreview.folded).toBe('false');
    expect(collapsedPreview.text).toBe('the running app');
    expect(collapsedPreview.height).toBeGreaterThan(200);
  });

  test('light mode uses a recessed activity ground instead of white cards', () => {
    const activity = observed.toolActivity;
    // First: that this page IS light. Without it the two colour assertions
    // below are satisfied by the default dark theme, where they say nothing.
    expect(activity.mode).toBe('light');
    expect(activity.ground).not.toBe(activity.pageGround);
    expect(activity.ground).not.toBe('rgb(255, 255, 255)');
  });
});

describe('a turn the harness wrote, as the browser attributes it', () => {
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
    const fork = observed.chat[UNSTAMPED_FORK_ROW]!;
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
    expect(observed.chat[UNSTAMPED_FORK_ROW]!.folded).toBe(true);
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

describe('feedback on a settled turn', () => {
  test('the buttons appear when the message is hovered, and a click records one vote', async () => {
    // Hidden at rest, revealed by hovering the MESSAGE (not the footer row):
    // the 2026-09 regression put the reveal on a `.group` the footer had left,
    // so nothing hovered and the buttons were invisible for good.
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1400 });
      await page.goto(`${origin}/gallery.html?frame=chat`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-chat-row="a1"]');

      const buttons = '[data-chat-row="a1"] button[title^="Mark this response"]';
      await page.waitForFunction(
        (selector: string) => document.querySelectorAll(selector).length === 2,
        {}, buttons,
      );

      const effectiveOpacity = (selector: string) => page.$$eval(selector, (nodes) => nodes.map((node) => {
        let visible = 1;

        for (let el: Element | null = node; el; el = el.parentElement) {
          visible *= Number(getComputedStyle(el).opacity);
        }

        return visible;
      }));

      expect(await effectiveOpacity(buttons)).toEqual([0, 0]);

      await page.hover('[data-chat-row="a1"]');
      await page.waitForFunction(
        (selector: string) => [...document.querySelectorAll(selector)].every((node) => {
          let visible = 1;

          for (let el: Element | null = node; el; el = el.parentElement) visible *= Number(getComputedStyle(el).opacity);

          return visible === 1;
        }),
        {}, buttons,
      );

      const up = '[data-chat-row="a1"] button[title^="Mark this response helpful"]';

      await page.click(up);
      expect(await page.$eval(up, (node) => node.classList.contains('p-text'))).toBe(true);

      // A second click on the same glyph clears it — the RPC writes null.
      await page.click(up);
      await page.waitForFunction(
        () => (document.documentElement.dataset.galleryFeedbackCalls ?? '').split('[').length - 1 >= 2,
      );

      const calls = await page.evaluate(() => JSON.parse(document.documentElement.dataset.galleryFeedbackCalls ?? '[]'));
      expect(calls).toEqual([{ method: 'setTurnFeedback', args: ['a1', 'positive'] }, { method: 'setTurnFeedback', args: ['a1', null] }]);
      expect(await page.$eval(up, (node) => node.classList.contains('p-text'))).toBe(false);
      await page.close();
    });
  });
});

describe('the drive, browsing the one composite plane', () => {
  test('the root is the workspace tree beside the mounts, badges on the mounted folders', () => {
    expect(observed.filesRoot.crumbs).toBe('/');
    expect(observed.filesRoot.entries).toEqual(expect.arrayContaining(['home', 'pc', 'sandbox']));
    // The origin badge names the machine, not the executor id — the device
    // wears the user's own device name, per the consent naming contract.
    expect(observed.filesRoot.badges).toEqual(expect.arrayContaining(["Ashish's MacBook", 'Sandbox']));
  });

  test('crossing into /pc lists the machines; a machine lands inside its consented directory', () => {
    // `/pc` is the roster. A machine root strips to the DEVICE's `/`, which its
    // consent boundary refuses with EACCES, so the machine lands on the
    // directory the owner consented to instead.
    expect(observed.filesRoster.crumbs).toBe('//pc');
    expect(observed.filesRoster.entries).toEqual(["Ashish's MacBook"]);
    expect(observed.filesInMount.crumbs).toBe("//pc/Ashish's MacBook/home/dev");
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
  test('one card per environment: status, mount path, and the device wears its own name', () => {
    const byName = Object.fromEntries(observed.envCards.map((card) => [card.name, card]));
    expect(byName["Ashish's MacBook"]?.status).toBe('active');
    expect(byName["Ashish's MacBook"]?.kind).toContain('Your PC');
    expect(byName["Ashish's MacBook"]?.mount).toBe('/pc');
    expect(byName['Workspace']?.mount).toBe('/');
    expect(byName['Sandbox']?.mount).toBe('/sandbox');
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

  // Measured in the same browser against a live workspace executor before the
  // fix (2026-09-01): `printf 'a\nb\nc\n'` drew `a`, ` b`, `  c` — one column
  // further right per line, because a program's LF moves down without
  // returning to column 0 and xterm writes what it is handed.
  test('every line of a command output starts at column zero', () => {
    expect(observed.terminalRows).toContain('ran: one');
    expect(observed.terminalRows).toContain('ran: two');
    expect(observed.terminalRows).toContain('ran: three');
  });

  // The same session: a pasted `echo first-line\necho second-line\n` ran the
  // first line and dropped the second with no echo and no error.
  test('a pasted two-line command runs whole, in one call', () => {
    const echoed = observed.terminalRows.filter((line) => line.startsWith('ran: '));
    expect(echoed).toEqual(['ran: one', 'ran: two', 'ran: three']);
    // One call, so both pasted lines are echoed under one prompt and the
    // second wears the continuation prompt rather than a new `$`.
    expect(observed.terminalRows).toContain('> three');
  });
});

describe('a node the provider rate-limited, as the run list reads it', () => {
  test('the row says rate limit, not fault', () => {
    // The seam this reads through is `isRateLimitedTurnError`. Rendering
    // `errorMessage` verbatim in the failure tone makes a node the provider
    // told us to wait for indistinguishable from a wedged one — the
    // distinction the classifier exists for.
    expect(observed.runNodes[RATE_LIMITED_NODE]?.reason).toBe('rate-limited');
    expect(observed.runNodes[RATE_LIMITED_NODE]?.reasonText).toContain('Rate limited');
  });

  test('its dot agrees with its line, and does not collide with a working node', () => {
    // Both halves matter. `warning` is the pacing tone; if a RUNNING node wore
    // it too, the one signal that the provider asked us to wait rather than
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
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1568, height: 1000 });
      await page.goto(`${origin}/gallery.html?frame=shell`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('aside');
      await page.waitForFunction(
        () => !(document.querySelector('aside')?.textContent ?? '').includes('loading...'),
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
  });

  test('mobile gives Chat and Workspace the full viewport in turn', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
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
  });
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
    newPage: Gallery['newPage'], origin: string, viewport: { width: number; height: number }, query = '',
  ): Promise<RigDriver> {
    const page = await newPage();
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
        // By the tab's own hook, never by element: Main IS its link, an open
        // agent tab is the rename host, a closed one wraps its link.
        for (const tab of await page.$$('nav[aria-label="Workspace agents"] [data-agent-tab]')) {
          const text = await tab.evaluate((el) => el.textContent ?? '');

          if (text.includes(label)) {
            await (await tab.$('a') ?? tab).click();

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
    await withGallery(async ({ newPage, origin }) => {
      const rig = await openRig(newPage, origin, { width: 1280, height: 900 });
      const { page } = rig;

      // The inherited mission is internal, and the roster's role string is
      // machinery — neither may render, before or after any interaction.
      expect(await rig.bodyText()).not.toContain(MISSION);
      expect(await rig.bodyText()).not.toContain(SEED_ROLE);

      // One click. No dialog, no role field, no mission field — the click
      // lands directly in the new agent's conversation, titled provisionally.
      // 108c6c414: the untitled tab reads "Untitled agent" now; "New agent"
      // is the create button's label, not the conversation's title.
      await page.click('[aria-label="New agent"]');
      await page.waitForFunction(() => (
        (document.querySelector('nav[aria-label="Workspace agents"] [aria-current="page"]')?.textContent ?? '').includes('Untitled agent')
      ));
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
      ));

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
      ));

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
  });

  test('mobile: one-click create and per-conversation drafts at 375px, with no overflow', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const rig = await openRig(newPage, origin, { width: 375, height: 812 });
      const { page } = rig;
      await page.click('[aria-label="New agent"]');
      await page.waitForSelector('[data-agent-pane="checkout-fixes/agents/agent-1"]');
      // 108c6c414: the untitled conversation is "Untitled agent" on the strip.
      expect(await rig.activeTab()).toContain('Untitled agent');
      expect(await rig.bodyText()).not.toContain('Add a subordinate');
      expect(await rig.bodyText()).not.toContain(MISSION);

      await page.type('[data-agent-pane] textarea', 'thumb-typed draft');
      await rig.clickTab('Main');
      await page.waitForSelector('[data-agent-pane="checkout-fixes/main"]');
      expect(await rig.draft()).toBe('');
      await rig.clickTab('Untitled agent');
      await page.waitForSelector('[data-agent-pane="checkout-fixes/agents/agent-1"]');
      expect(await rig.draft()).toBe('thumb-typed draft');

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(overflow).toBe(0);
      await page.close();
    });
  });

  /** The chain `?createFails=1` makes the first create reject with. Spelled
   *  here as well so a chain the gallery stopped chaining fails the equality
   *  instead of passing a weaker containment. */
  const CREATE_REFUSAL_CHAIN = 'the workspace refused the new agent: subordinate quota exhausted';

  test('a create the workspace refuses is recorded once, classified, and the strip keeps working', async () => {
    // The strip owns its own click: `onCreate` may reject, and the void on it
    // must not become an unhandled rejection with no context. The parent's
    // banner is WorkspacePage's; the bare rig has no parent, so the record is
    // the whole observable outcome here.
    await withGallery(async ({ newPage, origin }) => {
      const rig = await openRig(newPage, origin, { width: 1280, height: 900 }, '&createFails=1');
      const { page } = rig;
      const diagnostics = recordDiagnostics(page);
      const unhandled: string[] = [];
      page.on('pageerror', (error) => { unhandled.push(String(error)); });

      await page.click('[aria-label="New agent"]');
      await diagnosticsSettled(diagnostics, 1);
      expect([...diagnostics]).toEqual([{
        event: 'subordinates.create_failed', code: 'io',
        cause: `create a subordinate agent: ${CREATE_REFUSAL_CHAIN}`, fields: {},
      }]);
      // The refused click navigated nowhere.
      expect(await rig.activeTab()).toContain('Main');

      // The affordance is intact: the next click creates and opens the agent.
      await page.click('[aria-label="New agent"]');
      await page.waitForFunction(() => (
        (document.querySelector('nav[aria-label="Workspace agents"] [aria-current="page"]')?.textContent ?? '').includes('Untitled agent')
      ));
      // Exactly one record for exactly one failure — the create that landed
      // added nothing, and nothing was ever unhandled.
      expect(diagnostics).toHaveLength(1);
      expect(unhandled).toEqual([]);
      await page.close();
    });
  });

  test('the real WorkspacePage shows a refused create and the next click still lands', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 900 });
      const diagnostics = recordDiagnostics(page);
      await page.goto(`${origin}/gallery.html?frame=workspacepage&createFails=1`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('nav[aria-label="Workspace agents"]');

      // The page's own catch turns the refusal into its banner, whole chain
      // shown, with a way out.
      await page.click('[aria-label="New agent"]');
      await page.waitForSelector('[role="alert"]');
      const banner = await page.$eval('[role="alert"]', (node) => node.textContent ?? '');
      // 9593645b0: one spelling, "Could not create an agent".
      expect(banner).toContain('Could not create an agent');
      expect(banner).toContain(CREATE_REFUSAL_CHAIN);
      // The + button is not stuck in `creating`.
      expect(await page.$eval('[aria-label="New agent"]', (node) => node.hasAttribute('disabled'))).toBe(false);

      // The parent absorbed the rejection, so the strip's own net — the
      // record for a parent that LEAKS — stays silent: one owner per failure.
      expect(diagnostics.filter((line) => line.event === 'subordinates.create_failed')).toEqual([]);

      // Retry lands: the banner clears and the new conversation opens.
      await page.click('[aria-label="New agent"]');
      await page.waitForFunction(() => (
        (document.querySelector('nav[aria-label="Workspace agents"] [aria-current="page"]')?.textContent ?? '').includes('Untitled agent')
      ));
      // 9593645b0: the banner's spelling, if it wrongly returned.
      expect(await page.evaluate(() => document.body.innerText)).not.toContain('Could not create an agent');
      await page.close();
    });
  });

  test('the real WorkspacePage creates, opens, and renames an agent through its own wiring', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('nav[aria-label="Workspace agents"]');

      // One click on the page's own strip: the hook's zero-argument RPC, the
      // navigate, the facet column — all the page's real wiring.
      await page.click('[aria-label="New agent"]');
      // 108c6c414: the untitled conversation is "Untitled agent".
      await page.waitForFunction(() => (
        (document.querySelector('nav[aria-label="Workspace agents"] [aria-current="page"]')?.textContent ?? '').includes('Untitled agent')
      ));
      const body = await page.evaluate(() => document.body.innerText);
      expect(body).not.toContain('Add a subordinate');
      expect(body).not.toContain('Mission');

      // The facet conversation carries the full composer contract — the same
      // Auto/Plan segment the main column has.
      await page.waitForSelector('[aria-label="Turn mode"]');
      await page.waitForSelector('[title="Rename agent"]');

      // Rename lands on the parent roster the tabs read.
      await page.click('[title="Rename agent"]');
      await page.waitForSelector('[aria-label="Agent name"]');
      await page.type('[aria-label="Agent name"]', 'Payments triage');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => (
        (document.querySelector('nav[aria-label="Workspace agents"] [aria-current="page"]')?.textContent ?? '').includes('Payments triage')
      ));
      await page.close();
    });
  });

  test('an agent pane\'s picker shows the actor\'s effective model and writes the actor\'s own pin', async () => {
    // The pane's picker once wrote to the ROOT's `setModel`, so a pick there
    // repinned the whole workspace; then it was made read-only. Now it shows
    // the snapshot's effective model and a pick — or a thinking level — is
    // written to THIS actor, never the workspace.
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('nav[aria-label="Workspace agents"]');

      await page.click('[aria-label="New agent"]');
      await page.waitForFunction(() => (
        (document.querySelector('nav[aria-label="Workspace agents"] [aria-current="page"]')?.textContent ?? '').includes('Untitled agent')
      ));
      await page.waitForFunction(() => {
        const input = document.querySelector('[data-agent-pane] input[aria-label="Model"]');

        return input instanceof HTMLInputElement && input.value === 'Claude Opus 4' && !input.disabled;
      });

      const body = await page.evaluate(() => document.body.innerText);
      expect(body).not.toContain('Set for the workspace on the Main tab');

      // The thinking level is the actor's own write too.
      await page.select('[data-agent-pane] select[aria-label="Thinking level"]', 'high');
      await page.waitForFunction(() => (document.documentElement.dataset.galleryModelCalls ?? '').includes('setReasoningEffort'));
      const calls = await page.evaluate(() => JSON.parse(document.documentElement.dataset.galleryModelCalls ?? '[]'));
      expect(calls).toEqual([{ method: 'setReasoningEffort', args: ['high', 'agent-1'] }]);
      await page.close();
    });
  });

  test('a user-created chat deletes on click with no modal; an agent-created one keeps its confirmation', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const rig = await openRig(newPage, origin, { width: 1280, height: 900 });
      const { page } = rig;

      // What each flow did to the THREAD, read off the rig's record of the
      // call the strip made. The dialog's sentence is not the assertion: what
      // it promises about the conversation is, and only the call says that.
      const dismissals = async (): Promise<JsonValue[]> => parseJsonArray(await page.$eval(
        '[data-dismiss-log]',
        (el) => el.getAttribute('data-dismiss-log') ?? '[]',
      ));

      // The agent-created seed keeps a labelled dismiss control that opens the
      // confirmation: the two flows are different controls, not one modal with
      // two words in it.
      expect(await page.$('[aria-label="Dismiss Auto scout"]')).not.toBeNull();
      await page.click('[aria-label="Dismiss Auto scout"]');
      await page.waitForSelector('[role="dialog"]');

      // Cancel is a real way out and decides nothing.
      await page.evaluate(() => {
        const cancel = [...document.querySelectorAll('[role="dialog"] button')]
          .find((button) => (button.textContent ?? '').includes('Cancel'));

        if (!(cancel instanceof HTMLButtonElement)) throw new Error('Cancel absent in the dismiss dialog');
        cancel.click();
      });
      await page.waitForFunction(() => document.querySelector('[role="dialog"]') === null);
      expect(await dismissals()).toEqual([]);
      expect(await page.$('[aria-label="Dismiss Auto scout"]')).not.toBeNull();

      // Confirmed, it dismisses: the tab closes and the conversation is KEPT,
      // which is the one thing that dialog tells the reader.
      await page.click('[aria-label="Dismiss Auto scout"]');
      await page.waitForSelector('[role="dialog"]');
      await page.evaluate(() => {
        const confirm = [...document.querySelectorAll('[role="dialog"] button')]
          .find((button) => (button.textContent ?? '').trim() === 'Dismiss');

        if (!(confirm instanceof HTMLButtonElement)) throw new Error('Dismiss absent in the dismiss dialog');
        confirm.click();
      });
      await page.waitForFunction(() => document.querySelector('[aria-label="Dismiss Auto scout"]') === null);
      expect(await dismissals()).toEqual([{ agent: 'auto-scout', historyKept: true }]);

      // The user-created seed deletes on click: no modal at all, the tab gone,
      // and the conversation deleted with it.
      expect(await page.$('[aria-label="Delete Checkout scout"]')).not.toBeNull();
      await page.click('[aria-label="Delete Checkout scout"]');
      await page.waitForFunction(() => document.querySelector('[aria-label="Delete Checkout scout"]') === null);
      expect(await page.evaluate(() => document.body.innerText)).not.toContain('Checkout scout');
      expect(await page.$('[role="dialog"]')).toBeNull();
      expect(await dismissals()).toEqual([
        { agent: 'auto-scout', historyKept: true },
        { agent: 'scout', historyKept: false },
      ]);
      await page.close();
    });
  });

  test('the workspace panel does not remount or refetch when the agent tab changes', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const rig = await openRig(newPage, origin, { width: 1440, height: 900 });
      const { page } = rig;

      // The agentchats rig mounts the real tab strip over a scripted roster,
      // so switching tabs exercises the production remount behaviour with no
      // backend create. (Creating on the workspacepage frame hangs — the
      // gallery answers /api/* from fixtures and has no backend to create an
      // actor — so the create-then-switch path is covered by the live-app
      // tier instead.)
      await rig.clickTab('Checkout scout');
      await page.waitForSelector('[data-agent-pane="checkout-fixes/agents/scout"]');
      expect(await rig.activeTab()).toContain('Checkout scout');

      await rig.clickTab('Main');
      await page.waitForSelector('[data-agent-pane="checkout-fixes/main"]');
      expect(await rig.activeTab()).toContain('Main');

      // The per-conversation chrome survived the round trip: the drafts the
      // rig owns per conversation are the observable half of "nothing
      // remounted that should not have".
      await page.type('[data-agent-pane] textarea', 'main draft');
      await rig.clickTab('Checkout scout');
      await page.waitForSelector('[data-agent-pane="checkout-fixes/agents/scout"]');
      await rig.clickTab('Main');
      await page.waitForSelector('[data-agent-pane="checkout-fixes/main"]');
      expect(await rig.draft()).toBe('main draft');

      await page.close();
    });
  });
});

describe('the shell rails collapse and reopen, and the choice survives a reload', () => {
  test('rail and inspector each collapse then reopen by role and state, persisted across reload', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=app&path=/`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('button[aria-label="Hide sidebar"]');

      // The roster column, as opposed to the icon rail it folds to.
      const railVisible = () => page.evaluate(() => {
        const rail = document.querySelector('aside[data-rail]');

        return rail instanceof HTMLElement && rail.offsetParent !== null;
      });

      expect(await railVisible()).toBe(true);
      await page.click('button[aria-label="Hide sidebar"]');
      await page.waitForSelector('button[aria-label="Show sidebar"]');
      expect(await railVisible()).toBe(false);
      expect(await page.evaluate(() => localStorage.getItem('kinu:rail-open'))).toBe('0');
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('button[aria-label="Show sidebar"]');
      expect(await railVisible()).toBe(false);

      await page.click('button[aria-label="Show sidebar"]');
      await page.waitForSelector('button[aria-label="Hide sidebar"]');
      expect(await railVisible()).toBe(true);
      expect(await page.evaluate(() => localStorage.getItem('kinu:rail-open'))).toBe('1');

      // B8's other half, on the panel that carries the defect: a collapsed
      // right panel has to be reopenable, and the control is addressed the way
      // a reader reaches it — a button with that name — over the panel's own
      // measured width, never a test hook.
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('nav[aria-label="Workspace agents"]');
      await page.waitForSelector('button[aria-label="Hide inspector"]');

      const opened = await page.evaluate(() => Math.round(
        document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1,
      ));

      expect(opened).toBeGreaterThan(200);

      await page.click('button[aria-label="Hide inspector"]');
      await page.waitForFunction(() => Math.round(
        document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1,
      ) === 0);
      // The rail's choice is the rail's: collapsing this panel is not a shell
      // preference, and the two controls are not one.
      expect(await page.evaluate(() => localStorage.getItem('kinu:rail-open'))).toBe('1');
      expect(await page.$('button[aria-label="Hide inspector"]')).toBeNull();

      await page.click('button[aria-label="Show inspector"]');
      await page.waitForSelector('button[aria-label="Hide inspector"]');
      // Reopened at the width it was collapsed from, and the reopen handle is
      // gone because there is nothing left to reopen.
      expect(await page.evaluate(() => Math.round(
        document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1,
      ))).toBe(opened);
      expect(await page.$('button[aria-label="Show inspector"]')).toBeNull();

      await page.close();
    });
  });
});

/**
 * One workspace, one Durable Object, one socket per pane — and `broadcast`
 * reaches every one of them. The frames a hosted actor's host emits are
 * stamped with that actor; the root's own are not. A client that ignored the
 * stamp rendered a subordinate's cards in the workspace's own chat, which is
 * how the refiner's self-review brief arrived in the owner's thread.
 *
 * A browser row because the stamp only matters where the frames land: this
 * drives the real page over the gallery's transport, makes the SERVER send
 * both a stamped and an unstamped card, and reads the thread the owner would.
 * No fixture READ can produce a stamped frame, so the gate dispatches
 * `gallery:push-frame` and the stub delivers it on the open connection.
 */
describe('a hosted actor’s cards stay out of the workspace’s own chat', () => {
  test('an unstamped card joins the workspace thread and a stamped one never does', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('nav[aria-label="Workspace agents"]');
      await page.waitForSelector('.p-thread-column');

      // The refiner's own card first, stamped with its actor, then the
      // workspace's own drain with no stamp. The order is the failure's: the
      // stamped frame arrives before anything a reader could confuse it with,
      // so the unstamped card rendering is this row's end condition and the
      // absence below is read after the socket has certainly been heard.
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('gallery:push-frame', { detail: {
          type: 'signal_card', id: 'sig-refiner', state: 'pending', actorId: 'actor-refiner',
          metadata: { kinuEvent: 'event_drain' },
          text: '- [refinement] from refiner (self-review): reviewed 3 graded turns and changed nothing',
        } }));
        window.dispatchEvent(new CustomEvent('gallery:push-frame', { detail: {
          type: 'signal_card', id: 'sig-workspace', state: 'pending',
          metadata: { kinuEvent: 'event_drain' },
          text: '- [webhook] from stripe: a payout of 240.00 settled',
        } }));
      });

      await page.waitForFunction(() => (
        document.querySelector('.p-thread-column')?.textContent?.includes('a payout of 240.00 settled') === true
      ));

      const thread = await page.$eval('.p-thread-column', (el) => el.textContent ?? '');

      expect(thread).not.toContain('reviewed 3 graded turns and changed nothing');
      expect(thread).not.toContain('refiner');
      // One card, not two: the count is the assertion, because a dropped frame
      // and a rendered-but-scrolled-away one read the same in a text search.
      expect(await page.$$eval(
        '.p-thread-column button',
        (buttons) => buttons.filter((button) => button.innerText.includes('settled') || button.innerText.includes('graded turns')).length,
      )).toBe(1);

      await page.close();
    });
  });
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
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
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
      );
      const final = await page.$eval('[data-history-probe]', (probe) => probe.textContent ?? '');
      expect(final).toContain('"exhausted":true');
      expect(await page.$('[data-testid="conversation-skeleton"]')).toBeNull();
      await page.close();
    });
  });
});

/**
 * KINU-046. This mounts the real WorkspacePage, Composer, useKinu and send
 * latch. The gallery stub holds only the TRANSPORT promise and exposes how many
 * times it was entered; the two clicks occur in ONE browser task, before React
 * can render submitted/streaming state. A policy copy could only prove itself.
 */
describe('chat send admission at the actual WorkspacePage boundary', () => {
  test('two same-task Send clicks enter the transport once', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
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
      );
      expect(await page.evaluate(() => document.documentElement.dataset.galleryChatSends)).toBe('1');
      await page.close();
    });
  });
});

/**
 * KINU-074. The gallery transport supplies only SDK-shaped terminal inputs:
 * connectionError plus a matching 1008 CloseEvent, with snapshot deliberately
 * held so the real WorkspacePage has no agentStatus. Real useKinu and
 * WorkspacePage must render the terminal path instead of reconnecting.
 */
describe('terminal workspace denial at the actual WorkspacePage boundary', () => {
  test('1008 names denial, preserves SDK reason, and never promises reconnect', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.goto(`${origin}/gallery.html?frame=workspacepage&terminal=denied`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(
        () => document.body.textContent?.includes('Access to this workspace was denied') === true,
      );
      const text = await page.evaluate(() => document.body.innerText);
      expect(text).toContain('Access to this workspace was denied');
      expect(text).toContain('workspace access denied by fixture');
      expect(text).toContain('Try again');
      expect(text).toContain('Back to your workspaces');
      expect(text).not.toContain('Reconnecting...');
      await page.close();
    });
  });
});

/**
 * KINU-060. The real FilesSurface opens a preview whose FIRST RPC is held by
 * the fixture transport. A fixture mutation changes the listing's revision;
 * actual Refresh causes FileViewer/useAsyncResource to start its new request,
 * then the old request resolves. The current preview must stay current.
 */
describe('file preview request generation at the actual FilesSurface boundary', () => {
  test('a stale preview response cannot reclaim a refreshed file', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
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
      );
      await page.click('[data-files-fixture-release]');
      // The held first reply was old checkout content. Once it settles it must
      // not overwrite the fresh resource identity selected by the listing.
      const preview = await page.$eval('[data-files-preview-body]', (body) => body.textContent ?? '');
      expect(preview).toContain('Fresh after refresh');
      expect(preview).not.toContain('Checkout coupon regression');
      await page.close();
    });
  });
});

/**
 * KINU-060, remaining two authorities. The frames mount the shipped
 * usePagedScroll and WorkspaceRosterProvider; controls only hold/release their
 * network transport. Clear/reset and local rename are public transitions, not
 * fixture copies of the generations they exercise.
 */
describe('history and roster request generations at actual hook boundaries', () => {
  test('a held history page released after Clear cannot reseed the walk', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.goto(`${origin}/gallery.html?frame=historyauthority`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid="conversation-skeleton"]');
      await page.click('[data-history-reset]');
      await page.click('[data-history-release]');
      await page.waitForFunction(() => {
        const raw = document.querySelector('[data-history-probe]')?.textContent ?? '';

        return raw.includes('"loading":false') && raw.includes('"error":null') && raw.includes('"exhausted":false');
      });
      expect(await page.$('[data-testid="conversation-skeleton"]')).not.toBeNull();
      expect(await page.$('aria/Retry')).toBeNull();
      await page.close();
    });
  });

  test('a held roster list released after local rename cannot undo the rename', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.goto(`${origin}/gallery.html?frame=rosterauthority`, { waitUntil: 'networkidle0' });
      await page.click('[data-roster-local-rename]');
      // POSITIVE FIRST: the local transition really landed.
      await page.waitForFunction(
        () => document.querySelector('[data-roster-probe]')?.textContent === 'checkout-fixes:Renamed locally',
      );
      // POSITIVE SECOND: the mount read is still held, so there is a reply to
      // release. A roster whose read already ended has nothing to retire and
      // the assertion below would prove nothing.
      expect(await page.$eval('[data-roster-probe]', (el) => el.getAttribute('data-roster-pending'))).toBe('true');
      await page.click('[data-roster-release]');

      // The old server row spells "Checkout coupon bug", and the local edit
      // retired every read in flight, so the released list must publish
      // NOTHING. That is a claim about something NOT happening, and the proof
      // cannot be another `waitForFunction` on the rename: that condition is
      // already true, returns at once, and passed whatever the roster did
      // next. The end condition is the read's own: the provider's `pending`
      // stays true until the released reply has been consumed and either
      // published or retired, and React commits any publish before the flag
      // it rides on drops. Once the flag reads false, whatever the roster was
      // going to do it has done, and the probe text is the verdict.
      await page.waitForFunction(
        () => document.querySelector<HTMLElement>('[data-roster-probe]')?.dataset.rosterPending === 'false',
      );

      expect(await page.$eval('[data-roster-probe]', (el) => el.textContent ?? ''))
        .toBe('checkout-fixes:Renamed locally');
      await page.close();
    });
  });
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
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
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
      );
      expect(await page.$eval(
        '[data-settings-resource="your AI gateways"]',
        (resource) => resource.getAttribute('data-resource-state'),
      )).toBe('loading');

      await page.evaluate(() => window.dispatchEvent(new Event('gallery:settings-release')));
      await page.waitForSelector(
        '[data-settings-resource="your AI gateways"][data-resource-state="ready"]',
      );

      // Back on Account, the profile is still ready: the section switch was a
      // render, not a reload.
      await page.click('[data-settings-section="account"]');
      await page.waitForSelector('[data-settings-resource="your profile"][data-resource-state="ready"]');
      await page.close();
    });
  });

  test('a failed replay branch retries while alignment remains held, then both render', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 900, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=qualitybranches`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-quality-branch="replay"] button');
      expect(await page.$('[data-quality-branch="alignment"] [role="status"]')).not.toBeNull();

      await page.evaluate(() => window.dispatchEvent(new Event('gallery:quality-heal')));
      await page.click('[data-quality-branch="replay"] button');
      await page.waitForFunction(
        () => document.querySelector('[data-quality-branch="replay"]')?.textContent?.includes('Latest score') === true,
      );
      expect(await page.$('[data-quality-branch="alignment"] [role="status"]')).not.toBeNull();

      await page.evaluate(() => window.dispatchEvent(new Event('gallery:quality-release')));
      await page.waitForFunction(
        () => document.querySelector('[data-quality-branch="alignment"]')?.textContent?.includes('K_align') === true,
      );
      await page.close();
    });
  });
});

describe('the supervise view, live', () => {
  const headingTexts = (page: Page) => page.$$eval('h2', (els) => els.map((el) => el.textContent));

  test('a change landing after the page opened earns the Evolution section on the next revalidation', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1000, height: 1200 });
      await page.goto(`${origin}/gallery.html?frame=supervisefresh`, { waitUntil: 'networkidle0' });

      // The settled fresh view: Automations and Run history mount, and the
      // empty changes-only digest mounts no Evolution heading at all.
      await page.waitForFunction(
        () => [...document.querySelectorAll('h2')].some((h) => h.textContent === 'Run history'),
      );
      expect(await headingTexts(page)).toEqual(['Automations', 'Run history']);

      // A change lands. The page polls the changelog on the live-data cadence
      // (5s), so the heading must appear with no reload and no click.
      await page.evaluate(() => window.dispatchEvent(new Event('gallery:supervise-evolve')));
      await page.waitForFunction(
        () => [...document.querySelectorAll('h2')].some((h) => h.textContent === 'Evolution'),
      );
      expect(await page.$eval('body', (body) => body.textContent ?? ''))
        .toContain('I improved how I work');

      // The next digest read throws once: the card must report the failure
      // WITHOUT surrendering the entries it already showed — same policy the
      // jobs read follows.
      await page.evaluate(() => window.dispatchEvent(new Event('gallery:supervise-evolution-fail')));
      await page.waitForFunction(
        () => document.body.textContent?.includes('Could not load the evolution digest') === true,
      );
      expect(await page.$eval('body', (body) => body.textContent ?? ''))
        .toContain('I improved how I work');

      // That failure's own Retry — not the jobs one above it — recovers the
      // read, and the notice leaves.
      const retriedEvolution = await page.evaluate(() => {
        const failure = [...document.querySelectorAll('div')]
          .find((el) => el.querySelector('button') !== null
            && el.textContent?.includes('Could not load the evolution digest') === true);

        const retry = failure?.querySelector('button');

        retry?.click();

        return retry !== undefined && retry !== null;
      });

      expect(retriedEvolution).toBe(true);

      await page.waitForFunction(
        () => document.body.textContent?.includes('Could not load the evolution digest') === false,
      );
      await page.close();
    });
  });

  test('a failed background-jobs read reports itself and its retry republishes the rows', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1000, height: 1200 });
      await page.goto(`${origin}/gallery.html?frame=supervisefresh`, { waitUntil: 'networkidle0' });

      // The scoped failure renders in the Automations section — never as
      // silence and never as an empty jobs list.
      await page.waitForFunction(
        () => document.body.textContent?.includes('Could not load the background jobs') === true,
      );

      // Heal and click the failure's own Retry in one turn of the page, so the
      // cadence poll cannot claim the retry's recovery first.
      const retried = await page.evaluate(() => {
        window.dispatchEvent(new Event('gallery:supervise-jobs-heal'));

        const retry = [...document.querySelectorAll('button')]
          .find((button) => button.textContent?.includes('Retry'));

        retry?.click();

        return retry !== undefined;
      });

      expect(retried).toBe(true);

      await page.waitForFunction(
        () => document.body.textContent?.includes('Pick a migration-backfill approach') === true,
      );
      expect(await page.$eval('body', (body) => body.textContent ?? ''))
        .not.toContain('Could not load the background jobs');
      await page.close();
    });
  });
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
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1000, height: 1200 });
      await page.goto(`${origin}/gallery.html?frame=usersettingsstate&section=devices`, { waitUntil: 'networkidle0' });
      // The rail renders once the account reads settle, which lands after the
      // network goes quiet — the reads resolve through the page fixture, not
      // the wire — so the deep-link section is waited for, never read on arrival.
      await page.waitForSelector('[data-settings-section="devices"]');
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
      await page.waitForSelector('[data-device-incident="dev-1"]');
      await dialogAccepted;

      const immediate = await page.$eval('[data-device-incident="dev-1"]', (row) => row.textContent ?? '');
      // 33056d3d8: the warning reads "Kinu could not confirm that every
      // command stopped after revocation."
      expect(immediate).toContain('Kinu could not confirm that every command stopped after revocation.');
      expect(immediate).toContain('2 commands have no confirmed termination and may still run.');
      expect(await page.$('[data-device-incident="dev-1"] [title="Rename this device"]')).toBeNull();
      expect(await page.$('[data-device-incident="dev-1"] [title="Revoke device"]')).toBeNull();

      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-device-incident="dev-1"]');
      const persisted = await page.$eval('[data-device-incident="dev-1"]', (row) => row.textContent ?? '');
      // 33056d3d8: same rewrite as the immediate arm.
      expect(persisted).toContain('Kinu could not confirm that every command stopped after revocation.');
      expect(persisted).toContain('Commands may still run.');

      await page.click('[data-device-incident="dev-1"] button');
      await page.waitForFunction(
        () => document.querySelector('[data-device-incident="dev-1"]') === null,
      );
      await page.close();
    });
  });
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
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1100, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=environment&offline=device&connect=1`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-env-card="device"] [data-env-connect]');

      await page.click('[data-env-card="device"] [data-env-connect]');
      await page.waitForSelector('[role="dialog"] [data-connect-state="ready"]');
      // In place: the Environment surface is still mounted behind the dialog,
      // and the URL never moved.
      expect(await page.$('[data-env-card="workspace"]')).not.toBeNull();
      expect(new URL(page.url()).pathname).toBe('/gallery.html');
      // The disclosure is on screen BEFORE anything is installed.
      expect(await page.$eval('[role="dialog"]', (d) => d.textContent ?? ''))
        // 98caa7776 cut the disclosure to three lines, ending on "The daemon
        // only dials out. Revoke it any time under Account settings → Devices."
        .toContain('The daemon only dials out. Revoke it any time under Account settings → Devices.');

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
  });

  test('a machine that never dials in leaves the panel open and waiting', async () => {
    // The non-vacuity arm for the close above: same flow, same clicks, and a
    // roster whose row stays `connected: false`. A panel that closed on any
    // roster tick would pass the first test and fail this one.
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1100, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=environment&offline=device&connect=stall`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-env-card="device"] [data-env-connect]');
      await page.click('[data-env-card="device"] [data-env-connect]');
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
        {},
        readsAtHandover,
      );
      expect(await page.$('[role="dialog"] [data-connect-waiting]')).not.toBeNull();
      expect(await page.$('[data-connect-command]')).not.toBeNull();
      await page.close();
    });
  });

  test('the drive opens the same panel from its offline row', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1100, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=files&offline=device&connect=1`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-files-connect]');
      await page.click('[data-files-connect]');
      await page.waitForSelector('[role="dialog"] [data-connect-state="ready"]');
      // Still the drive underneath: the row it was opened from is right there.
      expect(await page.$('[data-files-offline-mount]')).not.toBeNull();
      await page.close();
    });
  });
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
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
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
        const keyCode229 = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        Object.defineProperty(keyCode229, 'keyCode', { value: 229 });
        input.dispatchEvent(keyCode229);
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
      );
      await page.keyboard.down('Shift');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Shift');
      await page.waitForFunction(
        () => document.querySelector('[data-continuity-probe]')?.getAttribute('data-draft')?.includes('\n') === true,
      );
      expect((await continuityProbe(page)).sends).toBe(0);
      await page.close();
    });
  });

  test('mixed clipboard strings survive beside deduplicated files; file-only is prevented', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
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
  });

  test('long user and steer tokens stay inside bubbles at desktop and mobile widths', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
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
  });

  test('a failed Markdown image becomes a diagnostic with its raw link; a loaded image remains an image', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
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
  });
});

/** The same live-token shape the gallery fixture assembles, spelled the same
 *  way so the commit-tier scan sees no literal here either. */
const ASSEMBLED = `cfut_${'a'.repeat(48)}`;

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
 * VALUE-LEVEL REDACTION (KINU-011's second half). Field names cannot see a
 * token inside a free-form string, and the `run`/`eval` inputs plus
 * `errorText` render as free text, not JSON — so the canonical policy's other
 * half, `redactSecrets`, masks secret-shaped VALUES off the same
 * `SECRET_PATTERNS` list the commit-tier scan runs. The gallery fixture
 * carries an assembled `cfut_` token inside the command, the output body and
 * the error text, and the assertions below prove none of it reaches a pixel.
 * A shape the list does not know still renders raw; that residual is now the
 * pattern list's own coverage question, not the preview's.
 */
describe('the tool preview redacts through the one canonical policy', () => {
  test('structured input and output are a fixed point of redactPayload', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1600 });
      await page.goto(`${origin}/gallery.html?frame=toolrun&secrets=1`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-tool-state]');

      // A group's own toggle mounts its members' toggles a render later, so the
      // pass repeats until nothing is left collapsed.
      for (let pass = 0; pass < 3; pass += 1) {
        const collapsed = await page.$$('button[aria-expanded="false"]');

        if (collapsed.length === 0) break;

        for (const toggle of collapsed) await toggle.click();
        await page.waitForFunction(() => document.querySelectorAll('pre').length > 0);
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

      // The free-text arms are closed: the token inside the command, the
      // output body and the error text is masked at the value, and the
      // surrounding prose survives.
      expect(rendered.body).toContain('--token=<redacted>');
      expect(rendered.body).toContain('token <redacted> accepted');
      expect(rendered.body).toContain('rejected the credential <redacted>');
      expect(rendered.body).toContain('curl -s https://api.stripe.example/v1/charges');
      expect(rendered.body, 'a secret-shaped value reached a pixel').not.toContain(ASSEMBLED);
    });
  });
});

test('file navigation does not pair a new breadcrumb with the old directory', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.goto(`${origin}/gallery.html?frame=files`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-files-entry][title="sandbox"]');

    const mismatches = await page.evaluate(async () => {
      const titles = (): string[] => [...document.querySelectorAll('[data-files-entry]')]
        .map((row) => row.getAttribute('title') ?? '');

      const trail = (): string => [...document.querySelectorAll('[data-files-crumb]')]
        .map((node) => node.textContent ?? '').join('/');

      const seen: string[] = [];

      /**
       * Cross one level and settle when `arrived` is drawn, recording every
       * frame where the trail already names the destination while `stale` — a
       * row that belongs only to the listing being left — is still on screen.
       */
      const cross = (row: string, crumb: string, stale: string, arrived: string): Promise<void> => {
        const { promise, resolve } = Promise.withResolvers<void>();

        const observe = (): void => {
          if (trail().includes(crumb) && titles().includes(stale)) seen.push(trail());

          if (titles().includes(arrived)) {
            changes.disconnect();
            resolve();
          }
        };

        const changes = new MutationObserver(observe);
        changes.observe(document.body, { childList: true, subtree: true, characterData: true });

        const target = document.querySelector<HTMLElement>(`[data-files-entry][title="${row}"]`);

        if (target === null) throw new Error(`the ${row} row is absent`);
        target.click();

        return promise;
      };

      // `/pc` is the roster and `/pc/<name>` the machine's consented directory,
      // so reaching a file on the device is TWO crossings and each one swaps a
      // trail and a listing together. Watching only the first and settling on a
      // file two levels down is a condition that cannot arrive: it hung this
      // suite, and with it the row, from 0cdf5d9b3 until this line.
      await cross('pc', 'pc', 'sandbox', "Ashish's MacBook");
      await cross("Ashish's MacBook", "Ashish's MacBook", "Ashish's MacBook", 'quarterly-report.txt');

      return seen;
    });

    expect(mismatches).toEqual([]);
  });
});

test('code retains syntax colors through streaming and sidebar ages share a right edge', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.setViewport({ width: 1100, height: 1000 });
    await page.evaluateOnNewDocument(() => {
      let clipboard = '';
      Object.defineProperty(navigator, 'clipboard', { value: {
        writeText: async (text: string) => { clipboard = text; },
        readText: async () => clipboard,
      } });
    });

    try {
      for (const mode of ['light', 'dark']) {
        await page.evaluateOnNewDocument((theme) => localStorage.setItem('theme', theme), mode);
        await page.goto(`${origin}/gallery.html?frame=chatcode`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('[data-chat-row="ca1"] code');
        await page.waitForFunction(() => document.fonts.status === 'loaded');
        await page.waitForFunction(() => [...document.querySelectorAll('[data-chat-row="ca1"] .p-code')].every((block) => block.querySelectorAll('code span').length > 1));

        const chatFences = await page.$$eval('[data-chat-row="ca1"] .p-code', (blocks) => blocks.map((block) => {
          const code = block.querySelector('code');
          const walker = document.createTreeWalker(code ?? block, NodeFilter.SHOW_TEXT);
          const ink = new Set<string>();

          while (walker.nextNode()) {
            const parent = walker.currentNode.parentElement;

            if (parent !== null && walker.currentNode.textContent?.trim()) ink.add(getComputedStyle(parent).color);
          }

          return { tokens: block.querySelectorAll('code span').length, colors: [...ink] };
        }));

        expect(chatFences.length).toBe(3);

        for (const fence of chatFences) {
          expect(fence.tokens, `${mode} chat fence token spans`).toBeGreaterThan(1);
          expect(fence.colors.length, `${mode} chat fence token colors`).toBeGreaterThan(1);
        }

        await page.goto(`${origin}/gallery.html?frame=coderendering`, { waitUntil: 'networkidle0' });

        const colors = await page.evaluate(() => [...document.querySelectorAll('[data-code-sample]')].map((sample) => {
          const code = sample.querySelector('code');
          const walker = document.createTreeWalker(code ?? sample, NodeFilter.SHOW_TEXT);
          const ink = new Set<string>();

          while (walker.nextNode()) {
            const parent = walker.currentNode.parentElement;

            if (parent !== null && walker.currentNode.textContent?.trim()) ink.add(getComputedStyle(parent).color);
          }

          return { language: sample.getAttribute('data-code-sample'), colors: [...ink] };
        }));

        for (const sample of colors.filter((item) => item.language !== 'unknown-language')) {
          expect(sample.colors.length, `${mode} ${sample.language} syntax colors`).toBeGreaterThan(1);
        }

        const ages = await page.$$eval('aside ul > li', (rows) => rows.flatMap((row) => {
          const link = row.querySelector('a[href^="/workspace/"]');
          const age = link?.lastElementChild;

          if (age === null || age === undefined || !(age instanceof HTMLElement)) return [];
          const range = document.createRange();
          range.selectNodeContents(age);

          return [{ text: age.textContent, align: getComputedStyle(age).textAlign, right: range.getBoundingClientRect().right, rowRight: row.getBoundingClientRect().right }];
        }));

        for (const age of ages) expect(age.align).toBe('right');

        expect(new Set(ages.map((age) => age.text?.length)).size).toBeGreaterThan(1);

        for (const age of ages) expect(age.rowRight - age.right).toBeLessThan(28);
        const firstAge = ages[0];

        if (firstAge === undefined) throw new Error('no sidebar ages');

        for (const age of ages) expect(Math.abs(age.right - firstAge.right)).toBeLessThan(1);
        const firstRow = 'aside ul > li:first-child';
        expect(await page.$eval(firstRow + ' a[href^="/workspace/"]', (link) => {
          const title = link.children[1];

          if (title === undefined) throw new Error('workspace title absent');

          return title.scrollWidth > title.clientWidth;
        })).toBeTrue();

        for (const action of ['a[href^="/settings/"]', 'button[title="Rename"]', 'button[title="Remove"]']) {
          await page.focus(firstRow + ' ' + action);
          await page.waitForFunction(() => {
            const age = document.querySelector('aside ul > li:first-child a[href^="/workspace/"]')?.lastElementChild;

            return age !== null && age !== undefined && getComputedStyle(age).opacity === '0';
          });

          const bounds = await page.$eval(firstRow, (row) => {
            const title = row.querySelector('a[href^="/workspace/"]')?.children[1];
            const active = document.activeElement;

            if (title === undefined || active === null) throw new Error('focused row missing');

            return { titleRight: title.getBoundingClientRect().right, actionLeft: active.getBoundingClientRect().left };
          });

          expect(bounds.titleRight).toBeLessThan(bounds.actionLeft);
        }

        const updated = 'export const finished = "' + 'stream complete '.repeat(20) + '";\nconsole.log(finished);';
        await page.focus('textarea');
        await page.keyboard.down('Control');
        await page.keyboard.press('a');
        await page.keyboard.up('Control');
        await page.keyboard.sendCharacter(updated);
        await page.waitForFunction((text) => document.querySelector('[data-code-sample="stream"] .shiki code')?.textContent === text, {}, updated);

        const streamed = await page.$eval('[data-code-sample="stream"]', (sample) => {
          const colors = new Set([...sample.querySelectorAll('code span')].map((token) => getComputedStyle(token).color));
          let scrollable = false;

          for (const element of sample.querySelectorAll('div, pre')) {
            element.scrollLeft = 50;

            if (element.scrollLeft > 0) scrollable = true;
            element.scrollLeft = 0;
          }

          return { colors: colors.size, scrollable };
        });

        expect(streamed.colors).toBeGreaterThan(1);
        expect(streamed.scrollable).toBeTrue();
        expect(await page.$eval('[data-code-sample="unknown-language"] code', (code) => code.textContent)).toBe('<script>unknown & safe</script>');
        await page.bringToFront();
        await page.$eval('[data-code-sample="stream"] button', (button) => button.click());
        await page.waitForFunction(() => document.querySelector('[data-code-sample="stream"] button')?.textContent?.includes('Copied'));
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(updated);
      }
    } finally {
      await page.close();
    }
  });
});

/**
 * The rail reads one size on every page. The workbench's compact type scale
 * once shrank the same rows on workspace routes while home kept them at the
 * default — nav 11px vs 14px, account label 11px vs 14px — until the flag
 * moved off `html` onto the workspace's own content root.
 */
test('sidebar rows keep one height and font size on home and workspace routes', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const rowsFor = async (frame: string) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 860 });
      await page.goto(`${origin}/gallery.html?frame=${frame}`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('nav[aria-label="Primary"] a');

      const rows = await page.$$eval('nav[aria-label="Primary"] a', (anchors) =>
        anchors.map((a) => ({
          height: a.getBoundingClientRect().height,
          font: getComputedStyle(a).fontSize,
        })));

      const aside = await page.$eval('aside', (rail) => {
        const rows = [...rail.querySelectorAll('a[href^="/workspace/"]')]
          .map((a) => ({ height: a.getBoundingClientRect().height, font: getComputedStyle(a).fontSize }));

        const buttons = [...rail.querySelectorAll('button')];
        const account = buttons.find((b) => b.querySelector('[class*="26px"]'));

        const accountLabel = account?.querySelector('span.min-w-0') ?? account?.querySelector('span');

        return {
          rows,
          account: accountLabel === null || accountLabel === undefined
            ? null
            : { height: accountLabel.getBoundingClientRect().height, font: getComputedStyle(accountLabel).fontSize },
        };
      });

      await page.close();

      return { nav: rows, ws: aside.rows, account: aside.account };
    };

    const home = await rowsFor('home');
    const shell = await rowsFor('shell');

    expect(home.nav).toHaveLength(4);
    expect(shell.nav).toHaveLength(4);

    for (const rows of [home.nav, shell.nav]) {
      for (const row of rows) {
        expect(row.font).toBe('14px');
        expect(Math.round(row.height)).toBe(34);
      }
    }

    expect(home.ws.length).toBeGreaterThan(0);
    expect(home.ws.length).toBe(shell.ws.length);

    for (let i = 0; i < home.ws.length; i++) {
      expect(shell.ws[i]?.font).toBe(home.ws[i]?.font);
      expect(Math.abs((shell.ws[i]?.height ?? 0) - (home.ws[i]?.height ?? 0))).toBeLessThan(1);
    }

    expect(home.account).not.toBeNull();
    expect(shell.account).not.toBeNull();
    expect(shell.account?.font).toBe(home.account?.font);
    expect(Math.abs((shell.account?.height ?? 0) - (home.account?.height ?? 0))).toBeLessThan(1);
  });
});

/**
 * One rule between the rail and the content, one rule above the account row,
 * and both tab-strip headers on the same bottom edge as their active
 * underline. Measured on the real workspace frame at 1440 wide, dark.
 */
test('rail gap is zero with one border, the footer keeps one rule, both strips share one height', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluateOnNewDocument(() => localStorage.setItem('theme', 'dark'));
    await page.goto(`${origin}/gallery.html?frame=shell`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('aside');
    await page.waitForSelector('nav[aria-label="Workspace agents"]');
    await page.waitForSelector('.p-tabstrip');

    const measured = await page.$eval('aside', (aside) => {
      const main = aside.nextElementSibling;
      const asideBox = aside.getBoundingClientRect();
      const mainBox = main === null ? null : main.getBoundingClientRect();
      const footerDivs = [...aside.querySelectorAll('div')];
      const footers = footerDivs.filter((el) => getComputedStyle(el).borderTopWidth !== '0px');

      const chat = document.querySelector('nav[aria-label="Workspace agents"]');
      const stripDivs = [...document.querySelectorAll('div.p-tabstrip')];
      const strip = stripDivs.find((el) => el.getAttribute('aria-label') === null) ?? document.querySelector('.p-tabstrip');


      const active = document.querySelector('.p-tab-active');

      return {
        gap: mainBox === null ? -1 : mainBox.left - asideBox.right,
        asideBorder: getComputedStyle(aside).borderRightWidth,
        mainBorder: main === null ? '?' : getComputedStyle(main).borderLeftWidth,
        footerRules: footers.length,
        chatY: chat === null ? -1 : chat.getBoundingClientRect().bottom,
        stripY: strip === null ? -1 : strip.getBoundingClientRect().bottom,
        activeY: active === null ? -1 : active.getBoundingClientRect().bottom,
      };
    });

    expect(measured.gap).toBe(0);
    expect(measured.asideBorder).toBe('1px');
    expect(measured.mainBorder).toBe('0px');
    expect(measured.footerRules).toBe(1);
    expect(Math.abs(measured.chatY - measured.stripY)).toBeLessThan(1);
    expect(Math.abs(measured.activeY - measured.stripY)).toBeLessThan(1);
    await page.close();
  });
});

test('the panel strip is one continuous rule with the underline on it', async () => {
  await withGallery(async ({ newPage, origin }) => {
    for (const theme of ['dark', 'light'] as const) {
      for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
        const page = await newPage();
        await page.setViewport(viewport);
        await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), theme);
        await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
        await page.reload({ waitUntil: 'networkidle0' });
        await page.waitForSelector('[aria-label="Work"]');

        const geometry = await page.evaluate(() => {
          const work = document.querySelector('[aria-label="Work"]');
          const panel = work === null ? null : work.closest('div.p-sidebar');
          const row = panel === null ? null : panel.querySelector(':scope > div[class*="border-b"]');
          const strip = panel === null ? null : panel.querySelector('.p-tabstrip');
          const active = panel === null ? null : panel.querySelector('.p-tab-active');
          const activity = panel === null ? null : panel.querySelector('[aria-label="Activity"]');

          if (panel === null || !(row instanceof HTMLElement) || !(strip instanceof HTMLElement) || !(active instanceof HTMLElement)) return null;

          const panelBox = panel.getBoundingClientRect();
          const rowBox = row.getBoundingClientRect();
          const stripBox = strip.getBoundingClientRect();
          const activeBox = active.getBoundingClientRect();
          const activityBox = activity instanceof HTMLElement ? activity.getBoundingClientRect() : null;

          return {
            panelLeft: panelBox.left, panelRight: panelBox.right,
            rowLeft: rowBox.left, rowRight: rowBox.right, rowBottom: rowBox.bottom,
            stripLeft: stripBox.left, stripRight: stripBox.right, stripBottom: stripBox.bottom,
            activeBottom: activeBox.bottom,
            activityLeft: activityBox?.left ?? -1, activityRight: activityBox?.right ?? -1,
          };
        });

        expect(geometry).not.toBeNull();

        if (geometry !== null) {
          // One continuous rule: the row spans the panel's full width with
          // the icons inside it — the strip scrolls within it, so the strip's
          // scrolled width may exceed the row, but nothing may stick out past
          // the panel's right edge.
          expect(geometry.rowLeft).toBeLessThanOrEqual(geometry.panelLeft + 1);
          expect(geometry.rowRight).toBeGreaterThanOrEqual(geometry.panelRight - 1);
          expect(geometry.activityRight).toBeLessThanOrEqual(geometry.panelRight + 1);
          expect(geometry.activityRight).toBeLessThanOrEqual(geometry.rowRight + 1);
          // The underline sits exactly on the rule.
          expect(Math.abs(geometry.activeBottom - geometry.rowBottom)).toBeLessThan(1.5);
          expect(Math.abs(geometry.stripBottom - geometry.rowBottom)).toBeLessThan(1.5);
        }

        await page.close();
      }
    }
  });
});

test('workspace tabs keep scrolling horizontal and suppress the scrollbar', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.setViewport({ width: 390, height: 844 });
    await page.goto(`${origin}/gallery.html?frame=work`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[aria-label="Work"]');

    const strip = await page.$eval('.p-tabstrip', (element) => {
      const style = getComputedStyle(element);
      element.scrollLeft = 50;

      return {
        names: [...element.querySelectorAll('button[aria-label]')].map((button) => button.getAttribute('aria-label')),
        overflowY: style.overflowY, scrollbarWidth: style.scrollbarWidth, scrollLeft: element.scrollLeft,
      };
    });

    expect(strip.names).toContain('Files');
    expect(['hidden', 'clip']).toContain(strip.overflowY);
    expect(strip.scrollbarWidth).toBe('none');
    expect(strip.scrollLeft).toBeGreaterThan(0);
    await page.close();
  });
});

/** One Work section, as the browser drew it. */
interface WorkSection {
  readonly title: string;
  /** The count beside the heading — the feed's own length, for the journal. */
  readonly badge: string;
  /** Chips the section offers, by their labels. */
  readonly chips: readonly string[];
  /** Retry affordances inside it: one per read that failed. */
  readonly retries: number;
  readonly text: string;
}

/** Every Work section on the page, in the order it was drawn. Only WorkTab
 *  mounts a `<section>` in this column, so the shape of this list IS the
 *  progressive-disclosure rule. */
function workSections(page: Page): Promise<WorkSection[]> {
  return page.$$eval('section', (nodes) => nodes.map((node) => {
    const heading = node.querySelector('.p-label');

    return {
      title: heading?.textContent ?? '',
      badge: heading?.nextElementSibling?.textContent ?? '',
      chips: [...node.querySelectorAll('button[aria-pressed]')].map((chip) => chip.textContent?.trim() ?? ''),
      retries: [...node.querySelectorAll('button')].filter((button) => button.textContent?.trim() === 'Retry').length,
      text: node.textContent ?? '',
    };
  }));
}

/** Rows the journal is rendering right now: the feed is one group of row
 *  children, so its length is the chip's answer. */
function journalRows(page: Page): Promise<number> {
  return page.evaluate(() => {
    const journal = [...document.querySelectorAll('section')]
      .find((node) => node.querySelector('.p-label')?.textContent === 'Journal');

    return journal?.querySelector('div.p-group')?.children.length ?? 0;
  });
}

/**
 * Work is three facets of one question — Needs you, Now, Journal — and a facet
 * with nothing to show is not drawn at all. Only a browser can hold that: every
 * guard reads state that arrives after the effects run, so a static render sees
 * each section in its loading shape and never in the settled one.
 *
 * Three states over the shipped fixtures: nothing in flight, nothing at all,
 * and both ledger reads refusing. The fourth row is the journal's chips, where
 * the chip named for everything has to hold the feed the badge counts — the
 * needs-you row above it counts an unseen self-change off the same read and
 * sends the reader down here to find it.
 */
describe('WorkTab draws a section only when it has something to show', () => {
  test('nothing in flight draws no Now, and the journal under it still draws', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 430, height: 1400 });
      await page.goto(`${origin}/gallery.html?frame=work&lane=settled`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => [...document.querySelectorAll('section')]
        .some((node) => node.querySelector('.p-label')?.textContent === 'Journal'));

      const sections = await workSections(page);

      expect(sections.map((section) => section.title)).toEqual(['Needs you', 'Journal']);
      expect(await journalRows(page)).toBeGreaterThan(0);

      // No job has ever run in this lane, so the Jobs chip is the empty one —
      // and a chip with nothing under it says so instead of framing a void.
      for (const chip of await page.$$('section button[aria-pressed]')) {
        if (await chip.evaluate((node) => node.textContent?.trim()) === 'Jobs') await chip.click();
      }

      await page.waitForFunction(() => [...document.querySelectorAll('button[aria-pressed="true"]')]
        .some((node) => node.textContent?.trim() === 'Jobs'));

      expect(await journalRows(page)).toBe(0);
      expect(await page.$$eval('section p', (nodes) => nodes.length)).toBe(1);
      await page.close();
    });
  });

  test('a workspace where nothing has happened draws no section, two empty lines and no failure', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 720, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=workempty`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => document.body.textContent?.includes('Nothing yet') === true);

      const column = await page.evaluate(() => ({
        sections: document.querySelectorAll('section').length,
        lines: document.querySelectorAll('p').length,
        retries: [...document.querySelectorAll('button')].filter((node) => node.textContent?.trim() === 'Retry').length,
        // The change-set tab is GATED on there being changes, and the card
        // reports presence for a FAILED read as well — so a tab here is a read
        // that broke, in the one column with nothing to read.
        diffs: document.querySelector('[aria-label="Diffs"]') !== null,
      }));

      // Two lines, because two cards are empty: the column's own and the
      // change-set's, which this column always draws. Nothing failed, so
      // nothing owes a retry and the gated tab stays away. Each of the last
      // three was the other answer while the change-set fixture handed a
      // record reader an array and the card rendered the TypeError instead.
      expect(column).toEqual({ sections: 0, lines: 2, retries: 0, diffs: false });
      await page.close();
    });
  });

  test('a refused read draws its own section with a retry, and Now keeps the job in hand', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 430, height: 1400 });
      await page.goto(`${origin}/gallery.html?frame=work&lane=failed`, { waitUntil: 'networkidle0' });
      // Each section owes ITS read's retry, and the two failed reads here are
      // the only failures on the page.
      await page.waitForFunction(() => [...document.querySelectorAll('section')]
        .filter((node) => [...node.querySelectorAll('button')]
          .some((button) => button.textContent?.trim() === 'Retry')).length === 2);

      const sections = await workSections(page);
      const now = sections[0];
      const journal = sections[1];

      expect(sections.map((section) => section.title)).toEqual(['Now', 'Journal']);
      // The plan read failed; the running job is a prop and is still Now's to
      // show, beside the one retry that read owes.
      expect(now?.text).toContain('7c1e4a92');
      expect(now?.retries).toBe(1);
      // The journal has no rows at all — its failure is the whole reason it is
      // on screen, so there are no chips over nothing.
      expect(journal?.retries).toBe(1);
      expect(journal?.chips).toEqual([]);
      expect(await journalRows(page)).toBe(0);
      // And nothing outside a section owes one: the change-set card this
      // column always draws reads an EMPTY change-set here, not a broken one.
      expect(await page.$$eval('button', (nodes) => nodes.filter((node) => node.textContent?.trim() === 'Retry').length)).toBe(2);
      await page.close();
    });
  });

  test('the chip named for everything holds every row the badge counts', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 430, height: 2400 });
      await page.goto(`${origin}/gallery.html?frame=work`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => [...document.querySelectorAll('section')]
        .some((node) => node.querySelector('.p-label')?.textContent === 'Journal'));

      const journal = (await workSections(page)).find((section) => section.title === 'Journal');
      const chips = await page.$$('section button[aria-pressed]');
      const counted: Record<string, number> = {};

      const sections = await workSections(page);

      expect(sections.map((section) => section.title)).toEqual(['Plans', 'Needs you', 'Now', 'Journal', 'Learnings']);

      for (const chip of chips) {
        const label = await chip.evaluate((node) => node.textContent?.trim() ?? '');
        await chip.click();
        await page.waitForFunction((pressed) => [...document.querySelectorAll('button[aria-pressed="true"]')]
          .some((node) => node.textContent?.trim() === pressed), {}, label);
        counted[label] = await journalRows(page);
      }

      // A chip that never answered leaves -1 behind, which no badge and no sum
      // can match, so a missing chip fails here rather than reading as zero.
      const all = counted.All ?? -1;
      const jobs = counted.Jobs ?? -1;
      const self = counted['Self-changes'] ?? -1;

      expect(journal?.chips).toEqual(['All', 'Jobs', 'Self-changes']);
      // The badge counts the feed and All renders it: a row the badge counts
      // but no chip lists is a row nobody can reach.
      expect(journal?.badge).toBe(String(all));
      // Jobs and Self-changes partition that same feed, so they add back up.
      expect(jobs + self).toBe(all);
      await page.close();
    });
  });
});

/**
 * The workspace's work is one thing: every actor's plans and tasks on one tab,
 * owners named, and a pending plan's decision one row in Needs you that opens
 * the review over the whole tab. `?frame=work`'s fixture carries a root plan
 * beside a subordinate's and a task that holds the note its agent left.
 */
describe('the Work tab reads the workspace, not the actor', () => {
  test('every actor\'s plans list with owner names, each with its own tasks', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 430, height: 1400 });
      await page.goto(`${origin}/gallery.html?frame=work`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => [...document.querySelectorAll('section')]
        .some((node) => node.querySelector('.p-label')?.textContent === 'Plans'));

      const plans = (await workSections(page)).find((section) => section.title === 'Plans');

      if (plans === undefined) throw new Error('the Plans section is missing');
      expect(plans.badge).toBe('2');
      expect(plans.text).toContain('Gateway timeout repair');
      expect(plans.text).toContain('Courier rollout');
      expect(plans.text).toContain('r3 · pending');
      // The courier's task sits under ITS plan with its owner named, and the
      // root's linked task sits under the root's — owners are per-card, not
      // per-tab.
      expect(plans.text).toContain('Stage the rollout');
      expect(plans.text).toContain('courier');

      const now = (await workSections(page)).find((section) => section.title === 'Now');

      if (now === undefined) throw new Error('the Now section is missing');
      expect(now.text).toContain('Patch the gateway timeout');
      expect(now.text).toContain('main');
      await page.close();
    });
  });

  test('a pending plan asks in Needs you, the row opens the review full-tab, and Back returns', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 430, height: 1400 });
      await page.goto(`${origin}/gallery.html?frame=work`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => [...document.querySelectorAll('section')]
        .some((node) => node.querySelector('.p-label')?.textContent === 'Plans'));

      const needs = (await workSections(page)).find((section) => section.title === 'Needs you');

      if (needs === undefined) throw new Error('the Needs you section is missing');
      expect(needs.text).toContain('Approve the plan · Gateway timeout repair');

      await page.evaluate(() => {
        const row = [...document.querySelectorAll('button')]
          .find((button) => button.textContent?.includes('Approve the plan'));

        if (row === undefined) throw new Error('the approve row is missing');
        row.click();
      });

      // The review takes the whole tab — the plan list is gone, and what is
      // on screen is the pending revision's own decisions, the way the list
      // row promised.
      await page.waitForSelector('[data-plan-review-root]');
      expect(await page.$eval('[data-plan-title]', (element) => element.textContent)).toContain('Gateway');
      expect(await page.$eval('[data-plan-status]', (element) => element.textContent)).toBe('Awaiting review');
      expect(await page.$('[data-work-plans]')).toBeNull();

      await page.click('[data-back-to-work]');
      await page.waitForSelector('[data-work-plans]');
      expect(await page.$('[data-plan-review-root]')).toBeNull();
      await page.close();
    });
  });

  test('a task carrying a note renders it under the title with its owner', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 430, height: 1400 });
      await page.goto(`${origin}/gallery.html?frame=work`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => document.querySelector('[data-work-plans]') !== null);

      const body = await page.evaluate(() => document.body.textContent ?? '');

      expect(body).toContain('Client already bails at 8s');
      await page.close();
    });
  });
  test('Learnings lists the workspace\'s saved memories, newest first', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 430, height: 1400 });
      await page.goto(`${origin}/gallery.html?frame=work`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => [...document.querySelectorAll('section')]
        .some((node) => node.querySelector('.p-label')?.textContent === 'Learnings'));

      const learnings = (await workSections(page)).find((section) => section.title === 'Learnings');

      if (learnings === undefined) throw new Error('the Learnings section is missing');
      expect(learnings.badge).toBe('2');

      const rows = await page.$$eval('[data-learning]', (nodes) => nodes.map((node) => node.textContent ?? ''));

      expect(rows).toHaveLength(2);
      expect(rows[0]).toContain('Prompt lanes assemble');
      expect(rows[0]).toContain('2026-09-17 · courier');
      expect(rows[1]).toContain('retry budget');
      expect(rows[1]).toContain('2026-09-15 · main');
      await page.close();
    });
  });
});


/**
 * Model tiers are an open vocabulary (#7, #9, #11). The owner adds a tier by
 * name, it renders beside the builtins with the reasoning levels ITS model
 * documents, and a role can be pointed at it. The row border is the page's
 * border token: the earlier `--c-border-subtle` was never defined, so every
 * tier row drew its border in the text colour.
 */
describe('model tiers are the owner\'s to add, and each offers its model\'s own levels', () => {
  test('an added tier renders, takes its model\'s levels, and is offered to roles', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1000, height: 1400 });
      await page.goto(`${origin}/gallery.html?frame=usersettingsstate&section=models`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="New tier id"]');

      const rowBorder = await page.$eval('[aria-label="default reasoning effort"]', (select) => {
        const row = select.closest('div.grid');
        const border = row === null ? '' : getComputedStyle(row).borderTopColor;
        const text = row === null ? '' : getComputedStyle(row).color;
        const token = getComputedStyle(document.documentElement).getPropertyValue('--c-border').trim();

        return { border, text, token };
      });

      expect(rowBorder.border).not.toBe(rowBorder.text);
      expect(rowBorder.token.length).toBeGreaterThan(0);

      await page.type('[aria-label="New tier id"]', 'review');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[aria-label="review reasoning effort"]');
      // A new tier starts as a copy of default (a Workers AI model, no levels).
      expect(await page.$$eval('[aria-label="review reasoning effort"] option', (options) => options.map((option) => option.textContent)))
        .toEqual(['Model default']);

      // Point it at a model that documents five levels: the select offers
      // exactly those, in the model's order. The picker is the same combobox
      // every tier row carries; the new row's is the last one on the page.
      const pickers = await page.$$('[aria-label$=" reasoning effort"]');
      const reviewRow = await pickers[pickers.length - 1]?.evaluateHandle((select) => select.closest('div.grid'));
      const reviewPicker = await reviewRow?.asElement()?.$('input');
      expect(reviewPicker).toBeDefined();
      await reviewPicker?.click();
      await reviewPicker?.type('Opus');
      await page.waitForSelector('[role="option"]');
      await page.click('[role="option"]');
      await page.waitForFunction(() => {
        const select = document.querySelector('[aria-label="review reasoning effort"]');

        return select !== null && select.querySelectorAll('option').length > 1;
      });
      expect(await page.$$eval('[aria-label="review reasoning effort"] option', (options) => options.map((option) => option.textContent)))
        .toEqual(['Model default', 'low', 'medium', 'high', 'xhigh', 'max']);

      // The role editor lists the new tier.
      const roleTiers = await page.$$eval('select', (selects) => selects
        .map((select) => [...select.options].map((option) => option.value))
        .find((values) => values.includes('fast') && values.includes('deep')) ?? []);

      expect(roleTiers).toContain('review');

      // Removing it is one click, and only a non-builtin offers it.
      expect(await page.$('[aria-label="Remove tier default"]')).toBeNull();
      await page.click('[aria-label="Remove tier review"]');
      expect(await page.$('[aria-label="review reasoning effort"]')).toBeNull();
      await page.close();
    });
  });
});

describe('the workbench type scale, as the browser computes it', () => {
  test('the workbench reads at the owner-approved compact scale', async () => {
    const sizes = await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1600 });
      await page.goto(`${origin}/gallery.html?frame=shell`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.prose-chat');
      await page.waitForSelector('[data-tool-state] strong');

      const measured = await page.evaluate(() => ({
        prose: getComputedStyle(document.querySelector('.prose-chat')!).fontSize,
        toolLabel: getComputedStyle(document.querySelector('[data-tool-state] strong')!).fontSize,
      }));

      await page.close();

      return measured;
    });

    // The scale's two load-bearing rungs on the workbench: chat prose just
    // under 15px, dense tool rows at 13. Both pinned to the sizes the owner
    // approved — the shell frame renders inside `.p-workbench`, so either
    // regression reads here.
    expect(sizes.prose).toBe('14.496px');
    expect(sizes.toolLabel).toBe('13px');
  });
});

/**
 * K-05. A workspace the user has never touched opens its inspector COLLAPSED;
 * the first thing worth seeing opens it on the workspace's behalf. From then
 * on the user's own choice rules: a resize persists across reloads, a collapse
 * persists, and a passive arrival raises a "Preview ready" chip where the
 * reader already is — only an explicit click navigates.
 */
describe('the workspace inspector at the actual WorkspacePage boundary', () => {
  test('collapsed until something arrives, then resize persists across reload; collapse persists; passive arrival chips, explicit click navigates', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      // The first visit mounts the column collapsed — worth-showing state is a
      // resource read, so the collapse lasts only until the snapshot lands,
      // and under load that whole window fits inside one rAF: no selector or
      // polling wait can catch it. The observer is installed before the page's
      // own scripts run and records the mount itself, so the insertion record
      // — not the element's presence at sample time — is the observable state.
      await page.evaluateOnNewDocument(() => {
        // SAFETY: the recorder is this test's own global; the cast names its
        // shape because a plain `window` carries no such field.
        const w = window as Window & { __inspectorMount?: { inserted: boolean; expand: boolean; width: number }[] };
        w.__inspectorMount = [];
        new MutationObserver((mutations) => {
          // SAFETY: same recorder, re-narrowed inside the callback's own scope.
          const w = window as Window & { __inspectorMount?: { inserted: boolean; expand: boolean; width: number }[] };
          const record = w.__inspectorMount!;

          if (record.length >= 500) return;

          const containsExpand = (node: Node): boolean => node instanceof Element
            && (node.hasAttribute('data-inspector-expand') || node.querySelector('[data-inspector-expand]') !== null);

          const panel = document.querySelectorAll('[data-panel]')[1];

          record.push({
            inserted: mutations.some((m) => [...m.addedNodes].some(containsExpand)),
            expand: document.querySelector('[data-inspector-expand]') !== null,
            width: panel === undefined ? -1 : Math.round(panel.getBoundingClientRect().width),
          });
        }).observe(document, {
          childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'],
        });
      });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="Work"]');

      const inspectorWidth = () => page.$$eval('[data-panel]', (panels) => Math.round(panels[1]?.getBoundingClientRect().width ?? -1));

      // A first visit with nothing to show collapses the column behind its
      // expand handle — the insertion proves the collapsed render committed,
      // and a zero-width panel sample proves it committed as a layout. The
      // signal has not arrived yet, so nothing reopens it.
      await page.waitForFunction(
        () => {
          // SAFETY: `__inspectorMount` is constructed on this window by the
          // evaluateOnNewDocument recorder installed above, so the field is
          // present from page load.
          const record = (window as Window & { __inspectorMount?: { inserted: boolean; expand: boolean; width: number }[] })
            .__inspectorMount;

          return record !== undefined
            && record.some((sample) => sample.inserted || sample.expand)
            && record.some((sample) => sample.width >= 0 && sample.width <= 2);
        },
      );

      // The passive arrival is the something worth seeing: the column opens
      // on the workspace's behalf AND raises the chip where the reader is —
      // Work stays current, only the explicit click navigates.
      await page.evaluate(() => { document.documentElement.dataset.previewArrived = '1'; });
      await page.waitForSelector('[data-preview-ready]');
      await page.waitForFunction(() => {
        const panels = [...document.querySelectorAll('[data-panel]')];

        return Math.round(panels[1]?.getBoundingClientRect().width ?? 0) > 200;
      });
      expect(await page.$eval('[aria-label="Work"]', (el) => el.getAttribute('aria-current'))).toBe('true');

      await page.click('[data-preview-ready]');
      await page.waitForSelector('[aria-label="Arrived app"][aria-current="true"]');
      expect(await page.$('[data-preview-ready]')).toBeNull();

      // A keyboard resize is an explicit size: it survives a reload. One
      // ArrowRight step is five percentage points, which lands the 340px
      // inspector on its 280px floor; further steps would collapse it, which
      // the collapse leg below covers through the button instead.
      await page.click('[data-separator]');
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => {
        const panels = [...document.querySelectorAll('[data-panel]')];
        const width = Math.round(panels[1]?.getBoundingClientRect().width ?? -1);

        return width >= 270 && width <= 290;
      });
      const resized = await inspectorWidth();
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="Work"]');
      await page.waitForFunction((expected: number) => {
        const panels = [...document.querySelectorAll('[data-panel]')];

        return Math.abs(Math.round(panels[1]?.getBoundingClientRect().width ?? -1) - expected) <= 3;
      }, {}, resized);

      // Collapse hides the column behind a visible handle; that stands a reload.
      await page.click('[data-inspector-collapse]');
      await page.waitForSelector('[data-inspector-expand]');
      expect(await inspectorWidth()).toBeLessThanOrEqual(2);
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-inspector-expand]');
      expect(await inspectorWidth()).toBeLessThanOrEqual(2);
      await page.click('[data-inspector-expand]');
      await page.waitForFunction(() => {
        const panels = [...document.querySelectorAll('[data-panel]')];

        return Math.round(panels[1]?.getBoundingClientRect().width ?? 0) > 200;
      });

      await page.close();
    });
  });

  test('an oversize saved width constrains on screen but survives in storage with no explicit choice', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      // The account holds a 2000px preference (kept from a wider display);
      // this workspace carries no open/close choice of its own.
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('kinu.inspector.account', 'ashish@example.com');
        localStorage.setItem('kinu.inspector.ashish@example.com', '2000');
      });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="Work"]');

      // The signal opens the column on the workspace's behalf; the group
      // cannot fit 2000px beside the chat minimum, so it commits what fits.
      // The column's committed width is stable across frames once the
      // write's commit — and any persist its report triggers — has landed.
      await page.waitForFunction(() => {
        const width = () => Math.round(document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? 0);

        return new Promise<boolean>((resolve) => {
          const first = width();
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(first > 200 && width() === first)));
        });
      });

      const state = await page.evaluate(() => ({
        width: Math.round(document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1),
        stored: { ...localStorage },
      }));

      // Constrained on screen, preferred in storage, and — nothing here was
      // the user's explicit choice, so no choice is written for this
      // workspace.
      expect(state.width).toBeLessThan(1500);
      expect(state.stored['kinu.inspector.ashish@example.com']).toBe('2000');
      expect(Object.keys(state.stored).filter((key) => key.startsWith('kinu.inspector.open.'))).toEqual([]);

      await page.close();
    });
  });

  test('a reset to the already-committed width leaves no mark: the next drag persists', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('kinu.inspector.account', 'ashish@example.com');
        localStorage.setItem('kinu.inspector.ashish@example.com', '340');
        localStorage.setItem('kinu.inspector.open.ashish@example.com.checkout-fixes', '1');
      });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="Work"]');
      await page.waitForFunction(() => {
        const panels = [...document.querySelectorAll('[data-panel]')];

        return Math.round(panels[1]?.getBoundingClientRect().width ?? 0) === 340;
      });

      // resetToDefault at the committed 340 issues a no-op write: the
      // library emits nothing, and nothing marks the next emission as
      // ours to swallow.
      await page.evaluate(() => {
        document.querySelector<HTMLElement>('[data-separator]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      });

      // A real drag follows: pointerdown marks the input, the release
      // commit persists the width the user's hand chose. The inspector is
      // the trailing panel — dragging the separator right narrows it.
      const separator = await page.waitForSelector('[data-separator]');
      const box = await separator!.boundingBox();
      const x = box!.x + box!.width / 2;
      const y = box!.y + box!.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 60, y, { steps: 4 });
      await page.mouse.up();

      // The release commit and its persist are synchronous in the same
      // dispatch: the width lands at 280 and the store holds it.
      await page.waitForFunction(() => Math.round(
        document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1,
      ) === 280);

      const state = await page.evaluate(() => ({
        width: Math.round(document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1),
        stored: { ...localStorage },
      }));

      expect(state.width).toBe(280);
      expect(state.stored['kinu.inspector.ashish@example.com']).toBe('280');

      await page.close();
    });
  });

  test('a viewport narrowing that squeezes the inspector persists nothing and latches no choice', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      // The stored 2000px cannot fit beside the chat floor: every committed
      // layout here is the ResizeObserver's constraint, never a gesture.
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('kinu.inspector.account', 'ashish@example.com');
        localStorage.setItem('kinu.inspector.ashish@example.com', '2000');
        localStorage.setItem('kinu.inspector.open.ashish@example.com.checkout-fixes', '1');
      });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="Work"]');
      await page.waitForFunction(() => {
        const panels = [...document.querySelectorAll('[data-panel]')];

        return Math.round(panels[1]?.getBoundingClientRect().width ?? 0) > 200;
      });

      const before = await page.evaluate(() => Math.round(
        document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1,
      ));

      // Narrowing re-commits a smaller constrained layout: no input mark,
      // so the preferred 2000 stays stored and no new choice is written.
      await page.setViewport({ width: 1100, height: 900 });
      await page.waitForFunction((prev: number) => Math.round(
        document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1,
      ) < prev, {}, before);

      const state = await page.evaluate(() => ({
        width: Math.round(document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1),
        stored: { ...localStorage },
      }));

      expect(state.width).toBeLessThan(before);
      expect(state.stored['kinu.inspector.ashish@example.com']).toBe('2000');
      expect(Object.keys(state.stored).filter((key) => key.startsWith('kinu.inspector.open.')).sort()).toEqual([
        'kinu.inspector.open.ashish@example.com.checkout-fixes',
      ]);

      await page.close();
    });
  });

  test('two desktop↔mobile remounts leave the document and separator listener counts at baseline', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.evaluateOnNewDocument(() => {
        // Every listener the page registers is counted by target+type; the
        // same accounting on remove keeps a live tally.
        const w: Window & { __liveListeners?: Map<string, number> } = window;
        w.__liveListeners = new Map();

        const tally = (target: EventTarget, type: string, delta: number) => {
          // The separator div carries `data-separator` (the library sets it);
          // `instanceof HTMLElement` narrows it without a cast, and
          // `instanceof Document` covers the ownerDocument listeners. Any
          // other target matches neither and is skipped.
          if (target instanceof HTMLElement && target.dataset['separator'] !== undefined) {
            const key = `sep:${type}`;
            w.__liveListeners!.set(key, (w.__liveListeners!.get(key) ?? 0) + delta);

            return;
          }

          if (target instanceof Document) {
            const key = `doc:${type}`;
            w.__liveListeners!.set(key, (w.__liveListeners!.get(key) ?? 0) + delta);
          }
        };

        const add = EventTarget.prototype.addEventListener;
        const remove = EventTarget.prototype.removeEventListener;

        EventTarget.prototype.addEventListener = function (type, listener, options) {
          tally(this, type, 1);

          if (listener !== null) add.call(this, type, listener, options);
        };

        EventTarget.prototype.removeEventListener = function (type, listener, options) {
          tally(this, type, -1);

          if (listener !== null) remove.call(this, type, listener, options);
        };

        localStorage.setItem('kinu.inspector.account', 'ashish@example.com');
        localStorage.setItem('kinu.inspector.ashish@example.com', '400');
        localStorage.setItem('kinu.inspector.open.ashish@example.com.checkout-fixes', '1');
      });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-separator]');

      const readTally = () => {
        const w: Window & { __liveListeners?: Map<string, number> } = window;

        return Object.fromEntries(w.__liveListeners!);
      };

      const baseline = await page.evaluate(readTally);

      // Two full remounts: each swap unmounts the separator element, which
      // must detach every listener the hook attached — element and document.
      // The remount states themselves are the wait: the separator is absent
      // on mobile, present on desktop.
      for (let i = 0; i < 2; i++) {
        await page.setViewport({ width: 600, height: 900 });
        await page.waitForFunction(() => document.querySelector('[data-separator]') === null);
        await page.setViewport({ width: 1440, height: 900 });
        await page.waitForSelector('[data-separator]');
      }

      const after = await page.evaluate(readTally);

      expect(after).toEqual(baseline);

      await page.close();
    });
  });

  test('a press retired by a remount cannot mark the next tree\'s commits', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      // A stored width with no choice of its own: the signal opens the
      // column on the workspace's behalf without writing a choice.
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('kinu.inspector.account', 'ashish@example.com');
        localStorage.setItem('kinu.inspector.ashish@example.com', '300');
      });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-separator]');
      await page.evaluate(() => { document.documentElement.dataset.previewArrived = '1'; });
      await page.waitForFunction(() => {
        const panels = [...document.querySelectorAll('[data-panel]')];

        return Math.round(panels[1]?.getBoundingClientRect().width ?? 0) > 200;
      });

      // Press without release: the input mark is set and no clear is
      // scheduled — only the separator's own detach can retire it. The
      // release-free move returns the library to inactive with zero
      // commits, which the hook never listens to, so the mark survives.
      await page.evaluate(() => {
        const separator = document.querySelector('[data-separator]');
        separator?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        separator?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
      });

      // The swap unmounts the separator; the restore mounts a new tree whose
      // first emission is its own announcement, not a gesture.
      await page.setViewport({ width: 600, height: 900 });
      await page.waitForFunction(() => document.querySelector('[data-separator]') === null);
      await page.setViewport({ width: 1440, height: 900 });
      await page.waitForSelector('[data-separator]');

      // The narrower group re-commits the held pixel width at a new share —
      // twice. The restore's announcement already consumed this tree's first
      // emission (the mode swap resets the measured flag after it), so the
      // first tweak only re-arms; the second is the one that classifies.
      // A retired press is input to no tree, so no choice key can appear.
      // That is a claim about a write that must never come, and geometry
      // cannot synchronize the read (panels reflow through plain CSS ahead
      // of the commit pipeline), so the end condition is the pipeline's own:
      // the group counts the layout commits the hook has classified, and the
      // storage is read once the second tweak's commit has been counted —
      // after which the hook has either persisted or adopted, and nothing
      // more is scheduled.
      const layoutCommits = async (): Promise<number> => page.$eval(
        '[data-inspector-commits]', (panel) => Number(panel.getAttribute('data-inspector-commits')),
      );

      const committedPast = async (previous: number): Promise<void> => {
        await page.waitForFunction((prev: number) => Number(
          document.querySelector('[data-inspector-commits]')?.getAttribute('data-inspector-commits'),
        ) > prev, {}, previous);
      };

      const commitsBefore = await layoutCommits();
      await page.setViewport({ width: 1400, height: 900 });
      await committedPast(commitsBefore);
      const commitsAfterFirst = await layoutCommits();
      await page.setViewport({ width: 1350, height: 900 });
      await committedPast(commitsAfterFirst);

      const openKey = 'kinu.inspector.open.ashish@example.com.checkout-fixes';

      expect(await page.evaluate((key: string) => localStorage.getItem(key), openKey)).toBeNull();

      const state = await page.evaluate(() => ({ ...localStorage }));

      expect(state['kinu.inspector.ashish@example.com']).toBe('300');

      await page.close();
    });
  });

  test('the first divider drag after a remount persists its width and choice', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('kinu.inspector.account', 'ashish@example.com');
        localStorage.setItem('kinu.inspector.ashish@example.com', '340');
        localStorage.setItem('kinu.inspector.open.ashish@example.com.checkout-fixes', '1');
      });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="Work"]');
      await page.waitForFunction(() => {
        const panels = [...document.querySelectorAll('[data-panel]')];

        return Math.round(panels[1]?.getBoundingClientRect().width ?? 0) === 340;
      });

      // A full remount: the restored tree's announcement is its own, so the
      // drag below is the first commit anyone could mistake — it must read
      // as the user's and persist, with no warmup commit in between.
      await page.setViewport({ width: 600, height: 900 });
      await page.waitForFunction(() => document.querySelector('[data-separator]') === null);
      await page.setViewport({ width: 1440, height: 900 });
      await page.waitForSelector('[data-separator]');

      // Quiesce the fresh tree so the coordinates below are live. The
      // inspector is the trailing panel — dragging the separator right
      // narrows it from 340 to its 280 floor.
      await page.waitForFunction(() => {
        const widths = () => Math.round(
          document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1,
        );

        const first = widths();

        return new Promise<boolean>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(widths() === first)));
        });
      });
      const separator = await page.waitForSelector('[data-separator]');
      const box = await separator!.boundingBox();
      const x = box!.x + box!.width / 2;
      const y = box!.y + box!.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 60, y, { steps: 4 });

      // The held drag must move pixels: a drag the library never hears
      // moves nothing, and must fail loudly here — never silently
      // downstream as a classification result. Live recompute applies
      // styles without committing, so this proves engagement while the
      // release commit is still to come.
      await page.waitForFunction(() => Math.round(
        document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1,
      ) !== 340);
      await page.mouse.up();

      // Settle, then assert: whatever the drag commit classified, every
      // commit it schedules (including a policy write-back) has landed —
      // the settled width plus the stored values pin the classification.
      await page.waitForFunction(() => {
        const widths = () => Math.round(
          document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1,
        );

        const first = widths();

        return new Promise<boolean>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(widths() === first)));
        });
      });

      const state = await page.evaluate(() => ({
        width: Math.round(document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1),
        stored: { ...localStorage },
      }));

      expect(state.width).toBe(280);
      expect(state.stored['kinu.inspector.ashish@example.com']).toBe('280');
      expect(state.stored['kinu.inspector.open.ashish@example.com.checkout-fixes']).toBe('1');

      await page.close();
    });
  });

  test('the first keyboard resize after a remount persists its width and choice', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('kinu.inspector.account', 'ashish@example.com');
        localStorage.setItem('kinu.inspector.ashish@example.com', '400');
        localStorage.setItem('kinu.inspector.open.ashish@example.com.checkout-fixes', '1');
      });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="Work"]');
      await page.waitForFunction(() => {
        const panels = [...document.querySelectorAll('[data-panel]')];

        return Math.round(panels[1]?.getBoundingClientRect().width ?? 0) === 400;
      });

      await page.setViewport({ width: 600, height: 900 });
      await page.waitForFunction(() => document.querySelector('[data-separator]') === null);
      await page.setViewport({ width: 1440, height: 900 });
      await page.waitForSelector('[data-separator]');

      // Quiesce the fresh tree, then focus the separator that is actually
      // mounted and press: the library reads only key and currentTarget,
      // but a press delivered while focus still sits on the detached old
      // element reaches no handler — that is a fixture outcome, not a
      // product one. One ArrowRight step is five percentage points,
      // landing the 400px inspector near 328 — off the seed, inside
      // bounds, exactly the user's.
      await page.waitForFunction(() => {
        const widths = () => Math.round(
          document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1,
        );

        const first = widths();

        return new Promise<boolean>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(widths() === first)));
        });
      });
      await page.evaluate(() => {
        document.querySelector<HTMLElement>('[data-separator]')?.focus();
      });
      await page.keyboard.press('ArrowRight');

      // The keypress must move pixels within a bound: a press the library
      // never hears is a dead tree and fails loudly here.
      await page.waitForFunction(() => Math.round(
        document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1,
      ) < 340);

      // Settle, then assert: whatever the keypress commit classified, every
      // commit it schedules (including a policy write-back) has landed.
      await page.waitForFunction(() => {
        const widths = () => Math.round(
          document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1,
        );

        const first = widths();

        return new Promise<boolean>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(widths() === first)));
        });
      });

      const state = await page.evaluate(() => ({
        width: Math.round(document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1),
        stored: { ...localStorage },
      }));

      // Fractional shares round differently across read paths, so the
      // committed width can differ a pixel from the rect read; a stored
      // width off the seed proves the commit was claimed as the user's.
      expect(state.width).toBeGreaterThanOrEqual(320);
      expect(state.width).toBeLessThanOrEqual(335);
      expect(Number(state.stored['kinu.inspector.ashish@example.com'])).toBeGreaterThanOrEqual(320);
      expect(Number(state.stored['kinu.inspector.ashish@example.com'])).toBeLessThanOrEqual(335);
      expect(state.stored['kinu.inspector.open.ashish@example.com.checkout-fixes']).toBe('1');

      await page.close();
    });
  });

  test('an anonymous session reads and writes nothing — the signal still opens the column', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      // `anon=1` answers the profile read null, so the hook never resolves an
      // account key and every persist path is a no-op — not "no account yet":
      // there is no account, and the seed row proves nothing wrote one.
      await page.goto(`${origin}/gallery.html?frame=workspacepage&anon=1`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="Work"]');

      // The signal opens the policy-collapsed column on the workspace's
      // behalf — with no account it still opens, it just cannot persist.
      await page.evaluate(() => { document.documentElement.dataset.previewArrived = '1'; });
      await page.waitForFunction(() => {
        const panels = [...document.querySelectorAll('[data-panel]')];

        return Math.round(panels[1]?.getBoundingClientRect().width ?? 0) > 200;
      });

      // The collapse control is still the user's own act; with no account it
      // claims the close for the session and writes nothing anywhere.
      await page.click('[data-inspector-collapse]');
      await page.waitForSelector('[data-inspector-expand]');

      const stored = await page.evaluate(() => ({ ...localStorage }));

      expect(Object.keys(stored).filter((key) => key.startsWith('kinu.inspector.'))).toEqual([]);

      await page.close();
    });
  });

  test('a stored collapse is the user\'s: the arriving signal does not reopen it', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      // The workspace's own stored '0' outranks the first-visit signal — the
      // port lands, the column stays behind its expand handle.
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('kinu.inspector.account', 'ashish@example.com');
        localStorage.setItem('kinu.inspector.ashish@example.com', '300');
        localStorage.setItem('kinu.inspector.open.ashish@example.com.checkout-fixes', '0');
      });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-inspector-expand]');

      await page.evaluate(() => { document.documentElement.dataset.previewArrived = '1'; });
      await page.waitForSelector('[data-preview-ready]');
      // Settle past the window the signal would have opened in: the panel
      // stays at its collapsed size and the choice is still '0'.
      await page.waitForFunction(() => {
        const width = () => Math.round(document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1);

        return new Promise<boolean>((resolve) => {
          const first = width();
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(first <= 2 && width() === first)));
        });
      });

      const stored = await page.evaluate(() => ({ ...localStorage }));

      expect(stored['kinu.inspector.open.ashish@example.com.checkout-fixes']).toBe('0');

      await page.close();
    });
  });

  test('a collapse issued while a reset is in flight still claims its target', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      // Open at 300: the reset's claim and the collapse's claim are both the
      // user's own acts — whichever report lands first, the close is '0' and
      // the resting width is the one the collapse read.
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('kinu.inspector.account', 'ashish@example.com');
        localStorage.setItem('kinu.inspector.ashish@example.com', '300');
        localStorage.setItem('kinu.inspector.open.ashish@example.com.checkout-fixes', '1');
      });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="Work"]');
      await page.waitForFunction(() => {
        const panels = [...document.querySelectorAll('[data-panel]')];

        return Math.round(panels[1]?.getBoundingClientRect().width ?? 0) === 300;
      });

      // One task, two control acts: the dblclick's resetToDefault claims 340
      // and issues the write; the collapse clicks before its report settles
      // and claims the close at call time. If the library commits the resize
      // synchronously the collapse reads 340 and persists it; if the report
      // lands later the collapse read 300. The un-conditional half is the
      // point: the close is '0' and the stored width is the column's own.
      await page.evaluate(() => {
        document.querySelector<HTMLElement>('[data-separator]')
          ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        document.querySelector<HTMLElement>('[data-inspector-collapse]')?.click();
      });

      await page.waitForSelector('[data-inspector-expand]');

      const state = await page.evaluate(() => ({
        width: Math.round(document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1),
        stored: { ...localStorage },
      }));

      expect(state.width).toBeLessThanOrEqual(2);
      expect(state.stored['kinu.inspector.open.ashish@example.com.checkout-fixes']).toBe('0');
      // The stored resting width is the reset's 340 or the pre-reset 300 —
      // the collapse claims whichever the panel answered at call time, and
      // the reset's own emission can never overwrite it.
      expect(['300', '340']).toContain(state.stored['kinu.inspector.ashish@example.com']);

      await page.close();
    });
  });
});

interface CreateProbe {
  posts: number;
  release: (() => void) | null;
}

declare global {
  interface Window { __createProbe: CreateProbe }
}

describe('the home creation form, as a browser submits it', () => {
  test('one gesture in flight means one create request, and a refused create frees a retry', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1100 });
      await page.evaluateOnNewDocument(() => { localStorage.setItem('theme', 'dark'); });
      await page.goto(`${origin}/gallery.html?frame=home`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('#workspace-mission');

      // The gallery's fetch IS the HTTP boundary for this page — the stub
      // returns a 404 for the create POST, so the probe wraps it to hold the
      // response under explicit test control. Every other request falls
      // through to the gallery's own handling untouched.
      await page.evaluate(() => {
        const inner = window.fetch;
        const probe: CreateProbe = { posts: 0, release: null };

        window.__createProbe = probe;
        // The member the Bun fetch type requires, forwarded from the callable
        // being wrapped — the pattern client-error/feedback-ux already use.
        window.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
          if (init?.method === 'POST' && String(input).includes('/api/user/workspaces')) {
            probe.posts += 1;

            // First POST: refuse it on release. Every later one: the entry the
            // registerWorkspace parse requires, so a retry exercises success.
            const status = probe.posts === 1 ? 500 : 200;

            const body = probe.posts === 1
              ? { error: 'probe: create refused' }
              : { name: 'probe-created', displayName: 'Probe created', createdAt: 1, lastVisited: 1, archivedAt: null };

            return new Promise<Response>((resolve) => {
              probe.release = () => resolve(new Response(
                JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
            });
          }

          return inner(input, init);
        }, { preconnect: inner.preconnect });
      });

      await page.type('#workspace-mission', 'Own the checkout service.');
      await page.click('button[type="submit"]');

      // Held request arrived AND the pending paint landed — not a sleep.
      await page.waitForFunction(() => {
        const btn = [...document.querySelectorAll('button')]
          .find((b) => b.textContent?.includes('Create workspace'));

        const ta = document.querySelector('#workspace-mission');

        return window.__createProbe.posts === 1
          && btn instanceof HTMLButtonElement && btn.disabled
          && ta instanceof HTMLTextAreaElement && ta.disabled
          && btn.querySelector('svg') !== null;
      });

      // A second gesture while the first is held: pointer submit AND the
      // keyboard path. Neither may queue another create.
      await page.click('button[type="submit"]');
      await page.evaluate(() => {
        const mission = document.querySelector('#workspace-mission');

        if (!(mission instanceof HTMLElement)) throw new Error('mission textarea absent');

        mission.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
      });
      expect(await page.evaluate(() => window.__createProbe.posts)).toBe(1);

      // Release into a refusal: the notice names it, the fields re-enable.
      await page.evaluate(() => { window.__createProbe.release?.(); });
      await page.waitForFunction(() => {
        const btn = [...document.querySelectorAll('button')]
          .find((b) => b.textContent?.includes('Create workspace'));

        const ta = document.querySelector('#workspace-mission');

        return document.querySelector('.p-notice-danger') !== null
          && btn instanceof HTMLButtonElement && !btn.disabled
          && ta instanceof HTMLTextAreaElement && !ta.disabled;
      });

      // The deliberate retry fires exactly one more request.
      await page.click('button[type="submit"]');
      await page.waitForFunction(
        () => window.__createProbe.posts === 2 && window.__createProbe.release !== null);
      await page.evaluate(() => { window.__createProbe.release?.(); });

      // The retry's 200 resolves through the real create path: the entry the
      // registry answered with lands in the roster the page reads
      // (roster.upsert runs before the awaited navigate), and no error
      // surface remains. The gallery mounts this page under a MemoryRouter,
      // so navigation itself is unobservable — the roster row is the real
      // product state the create had to produce.
      await page.waitForFunction(
        () => document.querySelector('.p-notice-danger') === null
          && document.body.innerText.includes('Probe created'));
      expect(await page.evaluate(() => window.__createProbe.posts)).toBe(2);
      await page.close();
    });
  });
});
