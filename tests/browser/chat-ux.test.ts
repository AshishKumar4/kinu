/**
 * The workspace chat, as a browser lays it out. The gate is a browser, so its test is a browser.
 *
 * Two defects the owner hit are invisible to `tsc`, `oxlint` and every
 * source-reading test in this repo, because each is about where a rendered box
 * lands or which of two lines a browser puts it on:
 *
 *   - The streaming caret sat on a line of its OWN below the paragraph. It was
 *     a `<span>` after `<MarkdownContent>`, and markdown emits block elements.
 *     Valid TSX, valid CSS, wrong line.
 *   - A turn that finished its prose and went quiet between steps rendered no
 *     live affordance at all, because the "Thinking" row existed only while a
 *     message had no parts.
 *
 * Every assertion below is a measurement of the real components in a real
 * cascade. Cut either wire and its test fails while the rest of the repo stays
 * green — which is precisely what did not happen before.
 *
 * One server, one browser, one pass: booting vite costs several seconds and
 * every assertion here reads from the same frames.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { detach } from '@kinu.run/core/obs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'puppeteer';

import { withGallery } from '../../scripts/gallery-harness';
import { CHATS, pressInDialog, pressRowMenu, settled as framesSettled } from '../../scripts/browser-page';
import { ADVISOR_HEADER, OUTPUT_CONTINUATION_TEXT, OVERFLOW_RETRY_TEXT, parseJsonValue, redactPayload, type JsonObject } from '@kinu.run/core';
import { evidenceDir, present } from '@kinu.run/test-utils';

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
  readonly reasoning: { viewportHeight: number; pulse: string } | null;
  /** The animated label a call in flight carries on its own row. */
  readonly runningIndicators: number;
}

/** One chat row, as the browser placed and drew it. */
interface ChatRow {
  /** The owner's bubble, by the class only the user branch draws. */
  readonly userBubbles: number;
  /** The generic harness-event card's event name, or null when there is none. */
  readonly systemEvent: string | null;
  /** All the card says, its words and its controls'. */
  readonly said: string;
  /** Opened by the person: its control says so. */
  readonly open: boolean;
}

/** One Exploration run-node row, as the browser drew it. */
interface RunNode {
  /** What the row TELLS a reader the node's ending was, read off the row rather
   *  than inferred from the prose it happens to carry. */
  readonly reason: string | null;
}

interface ObservedChat {
  readonly tails: Record<string, TailFrame>;
  readonly reducedMotionTails: Record<string, TailFrame>;
  readonly chat: Record<string, ChatRow>;
  readonly forkInterruptedAfterClick: ChatRow;
  /** Each failure card by its state (`live`, `refused`): its headline and whether it offers the turn again. */
  readonly chatErrors: Record<string, { readonly heading: string; readonly retry: boolean }>;
  /** Exploration's run-node rows on the mixed-status run, by node id. */
  readonly runNodes: Record<string, RunNode>;
  readonly toolActivity: {
    /** The call rows on screen before the reader clicks anything, and once every run's line is opened. */
    folded: ToolRows;
    unfolded: ToolRows;
    /** Each run's line, in order, as its calls and its state. */
    runs: { calls: string | null; state: string | null }[];
    /** What the preview card shows while the runs are still closed. */
    collapsedPreview: { text: string | null; visible: boolean };
  };
}

/** The call rows on screen, by the effect each row declares. */
interface ToolRows {
  readonly reads: number;
  readonly others: number;
}

/** The call rows the reader can see now, by the effect each row declares. Runs in the page. */
function toolRows(): ToolRows {
  const rows = [...document.querySelectorAll<HTMLElement>('[data-tool-state]')].filter((row) => row.getClientRects().length > 0);

  return {
    reads: rows.filter((row) => row.dataset.toolEffect === 'read').length,
    others: rows.filter((row) => row.dataset.toolEffect !== 'read').length,
  };
}

/** The gallery ids the provenance assertions address (gallery.tsx MESSAGES). */
const UNSTAMPED_FORK_ROW = 'f8798675-5e9a-4d13-aac2-293f4557f1c1';

const STAMPED_GATE_ROW = 'programmatic:completion-gate-1';

const TYPED_ROW = 'u1';

const DRAIN_ROW = 'd1';

/** The two endings the node rows are read for (gallery.tsx RUNNING_RUN): one
 *  turn that stalled, one the operator stopped. */
const STALLED_NODE = 'lv008';

const ABORTED_NODE = 'lv005';

async function readChatRows(page: Page): Promise<Record<string, ChatRow>> {
  return page.$$eval('[data-chat-row]', (rows) => {
    const measured: Record<string, {
      userBubbles: number; systemEvent: string | null; said: string; open: boolean;
    }> = {};

    for (const row of rows) {
      const card = row.querySelector('[data-system-event]');
      measured[row.getAttribute('data-chat-row') ?? ''] = {
        userBubbles: row.querySelectorAll('[data-user-bubble]').length,
        systemEvent: card?.getAttribute('data-system-event') ?? null,
        said: card?.textContent ?? '',
        open: (card?.querySelector('[aria-expanded="true"]') ?? null) !== null,
      };
    }

    return measured;
  });
}

async function readRunNodes(page: Page): Promise<Record<string, RunNode>> {
  return page.$$eval('[data-run-node]', (rows) => {
    const measured: Record<string, { reason: string | null }> = {};

    for (const row of rows) {
      const line = row.querySelector('[data-node-reason]');
      measured[row.getAttribute('data-run-node') ?? ''] = {
        reason: line === null ? null : line.getAttribute('data-node-reason'),
      };
    }

    return measured;
  });
}

async function readTails(page: Page): Promise<Record<string, TailFrame>> {
  return page.$$eval('[data-stream-id]', (rows) => {
    const measured: Record<string, TailFrame> = {};

    for (const row of rows) {
      const streaming = row.querySelector('[data-streaming]');
      const last = streaming?.lastElementChild ?? null;
      let heightCostPx = 0;

      if (streaming !== null) {
        const withCaret = streaming.getBoundingClientRect().height;
        streaming.classList.remove('p-streaming');
        heightCostPx = Math.round(withCaret - streaming.getBoundingClientRect().height);
        streaming.classList.add('p-streaming');
      }

      const viewport = row.querySelector('[data-reasoning] [data-disclosure-body="live"]');

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
          pulse: labelStyle?.animationName ?? 'none',
        } : null,
        // Tool styling can change; the semantic state is the contract.
        runningIndicators: row.querySelectorAll('[data-tool-state="running"]').length,
      };
    }

    return measured;
  });
}

async function runChat(): Promise<ObservedChat> {
  return withGallery(async ({ newPage, origin }) => {
    const stream = await newPage();
    await stream.setViewport({ width: 1280, height: 1400 });
    await stream.goto(`${origin}/gallery.html?frame=streaming`, { waitUntil: 'networkidle0' });
    await stream.reload({ waitUntil: 'networkidle0' });
    await stream.waitForSelector('[data-gallery-stream] [data-streaming]');
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
          heading: card.textContent ?? '',
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
    const runs = await tools.$$eval('[data-tool-run]', (lines) => lines.map((line) => ({ calls: line.getAttribute('data-tool-run-calls'), state: line.getAttribute('data-tool-run') })));

    // The preview card, read while the runs are still closed: the reader has clicked nothing, and the app the turn
    // started is on screen.
    const previewFrameHandle = await tools.waitForSelector('iframe');

    if (previewFrameHandle === null) throw new Error('the closed runs drew no preview frame');
    const previewDocument = await previewFrameHandle.contentFrame();

    if (!previewDocument) throw new Error('the preview frame created no document');
    await previewDocument.waitForSelector('[data-run-preview]');

    const collapsedPreview = {
      text: await previewDocument.$eval('[data-run-preview]', (element) => element.textContent),
      visible: await previewFrameHandle.isIntersectingViewport(),
    };

    // Every run's line opened, as a reader opens them.
    await tools.$$eval('[data-tool-run] > button[aria-expanded="false"]', (lines) => { for (const line of lines) if (line instanceof HTMLButtonElement) line.click(); });
    await tools.waitForFunction((shown: number) => document.querySelectorAll('[data-tool-state]').length > shown
      && [...document.querySelectorAll('[data-tool-run] [data-tool-state]')].every((row) => row.getClientRects().length > 0), {}, folded.reads + folded.others);

    const unfolded = await tools.evaluate(toolRows);

    const toolActivity = { folded, unfolded, runs, collapsedPreview };
    await tools.close();

    const explore = await newPage();
    await explore.setViewport({ width: 1280, height: 1100 });
    await explore.goto(`${origin}/gallery.html?frame=forkrunning`, { waitUntil: 'networkidle0' });
    await explore.reload({ waitUntil: 'networkidle0' });
    await explore.waitForSelector(`[data-run-node="${STALLED_NODE}"]`);
    const runNodes = await readRunNodes(explore);
    await explore.close();

    return { tails, reducedMotionTails, chat, forkInterruptedAfterClick, chatErrors, toolActivity, runNodes };
  });
}

/** Stable fixture identities from `STREAMING_MESSAGES` (gallery.tsx). */
const TEXT = 'st-text';

const AFTER_TOOLS = 'st-after-tools';

const TOOL_IN_FLIGHT = 'st-tool';

const REASONING = 'st-reasoning';

const NO_PARTS = 'st-empty';

let observed: ObservedChat;

beforeAll(async () => { observed = await runChat(); });

describe('the streaming turn, as a browser lays it out', () => {
  test('the caret is drawn, and drawn INSIDE the last block of the streamed text', () => {
    const tail = observed.tails[TEXT];
    // Cut `p-streaming` off the text block, or delete the CSS rule, and the
    // pseudo-element stops having a width.
    expect(Number.parseFloat(tail.caretWidth)).toBeGreaterThan(0);
    // The whole reported defect: a sibling span after a <p> starts a new line.
    expect(tail.heightCostPx).toBe(0);
  });

  test('a turn that went quiet between steps says so at its tail', () => {
    // Prose closed, both calls settled, request still open. This is the state
    // with no active part of its own to draw, and it still has to say so.
    expect(observed.tails[AFTER_TOOLS].thinkingRows).toBe(1);
  });

  test('a turn before its first token says so', () => {
    expect(observed.tails[NO_PARTS].thinkingRows).toBe(1);
  });

  test('a call in flight owns the running state — no second claim under it', () => {
    // One stream position reports one current activity.
    expect(observed.tails[TOOL_IN_FLIGHT].thinkingRows).toBe(0);
    expect(observed.tails[TOOL_IN_FLIGHT].runningIndicators).toBe(1);
  });

  test('streaming reasoning marks its own block live instead of adding a row', () => {
    expect(observed.tails[REASONING].thinkingRows).toBe(0);
    const reasoning = present(observed.tails[REASONING].reasoning, 'the streaming reasoning block');

    expect(reasoning.viewportHeight).toBeGreaterThan(0);
    // The label moves while the words arrive; under reduced motion it is still.
    expect(reasoning.pulse).not.toBe('none');
    expect(present(observed.reducedMotionTails[REASONING].reasoning, 'the reduced-motion reasoning block').pulse)
      .toBe('none');
  });

  test('a turn actively writing text is never also announced as thinking', () => {
    expect(observed.tails[TEXT].thinkingRows).toBe(0);
  });
});

describe('large tool runs, as the timeline draws them', () => {
  // The owner's rule, 2026-10-17: a run of calls in a row is one line, closed once the turn has moved on, and what the
  // owner reads (a preview the run started) stands outside it. Fifty reads, the preview, then three more calls.
  test('each run of calls is one closed line that counts them, and the preview between them splits the runs', () => {
    expect(observed.toolActivity.runs).toEqual([{ calls: '50', state: 'settled' }, { calls: '3', state: 'settled' }]);
  });

  test('no call row shows until its run is opened, and opening the runs shows every one', () => {
    const { folded, unfolded } = observed.toolActivity;

    // The preview call stands outside the runs, its own row on screen.
    expect(folded).toEqual({ reads: 0, others: 1 });
    expect(unfolded).toEqual({ reads: 50, others: 4 });
  });

  test('the app a mid-run call started is on screen before any click', () => {
    const { collapsedPreview } = observed.toolActivity;

    expect(collapsedPreview.text).toBe('the running app');
    expect(collapsedPreview.visible).toBe(true);
  });
});

/** Each run of calls in the chat, in order: its calls, its state, its failures, how long it took, and its rows on screen. */
function chatRuns(page: Page): Promise<{ calls: string | null; state: string | null; failed: string | null; span: boolean; rowsShown: number }[]> {
  return page.$$eval('[data-transcript] [data-tool-run]', (runs) => runs.map((line) => ({
    calls: line.getAttribute('data-tool-run-calls'),
    state: line.getAttribute('data-tool-run'),
    failed: line.querySelector('[data-tool-run-failed]')?.getAttribute('data-tool-run-failed') ?? null,
    span: line.hasAttribute('data-tool-run-span'),
    rowsShown: [...line.querySelectorAll('[data-tool-state]')].filter((row) => row.getClientRects().length > 0).length,
  })));
}

/** Shows the newest turn as a run of `calls` calls so far (gallery-tool-runs.tsx), as its stream would. */
async function runSoFar(page: Page, detail: { calls: number; failAt?: number; answer?: boolean; agent?: string }): Promise<void> {
  await page.evaluate((asked) => { window.dispatchEvent(new CustomEvent('gallery:tool-run', { detail: asked })); }, detail);
}

/** The live run's view: its height, and whether its newest row is inside what it shows. */
function liveView(page: Page): Promise<{ height: number; newestShown: boolean } | null> {
  return page.evaluate(() => {
    const view = document.querySelector('[data-tool-run="live"] [data-disclosure-body="live"]');
    const newest = [...(view?.querySelectorAll('[data-tool-state]') ?? [])].at(-1);

    if (view === null || newest === undefined) return null;
    const box = view.getBoundingClientRect();
    const row = newest.getBoundingClientRect();

    return { height: Math.round(box.height), newestShown: row.top >= box.top - 1 && row.bottom <= box.bottom + 1 };
  });
}

/**
 * The owner, 2026-10-17: a run of tool calls in a row, and the thinking between them, collapses into one line, as
 * thinking does. While it runs, the line says what it is doing over a small view that follows its newest step; once
 * the answer starts it settles closed, saying how many tools it used and how long it took. The answer, a preview and a
 * question for the owner stay outside it, and a failure inside shows on its line.
 */
describe("a turn's runs of tool calls, in the real chat", () => {
  test('each run is one closed line; the answer, the preview and the question stand outside, and a failure says so', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1000 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage&transcript=toolruns`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-transcript] [data-tool-run]');

      expect(await chatRuns(page)).toEqual([
        { calls: '6', state: 'settled', failed: null, span: false, rowsShown: 0 },
        { calls: '20', state: 'settled', failed: '1', span: false, rowsShown: 0 },
        { calls: '2', state: 'settled', failed: null, span: false, rowsShown: 0 },
        { calls: '2', state: 'settled', failed: null, span: false, rowsShown: 0 },
      ]);
      expect(await page.evaluate(() => ({
        answers: [...document.querySelectorAll('[data-transcript] [data-said]')].filter((answer) => answer.closest('[data-tool-run]') === null && answer.getClientRects().length > 0).length,
        previewOutside: document.querySelector('[data-transcript] iframe') !== null && document.querySelector('[data-tool-run] iframe') === null,
        askOutside: document.querySelector('[data-transcript] [data-ask-record]') !== null && document.querySelector('[data-tool-run] [data-ask-record]') === null,
      }))).toEqual({ answers: 3, previewOutside: true, askOutside: true });

      // Opened, the run with the failure shows every step, the failed one among them.
      const failedRun = '[data-transcript] [data-tool-run-calls="20"]';

      await page.click(`${failedRun} > button`);
      await page.waitForFunction((line: string) => document.querySelector(`${line} [data-tool-state="failed"]`)?.getClientRects().length === 1, {}, failedRun);
      expect(await page.$eval(failedRun, (line) => [...line.querySelectorAll('[data-tool-state]')].filter((row) => row.getClientRects().length > 0).length)).toBe(20);
      await page.close();
    });
  });

  test('a live run follows its newest step in a small view, says a failure on its line, and settles closed once the answer starts', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1000 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage&transcript=toolruns`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-transcript] [data-tool-run]');
      await claimIs(page, { kind: 'admitted', turnId: 'tr-u4', claimedAt: 1 });

      // One call is its own row; a second makes a run, live, its view on screen.
      await runSoFar(page, { calls: 1 });
      await page.waitForSelector('[data-transcript] [data-tool-state="running"]');
      await runSoFar(page, { calls: 3 });
      await page.waitForSelector('[data-tool-run="live"]');
      expect((await liveView(page))?.newestShown).toBe(true);

      // Twenty-two calls in, one failed: the view stays small and still shows the newest, and the line names the failure.
      await runSoFar(page, { calls: 22, failAt: 4 });
      await page.waitForFunction(() => document.querySelector('[data-tool-run="live"]')?.getAttribute('data-tool-run-calls') === '22');
      await page.waitForFunction(() => {
        const view = document.querySelector('[data-tool-run="live"] [data-disclosure-body="live"]');

        return view !== null && Math.abs(view.scrollTop + view.clientHeight - view.scrollHeight) <= 1;
      });
      const view = await liveView(page);

      expect(view?.newestShown).toBe(true);
      expect(view === null ? null : view.height <= 160).toBe(true);
      expect((await chatRuns(page)).at(-1)?.failed).toBe('1');

      // The answer starts: the run settles closed, saying how long it took, and the answer is outside it.
      await runSoFar(page, { calls: 22, failAt: 4, answer: true });
      await page.waitForFunction(() => document.querySelector('[data-tool-run="live"]') === null);
      expect((await chatRuns(page)).at(-1)).toEqual({ calls: '22', state: 'settled', failed: '1', span: true, rowsShown: 0 });
      expect(await page.evaluate(() => [...document.querySelectorAll('[data-transcript] [data-said]')].at(-1)?.closest('[data-tool-run]') === null)).toBe(true);
      await page.close();
    });
  });

  // Main, 2026-10-17: the line reads as the thinking block's does, a quiet chevron mark, not a word like a link; the
  // shots show it turning.
  test("a run's line is one control: no word but what it says, a chevron mark, and anywhere on it opens it", async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1000 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage&transcript=toolruns`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-transcript] [data-tool-run]');
      const line = '[data-transcript] [data-tool-run-calls="6"] > button';

      const read = () => page.$eval(line, (button) => ({
        open: button.getAttribute('aria-expanded'),
        extra: (button.textContent ?? '').replace(button.querySelector('[data-disclosure-label]')?.textContent ?? '', '')
          .replace(button.querySelector('[data-disclosure-after]')?.textContent ?? '', '').trim(),
        mark: button.querySelector('[data-disclosure-turn]') !== null,
      }));

      expect(await read()).toEqual({ open: 'false', extra: '', mark: true });

      // Pressed past its words and its mark, at the line's far end: the line is the control, not its words.
      await page.$eval(line, (button) => { button.scrollIntoView({ block: 'center' }); });

      const far = await page.$eval(line, (button) => {
        const whole = button.getBoundingClientRect();
        const mark = button.querySelector('[data-disclosure-turn]')?.getBoundingClientRect();

        return { x: whole.right - 2, y: whole.top + whole.height / 2, pastMark: mark === undefined ? false : whole.right - 2 > mark.right };
      });

      expect(far.pastMark).toBe(true);
      await page.mouse.click(far.x, far.y);
      await page.waitForFunction((selector: string) => document.querySelector(selector)?.getAttribute('aria-expanded') === 'true', {}, line);
      expect(await read()).toEqual({ open: 'true', extra: '', mark: true });
      await page.close();
    });
  });

  test("a hired agent's chat and a search node's transcript draw their runs the same way", async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1000 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage&transcript=toolruns`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-transcript] [data-tool-run]');
      await page.evaluate(async () => { await window.galleryNavigate?.('/workspace/api-worker/agents/route-checker'); });
      await page.waitForFunction(() => document.querySelector('[data-composer-root] textarea')?.getAttribute('placeholder')?.includes('route-checker') === true);
      await page.waitForSelector('[data-transcript] [data-tool-run]');
      expect((await chatRuns(page)).map((line) => [line.calls, line.state, line.rowsShown])).toEqual([['6', 'settled', 0], ['20', 'settled', 0], ['2', 'settled', 0], ['2', 'settled', 0]]);

      await page.goto(`${origin}/gallery.html?frame=transcript`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-tool-run]');
      expect(await page.$$eval('[data-tool-run]', (runs) => runs.every((line) => line.getAttribute('data-tool-run') === 'settled'
        && [...line.querySelectorAll('[data-tool-state]')].every((row) => row.getClientRects().length === 0)))).toBe(true);
      await page.close();
    });
  });
});

describe('a turn the harness wrote, as the browser attributes it', () => {
  test('the owner\'s own message is still the owner\'s bubble, pushed right', () => {
    // The denominator. Without it, a change that turned EVERY row into an event
    // card would satisfy every assertion below.
    const typed = observed.chat[TYPED_ROW];
    expect(typed.userBubbles).toBe(1);
    expect(typed.systemEvent).toBeNull();
  });

  test('the fork-interrupted row wears an event card, never the owner\'s bubble', () => {
    // THE INCIDENT, as a browser draws it. This row is the production shape:
    // a bare UUID id and `kinuEvent: fork_interrupted`, no author stamp,
    // which is what five rows in the owner's live workspaces look like. Under
    // the four-name allowlist this rendered right-aligned in `[data-user-bubble]`.
    const fork = observed.chat[UNSTAMPED_FORK_ROW];
    expect(fork.userBubbles).toBe(0);
    expect(fork.systemEvent).toBe('fork_interrupted');
  });

  test('a stamped harness turn lands the same way, without its event name mattering', () => {
    const gate = observed.chat[STAMPED_GATE_ROW];
    expect(gate.userBubbles).toBe(0);
    expect(gate.systemEvent).toBe('completion_gate');
  });

  test('the harness\'s words never show, folded or opened: the card says what happened', () => {
    // What the agent was handed is written for the model, in its terms; the
    // person reads what happened, from the event's fields, whether the card is
    // folded or opened.
    const handed = 'still marked running from an activation that has ended';
    expect(observed.chat[UNSTAMPED_FORK_ROW].said).not.toContain(handed);
    expect(observed.forkInterruptedAfterClick.open).toBe(true);
    expect(observed.forkInterruptedAfterClick.said).not.toContain(handed);
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

    expect(refused?.heading).toContain('Unauthorized');
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
      // The thoughts lead a run of calls, so they stand before it, outside it, as thinking always has.
      await page.waitForSelector('[data-chat-row="a1"] [data-reasoning] button[aria-expanded="false"]');
      expect(await page.$eval('[data-chat-row="a1"] [data-reasoning]', (block) => block.closest('[data-tool-run]') === null)).toBe(true);
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

describe('a settled thought folds to its line', () => {
  // m1111: a thought that is one long paragraph never folded, because the fold counted source lines; 2026-10-23, the
  // owner: once done, a thought folds as a phase does.
  test('one long paragraph shows none of itself and an expand, and expanding shows all of it', async () => {
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
      expect(open.height).toBeGreaterThan(folded.height);
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

      // A second click on the same glyph clears it — the RPC writes null.
      await page.click(up);
      await page.waitForFunction(
        () => (document.documentElement.dataset.galleryFeedbackCalls ?? '').split('[').length - 1 >= 2,
      );

      const calls = await page.evaluate(() => JSON.parse(document.documentElement.dataset.galleryFeedbackCalls ?? '[]'));
      expect(calls).toEqual([{ method: 'setTurnFeedback', args: ['a1', 'positive'] }, { method: 'setTurnFeedback', args: ['a1', null] }]);
      await page.close();
    });
  });
});

describe('an errored node, as the run list reads it', () => {
  test('a stalled node and a stopped one both read as failures, each with its own reason', () => {
    expect([observed.runNodes[STALLED_NODE]?.reason, observed.runNodes[ABORTED_NODE]?.reason]).toEqual(['failed', 'failed']);
  });
});

/**
 * One workspace, one Durable Object, one socket per pane — and `broadcast`
 * reaches every one of them. The frames a hosted actor's host emits are
 * stamped with that actor; the root's own are not. A client that ignored the
 * stamp rendered a subagent's cards in the workspace's own chat, which is
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
      await page.waitForSelector(CHATS);
      await page.waitForSelector('[data-transcript]');

      // The refiner's own card first, stamped with its actor, then the
      // workspace's own drain with no stamp. The order is the failure's: the
      // stamped frame arrives before anything a reader could confuse it with,
      // so the unstamped card rendering is this row's end condition and the
      // absence below is read after the socket has certainly been heard.
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('gallery:push-frame', { detail: {
          type: 'signal_card', id: 'sig-refiner', state: 'pending', at: Date.now(), actorId: 'actor-refiner',
          metadata: { kinuEvent: 'event_drain' },
          text: '- [refinement] from refiner (self-review): reviewed 3 graded turns and changed nothing',
        } }));
        window.dispatchEvent(new CustomEvent('gallery:push-frame', { detail: {
          type: 'signal_card', id: 'sig-workspace', state: 'pending', at: Date.now(),
          metadata: { kinuEvent: 'event_drain' },
          text: '- [webhook] from stripe: a payout of 240.00 settled',
        } }));
      });

      await page.waitForFunction(() => (
        document.querySelector('[data-transcript]')?.textContent?.includes('a payout of 240.00 settled') === true
      ));

      const thread = await page.$eval('[data-transcript]', (el) => el.textContent ?? '');

      expect(thread).not.toContain('reviewed 3 graded turns and changed nothing');
      expect(thread).not.toContain('refiner');
      // One card, not two: the count is the assertion, because a dropped frame
      // and a rendered-but-scrolled-away one read the same in a text search.
      expect(await page.$$eval(
        '[data-transcript] button',
        (buttons) => buttons.filter((button) => button.innerText.includes('settled') || button.innerText.includes('graded turns')).length,
      )).toBe(1);

      await page.close();
    });
  });
});

/** Each row of `?frame=provenance` as a reader meets it: whose bubble, which card, and what each drained event says. */
function readProvenance(page: Page) {
  return page.$$eval('[data-chat-row]', (rows) => Object.fromEntries(rows.map((row) => [row.getAttribute('data-chat-row') ?? '', {
    bubble: row.querySelector('[data-user-bubble]') !== null,
    card: row.querySelector('[data-signal-card]') !== null,
    systemEvent: row.querySelector('[data-system-event]')?.getAttribute('data-system-event') ?? null,
    advisor: row.querySelector('[data-advisor-severity]')?.getAttribute('data-advisor-severity') ?? null,
    events: [...row.querySelectorAll('[data-drained-event]')].map((event) => ({
      variant: event.getAttribute('data-drained-event'),
      replyExpected: event.hasAttribute('data-reply-expected'),
      source: event.querySelector('[data-event-source]')?.textContent ?? '',
      brief: event.querySelector('[data-event-brief]')?.textContent ?? '',
      text: event.textContent ?? '',
    })),
    text: row.textContent ?? '',
    height: row.getBoundingClientRect().height,
  }])));
}

/** Each provenance row said by its summary (gallery.tsx SYSTEM_EVENT_ROWS), by words only the text it handed the agent has. */
const HANDED = new Map([
  ['event-task-reminder', 'system-reminder'],
  ['event-task-reminder-kept', 'system-reminder'],
  ['event-continuation', OUTPUT_CONTINUATION_TEXT.slice(0, 40)],
  ['event-overflow', OVERFLOW_RETRY_TEXT.slice(0, 40)],
  ['event-gate', 'a mechanical gate'],
  ['event-consent', 'Re-issue the approved commands'],
  ['event-sandbox', 'Incident id'],
  ['event-plan-approved', 'approved-plan'],
  ['event-plan-feedback', 'submit_plan'],
  ['event-slate', 'streams to slate'],
  ['event-waits', 'Your owner has handled'],
  ['event-take', 'parallel branch'],
  ['event-fork', 'still marked running'],
  ['event-unknown', 'only the agent should read'],
  ['invented', 'Something new happened'],
  ['harness', 'The tree is clean'],
  ['adv-nit', ADVISOR_HEADER.slice(0, 60)],
  ['adv-concern', ADVISOR_HEADER.slice(0, 60)],
  ['adv-blocker', ADVISOR_HEADER.slice(0, 60)],
]);

/** The loose cards in the workspace's thread, each by its state and the briefs it lists. */
function threadCards(page: Page): Promise<{ state: string | null; briefs: string[] }[]> {
  return page.$$eval('[data-transcript] [data-signal-card]', (cards) => cards.map((card) => ({
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
  type: 'signal_card', id, state, at: Date.now(), metadata: { kinuEvent: 'event_drain' }, text: `- [webhook] from stripe: ${brief}`,
});

/**
 * A turn the person did not type never wears their bubble, whichever way it was written: an operator's words from
 * an MCP client or a steer re-run keep theirs, and a harness, a job, an advisor or a drained batch get a card. The
 * drains are core's own text, so a card reads what the agent was told.
 */
/** Where, in the thread's reading order, each of `needles` first appears: the index of the element that draws it. */
function readingOrder(page: Page, needles: readonly string[]): Promise<number[]> {
  return page.$$eval('[data-transcript] *', (all, wanted) => wanted.map((needle) => all.findIndex((el) => (el.textContent ?? '').includes(needle)
    && ![...el.children].some((child) => (child.textContent ?? '').includes(needle)))), needles);
}

const agentReport = (id: string, timestamp: number, content: string) => ({
  type: 'subagent_event', id, kind: 'report', subagent: 'binding-auditor', status: 'completed', content, timestamp,
});

/** The gallery's spliced webhook, and the words of the answer's two steps around it. */
const SPLICE = { brief: 'Translation job 4471 finished (de-DE)', before: 'Waiting on the German strings', after: 'The translation landed' } as const;

/** How far the agent has got with the spliced card, as its mark says it and as its colour does. */
function spliceDelivery(page: Page): Promise<{ state: string | null; tone: string | null } | null> {
  return page.evaluate(() => {
    const mark = document.querySelector('[data-spliced-signal="sig-lilt"] [data-delivery], [data-transcript] [data-signal-card] [data-delivery]');

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
      await page.waitForSelector('[data-transcript]');
      const text = `Events arrived while you were working:\n- [webhook] from lilt: ${SPLICE.brief}`;

      await pushFrames(page, [{ type: 'signal_card', id: 'sig-lilt', state: 'pending', at: Date.now(), metadata: { kinuEvent: 'event_drain', kinuAuthor: 'harness' }, text }]);
      await page.waitForFunction(() => document.querySelector('[data-transcript] [data-signal-card] [data-delivery="pending"]') !== null);
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
      expect(await page.$$eval('[data-transcript] [data-signal-card]', (cards) => cards.length)).toBe(1);
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
      expect(await spliceDelivery(page)).toMatchObject({ state: 'seen' });
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
      await page.waitForFunction(() => document.querySelector('[data-transcript]')?.textContent?.includes('routes/webhooks.ts') === true);
      // The fixture's two asks were written eight and six minutes ago.
      const now = await page.evaluate(() => Date.now());

      await pushFrames(page, [
        agentReport('rep-between', now - 7 * 60e3, 'between the two asks'),
        agentReport('rep-after', now + 60e3, 'after every answer'),
        agentReport('rep-twice-1', now + 120e3, 'the same report'),
        agentReport('rep-twice-2', now + 121e3, 'the same report'),
        { type: 'signal_card', id: 'sig-lilt', state: 'pending', at: now - 7 * 60e3 + 1, metadata: { kinuEvent: 'event_drain' },
          text: '- [webhook] from lilt: New Lilt chat activity\n- [webhook] from lilt: New Lilt chat activity' },
      ]);
      await page.waitForFunction(() => document.querySelector('[data-transcript]')?.textContent?.includes('New Lilt chat activity') === true);

      const [first, between, card, second, after] = await readingOrder(page, [
        'Add the missing-binding regression test', 'between the two asks', 'New Lilt chat activity', 'Now move the webhook routes onto openDb', 'after every answer',
      ]);

      // A card of the server's, like an approval answered, sits where it was delivered as a report does.
      expect({
        between: (first ?? 0) < (between ?? 0) && (between ?? 0) < (second ?? 0),
        card: (first ?? 0) < (card ?? 0) && (card ?? 0) < (second ?? 0),
        after: (second ?? 0) < (after ?? 0),
      }).toEqual({ between: true, card: true, after: true });

      const drawn = await page.evaluate(() => ({
        reports: [...document.querySelectorAll('[data-subagent-event]')].filter((row) => row.textContent?.includes('the same report'))
          .map((row) => row.querySelector('[data-event-repeats]')?.textContent ?? '1'),
        lilt: [...document.querySelectorAll('[data-drained-event]')].filter((row) => row.textContent?.includes('New Lilt chat activity'))
          .map((row) => row.querySelector('[data-event-repeats]')?.textContent ?? '1'),
      }));

      expect(drawn).toEqual({ reports: ['×2'], lilt: ['×2'] });

      // One line until opened: the report reads in full once its row is clicked.
      const row = '[data-subagent-event] [data-event-brief]';
      await page.evaluate(() => { [...document.querySelectorAll('[data-subagent-event]')].find((el) => el.textContent?.includes('between the two asks'))?.querySelector('button')?.click(); });
      await page.waitForFunction((brief) => [...document.querySelectorAll(brief)].some((el) => el.classList.contains('whitespace-pre-wrap')), {}, row);
      await page.close();
    });
  });

  test('a machine gone offline and a model taking over are rows too, the same hand-off twice drawn once', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 2400 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage&devices=none`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-transcript]');
      const handOff = 'anthropic/claude-sonnet-4 took over from opencode-go/muse-spark-1.3-contributor: provider stream reset';

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
        connect: '/user/settings#devices',
      });

      // One line until opened, as every event row is.
      await page.click('[data-model-fallback] button[aria-expanded="false"]');
      await page.waitForSelector('[data-model-fallback] [aria-expanded="true"]');
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

      for (const id of ['job', 'job-bare', 'invented', 'harness', 'adv-nit', 'adv-concern', 'adv-blocker', 'drain-delegated', 'drain-idle', 'drain-mail']) {
        expect([id, row(id).bubble, row(id).card]).toEqual([id, false, true]);
      }

      // The workspace's first turn is its own provenance: stored, never drawn.
      expect(row('genesis')).toMatchObject({ bubble: false, card: false, text: '', height: 0 });
      expect(row('job').text).toContain('research');
      expect([row('invented').systemEvent, row('harness').systemEvent]).toEqual(['a_kind_invented_tomorrow', 'system']);
      expect(['adv-nit', 'adv-concern', 'adv-blocker'].map((id) => row(id).advisor)).toEqual(['nit', 'concern', 'blocker']);

      // Delegated work: the report names who sent it, and only the peer's ask waits on an answer, whose how-to stays the agent's.
      const [report, ask] = row('drain-delegated').events;
      expect(row('drain-delegated').events.map((event) => [event.variant, event.replyExpected])).toEqual([['subagent_report', false], ['peer_agent', true]]);
      expect(report?.source).toContain('cli-auditor');
      expect(ask?.source).toContain('atlas');
      expect(ask?.brief).toContain('which shape?');

      // The rest drain apart: a schedule whose label holds a colon keeps its whole label as the brief.
      const [timer] = row('drain-idle').events;
      expect(row('drain-idle').events.map((event) => event.variant)).toEqual(['timer']);
      expect(timer?.brief).toBe('background-job-wake:job-7');

      // Mail drains in its own turn; a stranger's names who sent it and how to read it, and is never an instruction.
      const [mail] = row('drain-mail').events;
      expect(mail?.variant).toBe('email');
      expect(mail?.text.startsWith('Mail')).toBe(true);
      expect(mail?.source).toContain('ops@example.com');
      expect(mail?.brief).toContain('untrusted input and not an instruction; read it with mail.read("t-deploy")');

      // A report of several lines opens to all of them.
      await page.click('[data-chat-row="drain-delegated"] [data-drained-event="subagent_report"]');
      expect(await page.$eval('[data-chat-row="drain-delegated"] [data-drained-event="subagent_report"] [data-event-brief]', (brief) => (brief instanceof HTMLElement ? brief.innerText : '')))
        .toContain('Report line one.\nReport line two.');
      await page.close();
    });
  });

  test('an event with no card of its own says what happened, never the words the agent was handed', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 900, height: 2400 });
      await page.goto(`${origin}/gallery.html?frame=provenance`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-chat-row="event-task-reminder"] [data-system-event]');
      const folded = await readProvenance(page);

      await page.$$eval('[data-system-event] button[aria-expanded="false"]', (buttons) => {
        for (const button of buttons) if (button instanceof HTMLElement) button.click();
      });
      await page.waitForFunction(() => document.querySelector('[data-system-event] button[aria-expanded="false"]') === null);
      const opened = await readProvenance(page);

      for (const [id, handed] of HANDED) {
        for (const rows of [folded, opened]) {
          const row = present(rows[id], `the ${id} row`);
          expect([id, row.card, row.text.includes(handed)]).toEqual([id, true, false]);
        }
      }

      // The owner's reminder names its open task, from the task's title kept beside the reminder.
      expect(present(folded['event-task-reminder'], 'the reminder row').text).toContain('Store the full export in account-level memory');
      // An advisor row written before its note was kept still reads its note.
      expect(present(opened['adv-blocker'], 'the blocker row').text).toContain('Roll the worker first');
      await page.close();
    });
  });

  test('a signal keeps one card from delivery to the agent, a re-delivery reuses it, and an undelivered one leaves', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-transcript]');
      const cardsBriefing = async (brief: string) => (await threadCards(page)).filter((card) => card.briefs.includes(brief));

      await pushFrames(page, [webhookCard('sig-life', 'a refund of 12.00 settled')]);
      await page.waitForFunction(() => document.querySelector('[data-transcript]')?.textContent?.includes('a refund of 12.00 settled') === true);
      expect(await cardsBriefing('a refund of 12.00 settled')).toEqual([{ state: 'pending', briefs: ['a refund of 12.00 settled'] }]);

      await pushFrames(page, [{ type: 'signal_card', id: 'sig-life', state: 'shown' }]);
      await page.waitForSelector('[data-transcript] [data-signal-card="shown"]');
      expect(await cardsBriefing('a refund of 12.00 settled')).toEqual([{ state: 'shown', briefs: ['a refund of 12.00 settled'] }]);

      // Delivered again after it was shown: the same card, pending once more and saying the new words.
      await pushFrames(page, [webhookCard('sig-life', 'a refund of 12.00 settled twice')]);
      await page.waitForFunction(() => document.querySelector('[data-transcript]')?.textContent?.includes('settled twice') === true);
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
      await page.waitForFunction(() => document.querySelector('[data-transcript]')?.textContent?.includes('a payout of 3.00 settled') === true);
      expect(await cardsBriefing('a refund of 12.00 settled twice')).toEqual([]);
      expect((await threadCards(page)).length).toBe(before);

      // Cards keep arrival order, and a flood keeps the newest fifty.
      await pushFrames(page, Array.from({ length: 60 }, (_, at) => webhookCard(`sig-flood-${String(at)}`, `flood ${String(at).padStart(2, '0')}`)));
      await page.waitForFunction(() => document.querySelector('[data-transcript]')?.textContent?.includes('flood 59') === true);
      const flood = (await threadCards(page)).flatMap((card) => card.briefs).filter((brief) => brief.startsWith('flood'));
      expect(flood).not.toBeEmpty();
      expect(flood).toEqual(Array.from({ length: flood.length }, (_, at) => `flood ${String(60 - flood.length + at).padStart(2, '0')}`));
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
   * Stop gives the next Send its own turn, but only once the stop's cancel has come back and the stopped send has
   * landed: until then the composer stays on the Stop, and words typed go to the running turn. A send the transport
   * fails frees the next one. (A stopped send landing after a newer turn took the latch cannot happen from here now;
   * the latch's own fence against it is unit-send-admission's.)
   */
  test('a stopped or failed send frees the next turn, once the stopped one has landed', async () => {
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

      const settleSend = (at: number, failed = false) => page.evaluate((detail) => {
        window.dispatchEvent(new CustomEvent('gallery:settle-send', { detail }));
      }, { at, failed });

      await press('Send', 'first turn');
      expect(await counts()).toEqual({ turns: 1, toRunning: [] });
      await page.waitForSelector('[data-composer-root] button[aria-label="Stop this turn"]');

      // Stopped, with its cancel still out: the composer stays on the Stop, and words typed go to the running turn.
      await page.evaluate(() => { document.documentElement.dataset.galleryCancelHeld = '1'; });
      await page.click('[data-composer-root] button[aria-label="Stop this turn"]');
      await page.waitForSelector('[data-composer-root] button[aria-label="Stop this turn"]:disabled');
      await press('Steer the running turn', 'during the stop');
      expect(await counts()).toEqual({ turns: 1, toRunning: ['during the stop'] });

      // The cancel comes back and the stopped send lands: Send returns, and opens a turn of its own.
      await page.evaluate(() => {
        document.documentElement.dataset.galleryCancelHeld = '0';
        window.dispatchEvent(new Event('gallery:release-cancel'));
      });
      await settleSend(0);
      await page.waitForSelector('[data-composer-root] button[aria-label="Send"]');
      await press('Send', 'second turn');
      expect((await counts()).turns).toBe(2);
      await page.waitForSelector('[data-composer-root] button[aria-label="Stop this turn"]');

      // The transport fails the second: the next Send opens a turn of its own.
      await settleSend(1, true);
      await page.waitForSelector('[data-composer-root] button[aria-label="Send"]');
      await press('Send', 'after the failure');
      expect(await counts()).toEqual({ turns: 3, toRunning: ['during the stop'] });
      await page.close();
    });
  });

  /**
   * A Stop that reached the agent before an opening's words did hands them back (2026-10-18): they return to the draft
   * under the Stop's own notice, as a steer's do, and no failure shows. Send waits for that: offered before, a Continue
   * pressed at once ran without the brief the Stop was about to hand back (1008-e, staging rc20). An opening no Stop
   * touched is read where it ran.
   */
  test('words a Stop handed back before the agent read them are in the draft when Send returns, and no failure shows', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-composer-root] textarea');
      await page.evaluate(() => {
        document.documentElement.dataset.galleryChatHold = '1';
        document.documentElement.dataset.galleryHandedBack = '1';
      });

      const composer = () => page.evaluate(() => ({
        draft: document.querySelector<HTMLTextAreaElement>('[data-composer-root] textarea')?.value ?? '',
        notices: [...document.querySelectorAll('[data-composer-root] [data-notice]')].map((notice) => notice.getAttribute('data-notice')),
      }));

      await page.type('[data-composer-root] textarea', 'words the Stop handed back');
      await page.click('[data-composer-root] button[aria-label="Send"]');
      await page.waitForSelector('[data-composer-root] button[aria-label="Stop this turn"]');

      // The composer as it stands the moment Send is drawn again, read in the commit that draws it.
      const whenSendReturns = page.evaluate(() => new Promise((seen) => {
        const root = document.querySelector('[data-composer-root]');

        if (root === null) throw new Error('no composer');

        const observer = new MutationObserver(() => {
          if (root.querySelector('button[aria-label="Send"]') === null) return;
          observer.disconnect();
          seen({
            draft: root.querySelector<HTMLTextAreaElement>('textarea')?.value ?? '',
            notices: [...root.querySelectorAll('[data-notice]')].map((notice) => notice.getAttribute('data-notice')),
          });
        });

        observer.observe(root, { subtree: true, childList: true, attributes: true });
      }));

      await page.click('[data-composer-root] button[aria-label="Stop this turn"]');
      // The stopped request is still out: the composer stays on the Stop.
      await framesSettled(page, `document.querySelector('[data-composer-root] button[aria-label="Send"]') === null`);
      expect(await page.evaluate(() => document.querySelector('[data-composer-root] button[aria-label="Send"]') === null)).toBe(true);

      // The stopped request ends; the agent's record says no turn read the words.
      await page.evaluate(() => { window.dispatchEvent(new CustomEvent('gallery:settle-send', { detail: { at: 0 } })); });
      expect(await whenSendReturns).toEqual({ draft: 'words the Stop handed back', notices: ['info'] });

      // Sent again and left to run, they are read where they ran: nothing returns.
      await page.evaluate(() => { document.documentElement.dataset.galleryHandedBack = '0'; });
      await page.click('[data-composer-root] button[aria-label="Send"]');
      await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('[data-composer-root] textarea')?.value === '');
      await page.evaluate(() => { window.dispatchEvent(new CustomEvent('gallery:settle-send', { detail: { at: 1 } })); });
      await page.waitForSelector('[data-composer-root] button[aria-label="Stop this turn"]', { hidden: true });
      expect(await composer()).toEqual({ draft: '', notices: [] });
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
      // The conversation alone: the agent is told what its rewound turns left on the computer (REWIND-0924).
      expect(await page.evaluate(() => document.documentElement.dataset.galleryRevertChatOnly)).toBe('true');
      const body = await page.evaluate(() => document.body.innerText);
      expect(body).toContain('Add the missing-binding regression test');
      expect(body).not.toContain('so none reads the binding itself');
      expect(body).not.toContain('File history is unavailable');
      // The ask walked back past is back in the composer, to send again or change (owner, 2026-10-25).
      expect(await page.$eval('#chat textarea', (area) => (area instanceof HTMLTextAreaElement ? area.value : ''))).toContain('Now move the webhook routes');
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

      // With the device files: their restore is offered next, and the rewind sends the agent no notice.
      await page.click('[data-revert-action="conversation-and-device-files"]');
      await page.waitForFunction(() => document.documentElement.dataset.galleryRevertChatOnly !== undefined);
      expect(await page.evaluate(() => document.documentElement.dataset.galleryRevertChatOnly)).toBe('false');
      await page.close();
    });
  });
});

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
        const stoppedCall = at('sessions-binding.test.ts');
        const nextAsk = at('Now move the webhook routes onto openDb');
        const finishedCall = at('workers/api/src/routes');
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

      // The thread keeps where it stopped; the notice above the prompt box offers the retry.
      const failure = await page.evaluate(() => ({
        words: document.querySelector('#chat [data-turn-failure]')?.textContent ?? '',
        retry: [...document.querySelectorAll('[data-turn-failure-notice] button')].some((button) => /retry/i.test(button.textContent ?? '')),
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
      expect(await page.$eval(chip, (button) => button.textContent?.trim())).toContain('1 of 3');

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
      await pressRowMenu(page, row('SOUL.md'), '[data-files-rename]');
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
        () => document.querySelector('[data-roster-probe]')?.textContent === 'api-worker:Renamed locally',
      );
      // POSITIVE SECOND: the mount read is still held, so there is a reply to
      // release. A roster whose read already ended has nothing to retire and
      // the assertion below would prove nothing.
      expect(await page.$eval('[data-roster-probe]', (el) => el.getAttribute('data-roster-pending'))).toBe('true');
      await page.click('[data-roster-release]');

      // The old server row spells "API Worker", and the local edit
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
        .toBe('api-worker:Renamed locally');
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
            const bubble = document.querySelector<HTMLElement>(`${selector} [data-user-bubble]`);

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
      expect(failed.text).toContain('Request flow diagram');
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

test('code keeps its syntax colors through streaming, scrolls sideways, and copies what streamed', async () => {
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
        await page.waitForFunction(() => [...document.querySelectorAll('[data-chat-row="ca1"] [data-code-block]')].every((block) => block.querySelectorAll('code span').length > 1));

        // Highlighted: a block's tokens are told apart by their ink.
        const inks = (blocks: Element[]) => blocks.map((block) => new Set([...block.querySelectorAll('code span')].map((token) => getComputedStyle(token).color)).size);

        const chatFences = await page.$$eval('[data-chat-row="ca1"] [data-code-block]', inks);

        expect(chatFences.length).toBe(3);

        for (const fence of chatFences) expect(fence, `${mode} chat fence token colors`).toBeGreaterThan(1);

        await page.goto(`${origin}/gallery.html?frame=coderendering`, { waitUntil: 'networkidle0' });

        for (const colors of await page.$$eval('[data-code-sample]:not([data-code-sample="unknown-language"])', inks)) {
          expect(colors, `${mode} syntax colors`).toBeGreaterThan(1);
        }

        const updated = 'export const finished = "' + 'stream complete '.repeat(20) + '";\nconsole.log(finished);';
        await page.focus('textarea');
        await page.keyboard.down('Control');
        await page.keyboard.press('a');
        await page.keyboard.up('Control');
        await page.keyboard.sendCharacter(updated);
        await page.waitForFunction((text) => document.querySelector('[data-code-sample="stream"] .shiki code')?.textContent === text, {}, updated);

        const streamed = await page.$eval('[data-code-sample="stream"]', (sample) => {
          let scrollable = false;

          for (const element of sample.querySelectorAll('div, pre')) {
            element.scrollLeft = 50;

            if (element.scrollLeft > 0) scrollable = true;
            element.scrollLeft = 0;
          }

          return { colors: new Set([...sample.querySelectorAll('code span')].map((token) => getComputedStyle(token).color)).size, scrollable };
        });

        expect(streamed.colors).toBeGreaterThan(1);
        expect(streamed.scrollable).toBeTrue();
        expect(await page.$eval('[data-code-sample="unknown-language"] code', (code) => code.textContent)).toBe('<script>unknown & safe</script>');
        await page.bringToFront();
        await page.$eval('[data-code-sample="stream"] button', (button) => button.click());
        await page.waitForFunction(async (text) => await navigator.clipboard.readText() === text, {}, updated);
      }
    } finally {
      await page.close();
    }
  });
});

/** Where the agent tab strip's photographs land, outside the worktree. */
const TAB_SHOTS = evidenceDir('chat-ux');

mkdirSync(TAB_SHOTS, { recursive: true });

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
 * A row the room stamps after it ended (its phase lines, a rating) arrives alone. The tab holds rows from three places:
 * the room's newest window, rows that slid out of an older one, and pages read from history. The stamp redraws the row
 * in whichever holds it, and a stamp for a row the tab never drew draws nothing.
 */
describe('a row stamped after it ended', () => {
  test('the stamp redraws the row where the tab holds it, and an id it does not hold changes nothing', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      const chat = '[data-transcript].overflow-y-auto';
      const shows = (words: string) => page.waitForFunction((at, said) => (document.querySelector(at)?.textContent ?? '').includes(said), {}, chat, words);
      const said = () => page.$eval(chat, (scroller) => scroller.textContent ?? '');

      const amend = (message: { id: string; role: 'user' | 'assistant'; parts: { type: 'text'; text: string }[] }) => page.evaluate((detail) => {
        window.dispatchEvent(new CustomEvent('gallery:amend-row', { detail }));
      }, { message });

      await page.setViewport({ width: 1280, height: 860 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage&transcript=slates&slates=2&history=80&historyLatency=0`, { waitUntil: 'networkidle0' });
      await page.waitForSelector(chat);

      await amend({ id: 'sb-a3', role: 'assistant', parts: [{ type: 'text', text: 'Added a last-failure column, and who broke it.' }] });
      await shows('and who broke it');

      // The reader goes up to the history just above the window, and the page holding its newest row lands.
      await page.$eval(chat, (scroller) => {
        const reserved = scroller.querySelector<HTMLElement>('[data-history-reserve]')?.offsetHeight ?? 0;

        scroller.scrollTop = Math.max(0, reserved - 100);
      });
      await shows('Answer 79.');
      await amend({ id: 'hist-00079', role: 'assistant', parts: [{ type: 'text', text: 'Answer 79, stamped after its end.' }] });
      await shows('stamped after its end');
      expect(await said()).not.toContain('Answer 79. openDb');

      const rows = await page.$eval(chat, (scroller) => scroller.children.length);

      await amend({ id: 'nowhere', role: 'assistant', parts: [{ type: 'text', text: 'Never drawn.' }] });
      await page.evaluate(() => new Promise((painted) => { requestAnimationFrame(() => requestAnimationFrame(painted)); }));
      expect(await said()).not.toContain('Never drawn.');
      expect(await page.$eval(chat, (scroller) => scroller.children.length)).toBe(rows);
      await page.close();
    });
  });
});

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

/** Now's turn rows as a person reads them. */
function turnRowTexts(page: Page): Promise<string[]> {
  return page.$$eval('[data-inspected="turn"]', (rows) => rows.map((row) => row.textContent ?? ''));
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
      const owed = ['effect blocked', 'turn running', 'effect running', 'effect waiting', 'effect waiting', 'turn waiting'];

      expect(await owedRows(page)).toEqual(['turn blocked', ...owed]);
      // The owner, 2026-10-25: a running agent's row read "build turn · blocked · no activation is running it". Each row
      // now says what the agent does, and where it is not running, what it waits on or what the person can do.
      const [stuck, running, resuming] = await turnRowTexts(page);

      expect([stuck, running]).toEqual([
        'working on a request · stopped part-way and nothing will pick it up again: use Recover this turn in its chat · try 3',
        'working on a request',
      ]);
      expect(resuming).toMatch(/^quiet-cove-f8c76035 · working on a request · stopped by a restart; it picks up again on its own · next try in \d+s$/u);

      await claimIs(page, { kind: 'stranded', turnId: 'turn-stranded', claimedAt: 1 });
      // The pushed claim renders on the page's next commit, not within the dispatch.
      await page.waitForSelector('[data-composer-root] button[aria-label="Recover this turn"]');
      await page.click('[data-composer-root] button[aria-label="Recover this turn"]');
      await page.waitForFunction((left) => document.querySelectorAll('[data-inspected]').length === left, {}, owed.length);

      expect(await owedRows(page)).toEqual(owed);
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
      const pane = '[data-agent-pane="api-worker/main"]';
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
      await Bun.write(file, 'route,total\n/api/health,20\n');
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
