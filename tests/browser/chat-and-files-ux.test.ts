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
import { Effect } from 'effect';
import { detach } from '@kinu.run/core/obs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'puppeteer';

import { withGallery } from '../../scripts/gallery-harness';
import { CHECKPOINTS_UNAVAILABLE_NO_GIT, executorLabel, parseJsonValue, redactPayload, type JsonObject } from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';


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
  readonly reasoning: { viewportHeight: number; lineHeight: number; pulse: string; textAnimation: string } | null;
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
  /** Each failure card by its state (`live`, `refused`): its headline, its border's paint, and whether it offers the turn again. */
  readonly chatErrors: Record<string, { readonly heading: string; readonly border: string; readonly retry: boolean }>;
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
  /** /home/main rows after renaming SOUL.md → CREDO.md, then after deleting
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
  /** Every `input` frame the pane sent the workspace shell, in order. */
  readonly terminalInput: string[];
  /** Exploration's run-node rows on the mixed-status run, by node id. */
  readonly runNodes: Record<string, RunNode>;
  readonly toolActivity: {
    /** Call rows drawn before the reader clicks anything, and once the fold's
     *  control is pressed, each split into reads and everything else. */
    folded: ToolRows;
    unfolded: ToolRows;
    /** The one control standing for the calls a fold holds back, by its words. */
    foldLabel: string | null;
    /** What the preview card shows while the run is still folded. */
    collapsedPreview: { text: string | null; visible: boolean };
  };
}

/** The call rows a message draws: how many read, how many did anything else,
 *  and every row's height, so "the same compact row" is a measurement. */
interface ToolRows {
  readonly reads: number;
  readonly others: number;
  readonly heights: readonly number[];
}

/** The call rows on the page now, by the effect each row declares. Runs in
 *  the page. */
function toolRows(): ToolRows {
  const rows = [...document.querySelectorAll<HTMLElement>('[data-tool-state]')];

  return {
    reads: rows.filter((row) => row.dataset.toolEffect === 'read').length,
    others: rows.filter((row) => row.dataset.toolEffect !== 'read').length,
    heights: rows.map((row) => Math.round(row.getBoundingClientRect().height)),
  };
}

/** A fold's control, found by what it says: the only button whose words are a
 *  count of calls held back. Runs in the page. */
function foldControl(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((button) => /^\d+ more$/u.test((button.textContent ?? '').trim()));
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

      // The word the user reads, wherever the block places it: the innermost
      // element of the live indicator whose text is the word (an ancestor's
      // text is the same word, so the deepest match is the label itself).
      const label = [...row.querySelectorAll('[data-live-indicator="reasoning"] *')]
        .filter((node) => node.textContent?.trim() === 'Thinking').at(-1);

      const labelStyle = label ? getComputedStyle(label) : null;

      measured[row.getAttribute('data-stream-id') ?? ''] = {
        caretWidth: last === null ? 'none' : getComputedStyle(last, '::after').width,
        heightCostPx,
        thinkingRows: row.querySelectorAll('[aria-live="polite"]').length,
        reasoning: viewport ? {
          viewportHeight: viewport.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(getComputedStyle(viewport).lineHeight),
          pulse: labelStyle?.animationName ?? 'none',
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

    const forkInterruptedAfterClick = (await readChatRows(chatPage))[UNSTAMPED_FORK_ROW];

    const chatErrors = Object.fromEntries(await chatPage.$$eval(
      '[data-chat-error]',
      (cards) => cards.map((card) => [
        card.getAttribute('data-chat-error') ?? '',
        {
          heading: card.querySelector('.font-medium')?.textContent ?? '',
          border: getComputedStyle(card).borderTopColor,
          retry: [...card.querySelectorAll('button')].some((button) => /retry/i.test(button.textContent ?? '') && !button.disabled),
        },
      ]),
    ));

    await chatPage.close();

    const tools = await newPage();
    await tools.setViewport({ width: 1280, height: 1600 });
    await tools.goto(`${origin}/gallery.html?frame=toolrun`, { waitUntil: 'networkidle0' });
    await tools.reload({ waitUntil: 'networkidle0' });
    // The run's preview call points at the gallery's preview origin, which no
    // server here answers. Serve it, so what is asserted below is a frame that
    // really rendered rather than an element that merely exists.
    await tools.setRequestInterception(true);
    tools.on('request', (request) => detach(Effect.promise(async () => {
      if (!new URL(request.url()).hostname.endsWith('.preview.example.test')) {
        await request.continue();

        return;
      }

      await request.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><p data-run-preview>the running app</p>' });
    })));
    await tools.reload({ waitUntil: 'networkidle0' });
    await tools.waitForSelector('[data-tool-state]');

    const folded = await tools.evaluate(toolRows);
    const fold = await tools.evaluateHandle(foldControl);
    const foldLabel = await tools.evaluate((button: HTMLButtonElement | undefined) => button?.textContent?.trim() ?? null, fold);

    // The preview card, read while the group is still folded: the reader has
    // clicked nothing, and the app the turn started is on screen.
    const previewFrameHandle = await tools.waitForSelector('iframe');

    if (previewFrameHandle === null) throw new Error('the collapsed run drew no preview frame');
    const previewDocument = await previewFrameHandle.contentFrame();

    if (!previewDocument) throw new Error('the preview frame created no document');
    await previewDocument.waitForSelector('[data-run-preview]');

    const collapsedPreview = {
      text: await previewDocument.$eval('[data-run-preview]', (element) => element.textContent),
      visible: await previewFrameHandle.isIntersectingViewport(),
    };

    // No fold drawn is a finding for the assertions below, never a wait on a
    // control that is not there.
    if (foldLabel !== null) {
      await tools.evaluate((button: HTMLButtonElement | undefined) => { button?.click(); }, fold);
      await tools.waitForFunction((drawn: number) => document.querySelectorAll('[data-tool-state]').length > drawn,
        {}, folded.reads + folded.others);
    }

    const unfolded = await tools.evaluate(toolRows);

    const toolActivity = { folded, unfolded, foldLabel, collapsedPreview };
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
    await waitForRow('main');
    await files.click(rowSelector('main'));
    await waitForRow('notes.md');

    // The parent row goes UP ONE LEVEL — to /home, never straight to the root.
    await files.waitForSelector('[data-files-up-row]');
    await files.click('[data-files-up-row]');
    await waitForRow('main');
    const filesAfterUp = await crumbs();

    // The tree carries FILES, not only folders — a recursion that drops file
    // entries leaves the sidebar unable to reach one. Each level is expanded
    // through its own caret.
    await files.click(rowSelector('main'));
    await waitForRow('notes.md');
    await files.click('[data-files-tree-node="/home"] button');
    await files.waitForSelector('[data-files-tree-node="/home/main"]');
    await files.click('[data-files-tree-node="/home/main"] button');
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
    const renameInput = present(await files.$('[data-files-rename-input]'), 'the rename input');

    await renameInput.evaluate((el) => { if (el instanceof HTMLInputElement) el.value = ''; });
    await renameInput.type('CREDO.md');
    await renameInput.press('Enter');
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

    // The workspace shell: the pane sends what is typed as `input` frames over
    // the terminal socket. Two commands: one typed, one pasted with a newline in
    // it. What is read back is the frames the pane sent, because a paste that
    // reaches the shell as one frame cannot lose its second line; what the shell
    // prints is the fixture's own echo and proves nothing about the pane.
    await env.waitForSelector('.xterm-rows');
    await terminalSettled(env, '$ ');
    await env.click('.xterm-screen');
    await env.keyboard.type('one');
    await env.keyboard.press('Enter');
    await terminalSettled(env, 'ran: one');
    await pasteIntoTerminal(env, 'two\nthree\n');
    await terminalSettled(env, 'ran: three');

    const terminalInput = await env.evaluate(() => window.__kinuTerminalInput ?? []);

    // The jump switches the surface at once (`openFiles` navigates focus); the
    // Files surface's chunk loads with its first view, so the drive is awaited.
    await env.click('[data-env-card="workspace"] [data-env-files]');
    const envFilesJumpLandsOnDrive = await env.waitForSelector('[data-files-surface]') !== null;

    await env.close();

    const explore = await newPage();
    await explore.setViewport({ width: 1280, height: 1100 });
    await explore.goto(`${origin}/gallery.html?frame=forkrunning`, { waitUntil: 'networkidle0' });
    await explore.reload({ waitUntil: 'networkidle0' });
    await explore.waitForSelector(`[data-run-node="${RATE_LIMITED_NODE}"]`);
    const runNodes = await readRunNodes(explore);
    await explore.close();

    return {
      tails, reducedMotionTails, chat, forkInterruptedAfterClick, chatErrors, toolActivity,
      filesRoot, filesRoster, filesInMount, filesAfterUp, treeFileNames,
      filesMarkdownRendered, filesPreviewText, filesEditorSeedsFromTheFile,
      filesAfterRename, filesAfterDelete, filesFiltered, filesOfflineRow,
      envCards, envCapabilityChips, envCapabilityAbsences, envFilesJumpLandsOnDrive,
      terminalInput,
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
    const tail = observed.tails[TEXT];
    // Cut `p-streaming` off the text block, or delete the CSS rule, and the
    // pseudo-element stops having a width.
    expect(tail.caretWidth).toBe('2px');
    // The whole reported defect: a sibling span after a <p> starts a new line.
    expect(tail.heightCostPx).toBe(0);
  });

  test('a code fence carries the caret inside the fence', () => {
    const tail = observed.tails[CODE_FENCE];
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
    expect(observed.tails[AFTER_TOOLS].thinkingRows).toBe(1);
    expect(observed.tails[AFTER_TOOLS].caretWidth).toBe('none');
  });

  test('a turn before its first token says so', () => {
    expect(observed.tails[NO_PARTS].thinkingRows).toBe(1);
  });

  test('a call in flight owns the running state — no second claim under it', () => {
    // One stream position reports one current activity.
    expect(observed.tails[TOOL_IN_FLIGHT].thinkingRows).toBe(0);
    expect(observed.tails[TOOL_IN_FLIGHT].runningIndicators).toBe(1);
    expect(observed.tails[TOOL_IN_FLIGHT].caretWidth).toBe('none');
  });

  test('streaming reasoning marks its own block live instead of adding a row', () => {
    expect(observed.tails[REASONING].thinkingRows).toBe(0);
    const reasoning = present(observed.tails[REASONING].reasoning, 'the streaming reasoning block');

    expect(reasoning.viewportHeight).toBeGreaterThan(0);
    expect(reasoning.viewportHeight).toBeLessThanOrEqual(reasoning.lineHeight * 4);
    // The label moves while the words arrive and the words themselves stay
    // still; under reduced motion the label is still too. Which animation the
    // label wears is the design's, shared with the pause tail.
    expect(reasoning.pulse).not.toBe('none');
    expect(reasoning.textAnimation).toBe('none');
    expect(present(observed.reducedMotionTails[REASONING].reasoning, 'the reduced-motion reasoning block').pulse)
      .toBe('none');
  });

  test('a turn actively writing text is never also announced as thinking', () => {
    expect(observed.tails[TEXT].thinkingRows).toBe(0);
  });
});

describe('large tool runs, as the timeline draws them', () => {
  // The owner's rule, 2026-09-23: no activity card. Every call is one compact
  // row; only a run of nine or more adjacent read-only calls folds, and only
  // its middle, behind one "N more".
  test('the run of reads keeps its first and last rows and folds the rest behind one count', () => {
    const { folded, unfolded, foldLabel } = observed.toolActivity;

    expect(folded.reads).toBe(2);
    expect(foldLabel).toBe(`${String(unfolded.reads - folded.reads)} more`);
  });

  test('nothing but reads folds', () => {
    const { folded, unfolded } = observed.toolActivity;

    expect(folded.others).toBeGreaterThan(0);
    expect(folded.others).toBe(unfolded.others);
  });

  test('the app a mid-run call started is on screen before any click', () => {
    const { collapsedPreview, foldLabel } = observed.toolActivity;

    // Read while the reads were still folded: the reader has clicked nothing.
    expect(foldLabel).not.toBeNull();
    expect(collapsedPreview.text).toBe('the running app');
    expect(collapsedPreview.visible).toBe(true);
  });
});

describe('a turn the harness wrote, as the browser attributes it', () => {
  test('the owner\'s own message is still the owner\'s bubble, pushed right', () => {
    // The denominator. Without it, a change that turned EVERY row into an event
    // card would satisfy every assertion below.
    const typed = observed.chat[TYPED_ROW];
    expect(typed.userBubbles).toBe(1);
    expect(typed.systemEvent).toBeNull();
    expect(typed.offsetFromCentrePx).toBeGreaterThan(20);
  });

  test('the fork-interrupted row wears an event card, never the owner\'s bubble', () => {
    // THE INCIDENT, as a browser draws it. This row is the production shape:
    // a bare UUID id and `kinuEvent: fork_interrupted`, no author stamp,
    // which is what five rows in the owner's live workspaces look like. Under
    // the four-name allowlist this rendered right-aligned in `.p-user-bubble`.
    const fork = observed.chat[UNSTAMPED_FORK_ROW];
    expect(fork.userBubbles).toBe(0);
    expect(fork.systemEvent).toBe('fork_interrupted');
    expect(Math.abs(fork.offsetFromCentrePx)).toBeLessThan(20);
  });

  test('a stamped harness turn lands the same way, without its event name mattering', () => {
    const gate = observed.chat[STAMPED_GATE_ROW];
    expect(gate.userBubbles).toBe(0);
    expect(gate.systemEvent).toBe('completion_gate');
    expect(Math.abs(gate.offsetFromCentrePx)).toBeLessThan(20);
  });

  test('the harness\'s words are folded away, and open when asked', () => {
    // Collapsed by default is a measurement here, not a class name: the body
    // holds more than it shows. Clicking it makes the row taller and stops it
    // overflowing, which is the difference between folded and truncated.
    expect(observed.chat[UNSTAMPED_FORK_ROW].folded).toBe(true);
    expect(observed.forkInterruptedAfterClick.folded).toBe(false);
  });

  test('an event kind that HAS a card keeps it — the fallback did not swallow them', () => {
    // `event_drain` renders its parsed events, not the generic card. A fallback
    // that captured everything would read as green here while erasing four
    // purpose-built renderings.
    const drain = observed.chat[DRAIN_ROW];
    expect(drain.systemEvent).toBeNull();
    expect(drain.userBubbles).toBe(0);
  });

  test('a refused tab says so in the runtime\'s words, never as a failed turn', () => {
    // `sunlit-stone-4a20` answers a resume ACK with {"reason":…,"body":"Unauthorized","done":true,"error":true}: the
    // runtime refusing the tab, which was read as a turn that ended 2026-08-17. It names no turn and offers none again,
    // nor raises a failed turn's alarm.
    const { live, refused } = observed.chatErrors;

    expect(refused?.heading).toBe("This tab couldn't reconnect: Unauthorized");
    expect(refused?.border).not.toBe(live?.border);
    expect(live?.retry).toBe(true);
    expect(refused?.retry).toBe(false);
  });
});

describe('thinking in a settled turn', () => {
  // 2026-10-05, production: thinking showed its markdown raw ("**Planning…**") and two thoughts in a row drew two blocks.
  test('reads as markdown, and thoughts in a row are one block in order', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.goto(`${origin}/gallery.html?frame=chat`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-chat-row="a1"] [data-reasoning]');
      await page.click('[data-chat-row="a1"] [data-reasoning] button[aria-expanded="false"]');

      const thinking = await page.$$eval('[data-chat-row="a1"] [data-reasoning]', (blocks) => blocks.map((block) => ({
        strong: [...block.querySelectorAll('strong')].map((node) => node.textContent),
        raw: block.textContent?.includes('**') ?? true,
      })));

      expect(thinking).toEqual([{ strong: ['Reproducing the failure', 'Bisecting'], raw: false }]);
      await page.close();
    });
  });
});

describe('a long thought folds by its height', () => {
  // m1111: a thought that is one long paragraph never folded, because the fold counted source lines.
  test('one long paragraph shows a few lines and an expand, and expanding shows all of it', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 900, height: 1200 });
      await page.goto(`${origin}/gallery.html?frame=chat`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-chat-row="a2"] [data-reasoning]');

      const shown = () => page.$eval('[data-chat-row="a2"] [data-reasoning]', (block) => ({
        height: block.querySelector('.prose-thinking')?.getBoundingClientRect().height ?? 0,
        toggle: block.querySelector('button')?.getAttribute('aria-expanded') ?? null,
      }));

      const folded = await shown();

      expect(folded.toggle).toBe('false');
      await page.click('[data-chat-row="a2"] [data-reasoning] button');

      const open = await shown();

      expect(open.toggle).toBe('true');
      expect(open.height).toBeGreaterThan(folded.height * 1.5);
      await page.close();
    });
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
    // The origin badge names the machine, not the executor id: the device wears the user's own device name, per the
    // consent naming contract, and the agent's computer wears its product label.
    expect(observed.filesRoot.badges).toEqual(expect.arrayContaining(["Ashish's MacBook", executorLabel('sandbox')]));
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
    expect(byName[executorLabel('sandbox')]?.mount).toBe('/sandbox');
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

  // A pasted `echo first-line\necho second-line\n` once ran the first line and dropped the second.
  test('a pasted two-line command reaches the shell as one frame', () => {
    // One frame carries the whole paste, its newlines as the CR the shell
    // runs at; the pane never re-submits the second line as its own keys.
    expect(observed.terminalInput).toContain('two\rthree\r');
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
function panelBoxes(page: Page) {
  return page.$$eval('[data-panel]', (panels) => panels.map((panel) => {
    const box = panel.getBoundingClientRect();

    return { left: box.left, right: box.right, width: Math.round(box.width) };
  }));
}

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
        chatShown: (document.querySelector('[data-gallery-chat] > *')?.getBoundingClientRect().width ?? 0) > 0,
        chatWidth: Math.round(document.querySelector('[data-gallery-chat] > *')?.getBoundingClientRect().width ?? 0),
        composerWidth: Math.round(document.querySelector('[data-composer-root] > .p-composer')?.getBoundingClientRect().width ?? 0),
        headerSettings: document.querySelectorAll('[aria-label="Workspace settings"]').length,
        rosterSettings: document.querySelectorAll('[aria-label^="Workspace settings for"]').length,
      }));

      await page.close();
      expect(shell.footer).not.toContain('Could not load your profile');
      expect(shell.footer).toContain('@');
      expect(shell.chatShown).toBe(true);
      expect(shell.composerWidth).toBe(shell.chatWidth);
      expect(shell.headerSettings).toBe(1);
      expect(shell.rosterSettings).toBe(0);
    });
  });

  test('mobile gives Chat and Workspace the full viewport in turn', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 390, height: 844 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-composer-root]');

      const chatPanels = await panelBoxes(page);

      await page.click('.p-bar button[data-inspector-toggle]');
      await page.waitForFunction(
        () => [...document.querySelectorAll('[data-panel]')].some((panel, index) => (
          index === 1 && Math.round(panel.getBoundingClientRect().width) === 390
        )),
      );

      const workspacePanels = await panelBoxes(page);

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      const viewportWidth = await page.evaluate(() => innerWidth);
      await page.close();
      expect(chatPanels).toHaveLength(2);
      expect(workspacePanels).toHaveLength(2);
      expect(chatPanels[0].width).toBe(viewportWidth);
      expect(chatPanels[1].right).toBe(chatPanels[1].left);
      expect(workspacePanels[0].right).toBe(workspacePanels[0].left);
      expect(workspacePanels[1].width).toBe(viewportWidth);
      expect(overflow).toBe(0);
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
      await page.waitForSelector('nav[aria-label="Chats"]');
      await page.waitForSelector('button[aria-label="Hide inspector"]');

      const opened = await page.evaluate(() => Math.round(
        document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1,
      ));

      expect(await inspectorShown(page)).toBe('open');

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
      await page.waitForSelector('nav[aria-label="Chats"]');
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

/** Each row of `?frame=provenance` as a reader meets it: whose bubble, which card, and what each drained event says. */
function readProvenance(page: Page) {
  return page.$$eval('[data-chat-row]', (rows) => Object.fromEntries(rows.map((row) => [row.getAttribute('data-chat-row') ?? '', {
    bubble: row.querySelector('.p-user-bubble') !== null,
    card: row.querySelector('[data-signal-card]') !== null,
    systemEvent: row.querySelector('[data-system-event]')?.getAttribute('data-system-event') ?? null,
    advisor: row.querySelector('[data-advisor-severity]')?.getAttribute('data-advisor-severity') ?? null,
    events: [...row.querySelectorAll('[data-drained-event]')].map((event) => ({
      variant: event.getAttribute('data-drained-event'),
      replyExpected: event.hasAttribute('data-reply-expected'),
      source: event.querySelector('[data-event-source]')?.textContent ?? '',
      brief: event.querySelector('[data-event-brief]')?.textContent ?? '',
    })),
    text: row.textContent ?? '',
    height: row.getBoundingClientRect().height,
  }])));
}

/** The loose cards in the workspace's thread, each by its state and the briefs it lists. */
function threadCards(page: Page): Promise<{ state: string | null; briefs: string[] }[]> {
  return page.$$eval('.p-thread-column [data-signal-card]', (cards) => cards.map((card) => ({
    state: card.getAttribute('data-signal-card'),
    briefs: [...card.querySelectorAll('[data-drained-event]')].map((event) => event.querySelector('[data-event-brief]')?.textContent ?? ''),
  })));
}

/** Has the workspace's server send `frames` on the open connection, in order. */
function pushFrames(page: Page, frames: JsonObject[]): Promise<void> {
  return page.evaluate((all) => {
    for (const detail of all) window.dispatchEvent(new CustomEvent('gallery:push-frame', { detail }));
  }, frames);
}

const webhookCard = (id: string, brief: string, state = 'pending') => ({
  type: 'signal_card', id, state, metadata: { kinuEvent: 'event_drain' }, text: `- [webhook] from stripe: ${brief}`,
});

/**
 * A turn the person did not type never wears their bubble, whichever way it was written: an operator's words from
 * an MCP client or a steer re-run keep theirs, and a harness, a job, an advisor or a drained batch get a card. The
 * drains are core's own text, so a card reads what the agent was told.
 */
/** Where, in the thread's reading order, each of `needles` first appears: the index of the element that draws it. */
function readingOrder(page: Page, needles: readonly string[]): Promise<number[]> {
  return page.$$eval('.p-thread-column *', (all, wanted) => wanted.map((needle) => all.findIndex((el) => (el.textContent ?? '').includes(needle)
    && ![...el.children].some((child) => (child.textContent ?? '').includes(needle)))), needles);
}

const agentReport = (id: string, timestamp: number, content: string) => ({
  type: 'subordinate_event', id, kind: 'report', subordinate: 'coupon-auditor', status: 'completed', content, timestamp,
});

/** The gallery's spliced webhook, and the words of the answer's two steps around it. */
const SPLICE = { brief: 'Translation job 4471 finished (de-DE)', before: 'Waiting on the German strings', after: 'The translation landed' } as const;

/** How far the agent has got with the spliced card, as its mark says it and as its colour does. */
function spliceDelivery(page: Page): Promise<{ state: string | null; tone: string | null } | null> {
  return page.evaluate(() => {
    const mark = document.querySelector('[data-spliced-signal="sig-lilt"] [data-delivery], .p-thread-column [data-signal-card] [data-delivery]');

    if (mark === null) return null;
    const tone = ['p-warning', 'p-success'].find((name) => mark.classList.contains(name)) ?? null;

    return { state: mark.getAttribute('data-delivery'), tone };
  });
}

/**
 * An event that reaches the agent while it is answering sits between the parts of the answer it arrived between, live
 * and after a reload; it is amber while it waits or is being shown, and green once the step that read it has ended.
 * Production, 2026-10-08: such events collected after the live answer, grey then gold, and a reload lost them.
 */
describe('an event spliced into a running answer', () => {
  test('it waits amber, is drawn between the parts it arrived between once a step takes it in, and turns green once seen', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1600 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage&transcript=splice-live`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.p-thread-column');
      const text = `Events arrived while you were working:\n- [webhook] from lilt: ${SPLICE.brief}`;

      await pushFrames(page, [{ type: 'signal_card', id: 'sig-lilt', state: 'pending', metadata: { kinuEvent: 'event_drain', kinuAuthor: 'harness' }, text }]);
      await page.waitForFunction(() => document.querySelector('.p-thread-column [data-signal-card] [data-delivery="pending"]') !== null);
      expect(await spliceDelivery(page)).toEqual({ state: 'pending', tone: 'p-warning' });

      await pushFrames(page, [{ type: 'signal_card', id: 'sig-lilt', state: 'shown', atStep: 1 }]);
      await page.waitForSelector('[data-spliced-signal="sig-lilt"]');
      const [before, splice, after] = await readingOrder(page, [SPLICE.before, SPLICE.brief, SPLICE.after]);

      expect([before !== undefined && splice !== undefined && before < splice, splice !== undefined && after !== undefined && splice < after]).toEqual([true, true]);
      expect(await spliceDelivery(page)).toEqual({ state: 'shown', tone: 'p-warning' });

      await pushFrames(page, [{ type: 'signal_card', id: 'sig-lilt', state: 'seen' }]);
      await page.waitForFunction(() => document.querySelector('[data-spliced-signal="sig-lilt"] [data-delivery="seen"]') !== null);
      expect(await spliceDelivery(page)).toEqual({ state: 'seen', tone: 'p-success' });
      // Once, in the answer: not a second loose card below it.
      expect(await page.$$eval('.p-thread-column [data-signal-card]', (cards) => cards.length)).toBe(1);
      await page.close();
    });
  });

  test('after a reload the answer that read it still draws it, in place and seen', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1600 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage&transcript=splice-kept`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-spliced-signal="sig-lilt"]');
      const [before, splice, after] = await readingOrder(page, [SPLICE.before, SPLICE.brief, SPLICE.after]);

      expect([before !== undefined && splice !== undefined && before < splice, splice !== undefined && after !== undefined && splice < after]).toEqual([true, true]);
      expect(await spliceDelivery(page)).toEqual({ state: 'seen', tone: 'p-success' });
      await page.close();
    });
  });
});

/**
 * What happened besides what was said sits where it happened, as one quiet line that opens on a click, and the same
 * thing twice in a row is one line. Production, 2026-10-08: every such event collected at the bottom of the chat, as a
 * heavy card each.
 */
describe('a chat\'s events', () => {
  test('each sits where it happened, and the same one twice in a row is drawn once', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 2400 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage&transcript=revert`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => document.querySelector('.p-thread-column')?.textContent?.includes('pricing-service.ts') === true);
      // The fixture's two asks were written eight and six minutes ago.
      const now = await page.evaluate(() => Date.now());

      await pushFrames(page, [
        agentReport('rep-between', now - 7 * 60e3, 'between the two asks'),
        agentReport('rep-after', now + 60e3, 'after every answer'),
        agentReport('rep-twice-1', now + 120e3, 'the same report'),
        agentReport('rep-twice-2', now + 121e3, 'the same report'),
        { type: 'signal_card', id: 'sig-lilt', state: 'pending', metadata: { kinuEvent: 'event_drain' },
          text: '- [webhook] from lilt: New Lilt chat activity\n- [webhook] from lilt: New Lilt chat activity' },
      ]);
      await page.waitForFunction(() => document.querySelector('.p-thread-column')?.textContent?.includes('New Lilt chat activity') === true);

      const [first, between, second, after] = await readingOrder(page, [
        'Add the coupon-kind regression test', 'between the two asks', 'Now rewrite the pricing service', 'after every answer',
      ]);

      expect({ between: (first ?? 0) < (between ?? 0) && (between ?? 0) < (second ?? 0), after: (second ?? 0) < (after ?? 0) })
        .toEqual({ between: true, after: true });

      const drawn = await page.evaluate(() => ({
        reports: [...document.querySelectorAll('[data-subordinate-event]')].filter((row) => row.textContent?.includes('the same report'))
          .map((row) => row.querySelector('[data-event-repeats]')?.textContent ?? '1'),
        lilt: [...document.querySelectorAll('[data-drained-event]')].filter((row) => row.textContent?.includes('New Lilt chat activity'))
          .map((row) => row.querySelector('[data-event-repeats]')?.textContent ?? '1'),
      }));

      expect(drawn).toEqual({ reports: ['×2'], lilt: ['×2'] });

      // One line until opened: the report reads in full once its row is clicked.
      const row = '[data-subordinate-event] [data-event-brief]';
      await page.evaluate(() => { [...document.querySelectorAll('[data-subordinate-event]')].find((el) => el.textContent?.includes('between the two asks'))?.querySelector('button')?.click(); });
      await page.waitForFunction((brief) => [...document.querySelectorAll(brief)].some((el) => el.classList.contains('whitespace-pre-wrap')), {}, row);
      await page.close();
    });
  });

  test('a machine gone offline and a model taking over are rows too, the same hand-off twice drawn once', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 2400 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage&devices=none`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.p-thread-column');
      const handOff = 'anthropic/claude-sonnet-4 took over from anthropic/claude-opus-4: provider stream reset';

      await pushFrames(page, [
        { type: 'model_fallback', message: handOff },
        { type: 'model_fallback', message: handOff },
        { type: 'model_fallback', message: 'workers-ai/llama-4 took over from anthropic/claude-sonnet-4: rate limited' },
      ]);
      await page.waitForSelector('[data-device-offline]');
      await page.waitForFunction(() => document.querySelectorAll('[data-model-fallback]').length === 2);

      const drawn = await page.evaluate(() => ({
        handOffs: [...document.querySelectorAll('[data-model-fallback]')]
          .map((row) => [row.querySelector('[data-event-brief]')?.textContent?.slice(0, 18), row.querySelector('[data-event-repeats]')?.textContent ?? '1']),
        offline: document.querySelector('[data-device-offline] [data-event-brief]')?.textContent,
        connect: document.querySelector('[data-device-offline] a')?.getAttribute('href'),
      }));

      expect(drawn).toEqual({
        handOffs: [['anthropic/claude-s', '×2'], ['workers-ai/llama-4', '1']],
        offline: 'No machine connected',
        connect: '/devices',
      });

      // One line until opened, as every event row is.
      await page.click('[data-model-fallback] button');
      await page.waitForFunction(() => document.querySelector('[data-model-fallback] [data-event-brief]')?.classList.contains('whitespace-pre-wrap') === true);
      await page.close();
    });
  });
});

describe('whose words a turn is', () => {
  test('only what the person said is a bubble, and a drained batch lists each event it carried', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 900, height: 2400 });
      await page.goto(`${origin}/gallery.html?frame=provenance`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-chat-row="drain-idle"] [data-drained-event]');

      const rows = await readProvenance(page);
      const row = (id: string) => present(rows[id], `the ${id} row`);

      for (const id of ['typed', 'mcp', 'programmatic:steer']) expect([id, row(id).bubble, row(id).card]).toEqual([id, true, false]);

      for (const id of ['job', 'job-bare', 'invented', 'harness', 'adv-nit', 'adv-concern', 'adv-blocker', 'drain-delegated', 'drain-idle']) {
        expect([id, row(id).bubble, row(id).card]).toEqual([id, false, true]);
      }

      // The workspace's first turn is its own provenance: stored, never drawn.
      expect(row('genesis')).toMatchObject({ bubble: false, card: false, text: '', height: 0 });
      expect(row('job').text).toContain('research');
      expect([row('invented').systemEvent, row('harness').systemEvent]).toEqual(['a_kind_invented_tomorrow', 'system']);
      expect(['adv-nit', 'adv-concern', 'adv-blocker'].map((id) => row(id).advisor)).toEqual(['nit', 'concern', 'blocker']);

      // Delegated work: the report names who sent it, and only the peer's ask waits on an answer, whose how-to stays the agent's.
      const [report, ask] = row('drain-delegated').events;
      expect(row('drain-delegated').events.map((event) => [event.variant, event.replyExpected])).toEqual([['subordinate_report', false], ['peer_agent', true]]);
      expect(report?.source).toContain('cli-auditor');
      expect(ask?.source).toContain('atlas');
      expect(ask?.brief).toContain('which shape?');
      expect(row('drain-delegated').text).not.toContain('event_id');

      // The rest drain apart: a schedule whose label holds a colon keeps its whole label as the brief.
      const [timer, mail] = row('drain-idle').events;
      expect([timer?.variant, mail?.variant]).toEqual(['timer', 'email']);
      expect(timer?.brief).toBe('background-job-wake:job-7');
      expect(mail?.source).toContain('ops@example.com');
      expect(mail?.brief).toContain('exit 1');

      // A report of several lines opens to all of them.
      await page.click('[data-chat-row="drain-delegated"] [data-drained-event="subordinate_report"]');
      expect(await page.$eval('[data-chat-row="drain-delegated"] [data-drained-event="subordinate_report"] [data-event-brief]', (brief) => (brief instanceof HTMLElement ? brief.innerText : '')))
        .toContain('Report line one.\nReport line two.');
      await page.close();
    });
  });

  test('a signal keeps one card from delivery to the agent, a re-delivery reuses it, and an undelivered one leaves', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.p-thread-column');
      const cardsBriefing = async (brief: string) => (await threadCards(page)).filter((card) => card.briefs.includes(brief));

      await pushFrames(page, [webhookCard('sig-life', 'a refund of 12.00 settled')]);
      await page.waitForFunction(() => document.querySelector('.p-thread-column')?.textContent?.includes('a refund of 12.00 settled') === true);
      expect(await cardsBriefing('a refund of 12.00 settled')).toEqual([{ state: 'pending', briefs: ['a refund of 12.00 settled'] }]);

      await pushFrames(page, [{ type: 'signal_card', id: 'sig-life', state: 'shown' }]);
      await page.waitForSelector('.p-thread-column [data-signal-card="shown"]');
      expect(await cardsBriefing('a refund of 12.00 settled')).toEqual([{ state: 'shown', briefs: ['a refund of 12.00 settled'] }]);

      // Delivered again after it was shown: the same card, pending once more and saying the new words.
      await pushFrames(page, [webhookCard('sig-life', 'a refund of 12.00 settled twice')]);
      await page.waitForFunction(() => document.querySelector('.p-thread-column')?.textContent?.includes('settled twice') === true);
      expect(await cardsBriefing('a refund of 12.00 settled')).toEqual([]);
      expect(await cardsBriefing('a refund of 12.00 settled twice')).toEqual([{ state: 'pending', briefs: ['a refund of 12.00 settled twice'] }]);

      // Transitions for a card this page never saw open, and frames that are no card, draw nothing; the next real card is the proof they were heard.
      const before = (await threadCards(page)).length;
      await pushFrames(page, [
        { type: 'signal_card', id: 'sig-life', state: 'undelivered' },
        { type: 'signal_card', id: 'sig-unseen', state: 'shown' },
        { type: 'signal_card', id: 'sig-bare', state: 'pending' },
        { type: 'signal_card', id: 'sig-odd', state: 'elsewhere', text: 'odd', metadata: { kinuEvent: 'event_drain' } },
        webhookCard('sig-after', 'a payout of 3.00 settled'),
      ]);
      await page.waitForFunction(() => document.querySelector('.p-thread-column')?.textContent?.includes('a payout of 3.00 settled') === true);
      expect(await cardsBriefing('a refund of 12.00 settled twice')).toEqual([]);
      expect((await threadCards(page)).length).toBe(before);

      // Cards keep arrival order, and a flood keeps the newest fifty.
      await pushFrames(page, Array.from({ length: 60 }, (_, at) => webhookCard(`sig-flood-${String(at)}`, `flood ${String(at).padStart(2, '0')}`)));
      await page.waitForFunction(() => document.querySelector('.p-thread-column')?.textContent?.includes('flood 59') === true);
      const flood = (await threadCards(page)).flatMap((card) => card.briefs).filter((brief) => brief.startsWith('flood'));
      expect(flood).toEqual(Array.from({ length: 50 }, (_, at) => `flood ${String(at + 10)}`));
      await page.close();
    });
  });
});

/**
 * KINU-071. The fixture mounts the exact ConversationStartBoundary used by both
 * WorkspacePage columns over the real chat thread hook. Its first page is held
 * by a fixture promise, then rejects once; Retry returns status:end. This is a
 * browser test because the defect was which mutually-exclusive surface painted
 * during that interleaving. Blind spot: the agent socket is not involved; its
 * delivered-empty distinction is the `seeded` input stated here.
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
      const textarea = present(await page.waitForSelector('[data-composer-root] textarea'), 'the composer textarea');

      await textarea.type('admit exactly one turn');
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

  /**
   * Stop gives the next Send its own turn, but only once the stop's cancel has come back; the stopped send landing
   * late never frees a newer turn; and a send the transport fails frees the next one. A press the latch refuses is
   * not lost: it goes to the running turn.
   */
  test('a stopped or failed send frees the next turn, and a stale one never frees a newer turn', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-composer-root] textarea');
      await page.evaluate(() => { document.documentElement.dataset.galleryChatHold = '1'; });

      const counts = () => page.evaluate(() => ({
        turns: Number(document.documentElement.dataset.galleryChatSends ?? '0'),
        toRunning: (document.documentElement.dataset.galleryMidTurnSends ?? '').split('\n').filter(Boolean),
      }));

      // Waits until the words reached the transport or the running turn, so a press that went the wrong way fails, not waits.
      const press = async (label: string, words: string) => {
        await page.type('[data-composer-root] textarea', words);
        await page.click(`[data-composer-root] button[aria-label="${label}"]`);
        await page.waitForFunction((said) => [document.documentElement.dataset.galleryChatSent ?? '', document.documentElement.dataset.galleryMidTurnSends ?? '']
          .some((reached) => reached.includes(said)), {}, words);
      };

      const stopHeld = async () => {
        await page.evaluate(() => { document.documentElement.dataset.galleryCancelHeld = '1'; });
        await page.click('[data-composer-root] button[aria-label="Stop this turn"]');
        await page.waitForSelector('[data-composer-root] button[aria-label="Send"]');
      };

      const settleSend = (at: number, failed = false) => page.evaluate((detail) => {
        window.dispatchEvent(new CustomEvent('gallery:settle-send', { detail }));
      }, { at, failed });

      const releaseCancel = () => page.evaluate(() => {
        document.documentElement.dataset.galleryCancelHeld = '0';
        window.dispatchEvent(new Event('gallery:release-cancel'));
      });

      await press('Send', 'first turn');
      expect(await counts()).toEqual({ turns: 1, toRunning: [] });
      await page.waitForSelector('[data-composer-root] button[aria-label="Stop this turn"]');

      // Stopped, with its cancel still out: the turn still holds, so a Send goes to it.
      await stopHeld();
      await press('Send', 'during the stop');
      expect(await counts()).toEqual({ turns: 1, toRunning: ['during the stop'] });

      await releaseCancel();
      await page.waitForFunction(() => document.querySelector('[data-composer-root] button[aria-label="Send"]') !== null);
      await press('Send', 'second turn');
      expect((await counts()).turns).toBe(2);
      await page.waitForSelector('[data-composer-root] button[aria-label="Stop this turn"]');

      // The first send lands now, after the second took the latch: the second still holds it.
      await settleSend(0);
      await stopHeld();
      await press('Send', 'after the stale landing');
      expect(await counts()).toEqual({ turns: 2, toRunning: ['during the stop', 'after the stale landing'] });

      await releaseCancel();
      await press('Send', 'third turn');
      expect((await counts()).turns).toBe(3);
      await page.waitForSelector('[data-composer-root] button[aria-label="Stop this turn"]');

      // The transport fails the third: the next Send opens a turn of its own.
      await settleSend(2, true);
      await page.waitForSelector('[data-composer-root] button[aria-label="Send"]');
      await press('Send', 'after the failure');
      expect(await counts()).toEqual({ turns: 4, toRunning: ['during the stop', 'after the stale landing'] });
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
 * The walk-back, at the actual WorkspacePage boundary.
 *
 * The owner pressed the per-message affordance on a workspace with no device
 * and was told `File history is unavailable: no device connected`. The one
 * revert the product can always perform — the conversation — was never
 * offered, so the control read as broken.
 *
 * This drives the shipped page: the real MessageView affordance, the real
 * dialog, the real `useKinu` socket edge. The revert's own redraw arrives the
 * way the Durable Object sends it, as a transcript frame the fixture pushes
 * back, so what is asserted is a transcript the client re-read rather than one
 * a click removed locally.
 */
describe('the walk-back at the actual WorkspacePage boundary', () => {
  const revertAttributes = (page: Page, attribute: 'data-revert-turn' | 'data-revert-action'): Promise<string[]> => page.$$eval(
    `[${attribute}]`,
    (buttons, name) => buttons.map((button) => button.getAttribute(name) ?? ''), attribute,
  );

  const openDialog = async (page: Page, origin: string, search: string): Promise<void> => {
    await page.setViewport({ width: 1280, height: 1000 });
    await page.goto(`${origin}/gallery.html?frame=workspacepage&transcript=revert${search}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-revert-turn="rv-u2"]');
    await page.click('[data-revert-turn="rv-u2"]');
    await page.waitForSelector('[data-revert-dialog="ready"]');
  };

  test('one action with no device connected, and the transcript ends before that message', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await openDialog(page, origin, '');

      expect(await revertAttributes(page, 'data-revert-turn')).toEqual(['rv-u1', 'rv-u2']);
      expect(await revertAttributes(page, 'data-revert-action')).toEqual(['conversation']);

      const dialog = await page.$eval('[role="dialog"]', (element) => element.textContent ?? '');
      expect(dialog).toContain('Revert the conversation to before this message?');
      // The report itself: a workspace with no device must not be told its
      // file history is missing for pressing revert.
      expect(dialog).not.toContain('File history is unavailable');
      await page.screenshot({ path: join(TAB_SHOTS, 'revert-conversation-dialog.png') });

      await page.click('[data-revert-action="conversation"]');
      await page.waitForFunction(
        () => document.querySelector('[data-revert-turn="rv-u2"]') === null,
      );

      expect(await revertAttributes(page, 'data-revert-turn')).toEqual(['rv-u1']);
      const body = await page.evaluate(() => document.body.innerText);
      expect(body).toContain('Add the coupon-kind regression test');
      expect(body).not.toContain('read its rules from the campaign table');
      expect(body).not.toContain('File history is unavailable');
      await page.close();
    });
  });

  // m268: a device store that cannot answer is never reported as a turn that changed nothing.
  test('a device that keeps no history and a turn that changed no files are told apart, and neither offers device files', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const notes: Record<string, string> = {};

      for (const listing of ['nogit', 'none'] as const) {
        const page = await newPage();
        await openDialog(page, origin, `&checkpoints=${listing}`);
        expect(await revertAttributes(page, 'data-revert-action')).toEqual(['conversation']);
        notes[listing] = await page.$eval('[data-device-history]', (element) => element.textContent ?? '');
        await page.close();
      }

      expect(notes.nogit).toContain(CHECKPOINTS_UNAVAILABLE_NO_GIT);
      expect(notes.none).not.toContain(CHECKPOINTS_UNAVAILABLE_NO_GIT);
      expect(notes.nogit).not.toBe(notes.none);
    });
  });

  test('a device holding this turn’s checkpoint adds the second action', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await openDialog(page, origin, '&checkpoints=1');

      expect(await revertAttributes(page, 'data-revert-action')).toEqual([
        'conversation-and-device-files', 'conversation',
      ]);
      await page.screenshot({ path: join(TAB_SHOTS, 'revert-with-device-files-dialog.png') });
      await page.close();
    });
  });
});

/** Presses the open dialog's button by the words it shows. */
async function pressInDialog(page: Page, words: string): Promise<void> {
  await page.$$eval('[role="dialog"] button', (buttons, label) => {
    const button = buttons.find((each) => each.textContent?.trim() === label);

    if (!(button instanceof HTMLElement)) throw new Error(`no ${label} in the dialog`);
    button.click();
  }, words);
}

/** A turn whose loop stopped mid-work says so even though its last call settled; a turn that finished says nothing. */
describe('how a settled turn ended', () => {
  test('the turn that stopped mid-work carries a notice and the finished one does not', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1000 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage&transcript=revert`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => (document.querySelector('#chat')?.textContent ?? '').includes('eleven call sites'));

      // Where each status note sits: after the stopped turn's call and before the next request, or in the finished turn.
      const notes = await page.evaluate(() => {
        const chat = document.querySelector('#chat');
        const at = (words: string) => [...(chat?.querySelectorAll('*') ?? [])].filter((node) => node.textContent?.includes(words) === true).at(-1);
        const stoppedCall = at('coupon-kind.test.ts');
        const nextAsk = at('Now rewrite the pricing service');
        const finishedCall = at('packages/pricing');
        const after = (anchor: Element | undefined, node: Element) => anchor !== undefined && (anchor.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        const statuses = [...(chat?.querySelectorAll('[role="status"]') ?? [])];

        return {
          stopped: statuses.filter((node) => after(stoppedCall, node) && !after(nextAsk, node)).length,
          finished: statuses.filter((node) => after(finishedCall, node)).length,
        };
      });

      expect(notes).toEqual({ stopped: 1, finished: 0 });
      await page.close();
    });
  });

  // The final walk on 04a4dd0ab: a refused turn left the owner's message alone after a reload.
  test('a turn the provider refused shows the refusal in its words where a reload reads it, with its retry', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1000 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage&transcript=refused`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('#chat [data-turn-failure]');

      const failure = await page.$eval('#chat [data-turn-failure]', (row) => ({
        words: row.querySelector('code')?.textContent ?? '',
        retry: [...row.querySelectorAll('button')].some((button) => /retry/i.test(button.textContent ?? '')),
      }));

      expect(failure.words).toContain('Go usage limit exceeded');
      expect(failure.retry).toBe(true);
      await page.close();
    });
  });
});

/** A redirect that ran as a branch leaves takes to compare: the chip names the current one, the comparison cycles
 *  through all of them both ways, and a pick becomes the current answer. One take alone offers nothing to compare. */
describe('alternate takes on an answer', () => {
  const chip = '#chat button[title^="Your mid-turn redirect"]';
  const shown = (page: Page) => page.$eval('[role="dialog"]', (dialog) => /Take (\d) of (\d)/.exec(dialog.textContent ?? '')?.slice(1, 3).join('/') ?? '');

  test('compare, cycle both ways, and pick one, which the chip then names', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1000 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage&transcript=revert&takes=3`, { waitUntil: 'networkidle0' });
      await page.waitForSelector(chip);
      expect(await page.$eval(chip, (button) => button.textContent?.trim())).toBe('Take 1 of 3');

      await page.click(chip);
      await page.waitForSelector('[role="dialog"]');
      expect(await shown(page)).toBe('1/3');
      await page.keyboard.press('ArrowLeft');
      expect(await shown(page)).toBe('3/3');
      await page.click('[role="dialog"] button[aria-label="Next take"]');
      await page.click('[role="dialog"] button[aria-label="Next take"]');
      expect(await shown(page)).toBe('2/3');
      expect(await page.$eval('[role="dialog"]', (dialog) => dialog.textContent ?? '')).toContain('three call sites');

      await pressInDialog(page, 'Use this take');
      await page.waitForFunction(() => document.querySelector('[role="dialog"]') === null);
      await page.waitForFunction((at) => document.querySelector(at)?.textContent?.trim() === 'Take 2 of 3', {}, chip);

      await page.goto(`${origin}/gallery.html?frame=workspacepage&transcript=revert&takes=1`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => (document.querySelector('#chat')?.textContent ?? '').includes('eleven call sites'));
      expect(await page.$(chip)).toBeNull();
      await page.close();
    });
  });
});

/**
 * iOS Safari zooms the page when a text field under 16px takes focus, and leaves it zoomed. On a touch phone every
 * text field, on the pages that carry one, must compute to at least 16px.
 */
const PHONE = { width: 390, height: 844, isMobile: true, hasTouch: true } as const;

describe('text fields on a touch phone', () => {
  test('every visible text field computes to at least 16px, so iOS does not zoom on focus', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const small: string[] = [];

      for (const frame of ['workspacepage', 'home', 'files', 'usersettingsstate&section=providers']) {
        const page = await newPage();
        await page.setViewport(PHONE);
        await page.goto(`${origin}/gallery.html?frame=${frame}`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('input, textarea');
        // The load swaps the renderer, which once took the touch pointer after the page read it (0965, under load). The
        // same viewport again sends touch emulation to the renderer now showing the page, and resolves once applied.
        await page.setViewport({ ...PHONE });

        const measured = await page.$$eval(
          'input:not([type="checkbox"], [type="radio"], [type="range"], [type="file"], [type="color"], [type="button"], [type="submit"]), textarea, select',
          (fields) => ({
            coarse: matchMedia('(pointer: coarse)').matches,
            fields: fields.filter((field) => field.checkVisibility()).map((field) => ({
              name: field.getAttribute('aria-label') ?? field.getAttribute('placeholder') ?? field.tagName,
              px: Number.parseFloat(getComputedStyle(field).fontSize),
            })),
          }),
        );

        expect(measured.coarse).toBe(true);
        expect(measured.fields.length).toBeGreaterThan(0);
        small.push(...measured.fields.filter((field) => field.px < 16).map((field) => `${frame}: ${field.name} ${String(field.px)}px`));
        await page.close();
      }

      expect(small).toEqual([]);
    });
  });
});

/**
 * An IME delivers the Enter that picks a candidate, and the Escape that drops one, as ordinary keydowns: Chrome marks them
 * `isComposing`, and WebKit, which ends the composition first, marks them keyCode 229. Neither may commit or cancel.
 */
describe('a rename while an IME composes', () => {
  test("the IME's own Enter and Escape leave the rename open with its text", async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1000 });
      await page.goto(`${origin}/gallery.html?frame=files`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      const row = (name: string) => `[data-files-entry][title="${name}"]`;
      await page.waitForSelector(row('home'));
      await page.click(row('home'));
      await page.waitForSelector(row('main'));
      await page.click(row('main'));
      await page.waitForSelector(row('SOUL.md'));
      await page.hover(row('SOUL.md'));
      await page.click(`${row('SOUL.md')} [data-files-rename]`);
      await page.waitForSelector('[data-files-rename-input]');
      await page.$eval('[data-files-rename-input]', (el) => { if (el instanceof HTMLInputElement) el.value = ''; });
      await page.type('[data-files-rename-input]', '魂');

      const imeKey = (key: string, mark: 'composing' | 'webkit') => page.evaluate((k, m) => {
        document.querySelector('[data-files-rename-input]')?.dispatchEvent(new KeyboardEvent('keydown', {
          key: k, bubbles: true, cancelable: true, isComposing: m === 'composing', keyCode: m === 'webkit' ? 229 : 0,
        }));
      }, key, mark);

      const open = () => page.evaluate(() => {
        const input = document.querySelector('[data-files-rename-input]');

        return input instanceof HTMLInputElement ? input.value : null;
      });

      for (const mark of ['composing', 'webkit'] as const) {
        await imeKey('Enter', mark);
        await imeKey('Escape', mark);
        expect(await open()).toBe('魂');
      }

      expect(await page.$(row('魂'))).toBeNull();
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
      await page.waitForSelector(row('main'));
      await page.click(row('main'));
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
 * useChatThread and WorkspaceRosterProvider; controls only hold/release their
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

      // The old server row spells "Storefront", and the local edit
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

  test('a rating landing while the Quality tab is open shows without a reload', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 900, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=qualitylive`, { waitUntil: 'networkidle0' });

      const rated = () => page.evaluate(() => [...document.querySelectorAll('[data-quality-live] *')]
        .find((node) => node.textContent?.startsWith('Turns rated') === true && node.children.length > 0)?.textContent ?? '');

      await page.waitForFunction(() => document.querySelector('[data-quality-live]')?.textContent?.includes('Turns rated') === true);
      const before = await rated();

      await page.click('[data-quality-rate]');
      await page.waitForFunction((was: string) => [...document.querySelectorAll('[data-quality-live] *')]
        .find((node) => node.textContent?.startsWith('Turns rated') === true && node.children.length > 0)?.textContent !== was, {}, before);
      await page.close();
    });
  });

  test('a failed quality read retries, then shows satisfaction per day', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 900, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=qualityretry`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-quality-retry] button');

      await page.evaluate(() => window.dispatchEvent(new Event('gallery:quality-heal')));
      await page.click('[data-quality-retry] button');
      await page.waitForFunction(
        () => document.querySelector('[data-quality-retry]')?.textContent?.includes('Satisfaction per day') === true,
      );
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
      await page.click('[title="Revoke device"]');
      await page.waitForSelector('[role="dialog"]');
      expect(await page.$eval('[role="dialog"]', (dialog) => dialog.textContent ?? '')).toContain('Agents will lose access');
      await pressInDialog(page, 'Revoke');
      await page.waitForSelector('[data-device-incident="dev-1"]');

      const immediate = await page.$eval('[data-device-incident="dev-1"]', (row) => row.textContent ?? '');
      // 3d50a51a3: the warning reads "Kinu could not confirm that every
      // command stopped after revocation."
      expect(immediate).toContain('Kinu could not confirm that every command stopped after revocation.');
      expect(immediate).toContain('2 commands have no confirmed termination and may still run.');
      expect(await page.$('[data-device-incident="dev-1"] [title="Rename this device"]')).toBeNull();
      expect(await page.$('[data-device-incident="dev-1"] [title="Revoke device"]')).toBeNull();

      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-device-incident="dev-1"]');
      const persisted = await page.$eval('[data-device-incident="dev-1"]', (row) => row.textContent ?? '');
      // 3d50a51a3: same rewrite as the immediate arm.
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
      await page.waitForSelector('[data-env-connect]');

      await page.click('[data-env-connect]');
      await page.waitForSelector('[role="dialog"] [data-connect-state="ready"]');
      // In place: the Environment surface is still mounted behind the dialog,
      // and the URL never moved.
      expect(await page.$('[data-env-card="workspace"]')).not.toBeNull();
      expect(new URL(page.url()).pathname).toBe('/gallery.html');
      // The disclosure is on screen before anything is installed: no command yet.
      expect(await page.$('[data-connect-command]')).toBeNull();

      // Named, and pressed twice before the first answer: one registration, carrying the name.
      await page.type('[role="dialog"] input[aria-label="Device name"]', 'Build box');
      await page.$eval('[role="dialog"] [data-connect-start]', (button) => {
        if (!(button instanceof HTMLButtonElement)) throw new Error('the start control is not a button');
        button.click();
        button.click();
      });
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
      // One registration got us here, though the button was pressed twice: a second would be a device row nobody notices.
      expect(JSON.parse(await page.evaluate(() => document.documentElement.dataset.galleryRegistrations ?? '[]'))).toEqual(['Build box']);
      await page.close();
    });
  });

  // The non-vacuity arms for the close above: same flow, same clicks, and a roster where the device the connect issued
  // stays `connected: false`, alone or beside another machine of the account that connects. A panel that closed on any
  // roster tick, or on any machine that arrived (26244c765), would pass the first test and fail these.
  for (const [what, mode] of [['a machine that never dials in', 'stall'], ['another machine connecting', 'other']]) {
    test(`${what} leaves the panel open and waiting`, async () => {
      await withGallery(async ({ newPage, origin }) => {
        const page = await newPage();
        await page.setViewport({ width: 1100, height: 900 });
        await page.goto(`${origin}/gallery.html?frame=environment&offline=device&connect=${mode}`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('[data-env-connect]');
        await page.click('[data-env-connect]');
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
  }

  test('a refused registration is named, and the next press registers', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1100, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=environment&offline=device&connect=fail-first`, { waitUntil: 'networkidle0' });
      await page.click('[data-env-connect]');
      await page.waitForSelector('[role="dialog"] [data-connect-start]');

      await page.click('[role="dialog"] [data-connect-start]');
      await page.waitForSelector('[role="dialog"] [data-connect-error]');
      expect(await page.$eval('[data-connect-error]', (line) => line.textContent ?? '')).toContain('the hub is busy');

      await page.click('[role="dialog"] [data-connect-start]');
      await page.waitForSelector('[data-connect-command]');
      expect(JSON.parse(await page.evaluate(() => document.documentElement.dataset.galleryRegistrations ?? '[]'))).toHaveLength(2);
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
      const textarea = present(await page.waitForSelector('[data-composer-root] textarea'), 'the composer textarea');

      await textarea.focus();

      await textarea.evaluate((input) => {
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '変換' }));
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', bubbles: true, cancelable: true, isComposing: true,
        }));
      });
      expect((await continuityProbe(page)).sends).toBe(0);

      await textarea.evaluate((input) => {
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
      await textarea.focus();
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
      const textarea = present(await page.waitForSelector('[data-composer-root] textarea'), 'the composer textarea');

      const paste = (kind: 'plain' | 'html' | 'file' | 'same-metadata') => textarea.evaluate((input, flavor) => {
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
      // suite, and with it the row, from 89f3b895d until this line.
      await cross('pc', 'pc', 'sandbox', "Ashish's MacBook");
      await cross("Ashish's MacBook", "Ashish's MacBook", "Ashish's MacBook", 'quarterly-report.txt');

      return seen;
    });

    expect(mismatches).toEqual([]);
  });
});

test('code retains syntax colors through streaming and long sidebar titles stay clipped', async () => {
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

        const firstRow = 'aside ul > li:first-child';
        expect(await page.$eval(firstRow + ' a[href^="/workspace/"]', (link) => {
          const title = link.children[1];

          if (title === undefined) throw new Error('workspace title absent');

          return title.scrollWidth > title.clientWidth;
        })).toBeTrue();

        for (const action of ['button[title="Rename"]', 'button[title="Remove"]']) {
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
          const tokenColors = new Set([...sample.querySelectorAll('code span')].map((token) => getComputedStyle(token).color));
          let scrollable = false;

          for (const element of sample.querySelectorAll('div, pre')) {
            element.scrollLeft = 50;

            if (element.scrollLeft > 0) scrollable = true;
            element.scrollLeft = 0;
          }

          return { colors: tokenColors.size, scrollable };
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

test('page tabs past the edge stay reachable by scrolling the strip sideways', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    // The default inspector width with three slates: their tabs share the bar with the workspace's pinned tools.
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${origin}/gallery.html?frame=workspacepage&slates=3`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[aria-label="Tally"]');

    // The tabs' own scroller: the nearest container around the first page that scrolls sideways.
    const reach = await page.$eval('[aria-label="Board"]', (tab) => {
      let scroller = tab.parentElement;

      while (scroller !== null && getComputedStyle(scroller).overflowX !== 'auto') scroller = scroller.parentElement;

      if (scroller === null) throw new Error('the page tabs have no scrolling container');
      const row = scroller;
      const last = row.querySelector<HTMLElement>('button[aria-label="Tally"]');

      if (last === null) throw new Error('the strip has no Tally tab');

      const inView = (): boolean => {
        const box = last.getBoundingClientRect();
        const frame = row.getBoundingClientRect();

        return box.left >= frame.left && box.right <= frame.right;
      };

      const before = inView();
      const heightBefore = row.getBoundingClientRect().height;
      last.focus();

      return { before, after: inView(), grew: row.getBoundingClientRect().height !== heightBefore };
    });

    expect(reach.before).toBe(false);
    expect(reach.after).toBe(true);
    expect(reach.grew).toBe(false);
    await page.close();
  });
});

/** Where the agent tab strip's photographs land, outside the worktree. */
const TAB_SHOTS = join(import.meta.dir, '..', '..', '..', 'kinu-logs', 'chat-and-files-ux');

mkdirSync(TAB_SHOTS, { recursive: true });

/** One agent tab, as the browser painted it. */
/**
 * 2026-09-29 (the ci run on 9dd2971ae4): this row hung for 480 s on a waitForSelector the tabs frame always
 * satisfies, and passes alone. A renderer that dies mid-wait was the only way to that shape: puppeteer answers its
 * crash with an `error` event and nothing else, so an unbounded wait on the page never ended. The wait now ends with it.
 */
test('a wait on a page whose renderer crashed ends with the crash, not silence', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.goto(`${origin}/gallery.html?frame=tabs`, { waitUntil: 'networkidle0' });
    const cdp = await page.createCDPSession();
    // Held, not handed to `expect` yet: bun's `.rejects` settles its promise before returning, and nothing has crashed.
    const waiting = page.waitForSelector('[data-tab-strip="never-rendered"]');

    // The session dies with the renderer, so its own answer never comes: the wait's end is what is awaited.
    await Promise.race([cdp.send('Page.crash'), Promise.allSettled([waiting])]);
    await expect(waiting).rejects.toThrow('the page crashed');
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

/** Waits until the Work tab has drawn the section under `title`. */
async function waitForWorkSection(page: Page, title: string): Promise<void> {
  await page.waitForFunction((label: string) => [...document.querySelectorAll('section')]
    .some((node) => node.querySelector('.p-label')?.textContent === label), {}, title);
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
      await waitForWorkSection(page, 'Journal');

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

  test('a workspace where nothing has happened draws no section, one empty line and no failure', async () => {
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
        diffs: document.querySelector('[aria-label="Changes"]') !== null,
      }));

      // One line: the column's own empty card. The change-set draws nothing
      // while nothing has changed, and its gated tab stays away. Nothing
      // failed, so nothing owes a retry. The last two were the other answer
      // while a fixture handed the change-set's record reader an array.
      expect(column).toEqual({ sections: 0, lines: 1, retries: 0, diffs: false });
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
      await waitForWorkSection(page, 'Journal');

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

/** The live indicators the page draws, by kind, and which of Stop and Recover the composer offers. */
function liveState(page: Page): Promise<{ indicators: (string | null)[]; stop: boolean; recover: boolean }> {
  return page.evaluate(() => ({
    indicators: [...document.querySelectorAll('[data-live-indicator]')].map((each) => each.getAttribute('data-live-indicator')),
    stop: document.querySelector('[data-composer-root] button[aria-label="Stop this turn"]') !== null,
    recover: document.querySelector('[data-composer-root] button[aria-label="Recover this turn"]') !== null,
  }));
}

/** Has the workspace's server say its root claim is now `claim`. */
async function claimIs(page: Page, claim: Record<string, string | number>): Promise<void> {
  await page.evaluate((detail) => { window.dispatchEvent(new CustomEvent('gallery:push-frame', { detail })); }, { type: 'turn_claim', claim });
}

/**
 * The root's claim decides what the page offers. Admitted, the page paints one live indicator and offers Stop. A
 * claim whose isolate died never settles on its own: the page paints no indicator, offers recovery rather than a
 * Stop that would never land, and recovery settles it.
 */
describe('the live indicator follows the root claim', () => {
  test('an admitted turn paints one indicator with Stop; a stranded one paints none and offers recovery, which settles it', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-composer-root] textarea');
      expect(await liveState(page)).toEqual({ indicators: [], stop: false, recover: false });

      await claimIs(page, { kind: 'admitted', turnId: 'turn-live', claimedAt: 1 });
      await page.waitForSelector('[data-composer-root] button[aria-label="Stop this turn"]');
      const live = await liveState(page);

      expect([live.indicators.length, live.stop, live.recover]).toEqual([1, true, false]);

      await claimIs(page, { kind: 'stranded', turnId: 'turn-live', claimedAt: 1 });
      await page.waitForSelector('[data-composer-root] button[aria-label="Recover this turn"]');
      expect(await liveState(page)).toEqual({ indicators: [], stop: false, recover: true });

      await page.click('[data-composer-root] button[aria-label="Recover this turn"]');
      await page.waitForFunction(() => document.querySelector('[data-composer-root] button[aria-label="Recover this turn"]') === null);
      expect(await page.evaluate(() => document.documentElement.dataset.galleryRecoveries)).toBe('1');
      expect(await liveState(page)).toEqual({ indicators: [], stop: false, recover: false });
      await page.close();
    });
  });
});

/** Now's owed rows in order, each as its kind and phase. */
function owedRows(page: Page): Promise<string[]> {
  return page.$$eval('[data-inspected]', (rows) => rows.map((row) => `${row.getAttribute('data-inspected') ?? ''} ${row.getAttribute('data-phase') ?? ''}`));
}

/**
 * Work → Now lists every turn and effect still owed as the workspace's one work read reports it: blocked first, since
 * nothing in flight will move it, then what runs, then what waits. Recovering the stranded turn settles its claim, and
 * that write moves the read, so the row leaves without a reload.
 */
describe('Now lists what is still owed, by the phase its store records', () => {
  test('blocked, then running, then waiting; recovering the stranded turn takes it off', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage&owed=all`, { waitUntil: 'networkidle0' });
      await page.click('nav[aria-label="Workspace"] button[aria-label="Work"]');
      await page.waitForSelector('[data-inspected]');
      const owed = ['effect blocked', 'turn running', 'effect running', 'effect waiting', 'effect waiting'];

      expect(await owedRows(page)).toEqual(['turn blocked', ...owed]);

      await claimIs(page, { kind: 'stranded', turnId: 'turn-stranded', claimedAt: 1 });
      await page.click('[data-composer-root] button[aria-label="Recover this turn"]');
      await page.waitForFunction((left) => document.querySelectorAll('[data-inspected]').length === left, {}, owed.length);

      expect(await owedRows(page)).toEqual(owed);
      await page.close();
    });
  });
});

/** What the running job's card prints, a line per row, with the name it goes by above it. */
function latestOutput(page: Page): Promise<{ name: string; lines: string[] }> {
  return page.$eval('[aria-label="Latest output"]', (output) => ({
    name: output.parentElement?.firstElementChild?.textContent ?? '',
    lines: (output.textContent ?? '').split('\n'),
  }));
}

/**
 * Now shows the work in hand as it runs: a running job prints its last lines, says where its sender dropped bytes
 * and how many, and keeps up as it prints. Under it the journal is every settled thing, newest first, whatever kind.
 */
describe('Work keeps up with what is happening and what happened', () => {
  test('a running job shows its last lines with each drop in place, and moves on as it prints', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 430, height: 1400 });
      // The sender dropped 1.2 MB before its first line and 4 KB before its fifth.
      await page.goto(`${origin}/gallery.html?frame=work&lane=streaming&lines=6&lost=1258291,0,0,0,4096`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="Latest output"]');

      const { name, lines } = await latestOutput(page);

      // Named by its label, then its short id.
      expect(name).toBe('workspace: bun run build4e1a77c0');
      // Four lines of its own; the drop before them is told first and the one between them where it fell.
      expect(lines.filter((line) => !line.includes('omitted'))).toEqual(['warn: chunk vendor.js is 1.4 MB after minify', 'compiled 120 modules', 'compiled 248 modules', 'compiled 377 modules']);
      expect(lines[0]).toContain('1.2 MB');
      expect(lines[3]).toContain('4.0 KB');
      // Only the job still running prints; a settled one shows its outcome.
      expect(await page.$$eval('[aria-label="Latest output"]', (outputs) => outputs.length)).toBe(1);

      await page.goto(`${origin}/gallery.html?frame=work&lane=streaming&lines=4&live=1`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => document.querySelector('[aria-label="Latest output"]')?.textContent?.endsWith('compiled 248 modules') === true);
      expect((await latestOutput(page)).lines).toEqual(['resolving 412 packages', 'warn: chunk vendor.js is 1.4 MB after minify', 'compiled 120 modules', 'compiled 248 modules']);
      await page.close();
    });
  });

  test('the journal interleaves settled jobs, closed tasks and self-changes, newest first', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 430, height: 2400 });
      await page.goto(`${origin}/gallery.html?frame=work`, { waitUntil: 'networkidle0' });
      await waitForWorkSection(page, 'Journal');

      const rows = await page.evaluate(() => [...[...document.querySelectorAll('section')]
        .find((node) => node.querySelector('.p-label')?.textContent === 'Journal')?.querySelector('div.p-group')?.children ?? []]
        .map((row) => row.textContent ?? ''));

      // Each fixture row by something only it says, in the order the fixture's times put them; a closed task names whose it was.
      const order = ['changed nothing', 'tool preamble', 'bisect_migration', '2f8b1d04', 'coupon docs page · main', 'SAVE20 coupon 500 · main', 'percentage coupons', 'Stage the rollout · courier', '9d3c6e11'];

      expect(rows.map((row) => order.findIndex((marker) => row.includes(marker)))).toEqual(order.map((_, at) => at));
      // The running job is Now's, not the journal's.
      expect(rows.some((row) => row.includes('7c1e4a92'))).toBe(false);
      await page.close();
    });
  });
});

/**
 * The workspace's work is one thing: every actor's plans and tasks on one tab,
 * owners named, and a pending plan's decision one row in Needs you that opens
 * the plan's own page. `?frame=work`'s fixture carries a root plan
 * beside a subordinate's and a task that holds the note its agent left.
 */
describe('the Work tab reads the workspace, not the actor', () => {
  test('every actor\'s plans list with owner names, each with its own tasks', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 430, height: 1400 });
      await page.goto(`${origin}/gallery.html?frame=work`, { waitUntil: 'networkidle0' });
      await waitForWorkSection(page, 'Plans');

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

  test('a pending plan asks in Needs you, the row opens its own page tab, and Work is one click back', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 430, height: 1400 });
      await page.goto(`${origin}/gallery.html?frame=work`, { waitUntil: 'networkidle0' });
      await waitForWorkSection(page, 'Plans');

      const needs = (await workSections(page)).find((section) => section.title === 'Needs you');

      if (needs === undefined) throw new Error('the Needs you section is missing');
      expect(needs.text).toContain('Approve the plan · Gateway timeout repair');

      await page.evaluate(() => {
        const row = [...document.querySelectorAll('button')]
          .find((button) => button.textContent?.includes('Approve the plan'));

        if (row === undefined) throw new Error('the approve row is missing');
        row.click();
      });

      // The review is the plan's own page, its tab current among the pages: the plan list is gone, and what is on
      // screen is the pending revision's own decisions, the way the row promised.
      await page.waitForSelector('[data-plan-review-root]');
      expect(await page.$eval('[data-plan-title]', (element) => element.textContent)).toContain('Gateway');
      expect(await page.$eval('[data-plan-status]', (element) => element.textContent)).toBe('Awaiting review');
      expect(await page.$eval('nav[aria-label="Pages"] [aria-current="true"]', (tab) => tab.getAttribute('aria-label'))).toContain('Gateway');
      expect(await page.$eval('[data-work-plans]', (list) => list.checkVisibility())).toBe(false);

      await page.click('nav[aria-label="Workspace"] button[aria-label="Work"]');
      await page.waitForSelector('[data-work-plans]', { visible: true });
      expect(await page.$eval('[data-plan-review-root]', (review) => review.checkVisibility())).toBe(false);
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
      await waitForWorkSection(page, 'Learnings');

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
/** Opens the themed choice named `label`, reads its options, and closes it; a closed popup stays mounted, hidden. */
async function choiceOptions(page: Page, label: string, selector = `[aria-label="${label}"]`): Promise<string[]> {
  await page.click(selector);
  await page.waitForFunction(() => [...document.querySelectorAll('[role="option"]')].some((node) => node.checkVisibility()));

  const options = await page.$$eval('[role="option"]', (nodes) => nodes
    .filter((node) => node.checkVisibility())
    .map((node) => node.textContent?.trim() ?? ''));

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => ![...document.querySelectorAll('[role="option"]')].some((node) => node.checkVisibility()));

  return options;
}

/** Opens the themed choice named `label` and picks the visible option reading exactly `text`, with a real click. */
async function chooseOption(page: Page, label: string, text: string): Promise<void> {
  await page.click(`[aria-label="${label}"]`);
  await page.waitForFunction(() => [...document.querySelectorAll('[role="option"]')].some((node) => node.checkVisibility()));

  for (const option of await page.$$('[role="option"]')) {
    if (await option.evaluate((node, wanted) => node.checkVisibility() && node.textContent?.trim() === wanted, text)) {
      await option.click();

      return;
    }
  }

  throw new Error(`${label} offers no ${text}`);
}

describe('model tiers are the owner\'s to add, and each offers its model\'s own levels', () => {
  test('an added tier renders, takes its model\'s levels, and is offered to roles', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1000, height: 1400 });
      await page.goto(`${origin}/gallery.html?frame=usersettingsstate&section=models`, { waitUntil: 'networkidle0' });
      // Adding a tier is one of the Advanced settings, closed until asked for.
      await page.click('[data-section="advanced"] > button');
      await page.waitForSelector('[aria-label="New tier id"]');

      await page.type('[aria-label="New tier id"]', 'review');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-tier="review"] [data-model-picker="review model"]');
      // A new tier starts as a copy of default (a Workers AI model, no levels): no thinking to pick.
      expect(await page.$('[aria-label="review reasoning effort"]')).toBeNull();

      // Point it at a model that documents five levels: the choice offers
      // exactly those, in the model's order, through the combobox every tier row carries.
      // The picker opens on an empty search, so a new choice starts by typing, never by deleting.
      await page.click('[data-tier="review"] [data-model-picker="review model"]');
      await page.waitForSelector('input[aria-label="Search review model"]');
      expect(await page.$eval('input[aria-label="Search review model"]', (input) => (input instanceof HTMLInputElement ? input.value : null))).toBe('');
      await page.keyboard.type('Opus');
      await page.waitForSelector('[role="option"]');
      await page.click('[role="option"]');
      await page.waitForSelector('[aria-label="review reasoning effort"]');
      const levels = () => page.$$eval('[aria-label="review reasoning effort"] [role="tab"]', (tabs) => tabs.map((tab) => tab.textContent?.trim()));

      expect(await levels()).toEqual(['Auto', 'Low', 'Medium', 'High', 'Extra high', 'Max']);

      // Its provider holds two accounts, so the row asks which; the model's levels stay offered on either.
      expect((await choiceOptions(page, 'review model account')).slice(1)).toEqual(['main', 'work']);
      await chooseOption(page, 'review model account', 'work');
      await page.waitForFunction(() => document.querySelector('[aria-label="review model account"]')?.textContent?.trim() === 'work');
      expect(await levels()).toEqual(['Auto', 'Low', 'Medium', 'High', 'Extra high', 'Max']);

      // The role editor lists the new tier.
      expect(await choiceOptions(page, 'Default tier')).toContain('review model');

      // Removing it is one click, and only a non-builtin offers it.
      expect(await page.$('[aria-label="Remove tier default"]')).toBeNull();
      await page.click('[aria-label="Remove tier review"]');
      expect(await page.$('[aria-label="review reasoning effort"]')).toBeNull();
      await page.close();
    });
  });

  test('a tier\'s fallbacks are chosen in order, may run one model on each account, never repeat an entry, and leave by their remove', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1000, height: 1400 });
      await page.goto(`${origin}/gallery.html?frame=usersettingsstate&section=models`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="default fallbacks"]');

      const chain = () => page.$eval('[aria-label="default fallbacks"]', (group) => [...group.querySelectorAll('[data-spec]')]
        .map((chip) => chip.getAttribute('data-spec') ?? ''));

      // The model picker's trigger is named from inside it; `data-model-picker` is where that name sits.
      const offered = async (label: string) => (await choiceOptions(page, 'default add fallback', '[data-model-picker="default add fallback"]'))
        .some((option) => option.includes(label));

      const settled = (specs: readonly string[]) => page.waitForFunction((wanted) => {
        const chips = [...document.querySelectorAll('[aria-label="default fallbacks"] [data-spec]')].map((chip) => chip.getAttribute('data-spec'));

        return JSON.stringify(chips) === JSON.stringify(wanted);
      }, {}, specs);

      const pick = async (label: string) => {
        await page.click('[data-model-picker="default add fallback"]');
        await page.waitForFunction(() => [...document.querySelectorAll('[role="option"]')].some((node) => node.checkVisibility()));

        for (const option of await page.$$('[role="option"]')) {
          if (await option.evaluate((node, wanted) => node.checkVisibility() && node.textContent?.includes(wanted) === true, label)) {
            await option.click();

            return;
          }
        }

        throw new Error(`no option ${label}`);
      };

      expect(await chain()).toEqual([]);
      expect(await offered('Claude Opus 4.7')).toBe(true);
      await pick('Claude Opus 4.7');
      await settled(['anthropic/claude-opus-4-7']);

      // An entry names its account: switch the first to `work`, then the same model is offered on each account left.
      await chooseOption(page, 'default fallback 1 account', 'work');
      await settled(['anthropic@work/claude-opus-4-7']);

      await pick('Claude Opus 4.7');
      await settled(['anthropic@work/claude-opus-4-7', 'anthropic/claude-opus-4-7']);
      await pick('Claude Opus 4.7');
      await settled(['anthropic@work/claude-opus-4-7', 'anthropic/claude-opus-4-7', 'anthropic@main/claude-opus-4-7']);

      // Every account of it is in the chain now: it is not offered again.
      expect(await offered('Claude Opus 4.7')).toBe(false);
      await pick('Llama 4');
      await settled(['anthropic@work/claude-opus-4-7', 'anthropic/claude-opus-4-7', 'anthropic@main/claude-opus-4-7', 'workers-ai/llama-4']);

      await page.click('[aria-label="Remove anthropic@work/claude-opus-4-7 from the default fallbacks"]');
      await settled(['anthropic/claude-opus-4-7', 'anthropic@main/claude-opus-4-7', 'workers-ai/llama-4']);
      await page.close();
    });
  });
});

/**
 * K-05. A workspace the user has never touched opens its inspector COLLAPSED;
 * the first thing worth seeing opens it on the workspace's behalf. From then
 * on the user's own choice rules: a resize persists across reloads, a collapse
 * persists, and a passive arrival raises a "Preview ready" chip where the
 * reader already is — only an explicit click navigates.
 */
/** Waits until the trailing panel reports `want`; `'open'` is any width past
 *  the 200px an opened column clears. */
/** The trailing panel's widths that read as open and as collapsed: a collapsed column keeps at most its border. */
const INSPECTOR_BOUNDS = { open: 200, collapsed: 2 };

/** Whether the trailing panel reads as open, collapsed, or neither. */
async function inspectorShown(page: Page): Promise<'open' | 'collapsed' | 'between'> {
  return await page.evaluate(({ open, collapsed }) => {
    const width = Math.round(document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1);

    if (width > open) return 'open';

    return width <= collapsed ? 'collapsed' : 'between';
  }, INSPECTOR_BOUNDS);
}

async function waitForInspectorWidth(page: Page, want: number | 'open'): Promise<void> {
  await page.waitForFunction((target: number | 'open', { open }: typeof INSPECTOR_BOUNDS) => {
    const panels = [...document.querySelectorAll('[data-panel]')];
    const width = Math.round(panels[1]?.getBoundingClientRect().width ?? 0);

    return target === 'open' ? width > open : width === target;
  }, {}, want, INSPECTOR_BOUNDS);
}

/** Waits until two frames report the same trailing-panel width, and that width
 *  is the asked-for state. A commit and any write-back it schedules land inside
 *  one frame, so a width that survives two is the settled one. */
async function inspectorSettled(page: Page, want: 'open' | 'collapsed' | 'any'): Promise<void> {
  await page.waitForFunction((state: 'open' | 'collapsed' | 'any', { open, collapsed }: typeof INSPECTOR_BOUNDS) => {
    const width = () => Math.round(
      document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1,
    );

    const first = width();
    const wanted = state === 'any' || (state === 'open' ? first > open : first <= collapsed);

    return new Promise<boolean>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(wanted && width() === first)));
    });
  }, {}, want, INSPECTOR_BOUNDS);
}

/** The trailing panel's rounded width, and every key the page holds in
 *  `localStorage`. `Storage` is read through its own index API: it is a host
 *  object, and spreading it would lose the accessors it is defined with. */
async function readInspectorState(page: Page): Promise<{ width: number; stored: Record<string, string> }> {
  return await page.evaluate(() => {
    const stored: Record<string, string> = {};

    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);

      if (key === null) continue;

      const value = localStorage.getItem(key);

      if (value !== null) stored[key] = value;
    }

    return {
      width: Math.round(document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1),
      stored,
    };
  });
}

/** The separator's centre, once it is on the page: where a drag starts. */
async function separatorCentre(page: Page): Promise<{ x: number; y: number }> {
  const separator = present(await page.waitForSelector('[data-separator]'), 'the inspector separator');
  const box = present(await separator.boundingBox(), 'the separator bounding box');

  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

describe('the workspace inspector at the actual WorkspacePage boundary', () => {
  test('collapsed until something arrives, then resize persists across reload; collapse persists; passive arrival chips, explicit click navigates', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      // The first visit has nothing worth showing only until its snapshot lands, and a fixture answers in
      // microseconds, so the snapshot is held: the collapsed state lasts until the gate releases it.
      await page.goto(`${origin}/gallery.html?frame=workspacepage&snapshot=held`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="Work"]');

      const inspectorWidth = () => page.$$eval('[data-panel]', (panels) => Math.round(panels[1]?.getBoundingClientRect().width ?? -1));

      // The first layout commit is the definite event: a collapsed column behind its handle is asserted, never
      // waited for, so a first visit that opens fails here at once.
      await page.waitForSelector('[data-inspector-commits]');
      expect(await page.$('[data-inspector-expand]')).not.toBeNull();
      expect(await inspectorShown(page)).toBe('collapsed');

      // The snapshot's pending plan needs the person, so its arrival opens the column.
      await page.evaluate(() => { document.documentElement.dataset.snapshotReleased = '1'; });
      await waitForInspectorWidth(page, 'open');

      // The passive arrival is the something worth seeing: the column opens
      // on the workspace's behalf AND raises the chip where the reader is —
      // Work stays current, only the explicit click navigates.
      await page.evaluate(() => { document.documentElement.dataset.previewArrived = '1'; });
      await page.waitForSelector('[data-preview-ready]');
      await waitForInspectorWidth(page, 'open');
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
      expect(await inspectorShown(page)).toBe('collapsed');
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-inspector-expand]');
      expect(await inspectorShown(page)).toBe('collapsed');
      await page.click('[data-inspector-expand]');
      await waitForInspectorWidth(page, 'open');

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
      await inspectorSettled(page, 'open');

      const state = await readInspectorState(page);

      // Constrained on screen, preferred in storage, and — nothing here was
      // the user's explicit choice, so no choice is written for this
      // workspace.
      expect(state.width).toBeLessThan(await page.evaluate(() => innerWidth));
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
      await waitForInspectorWidth(page, 340);

      // resetToDefault at the committed 340 issues a no-op write: the
      // library emits nothing, and nothing marks the next emission as
      // ours to swallow.
      await page.evaluate(() => {
        document.querySelector<HTMLElement>('[data-separator]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      });

      // A real drag follows: pointerdown marks the input, the release
      // commit persists the width the user's hand chose. The inspector is
      // the trailing panel — dragging the separator right narrows it.
      const { x, y } = await separatorCentre(page);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 60, y, { steps: 4 });
      await page.mouse.up();

      // The release commit and its persist are synchronous in the same
      // dispatch: the width lands at 280 and the store holds it.
      await page.waitForFunction(() => Math.round(
        document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1,
      ) === 280);

      const state = await readInspectorState(page);

      expect(state.width).toBe(Number(state.stored['kinu.inspector.ashish@example.com']));
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
      await waitForInspectorWidth(page, 'open');

      const before = await page.evaluate(() => Math.round(
        document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1,
      ));

      // Narrowing re-commits a smaller constrained layout: no input mark,
      // so the preferred 2000 stays stored and no new choice is written.
      await page.setViewport({ width: 1100, height: 900 });
      await page.waitForFunction((prev: number) => Math.round(
        document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1,
      ) < prev, {}, before);

      const state = await readInspectorState(page);

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
        const listeners = new Map<string, number>();

        window.__liveListeners = listeners;

        const tally = (target: EventTarget, type: string, delta: number) => {
          // The separator div carries `data-separator` (the library sets it);
          // `instanceof HTMLElement` narrows it without a cast, and
          // `instanceof Document` covers the ownerDocument listeners. Any
          // other target matches neither and is skipped.
          if (target instanceof HTMLElement && target.dataset['separator'] !== undefined) {
            const key = `sep:${type}`;
            listeners.set(key, (listeners.get(key) ?? 0) + delta);

            return;
          }

          if (target instanceof Document) {
            const key = `doc:${type}`;
            listeners.set(key, (listeners.get(key) ?? 0) + delta);
          }
        };

        const proto: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> = EventTarget.prototype;
        const add = proto.addEventListener;
        const remove = proto.removeEventListener;

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
        const listeners = window.__liveListeners;

        if (listeners === undefined) throw new Error('the listener tally was never installed');

        return Object.fromEntries(listeners);
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
      await waitForInspectorWidth(page, 'open');

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

      const { stored } = await readInspectorState(page);

      expect(stored['kinu.inspector.ashish@example.com']).toBe('300');

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
      await waitForInspectorWidth(page, 340);

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
      await inspectorSettled(page, 'any');
      const { x, y } = await separatorCentre(page);
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
      await inspectorSettled(page, 'any');

      const state = await readInspectorState(page);

      expect(state.width).toBe(Number(state.stored['kinu.inspector.ashish@example.com']));
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
      await waitForInspectorWidth(page, 400);

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
      await inspectorSettled(page, 'any');
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
      await inspectorSettled(page, 'any');

      const state = await readInspectorState(page);

      // Fractional shares round differently across read paths, so the
      // committed width can differ a pixel from the rect read; a stored
      // width off the seed proves the commit was claimed as the user's.
      expect(state.width).toBeCloseTo(Number(state.stored['kinu.inspector.ashish@example.com']), -1);
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
      await waitForInspectorWidth(page, 'open');

      // The collapse control is still the user's own act; with no account it
      // claims the close for the session and writes nothing anywhere.
      await page.click('[data-inspector-collapse]');
      await page.waitForSelector('[data-inspector-expand]');

      const { stored } = await readInspectorState(page);

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
      await inspectorSettled(page, 'collapsed');

      const { stored } = await readInspectorState(page);

      expect(stored['kinu.inspector.open.ashish@example.com.checkout-fixes']).toBe('0');

      await page.close();
    });
  });

  // A preview is only replaced by what the sandbox validly says: a failed or forged answer keeps the last good one and
  // names the problem; an answer of no ports retires it.
  test('a running preview survives a failed or forged listing, and leaves when the sandbox lists no ports', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.evaluate(() => { document.documentElement.dataset.previewArrived = '1'; });
      await page.waitForSelector('[data-preview-ready]');
      await page.click('[data-preview-ready]');
      await page.waitForSelector('[aria-label="Arrived app"]');

      const listingSays = (state: string) => page.evaluate((next) => { document.documentElement.dataset.sandboxPorts = next; }, state);

      // The listing's failure line, by what it names; its full message is the line's title.
      const problem = () => page.evaluate(() => [...document.querySelectorAll('[data-failure]')]
        .find((line) => line.textContent?.includes('preview listings'))?.getAttribute('title') ?? null);

      await listingSays('failed');
      await page.waitForFunction(() => [...document.querySelectorAll('[data-failure]')].some((line) => line.textContent?.includes('preview listings')));
      expect(await problem()).toContain('Nimbus is temporarily unavailable');
      expect(await page.$('[aria-label="Arrived app"]')).not.toBeNull();

      await listingSays('forged');
      await page.waitForFunction(() => [...document.querySelectorAll('[data-failure]')].some((line) => line.getAttribute('title')?.includes('invalid preview registration')));
      expect(await page.$eval('[aria-label="Arrived app"]', (tab) => tab.getAttribute('title') ?? tab.textContent ?? '')).not.toContain('evil.example');

      await listingSays('none');
      await page.waitForFunction(() => document.querySelector('[aria-label="Arrived app"]') === null);
      expect(await problem()).toBeNull();
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
      await waitForInspectorWidth(page, 300);

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

      const state = await readInspectorState(page);

      expect(await inspectorShown(page)).toBe('collapsed');
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
  interface Window {
    __createProbe: CreateProbe;
    /** Every `input` frame the pane sent the gallery's workspace shell (`gallery-terminal.ts`). */
    __kinuTerminalInput?: string[];
    /** Listener counts by target and type, kept by the patched `EventTarget`. */
    __liveListeners?: Map<string, number>;
  }
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
          const url = input instanceof Request ? input.url : input.toString();

          if (init?.method === 'POST' && url.includes('/api/user/workspaces')) {
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

/** Two files dropped one after the other, each under the cap but over it together: the one dropped first is kept,
 *  the other is refused by name, and only what was kept goes out with the words. */
describe('attachments at the message cap', () => {
  test('two drops that together exceed the cap keep the first, refuse the second by name, and send only the first', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      const pane = '[data-agent-pane="checkout-fixes/main"]';
      await page.waitForSelector(`${pane} textarea:not([disabled])`);

      // Two separate drops in one task: both read their files while the other is still being read.
      await page.$eval(pane, (node) => {
        const drop = (name: string) => {
          const files = new DataTransfer();
          files.items.add(new File([new Uint8Array(640 * 1024)], name, { type: 'application/octet-stream' }));
          node.dispatchEvent(new DragEvent('dragover', { dataTransfer: files, bubbles: true, cancelable: true }));
          node.dispatchEvent(new DragEvent('drop', { dataTransfer: files, bubbles: true, cancelable: true }));
        };

        drop('first.bin');
        drop('second.bin');
      });

      const composer = `${pane} [data-composer-root]`;
      await page.waitForFunction((at) => (document.querySelector(at)?.textContent ?? '').includes('second.bin'), {}, composer);

      const shown = await page.$eval(composer, (root) => ({
        chips: [...root.querySelectorAll('button[aria-label^="Remove "]')].map((button) => button.getAttribute('aria-label')),
        refusal: [...root.querySelectorAll('*')].map((node) => node.textContent ?? '').find((text) => text.includes('did not fit')) ?? '',
      }));

      expect(shown.chips).toEqual(['Remove first.bin']);
      expect(shown.refusal).toContain('second.bin');

      await page.type(`${pane} textarea`, 'Here are the files');
      await page.click(`${pane} button[aria-label="Send"]`);
      await page.waitForFunction(() => document.documentElement.dataset.galleryChatSent !== undefined);
      expect(JSON.parse(await page.evaluate(() => document.documentElement.dataset.galleryChatSent ?? '[]'))).toEqual(['file:first.bin', 'text:Here are the files']);
      await page.close();
    });
  });
});

/** Mid-turn, Branch runs the draft's words beside the turn: it is offered only while there are words to run, never for
 *  attachments alone. A composer showing a status row keeps that row's Retry and stays usable. */
describe('the composer while a turn runs and under a status row', () => {
  test('Branch follows the words in the draft, not its attachments; a status row keeps its retry and the composer', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1100, height: 1200 });
      await page.goto(`${origin}/gallery.html?frame=composer`, { waitUntil: 'networkidle0' });
      const live = '[data-gallery-composer="live"]';
      const branch = () => page.$$eval(`${live} button`, (buttons) => buttons.some((button) => button.textContent?.trim() === 'Branch'));

      expect(await branch()).toBe(true);
      await page.$eval(`${live} textarea`, (box) => { box.select(); });
      await page.keyboard.press('Backspace');
      await page.waitForFunction((at) => ![...document.querySelectorAll(`${at} button`)].some((button) => button.textContent?.trim() === 'Branch'), {}, live);

      const attach = await page.$(`${live} input[type="file"]`);
      const file = `${process.env.TMPDIR ?? '/tmp'}/branch-attachment.csv`;
      await Bun.write(file, 'cart,total\n1,20\n');
      await attach?.uploadFile(file);
      await page.waitForFunction((at) => (document.querySelector(at)?.textContent ?? '').includes('branch-attachment.csv'), {}, live);
      expect(await branch()).toBe(false);

      await page.type(`${live} textarea`, 'try the other fix');
      await page.waitForFunction((at) => [...document.querySelectorAll(`${at} button`)].some((button) => button.textContent?.trim() === 'Branch'), {}, live);

      const notice = '[data-gallery-composer="notice"]';
      expect(await page.$$eval(`${notice} button`, (buttons) => buttons.some((button) => button.textContent?.trim() === 'Retry'))).toBe(true);
      expect(await page.$(`${notice} textarea:not([disabled])`)).not.toBeNull();
      await page.close();
    });
  });
});

describe('the Environment cards', () => {
  // Staging, 2026-10-08: at the inspector's default width every card ran past the panel's right edge.
  test('fit a panel as narrow as the inspector', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 340, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=environment`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-env-card="sandbox"] [data-env-size]');

      // Each card inside the page, and everything drawn in a card inside the card: its size choice ran past it.
      const past = await page.$$eval('[data-env-card]', (cards) => cards.flatMap((card) => {
        const edge = card.getBoundingClientRect().right;
        const drawn = [...card.querySelectorAll('*')].filter((inner) => inner.getClientRects().length > 0);
        const furthest = Math.max(edge, ...drawn.map((inner) => inner.getBoundingClientRect().right));

        return [
          [card.getAttribute('data-env-card'), Math.round(edge - document.documentElement.clientWidth)],
          [`${card.getAttribute('data-env-card') ?? ''} contents`, Math.round(furthest - edge)],
        ];
      }).filter(([, beyond]) => Number(beyond) > 0));

      expect(past).toEqual([]);
    });
  });
});
