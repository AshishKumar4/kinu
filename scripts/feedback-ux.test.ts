/**
 * The feedback capture, driven in a real browser, because every claim it makes
 * is about pixels and none of them is checkable from source.
 *
 * The load-bearing assertion is the REDACTION one, and it is made against the
 * captured image's actual pixels rather than against the clone: a secret is only
 * gone if the bytes that would have left the browser do not carry it. The
 * negative control matters as much as the positive ones — a blank or all-black
 * capture would satisfy every "this region is uniform" test for the wrong
 * reason, so an unmarked paragraph must come back NOT uniform.
 *
 * The oversized refusal is driven with real bytes: `?noise=1` renders an
 * incompressible canvas, so the PNG genuinely exceeds the 8 MiB limit instead of
 * a size being stubbed.
 *
 * `/api/feedback` does not exist under the gallery's Vite server, so the POST is
 * answered by request interception. Everything on the browser side of that
 * boundary — the multipart body, the client's own size refusal, the retry that
 * reuses the capture in memory — is the shipped code path.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { TimeoutError, type HTTPRequest, type Page } from 'puppeteer';
import { diagnosticsSettled, recordDiagnostics, withGallery, type DiagnosticLine } from './gallery-harness';

const FEEDBACK = '/api/feedback';
/** One sampled region of the captured image. */
interface Region {
  /** Every sampled pixel was the redaction fill (#111111). */
  uniformlyRedacted: boolean;
  /** How many distinct colours the region holds — 1 means a solid block. */
  colours: number;
  sampled: number;
  /** Sampled pixels that were NOT the fill. Reported so a failure says how big
   *  the leak is: a handful is an antialiased edge, hundreds are glyphs. */
  offFill: number;
}

/** A sampled region, named so a failure says WHICH one leaked. */
interface NamedRegion extends Region {
  label: string;
}

/** Where a secret really is in the LIVE page. Asserted BEFORE anything is
 *  asserted absent: a needle nobody rendered is absent from every clone and
 *  every pixel, and proves nothing. */
interface LivePresence {
  needle: string;
  inText: boolean;
  inAttrs: boolean;
  inValues: boolean;
}

/** One secret-bearing surface, measured every way it could leak. */
interface SurfaceProbe {
  live: LivePresence[];
  clone: { serializations: number; bytes: number; leaked: string[] };
  regions: NamedRegion[];
  /** Every marked FIELD, and how it is typed. A secret input has to be a
   *  password field as well as a marked region; a textarea cannot be one, which
   *  is why the two are reported rather than assumed alike. */
  fields: { tag: string; type: string }[];
  control: Region;
  redacted: number;
}

/* The secrets `gallery.tsx`'s `FeedbackSecretsFrame` renders. Spelled here as
 * well because the gate has to know them independently of the page — and the
 * live-presence check is what makes a mismatch fail instead of pass. */
const LEAK_HMAC = 'whsec_hmacLEAKSifREDACTIONfails0001';
const LEAK_BEARER = 'whsec_bearerLEAKSifREDACTIONfails0002';
/** Typed into the create dialog's own field, which the reporter fills in before
 *  any secret has been issued. */
const LEAK_TYPED = 'typedLEAKSifREDACTIONfails0003';
/** Pasted into the MCP headers editor, which is a textarea and therefore cannot
 *  be a password field. */
const LEAK_MCP = 'mcpLEAKSifREDACTIONfails0004';
const MCP_HEADERS = `{"Authorization": "Bearer ${LEAK_MCP}"}`;

/** The sabotage, chained TWO frames deep on purpose: the assertions can then
 *  tell a preserved chain from its outermost message — the exact loss
 *  `gate:silent-drop`'s `message_only` class exists to catch. */
const CAPTURE_SABOTAGE = { outer: 'the encoder was sabotaged', inner: 'toBlob broken by this gate' };
const CAPTURE_CHAIN = `${CAPTURE_SABOTAGE.outer}: ${CAPTURE_SABOTAGE.inner}`;
const DECODE_SABOTAGE = { outer: 'the preview decoder was sabotaged', inner: 'createImageBitmap broken by this gate' };
const DECODE_CHAIN = `${DECODE_SABOTAGE.outer}: ${DECODE_SABOTAGE.inner}`;

/** One outgoing submission, as the client actually built it. */
interface Submission {
  fields: string[];
  note: string;
  route: string;
  workspace: string;
  annotated: string;
  /** Absent when the report carries no screenshot. */
  screenshot: { size: number; type: string; name: string } | null;
  /**
   * How the request ENDED: `pending`, `answered`, or the rejected error's own
   * `name`. Filled in by the recorder when it happens, so it is read after the
   * fact rather than awaited.
   *
   * `pending` is a request the network never answered — the state a stalled POST
   * leaves behind. `AbortError` is the proof that a stop reached the REQUEST and
   * not only the button that asked for it: a component that merely ignored the
   * answer would leave this `pending` for as long as the page lived.
   */
  outcome: string;
}

/**
 * Watch what the client sends, from INSIDE the page.
 *
 * Puppeteer returns nothing for a multipart body (`postData()` is empty for a
 * binary payload), and the interesting facts are the `FormData` entries the
 * component assembled — the PNG's real size and type included. So the recorder
 * wraps `fetch` at document start, records, and delegates. The gallery wraps
 * `fetch` too, later, so this recorder sits underneath and sees the call either
 * way; the request still reaches the network, where interception answers it.
 */
declare global {
  interface Window {
    /** Installed by `recordSubmissions` at document start. Declared rather than
     *  asserted at each read: the recorder below is its only writer, so the
     *  shape is this file's own and there is nothing external to validate. */
    __feedbackSent?: Submission[];
    /** Installed by `recordSerialized`. Holds the rasteriser's own DOM
     *  serializations — the clone, as it goes into the image. */
    __serialized?: string[];
    /** Installed by the sabotage stages; each puts the broken global back. */
    __restoreCapture?: () => void;
    __restoreDecode?: () => void;
    __heldFeedbackEncodes?: number;
    __releaseFeedbackEncodes?: () => Promise<void>;
  }
}

async function recordSubmissions(page: Page): Promise<void> {
  await page.evaluateOnNewDocument((endpoint: string) => {
    const real = window.fetch.bind(window);
    const seen: Submission[] = [];
    window.__feedbackSent = seen;
    window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = init?.body;
      if (url.endsWith(endpoint) && body instanceof FormData) {
        const shot = body.get('screenshot');
        const record: Submission = {
          fields: [...body.keys()],
          note: String(body.get('note') ?? ''),
          route: String(body.get('route') ?? ''),
          workspace: String(body.get('workspace') ?? ''),
          annotated: String(body.get('annotated') ?? ''),
          screenshot: shot instanceof File ? { size: shot.size, type: shot.type, name: shot.name } : null,
          outcome: 'pending',
        };
        seen.push(record);
        // The returned fetch promise owns the recording and preserves the
        // component's resolution or rejection.
        try {
          const response = await real(input, init);
          record.outcome = 'answered';
          return response;
        } catch (cause) {
          record.outcome = cause instanceof Error ? cause.name : 'unknown';
          throw cause;
        }
      }
      return real(input, init);
    }, { preconnect: real.preconnect });
  }, FEEDBACK);
}

async function submissions(page: Page): Promise<Submission[]> {
  return page.evaluate(() => window.__feedbackSent ?? []);
}


/**
 * Answer `/api/feedback` at the network, one behaviour per attempt.
 *
 * `attempts` names what happens to the first, second, … POST; anything past the
 * end of the list is answered. `refuse` aborts at the connection, so the retry
 * path runs against a real network failure rather than a simulated error state.
 * `hold` NEVER answers and never fails — the request a proxy swallows, which is
 * the only honest way to drive a dialog that had no way out of it.
 *
 * Vite's HMR socket is refused on the way in. Sibling work in this tree touches
 * `src/` while a gate is running, and an HMR update re-mounts the React root
 * mid-interaction — the dialog simply vanishes. Only the socket carrying
 * `vite-hmr` is stubbed, so module loading is untouched.
 */
type Attempt = 'answer' | 'refuse' | 'hold';

async function serveFeedback(page: Page, options: { attempts?: readonly Attempt[] } = {}): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    const Real = WebSocket;
    const Stub = function (url: string, protocols?: string | string[]) {
      const wanted = protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols];
      if (wanted.includes('vite-hmr')) {
        return { readyState: 3, close() { /* never opened */ }, send() { /* never opened */ },
          addEventListener() { /* never fires */ }, removeEventListener() { /* never fires */ } };
      }
      return new Real(url, protocols);
    };
    Object.assign(window, { WebSocket: Stub });
  });
  await recordSubmissions(page);
  let attempt = 0;
  await page.setRequestInterception(true);
  page.on('request', async (request: HTTPRequest) => {
    if (!request.url().endsWith(FEEDBACK)) {
      await request.continue();
      return;
    }
    const behaviour = options.attempts?.[attempt] ?? 'answer';
    attempt += 1;
    if (behaviour === 'hold') return;
    if (behaviour === 'refuse') {
      await request.abort('connectionrefused');
      return;
    }
    await request.respond({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'fb-0001-abcdef' }),
    });
  });
}

/**
 * Wait for the capture to settle either way, and for the preview to be DRAWN.
 *
 * A canvas EXISTS as soon as the ready state renders; it is only drawn once the
 * decode resolves and the paint effect stamps it. Reading pixels between those
 * two is how this gate flaked, so every path that samples the image waits for
 * the stamp rather than for the element.
 */
async function captureSettled(page: Page): Promise<void> {
  await page.waitForSelector('[data-feedback-note]');
  await page.waitForFunction(
    () => document.querySelector('[data-feedback-shot="ready"], [data-feedback-shot="failed"]') !== null,
    { timeout: 90_000 },
  );
  await page.waitForFunction(
    () => document.querySelector('[data-feedback-shot="failed"]') !== null
      || document.querySelector('[data-feedback-canvas][data-feedback-painted]') !== null,
    { timeout: 90_000 },
  );
}
/**
 * The checkbox's off state removes this marker. Observe that DOM-state
 * boundary through mutations rather than sampling on animation frames, which
 * throttled renderers can defer after the state update has committed.
 */
async function waitForShotRemoval(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.querySelector('[data-feedback-shot]') === null) return;
    return new Promise<void>((resolve) => {
      const observer = new MutationObserver(() => {
        if (document.querySelector('[data-feedback-shot]') !== null) return;
        observer.disconnect();
        resolve();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  });
}


/** Open the dialog and wait for the capture to settle either way. */
async function openDialog(page: Page, selector = '[data-feedback-open]'): Promise<void> {
  await page.click(selector);
  await captureSettled(page);
}

/**
 * Open the dialog WITHOUT moving the page.
 *
 * `page.click` scrolls its target into view first, which resets the scroll
 * position the stage below exists to photograph. A click dispatched in the page
 * is the same click without the scroll.
 */
async function openDialogInPlace(page: Page, selector = '[data-feedback-open]'): Promise<void> {
  await page.evaluate((target: string) => {
    const button = document.querySelector<HTMLElement>(target);
    if (button === null) throw new Error(`no ${target} to open the dialog with`);
    button.click();
  }, selector);
  await captureSettled(page);
}

/** Wait for the dialog to be sending: the footer's one escape becomes Stop. */
async function sending(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.querySelector('[data-feedback-cancel]')?.getAttribute('data-feedback-cancel') === 'stop',
    { timeout: 30_000 },
  );
}

/** Wait until `count` POSTs have actually left the page, so a stage that stops
 *  one is stopping a request rather than the work that precedes it. */
async function posted(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    (wanted: number) => (window.__feedbackSent ?? []).length >= wanted,
    { timeout: 30_000 }, count,
  );
}

/** Which job the footer's escape is currently doing: `stop` or `close`. */
async function cancelHook(page: Page): Promise<string> {
  return page.$eval('[data-feedback-cancel]', (node) => node.getAttribute('data-feedback-cancel') ?? '');
}

async function textOf(page: Page, selector: string): Promise<string> {
  return page.$eval(selector, (node) => node.textContent ?? '');
}

/** A bounded wait whose EXPIRY is a reading rather than an error: the assertion
 *  that follows reports what was observed, where a raised timeout would only
 *  report when. */
async function tolerateTimeout(waiting: Promise<unknown>): Promise<void> {
  try {
    await waiting;
  } catch (thrown) {
    if (!(thrown instanceof TimeoutError)) throw thrown;
  }
}

/**
 * Sample the captured image at the on-page position of `selector`.
 *
 * The capture omitted the dialog and the dialog is a fixed overlay, so the live
 * page's layout is the layout that was photographed: a live bounding box, moved
 * by however far the page is scrolled and scaled by the capture's own scale
 * factor, is where that element's pixels are. The scroll term is what makes the
 * mapping true of a page the reporter left part-way down, rather than only of one
 * a stage remembered to send back to the top.
 *
 * The box is inset by 8 device pixels, which is past this design system's
 * `rounded-md` corner. Antialiasing where a rounded block meets the page ground
 * is not a leak, and demanding a pixel-perfect rectangle would force the
 * redaction to be square for the test's convenience. What is asserted instead is
 * the interior: every pixel the block claims to cover IS covered. `offFill`
 * carries the count that failed it, so a real leak (hundreds of glyph pixels)
 * cannot hide behind a plausible handful of edge pixels.
 */
async function readRegion(page: Page, selector: string): Promise<Region> {
  return page.evaluate((target: string) => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-feedback-canvas]');
    const node = document.querySelector<HTMLElement>(target);
    if (canvas === null || node === null) throw new Error(`no canvas or no ${target}`);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('no 2d context');
    const scale = canvas.width / document.documentElement.clientWidth;
    const box = node.getBoundingClientRect();
    const inset = 8;
    const x = Math.round((box.left + window.scrollX) * scale) + inset;
    const y = Math.round((box.top + window.scrollY) * scale) + inset;
    const w = Math.max(1, Math.round(box.width * scale) - inset * 2);
    const h = Math.max(1, Math.round(box.height * scale) - inset * 2);
    const pixels = context.getImageData(x, y, w, h).data;
    const colours = new Set<string>();
    let offFill = 0;
    let sampled = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      sampled += 1;
      colours.add(`${String(pixels[i])},${String(pixels[i + 1])},${String(pixels[i + 2])}`);
      if (pixels[i] !== 17 || pixels[i + 1] !== 17 || pixels[i + 2] !== 17) offFill += 1;
    }
    return { uniformlyRedacted: sampled > 0 && offFill === 0, colours: colours.size, sampled, offFill };
  }, selector);
}

/** The preview canvas's own PNG size, which is what the client measures. */
async function readShot(page: Page): Promise<{ width: number; height: number; redacted: number }> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-feedback-canvas]');
    const meta = document.querySelector<HTMLElement>('[data-feedback-shot-meta]');
    if (canvas === null) throw new Error('no preview canvas');
    return {
      width: canvas.width,
      height: canvas.height,
      redacted: Number(meta?.dataset.feedbackShotMeta ?? '0'),
    };
  });
}

/**
 * Record every DOM serialization the rasteriser performs.
 *
 * `modern-screenshot` puts the redacted CLONE inside an SVG `foreignObject` and
 * turns it into an image through `new XMLSerializer().serializeToString(…)`.
 * Wrapping that one call is how this gate reads the real clone — every text
 * node, every attribute, and the input values the rasteriser copies in itself
 * (it writes a live `value` attribute onto each cloned field, which is the leak
 * `redactClone` exists to undo). A reconstruction of that clone would be a
 * second implementation of it, and would drift.
 *
 * The markup stays in the page. Only counts and the needles found in it cross
 * back, because a full-page serialization is megabytes.
 */
async function recordSerialized(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    const seen: string[] = [];
    window.__serialized = seen;
    const real = XMLSerializer.prototype.serializeToString;
    XMLSerializer.prototype.serializeToString = function record(node: Node): string {
      const markup = real.call(this, node);
      seen.push(markup);
      return markup;
    };
  });
}

/** What the clone carried. `serializations` guards the vacuous pass: a needle
 *  cannot be absent from markup that was never produced. */
async function cloneLeaks(
  page: Page, needles: readonly string[],
): Promise<{ serializations: number; bytes: number; leaked: string[] }> {
  return page.evaluate((wanted: string[]) => {
    const seen = window.__serialized ?? [];
    return {
      serializations: seen.length,
      bytes: seen.reduce((total, markup) => total + markup.length, 0),
      leaked: wanted.filter((needle) => seen.some((markup) => markup.includes(needle))),
    };
  }, [...needles]);
}

/** Where each secret sits in the live page: in rendered text, in an attribute,
 *  or in a field's value. All three are channels the clone could carry. */
async function livePresence(page: Page, needles: readonly string[]): Promise<LivePresence[]> {
  return page.evaluate((wanted: string[]) => wanted.map((needle) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let inText = false;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if ((node.textContent ?? '').includes(needle)) inText = true;
    }
    let inAttrs = false;
    let inValues = false;
    for (const element of document.body.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        if (attribute.value.includes(needle)) inAttrs = true;
      }
      const field = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value
        : '';
      if (field.includes(needle)) inValues = true;
    }
    return { needle, inText, inAttrs, inValues };
  }), [...needles]);
}

/**
 * Sample EVERY region the shipped redaction selector covers, in the captured
 * image, at each region's own on-page position.
 *
 * The selector is `redactClone`'s own, so this measures the product's contract
 * rather than a list this file maintains: a secret the components forgot to mark
 * is not sampled here at all, which is what the live-presence and clone checks
 * are for. The descendant clause is left off because a marked region that holds
 * child elements is covered by its own box.
 *
 * The inset is PROPORTIONAL, unlike the flat eight device pixels above: these
 * are real components, and one of them is a single line of monospace inside a
 * shell snippet, where a flat inset would sample nothing at all.
 *
 * And the box is CLIPPED to what the page actually paints. The curl snippet
 * scrolls horizontally, so the redacted secret inside it genuinely extends past
 * the edge of the block that holds it; sampling the unclipped layout box reads
 * the card behind that edge and calls the card a leak.
 */
async function readSecretRegions(page: Page): Promise<NamedRegion[]> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-feedback-canvas]');
    if (canvas === null) throw new Error('no preview canvas');
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('no 2d context');
    const scale = canvas.width / document.documentElement.clientWidth;
    const found: NamedRegion[] = [];
    let index = 0;
    for (const node of document.querySelectorAll<HTMLElement>('[data-feedback-redact], input[type="password"]')) {
      index += 1;
      // The painted box: the node's own, narrowed by every clipping ancestor to
      // that ancestor's CONTENT box. Measured, not assumed: a scroll container's
      // child paints to the content edge and not into the padding, so the curl
      // block's redaction ends twelve pixels short of the `<pre>` it sits in.
      const box = node.getBoundingClientRect();
      let left = box.left; let top = box.top; let right = box.right; let bottom = box.bottom;
      for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
        const clip = parent.getBoundingClientRect();
        const edge = (...widths: string[]): number =>
          widths.reduce((total, width) => total + (Number.parseFloat(width) || 0), 0);
        left = Math.max(left, clip.left + edge(style.borderLeftWidth, style.paddingLeft));
        top = Math.max(top, clip.top + edge(style.borderTopWidth, style.paddingTop));
        right = Math.min(right, clip.right - edge(style.borderRightWidth, style.paddingRight));
        bottom = Math.min(bottom, clip.bottom - edge(style.borderBottomWidth, style.paddingBottom));
      }
      const inset = Math.max(1, Math.min(6, Math.round(Math.min(right - left, bottom - top) * scale * 0.2)));
      // Document coordinates, so the sampling holds wherever the page is
      // scrolled: the capture spans the whole document and starts at its top.
      const x = Math.round((left + window.scrollX) * scale) + inset;
      const y = Math.round((top + window.scrollY) * scale) + inset;
      const w = Math.round((right - left) * scale) - inset * 2;
      const h = Math.round((bottom - top) * scale) - inset * 2;
      const label = `${String(index)}:${node.tagName.toLowerCase()}${node.getAttribute('type') ?? ''}`;
      if (w < 1 || h < 1 || y + h > canvas.height || x + w > canvas.width) {
        found.push({ label, uniformlyRedacted: false, colours: 0, sampled: 0, offFill: 0 });
        continue;
      }
      const pixels = context.getImageData(x, y, w, h).data;
      const colours = new Set<string>();
      let offFill = 0;
      let sampled = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        sampled += 1;
        colours.add(`${String(pixels[i])},${String(pixels[i + 1])},${String(pixels[i + 2])}`);
        if (pixels[i] !== 17 || pixels[i + 1] !== 17 || pixels[i + 2] !== 17) offFill += 1;
      }
      found.push({ label, uniformlyRedacted: sampled > 0 && offFill === 0, colours: colours.size, sampled, offFill });
    }
    return found;
  });
}

/** One surface, measured every way it could leak. */
async function probeSurface(page: Page, needles: readonly string[]): Promise<SurfaceProbe> {
  return {
    live: await livePresence(page, needles),
    clone: await cloneLeaks(page, needles),
    regions: await readSecretRegions(page),
    fields: await page.evaluate(() => [...document.querySelectorAll('[data-feedback-redact]')]
      .filter((node) => node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)
      .map((node) => ({ tag: node.tagName.toLowerCase(), type: node.getAttribute('type') ?? '' }))),
    control: await readRegion(page, '[data-visible-copy]'),
    redacted: (await readShot(page)).redacted,
  };
}

/**
 * One pane of the nested-scroll fixture, as the captured image carries it.
 *
 * No colour is spelled in this file. `wanted` and `atRest` are read off the LIVE
 * fixture through `getComputedStyle`, so the fixture owns its own fills and the
 * two cannot drift apart; `atRest` is the pane an ignored scroll offset shows,
 * which is what keeps a passing `seen` from being a coincidence.
 */
interface Pane {
  label: string;
  /** The one colour every sampled pixel carried, or a count when it was more. */
  seen: string;
  /** The fill of the band or cell the reader scrolled to. */
  wanted: string;
  /** The fill of the one at offset zero. */
  atRest: string;
  sampled: number;
}

/**
 * Sample the captured image inside both panes of the nested-scroll fixture: the
 * strip of the outer band below the inner pane, and the inner pane itself.
 *
 * Both boxes are inset past their own scrollbars — a scrollbar is drawn inside
 * the container, and its groove is neither band nor cell.
 */
async function readScrollPanes(page: Page): Promise<Pane[]> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-feedback-canvas]');
    if (canvas === null) throw new Error('no preview canvas');
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('no 2d context');
    const scale = canvas.width / document.documentElement.clientWidth;
    const at = (selector: string): HTMLElement => {
      const node = document.querySelector<HTMLElement>(selector);
      if (node === null) throw new Error(`no ${selector} in the fixture`);
      return node;
    };
    /** `rgb(18, 64, 110)` and `rgba(18, 64, 110, 1)` both come back `18,64,110`,
     *  so a sampled pixel and a computed fill compare as themselves. */
    const triple = (css: string): string => (css.match(/\d+/gu) ?? []).slice(0, 3).join(',');
    const fill = (selector: string): string => triple(getComputedStyle(at(selector)).backgroundColor);
    const outer = at('[data-scroll-outer]').getBoundingClientRect();
    const inner = at('[data-scroll-inner]').getBoundingClientRect();
    const sample = (box: { x: number; y: number; w: number; h: number }) => {
      const pixels = context.getImageData(
        Math.round((box.x + window.scrollX) * scale), Math.round((box.y + window.scrollY) * scale),
        Math.max(1, Math.round(box.w * scale)), Math.max(1, Math.round(box.h * scale)),
      ).data;
      const colours = new Set<string>();
      for (let i = 0; i < pixels.length; i += 4) {
        colours.add(`${String(pixels[i])},${String(pixels[i + 1])},${String(pixels[i + 2])}`);
      }
      const only = [...colours];
      return {
        seen: only.length === 1 ? String(only[0]) : `${String(only.length)} colours`,
        sampled: pixels.length / 4,
      };
    };
    return [
      {
        label: 'the outer band, below the inner pane',
        ...sample({ x: inner.left + 8, y: inner.bottom + 6, w: inner.width - 16, h: outer.bottom - inner.bottom - 12 }),
        wanted: fill('[data-scroll-band="2"]'),
        atRest: fill('[data-scroll-band="0"]'),
      },
      {
        label: 'the inner pane, scrolled sideways',
        ...sample({ x: inner.left + 8, y: inner.top + 8, w: inner.width - 16, h: inner.height - 32 }),
        wanted: fill('[data-scroll-cell="2"]'),
        atRest: fill('[data-scroll-cell="0"]'),
      },
    ];
  });
}

interface Observed {
  desktop: {
    shot: { width: number; height: number; redacted: number };
    password: Region;
    token: Region;
    control: Region;
    consent: string;
    sent: Submission[];
    toast: string;
  };
  annotated: { before: number; afterDrag: number; afterUndo: number; sentAnnotated: string };
  noteOnly: { shotSectionPresent: boolean; sent: Submission[] };
  oversized: { message: string; sendableWithoutShot: boolean; sent: Submission[] };
  retry: {
    errorText: string; buttonLabel: string; canvasSurvived: boolean;
    attempts: number; sizes: number[]; toast: string;
    diagnostics: DiagnosticLine[];
  };
  captureFailure: {
    message: string; sendableWithNote: boolean;
    diagnostics: DiagnosticLine[]; retook: boolean;
  };
  decodeFailure: { message: string; diagnostics: DiagnosticLine[]; retook: boolean };
  mobile: { buttonVisible: boolean; dialogWithin: boolean; captureSucceeded: boolean };
  /** The shipped webhook cards and the MCP headers editor. */
  cards: SurfaceProbe;
  /** The shipped create-webhook dialog, with a secret typed into its field. */
  dialog: SurfaceProbe;
  /** The shipped shell, routed: the rail's own Feedback affordance, a report
   *  addressed by the route the router resolved, and two nested panes the
   *  reporter scrolled. */
  routed: {
    openedFromRail: boolean;
    offsets: { outer: number; inner: number };
    panes: Pane[];
    sent: Submission[];
  };
  /** A POST the network never answers. */
  stalled: {
    whileSending: { cancelHook: string; sendLabel: string; dismissedByEscape: boolean };
    afterStop: { errorText: string; cancelHook: string; sendLabel: string; canvasSurvived: boolean };
    outcomes: string[];
    retryToast: string;
    diagnostics: DiagnosticLine[];
    closedAfterStop: boolean;
  };
  /** The same page, photographed while the reporter is part-way down it. */
  scrolledDocument: { scrollY: number; regions: NamedRegion[]; control: Region };
}

async function run(): Promise<Observed> {
  return withGallery(async ({ browser, origin }) => {
    // ── desktop: capture, redaction, send ────────────────────────────────
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await serveFeedback(page);
    await page.goto(`${origin}/gallery.html?frame=feedback`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-secret-input]');
    await openDialog(page);
    await page.waitForSelector('[data-feedback-canvas]');

    const shot = await readShot(page);
    const password = await readRegion(page, '[data-secret-input]');
    const token = await readRegion(page, '[data-secret-token]');
    const control = await readRegion(page, '[data-visible-copy]');
    const consent = await page.$eval('[data-feedback-consent]', (node) => node.textContent ?? '');

    await page.type('[data-feedback-note]', 'the key field renders behind the label');
    await page.click('[data-feedback-send]');
    await page.waitForSelector('[data-feedback-sent]', { timeout: 30_000 });
    const toast = await page.$eval('[data-feedback-sent]', (node) => node.textContent ?? '');
    const sent = await submissions(page);
    await page.close();

    // ── annotation ───────────────────────────────────────────────────────
    const draw = await browser.newPage();
    await draw.setViewport({ width: 1280, height: 900 });
    await serveFeedback(draw);
    await draw.goto(`${origin}/gallery.html?frame=feedback`, { waitUntil: 'networkidle0' });
    await openDialog(draw);
    await draw.waitForSelector('[data-feedback-canvas]');

    const colourCount = async (): Promise<number> => (await readRegion(draw, '[data-visible-copy]')).colours;
    const before = await colourCount();
    await draw.click('[data-feedback-tool="hide"]');
    const box = await draw.$eval('[data-feedback-canvas]', (node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
    });
    const target = await draw.$eval('[data-visible-copy]', (node) => {
      const rect = node.getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    });
    // Drag across the control paragraph's own band of the image, in canvas
    // display coordinates: covering it is what a reporter does to something the
    // automatic redaction could not know about.
    const bandTop = box.y + (target.top / (await draw.evaluate(() => document.documentElement.clientHeight))) * box.h;
    await draw.mouse.move(box.x + box.w * 0.05, bandTop + 2);
    await draw.mouse.down();
    await draw.mouse.move(box.x + box.w * 0.9, bandTop + Math.max(12, (target.height / 900) * box.h), { steps: 8 });
    await draw.mouse.up();
    // The canvas states how many marks it has painted, so the measurement waits
    // on the PAINT rather than on the button's enabled state — those used to be
    // different commits, which is how an async repaint read as a lost undo.
    const painted = async (count: number): Promise<void> => {
      await draw.waitForFunction(
        (want: number) => document.querySelector('[data-feedback-canvas]')
          ?.getAttribute('data-feedback-painted') === String(want),
        { timeout: 30_000 }, count,
      );
    };
    await painted(1);
    const afterDrag = await colourCount();
    await draw.click('[data-feedback-undo]');
    await painted(0);
    const afterUndo = await colourCount();

    // Re-draw one mark so the sent body reports annotation.
    await draw.mouse.move(box.x + box.w * 0.05, bandTop + 2);
    await draw.mouse.down();
    await draw.mouse.move(box.x + box.w * 0.9, bandTop + 20, { steps: 8 });
    await draw.mouse.up();
    await painted(1);
    await draw.type('[data-feedback-note]', 'covering the middle paragraph');
    await draw.click('[data-feedback-send]');
    await draw.waitForSelector('[data-feedback-sent]', { timeout: 30_000 });
    const sentAnnotated = (await submissions(draw)).at(-1)?.annotated ?? '';
    await draw.close();

    // ── note only ────────────────────────────────────────────────────────
    const bare = await browser.newPage();
    await bare.setViewport({ width: 1280, height: 900 });
    await serveFeedback(bare);
    await bare.goto(`${origin}/gallery.html?frame=feedback`, { waitUntil: 'networkidle0' });
    await openDialog(bare);
    await bare.click('[data-feedback-include-shot]');
    await waitForShotRemoval(bare);
    const shotSectionPresent = await bare.$('[data-feedback-shot]') !== null;
    await bare.type('[data-feedback-note]', 'no screenshot for this one');
    await bare.click('[data-feedback-send]');
    await bare.waitForSelector('[data-feedback-sent]', { timeout: 30_000 });
    const bareSent = await submissions(bare);
    await bare.close();

    // ── oversized, with real incompressible bytes ────────────────────────
    const big = await browser.newPage();
    await big.setViewport({ width: 1280, height: 900 });
    await serveFeedback(big);
    await big.goto(`${origin}/gallery.html?frame=feedback&noise=1`, { waitUntil: 'networkidle0' });
    await openDialog(big);
    await big.waitForSelector('[data-feedback-shot="failed"]', { timeout: 120_000 });
    const message = await big.$eval('[data-feedback-shot="failed"]', (node) => node.textContent ?? '');
    await big.type('[data-feedback-note]', 'the page is too big to photograph');
    const sendableWithoutShot = await big.$eval('[data-feedback-send]', (node) => !node.hasAttribute('disabled'));
    await big.click('[data-feedback-send]');
    await big.waitForSelector('[data-feedback-sent]', { timeout: 30_000 });
    const bigSent = await submissions(big);
    await big.close();

    // ── a failed send keeps the capture, and retry sends it ──────────────
    const flaky = await browser.newPage();
    await flaky.setViewport({ width: 1280, height: 900 });
    await serveFeedback(flaky, { attempts: ['refuse'] });
    const flakyDiagnostics = recordDiagnostics(flaky);
    await flaky.goto(`${origin}/gallery.html?frame=feedback`, { waitUntil: 'networkidle0' });
    await openDialog(flaky);
    await flaky.waitForSelector('[data-feedback-canvas]');
    await flaky.type('[data-feedback-note]', 'first attempt will not reach the server');
    await flaky.click('[data-feedback-send]');
    await flaky.waitForSelector('[data-feedback-error]', { timeout: 30_000 });
    const errorText = await flaky.$eval('[data-feedback-error]', (node) => node.textContent ?? '');
    const buttonLabel = await flaky.$eval('[data-feedback-send]', (node) => node.textContent ?? '');
    const canvasSurvived = await flaky.$('[data-feedback-canvas]') !== null;
    await flaky.click('[data-feedback-send]');
    await flaky.waitForSelector('[data-feedback-sent]', { timeout: 30_000 });
    const retryToast = await flaky.$eval('[data-feedback-sent]', (node) => node.textContent ?? '');
    const flakySent = await submissions(flaky);
    await diagnosticsSettled(flakyDiagnostics, 1);
    await flaky.close();

    // ── a capture that fails: told, recorded, retakable ──────────────────
    const broken = await browser.newPage();
    await broken.setViewport({ width: 1280, height: 900 });
    await serveFeedback(broken);
    const captureDiagnostics = recordDiagnostics(broken);
    await broken.goto(`${origin}/gallery.html?frame=feedback`, { waitUntil: 'networkidle0' });
    // Break the PNG encoder underneath `capturePage`, so the capture rejects
    // with this chain and nothing else on the page is touched.
    await broken.evaluate((outer: string, inner: string) => {
      const original = HTMLCanvasElement.prototype.toBlob;
      window.__restoreCapture = () => { HTMLCanvasElement.prototype.toBlob = original; };
      HTMLCanvasElement.prototype.toBlob = () => { throw new Error(outer, { cause: new Error(inner) }); };
    }, CAPTURE_SABOTAGE.outer, CAPTURE_SABOTAGE.inner);
    await openDialog(broken);
    const captureMessage = await broken.$eval('[data-feedback-shot="failed"]', (node) => node.textContent ?? '');
    await broken.type('[data-feedback-note]', 'the note survives a failed capture');
    const captureNoteSendable = await broken.$eval('[data-feedback-send]', (node) => !node.hasAttribute('disabled'));
    await diagnosticsSettled(captureDiagnostics, 1);
    // The failed state's retry affordance is the checkbox: off, then on again.
    await broken.evaluate(() => window.__restoreCapture?.());
    await broken.click('[data-feedback-include-shot]');
    await waitForShotRemoval(broken);
    await broken.click('[data-feedback-include-shot]');
    await broken.waitForFunction(
      () => document.querySelector('[data-feedback-canvas][data-feedback-painted]') !== null,
      { timeout: 90_000 },
    );
    const captureRetook = await broken.$('[data-feedback-shot="ready"]') !== null;
    await broken.close();

    // ── a preview decode that fails: told, recorded, retakable ───────────
    const undecodable = await browser.newPage();
    await undecodable.setViewport({ width: 1280, height: 900 });
    await serveFeedback(undecodable);
    const decodeDiagnostics = recordDiagnostics(undecodable);
    await undecodable.goto(`${origin}/gallery.html?frame=feedback`, { waitUntil: 'networkidle0' });
    // The capture succeeds; the preview decode is what rejects.
    await undecodable.evaluate((outer: string, inner: string) => {
      const original = window.createImageBitmap.bind(window);
      window.__restoreDecode = () => { Object.assign(window, { createImageBitmap: original }); };
      Object.assign(window, {
        createImageBitmap: () => Promise.reject(new Error(outer, { cause: new Error(inner) })),
      });
    }, DECODE_SABOTAGE.outer, DECODE_SABOTAGE.inner);
    await openDialog(undecodable);
    await undecodable.waitForSelector('[data-feedback-shot="failed"]', { timeout: 90_000 });
    const decodeMessage = await undecodable.$eval('[data-feedback-shot="failed"]', (node) => node.textContent ?? '');
    await diagnosticsSettled(decodeDiagnostics, 1);
    await undecodable.evaluate(() => window.__restoreDecode?.());
    await undecodable.click('[data-feedback-include-shot]');
    await waitForShotRemoval(undecodable);
    await undecodable.click('[data-feedback-include-shot]');
    await undecodable.waitForFunction(
      () => document.querySelector('[data-feedback-canvas][data-feedback-painted]') !== null,
      { timeout: 90_000 },
    );
    const decodeRetook = await undecodable.$('[data-feedback-shot="ready"]') !== null;
    await undecodable.close();

    // ── mobile ───────────────────────────────────────────────────────────
    const phone = await browser.newPage();
    await phone.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    await serveFeedback(phone);
    await phone.goto(`${origin}/gallery.html?frame=feedback`, { waitUntil: 'networkidle0' });
    const buttonVisible = await phone.$eval('[data-feedback-open]', (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.right <= window.innerWidth + 1;
    });
    await openDialog(phone);
    const dialogWithin = await phone.$eval('[role="dialog"]', (node) => {
      const rect = node.getBoundingClientRect();
      return rect.left >= -1 && rect.right <= window.innerWidth + 1;
    });
    const captureSucceeded = await phone.$('[data-feedback-shot="ready"]') !== null;
    await phone.close();

    // ── the REAL secret-bearing surfaces ─────────────────────────────────
    // The frame above proves the two mechanisms on markup written for the
    // purpose. These two stages prove the product: the components a person has
    // open when they press Feedback, driven through the same capture.
    const cardsPage = await browser.newPage();
    await cardsPage.setViewport({ width: 1280, height: 1000 });
    await serveFeedback(cardsPage);
    await recordSerialized(cardsPage);
    await cardsPage.goto(`${origin}/gallery.html?frame=feedbacksecrets`, { waitUntil: 'networkidle0' });
    // The MCP form's only textarea. Typed rather than seeded, because a pasted
    // bearer header lives in the field's VALUE and never in its markup — which
    // is the half of this leak no source read would have found.
    await cardsPage.waitForSelector('textarea');
    await cardsPage.type('textarea', MCP_HEADERS);
    // Typing scrolls the field into view. The capture starts at the document
    // origin, so every sampled coordinate below assumes the page is at the top.
    await cardsPage.evaluate(() => { window.scrollTo(0, 0); });
    await openDialog(cardsPage);
    const cards = await probeSurface(cardsPage, [LEAK_HMAC, LEAK_BEARER, LEAK_MCP]);
    await cardsPage.close();

    const dialogPage = await browser.newPage();
    await dialogPage.setViewport({ width: 1280, height: 1000 });
    await serveFeedback(dialogPage);
    await recordSerialized(dialogPage);
    await dialogPage.goto(`${origin}/gallery.html?frame=feedbacksecrets&modal=1`, { waitUntil: 'networkidle0' });
    // The create dialog's secret field, addressed by EITHER protection so the
    // harness survives the loss of one and the assertions do the talking: a
    // selector that named only the type turned a missing password field into a
    // 30-second timeout instead of a failed expectation.
    const secretField = 'input[type="password"], [data-feedback-redact]';
    await dialogPage.waitForSelector(secretField);
    await dialogPage.type(secretField, LEAK_TYPED);
    await dialogPage.evaluate(() => { window.scrollTo(0, 0); });
    await openDialog(dialogPage);
    const dialog = await probeSurface(dialogPage, [LEAK_TYPED]);
    await dialogPage.close();

    // ── the shipped shell, routed ────────────────────────────────────────
    // `Layout`, its rail, and the account menu's own Feedback affordance,
    // mounted at `/workspace/checkout-fixes`. The two frames above prove the
    // capture; this one proves the SUBMISSION: the route and the workspace a
    // report carries are read off a route the router resolved, and no bare
    // component mount can produce either.
    const routedPage = await browser.newPage();
    await routedPage.setViewport({ width: 1280, height: 900 });
    await serveFeedback(routedPage);
    await routedPage.goto(`${origin}/gallery.html?frame=feedbackrouted`, { waitUntil: 'networkidle0' });
    // The rail's account row, addressed by the email the profile renders:
    // waiting for it is waiting for the signed-in state, and the menu holding
    // Feedback does not exist until that row is clicked.
    await routedPage.waitForFunction(
      () => [...document.querySelectorAll('aside button')].some((row) => (row.textContent ?? '').includes('@')),
      { timeout: 30_000 },
    );
    await routedPage.evaluate(() => {
      const row = [...document.querySelectorAll<HTMLElement>('aside button')]
        .find((button) => (button.textContent ?? '').includes('@'));
      if (row === undefined) throw new Error('no account row in the rail');
      row.click();
    });
    await routedPage.waitForSelector('aside [data-feedback-open]', { timeout: 30_000 });
    const openedFromRail = await routedPage.$('aside [data-feedback-open]') !== null;
    // Two bands down and two cells across. The offsets are read BACK, so a
    // fixture that could not scroll fails here instead of passing by accident.
    const offsets = await routedPage.evaluate(() => {
      const outer = document.querySelector<HTMLElement>('[data-scroll-outer]');
      const inner = document.querySelector<HTMLElement>('[data-scroll-inner]');
      if (outer === null || inner === null) throw new Error('the nested panes are not in this frame');
      outer.scrollTop = outer.clientHeight * 2;
      inner.scrollLeft = inner.clientWidth * 2;
      return { outer: outer.scrollTop, inner: inner.scrollLeft };
    });
    await openDialog(routedPage, 'aside [data-feedback-open]');
    const panes = await readScrollPanes(routedPage);
    await routedPage.type('[data-feedback-note]', 'the panes were scrolled when this was taken');
    await routedPage.click('[data-feedback-send]');
    await routedPage.waitForSelector('[data-feedback-sent]', { timeout: 30_000 });
    const routedSent = await submissions(routedPage);
    await routedPage.close();

    // ── a POST the network never answers ─────────────────────────────────
    // Held open at the network rather than answered slowly: this is the request
    // a proxy swallows, and the only honest way to reach the state where the
    // dialog stayed busy for as long as the request did. Three attempts, and the
    // middle one answers: stop, retry, then stop and leave.
    const stalledPage = await browser.newPage();
    await stalledPage.setViewport({ width: 1280, height: 900 });
    await serveFeedback(stalledPage, { attempts: ['hold', 'answer', 'hold'] });
    const stalledDiagnostics = recordDiagnostics(stalledPage);
    await stalledPage.goto(`${origin}/gallery.html?frame=feedback`, { waitUntil: 'networkidle0' });
    await openDialog(stalledPage);
    await stalledPage.type('[data-feedback-note]', 'this one hangs on the way out');
    await stalledPage.click('[data-feedback-send]');
    await sending(stalledPage);
    // The POST has genuinely left before it is stopped. Without this the stage
    // could stop the dialog during the attach step and prove nothing about a
    // request in flight.
    await posted(stalledPage, 1);
    // Escape while the request is genuinely in flight: the shared dialog keeps
    // refusing it, because a stray key must not tear down a report mid-write.
    // The way out is the footer button, and it is the next thing pressed.
    await stalledPage.keyboard.press('Escape');
    // Two frames, so "it stayed open" is a reading of a moment that has passed
    // rather than of one that had not arrived.
    await stalledPage.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => { requestAnimationFrame(() => { resolve(); }); });
    }));
    const whileSending = {
      cancelHook: await cancelHook(stalledPage),
      sendLabel: await textOf(stalledPage, '[data-feedback-send]'),
      dismissedByEscape: await stalledPage.$('[data-feedback-note]') === null,
    };
    await stalledPage.click('[data-feedback-cancel]');
    await stalledPage.waitForSelector('[data-feedback-error]', { timeout: 30_000 });
    const afterStop = {
      errorText: await textOf(stalledPage, '[data-feedback-error]'),
      cancelHook: await cancelHook(stalledPage),
      sendLabel: await textOf(stalledPage, '[data-feedback-send]'),
      canvasSurvived: await stalledPage.$('[data-feedback-canvas]') !== null,
    };
    await stalledPage.click('[data-feedback-send]');
    await stalledPage.waitForSelector('[data-feedback-sent]', { timeout: 30_000 });
    const stalledToast = await textOf(stalledPage, '[data-feedback-sent]');
    // And a stopped report can be left behind: sent one closed, a second stalls,
    // stops, and Escape — refused above — now dismisses it.
    await stalledPage.click('[data-feedback-done]');
    await stalledPage.waitForFunction(
      () => document.querySelector('[data-feedback-note]') === null, { timeout: 30_000 },
    );
    await openDialog(stalledPage);
    await stalledPage.type('[data-feedback-note]', 'and this one hangs too');
    await stalledPage.click('[data-feedback-send]');
    await sending(stalledPage);
    await posted(stalledPage, 3);
    await stalledPage.click('[data-feedback-cancel]');
    await stalledPage.waitForSelector('[data-feedback-error]', { timeout: 30_000 });
    await stalledPage.keyboard.press('Escape');
    await tolerateTimeout(stalledPage.waitForFunction(
      () => document.querySelector('[data-feedback-note]') === null, { timeout: 10_000 },
    ));
    const closedAfterStop = await stalledPage.$('[data-feedback-note]') === null;
    // Every POST this page made, and how each ENDED. Awaited briefly rather than
    // read on the spot: a rejection lands a microtask after the click that
    // caused it, and a dialog that had only stopped listening would leave one
    // `pending` — which is what the assertion then reports, where a raised
    // timeout would have said nothing about it.
    await tolerateTimeout(stalledPage.waitForFunction(
      () => (window.__feedbackSent ?? []).every((one) => one.outcome !== 'pending'),
      { timeout: 10_000 },
    ));
    const outcomes = (await submissions(stalledPage)).map((one) => one.outcome);
    await stalledPage.close();

    // ── photographed part-way down a page that scrolls ───────────────────
    // The capture spans the whole document and starts at its TOP, wherever the
    // reporter happens to be. Restoring a scrolled pane must not also move the
    // page: the rasteriser counts `documentElement` among its scroll containers,
    // and left to itself it takes the reader's own offset off the top of the
    // image and leaves the same blank at the bottom.
    const downPage = await browser.newPage();
    await downPage.setViewport({ width: 1280, height: 800 });
    await serveFeedback(downPage);
    await downPage.goto(`${origin}/gallery.html?frame=feedbacksecrets`, { waitUntil: 'networkidle0' });
    await downPage.waitForSelector('[data-visible-copy]');
    const scrollY = await downPage.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      return document.documentElement.scrollTop;
    });
    await openDialogInPlace(downPage);
    const downRegions = await readSecretRegions(downPage);
    const downControl = await readRegion(downPage, '[data-visible-copy]');
    await downPage.close();

    return {
      desktop: { shot, password, token, control, consent, sent, toast },
      annotated: { before, afterDrag, afterUndo, sentAnnotated },
      noteOnly: { shotSectionPresent, sent: bareSent },
      oversized: { message, sendableWithoutShot, sent: bigSent },
      retry: {
        errorText, buttonLabel, canvasSurvived, toast: retryToast,
        attempts: flakySent.length,
        sizes: flakySent.map((one) => one.screenshot?.size ?? 0),
        diagnostics: [...flakyDiagnostics],
      },
      captureFailure: {
        message: captureMessage,
        sendableWithNote: captureNoteSendable,
        diagnostics: [...captureDiagnostics],
        retook: captureRetook,
      },
      decodeFailure: {
        message: decodeMessage,
        diagnostics: [...decodeDiagnostics],
        retook: decodeRetook,
      },
      mobile: { buttonVisible, dialogWithin, captureSucceeded },
      cards,
      dialog,
      routed: { openedFromRail, offsets, panes, sent: routedSent },
      stalled: {
        whileSending, afterStop, outcomes, closedAfterStop,
        retryToast: stalledToast,
        diagnostics: [...stalledDiagnostics],
      },
      scrolledDocument: { scrollY, regions: downRegions, control: downControl },
    };
  });
}

let observed: Observed;
beforeAll(async () => { observed = await run(); }, 600_000);

describe('the screenshot never carries a secret', () => {
  test('a password field is a solid block, without being marked for redaction', () => {
    // No `data-feedback-redact` on that input. Being a password is the whole
    // qualification, because an opt-in list is only as good as the last person
    // who remembered it.
    expect(observed.desktop.password.sampled).toBeGreaterThan(100);
    expect(observed.desktop.password.offFill).toBe(0);
    expect(observed.desktop.password.colours).toBe(1);
    expect(observed.desktop.password.uniformlyRedacted).toBe(true);
  });

  test('a marked region holding a token rendered as text is a solid block too', () => {
    expect(observed.desktop.token.sampled).toBeGreaterThan(100);
    expect(observed.desktop.token.offFill).toBe(0);
    expect(observed.desktop.token.colours).toBe(1);
    expect(observed.desktop.token.uniformlyRedacted).toBe(true);
  });

  test('the rest of the page is really there — the control that stops the above passing on a blank image', () => {
    expect(observed.desktop.control.sampled).toBeGreaterThan(100);
    expect(observed.desktop.control.colours).toBeGreaterThan(1);
    expect(observed.desktop.control.uniformlyRedacted).toBe(false);
  });

  test('the dialog reports how many fields it hid, so redaction is visible rather than promised', () => {
    expect(observed.desktop.shot.redacted).toBeGreaterThanOrEqual(2);
  });

  test('the capture has real dimensions', () => {
    expect(observed.desktop.shot.width).toBeGreaterThan(1000);
    expect(observed.desktop.shot.height).toBeGreaterThan(400);
  });
});

describe('the real secret-bearing surfaces the app actually shows', () => {
  test('every secret is genuinely on the page — the control that stops the rest passing on an empty one', () => {
    const [hmac, bearer, mcp] = observed.cards.live;
    // The issued secret and the curl that tests it are TEXT, which no
    // password-input rule can reach.
    expect(hmac?.inText).toBe(true);
    expect(bearer?.inText).toBe(true);
    // A pasted bearer header lives in a field's value and nowhere in the markup.
    expect(mcp?.inValues).toBe(true);
    expect(observed.dialog.live[0]?.inValues).toBe(true);
  });

  test('no secret survives into the clone the screenshot is rasterised from', () => {
    // Text, attributes and the values the rasteriser copies in itself: the clone
    // is read as the rasteriser serialized it, so all three are covered at once.
    expect(observed.cards.clone.serializations).toBeGreaterThan(0);
    expect(observed.cards.clone.bytes).toBeGreaterThan(10_000);
    expect(observed.cards.clone.leaked).toEqual([]);
    expect(observed.dialog.clone.serializations).toBeGreaterThan(0);
    expect(observed.dialog.clone.leaked).toEqual([]);
  });

  test('every marked region is a solid block in the captured image', () => {
    for (const region of [...observed.cards.regions, ...observed.dialog.regions]) {
      expect({ label: region.label, offFill: region.offFill, colours: region.colours })
        .toEqual({ label: region.label, offFill: 0, colours: 1 });
      expect(region.sampled).toBeGreaterThan(20);
    }
  });

  test('all four surfaces are covered, not only the ones somebody remembered', () => {
    // Two cards, each with an issued secret AND the secret inside its curl, plus
    // the MCP headers editor: five regions. A card that stopped marking one of
    // its two renderings would still pass a count of one.
    expect(observed.cards.regions).toHaveLength(5);
    expect(observed.cards.redacted).toBe(5);
    // The dialog's field, redacted as a password AND as a marked region.
    expect(observed.dialog.regions).toHaveLength(1);
    expect(observed.dialog.redacted).toBe(1);
  });

  test('a secret input is a password field as well as a marked region', () => {
    // Both, deliberately: the type is what keeps it out of a screenshot without
    // anyone annotating it, and the marker is what survives someone adding a
    // reveal toggle that flips the type to `text`.
    expect(observed.dialog.fields).toEqual([{ tag: 'input', type: 'password' }]);
    // The MCP headers editor is a textarea, which cannot be a password field at
    // all, so the marker is the whole of its protection.
    expect(observed.cards.fields).toEqual([{ tag: 'textarea', type: '' }]);
  });

  test('the surfaces around them are really rendered', () => {
    expect(observed.cards.control.colours).toBeGreaterThan(1);
    expect(observed.dialog.control.colours).toBeGreaterThan(1);
  });
});

describe('sending a report', () => {
  test('the body carries the note, the route and a real PNG, and nothing else', () => {
    const submission = observed.desktop.sent.at(-1);
    expect(submission).toBeDefined();
    expect(new Set(submission?.fields)).toEqual(new Set(['note', 'route', 'workspace', 'annotated', 'screenshot']));
    expect(submission?.note).toBe('the key field renders behind the label');
    expect(submission?.route).toBe('/');
    expect(submission?.screenshot?.type).toBe('image/png');
    expect(submission?.screenshot?.name).toBe('feedback.png');
    // A real capture, not an empty file — and inside the limit both halves hold.
    expect(submission?.screenshot?.size ?? 0).toBeGreaterThan(5_000);
    expect(submission?.screenshot?.size ?? 0).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  test('success is stated, with the id the server returned', () => {
    expect(observed.desktop.toast).toContain('fb-0001');
  });

  test('the consent line says what leaves the browser, before anything does', () => {
    expect(observed.desktop.consent).toContain('note');
    expect(observed.desktop.consent).toContain('screenshot');
    expect(observed.desktop.consent).toContain('email');
    expect(observed.desktop.consent).toMatch(/[Pp]assword/u);
  });
});

describe('annotation', () => {
  test('a drag covers what it was dragged over, and undo puts it back', () => {
    expect(observed.annotated.afterDrag).toBeLessThan(observed.annotated.before);
    expect(observed.annotated.afterUndo).toBe(observed.annotated.before);
  });

  test('an annotated report says so, so the marker can count it', () => {
    expect(observed.annotated.sentAnnotated).toBe('1');
  });
});

describe('a report without a screenshot', () => {
  test('unticking the box removes the whole screenshot section', () => {
    expect(observed.noteOnly.shotSectionPresent).toBe(false);
  });

  test('the note alone is a complete report', () => {
    const submission = observed.noteOnly.sent.at(-1);
    expect(submission?.fields).not.toContain('screenshot');
    expect(submission?.note).toBe('no screenshot for this one');
  });
});

describe('a capture too large to send', () => {
  test('it is refused in the browser, with the limit named', () => {
    expect(observed.oversized.message).toMatch(/MiB/u);
    expect(observed.oversized.message).toContain('note');
  });

  test('the note is still sendable, and goes without an image', () => {
    expect(observed.oversized.sendableWithoutShot).toBe(true);
    expect(observed.oversized.sent.at(-1)?.fields).not.toContain('screenshot');
  });
});

describe('a send that fails', () => {
  test('the reporter is told, and told the work is not lost', () => {
    expect(observed.retry.errorText).toContain('Not sent');
    expect(observed.retry.errorText).toMatch(/still here/u);
  });

  test('nothing retries on its own — the button becomes Retry and waits', () => {
    expect(observed.retry.buttonLabel).toBe('Retry');
    expect(observed.retry.canvasSurvived).toBe(true);
    // Exactly two attempts for exactly two clicks: the one that was refused at
    // the connection, and the one the reporter asked for. A third would mean
    // something retried by itself.
    expect(observed.retry.attempts).toBe(2);
  });

  test('retry sends the same capture, kept in memory across the failure', () => {
    expect(observed.retry.toast).toContain('fb-0001');
    // Both attempts carried a screenshot of the same size — the bytes were
    // reused, not re-captured, which is what "kept in memory" means.
    expect(observed.retry.sizes).toHaveLength(2);
    expect(observed.retry.sizes[0]).toBeGreaterThan(5_000);
    expect(observed.retry.sizes[0]).toBe(observed.retry.sizes[1]);
  });

  test('the failure is recorded exactly once, classified, with its cause', () => {
    // One click that failed, one classified record. The retry that succeeded
    // adds nothing, and the UI string above is a display, not the record.
    expect(observed.retry.diagnostics).toEqual([
      { event: 'feedback.send_failed', code: 'io', cause: 'send a feedback report: Failed to fetch', fields: {} },
    ]);
  });
});

describe('a capture that fails', () => {
  test('the reporter is told, with the whole cause chain, and the note still sends', () => {
    expect(observed.captureFailure.message).toContain('No screenshot:');
    expect(observed.captureFailure.message).toContain(CAPTURE_CHAIN);
    expect(observed.captureFailure.message).toContain('sent on its own');
    expect(observed.captureFailure.sendableWithNote).toBe(true);
  });

  test('every failed attempt is recorded, classified, with the chain intact', () => {
    // StrictMode re-runs the opening effect, so the attempt COUNT is the
    // runtime's business. What this gate holds per attempt: the one event
    // name, the class, and the WHOLE chain — the `doing` frame first, never
    // the head of the chain alone.
    expect(observed.captureFailure.diagnostics.length).toBeGreaterThanOrEqual(1);
    for (const line of observed.captureFailure.diagnostics) {
      expect(line.event).toBe('feedback.capture_failed');
      expect(line.code).toBe('unsupported');
      expect(line.cause).toBe(`capture the page for a feedback report: ${CAPTURE_CHAIN}`);
    }
  });

  test('the checkbox retakes once the page can be photographed again', () => {
    expect(observed.captureFailure.retook).toBe(true);
  });
});

describe('a preview that cannot be decoded', () => {
  test('the shot is a failure the reporter can read, not a blank canvas', () => {
    expect(observed.decodeFailure.message).toContain('No screenshot:');
    expect(observed.decodeFailure.message).toContain(DECODE_CHAIN);
  });

  test('every failed decode is recorded, classified, with the chain intact', () => {
    expect(observed.decodeFailure.diagnostics.length).toBeGreaterThanOrEqual(1);
    for (const line of observed.decodeFailure.diagnostics) {
      expect(line.event).toBe('feedback.decode_failed');
      expect(line.code).toBe('bad_input');
      expect(line.cause).toBe(`decode the captured screenshot for preview: ${DECODE_CHAIN}`);
    }
  });

  test('a retake recovers the preview', () => {
    expect(observed.decodeFailure.retook).toBe(true);
  });
});

describe('on a phone', () => {
  test('the feedback affordance is reachable and inside the viewport', () => {
    expect(observed.mobile.buttonVisible).toBe(true);
  });

  test('the dialog does not overflow a 390px screen', () => {
    expect(observed.mobile.dialogWithin).toBe(true);
  });

  test('the capture works at device-pixel-ratio 2', () => {
    expect(observed.mobile.captureSucceeded).toBe(true);
  });
});

describe('a report sent from the routed app', () => {
  test('the affordance is the rail\'s own, in the account menu the app ships', () => {
    expect(observed.routed.openedFromRail).toBe(true);
  });

  test('the report is addressed by the route the router resolved', () => {
    const submission = observed.routed.sent.at(-1);
    expect(submission).toBeDefined();
    // Not `/`: the fixture frames send from the gallery's own root, and this
    // pair of fields is what the ingest keys a report to a workspace by.
    expect(submission?.route).toBe('/workspace/checkout-fixes');
    expect(submission?.workspace).toBe('checkout-fixes');
    expect(submission?.screenshot?.type).toBe('image/png');
    expect(submission?.outcome).toBe('answered');
  });
});

describe('a pane the reporter scrolled', () => {
  test('the fixture really was scrolled, in both directions', () => {
    // Two viewports each way. The vertical figure is not a round 360: the design
    // system's grouped-row rule puts a hairline on the pane's top edge, so the
    // scrollable viewport is a couple of pixels shorter than its declared
    // height. Which band the image caught is the claim below; this one only has
    // to say the fixture moved.
    expect(observed.routed.offsets.outer).toBeGreaterThan(300);
    expect(observed.routed.offsets.inner).toBe(960);
  });

  test('is photographed where they left it, vertically and horizontally', () => {
    expect(observed.routed.panes).toHaveLength(2);
    for (const pane of observed.routed.panes) {
      // `atRest` is the fill an ignored scroll offset shows. Asserting the two
      // differ is what stops this passing on a fixture that cannot tell them
      // apart, and the sampled colour is then the whole claim.
      expect(pane.atRest).not.toBe(pane.wanted);
      expect({ label: pane.label, seen: pane.seen }).toEqual({ label: pane.label, seen: pane.wanted });
      expect(pane.sampled).toBeGreaterThan(400);
    }
  });
});

describe('photographed part-way down a page that scrolls', () => {
  test('the page really was scrolled', () => {
    expect(observed.scrolledDocument.scrollY).toBeGreaterThan(100);
  });

  test('the capture still starts at the top of the document', () => {
    // Every marked region, sampled at its DOCUMENT position. A capture that
    // moved with the reader would put a card where each block is expected and
    // fail every one of these.
    expect(observed.scrolledDocument.regions).toHaveLength(5);
    for (const region of observed.scrolledDocument.regions) {
      expect({ label: region.label, offFill: region.offFill, colours: region.colours })
        .toEqual({ label: region.label, offFill: 0, colours: 1 });
      expect(region.sampled).toBeGreaterThan(20);
    }
  });

  test('and the page around them is really there', () => {
    expect(observed.scrolledDocument.control.colours).toBeGreaterThan(1);
  });
});

describe('a send the network never answers', () => {
  test('the dialog offers a way out of it', () => {
    expect(observed.stalled.whileSending.cancelHook).toBe('stop');
    expect(observed.stalled.whileSending.sendLabel).toBe('Sending…');
  });

  test('a stray Escape still does not tear down a report mid-write', () => {
    expect(observed.stalled.whileSending.dismissedByEscape).toBe(false);
  });

  test('stopping keeps the note and the capture, and says who stopped it', () => {
    expect(observed.stalled.afterStop.errorText).toMatch(/you stopped it/i);
    expect(observed.stalled.afterStop.errorText).toMatch(/still here/u);
    expect(observed.stalled.afterStop.canvasSurvived).toBe(true);
    expect(observed.stalled.afterStop.sendLabel).toBe('Retry');
    expect(observed.stalled.afterStop.cancelHook).toBe('close');
  });

  test('the stop reached the request, and retry sent a new one', () => {
    // Three POSTs for three presses. The first ENDED — a dialog that merely
    // stopped listening would leave it `pending` for as long as the page lived —
    // the second was answered, and the third was stopped the same way.
    expect(observed.stalled.outcomes).toEqual(['AbortError', 'answered', 'AbortError']);
    expect(observed.stalled.retryToast).toContain('fb-0001');
  });

  test('a stopped send is not recorded as a failure', () => {
    // The reporter's own decision. Recording it would make every impatient
    // person on a slow connection an incident.
    expect(observed.stalled.diagnostics).toEqual([]);
  });

  test('and the dialog can then be left', () => {
    expect(observed.stalled.closedAfterStop).toBe(true);
  });
});

test('a capture completed after screenshot opt-out cannot attach to the report', async () => {
  await withGallery(async ({ browser, origin }) => {
    const page = await browser.newPage();
    await serveFeedback(page);
    await page.goto(`${origin}/gallery.html?frame=feedback`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => {
      const encode = HTMLCanvasElement.prototype.toBlob;
      const held: (() => Promise<void>)[] = [];
      window.__heldFeedbackEncodes = 0;
      HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
        held.push(() => new Promise<void>((resolve) => {
          encode.call(this, (blob) => { callback(blob); resolve(); }, type, quality);
        }));
        window.__heldFeedbackEncodes = held.length;
      };
      window.__releaseFeedbackEncodes = async () => {
        HTMLCanvasElement.prototype.toBlob = encode;
        await Promise.all(held.map((release) => release()));
      };
    });
    await page.click('[data-feedback-open]');
    await page.waitForFunction(() => (window.__heldFeedbackEncodes ?? 0) > 0);
    await page.click('[data-feedback-include-shot]');
    await waitForShotRemoval(page);
    await page.evaluate(async () => { await window.__releaseFeedbackEncodes?.(); });
    await page.type('[data-feedback-note]', 'send no screenshot');
    await page.click('[data-feedback-send]');
    await page.waitForSelector('[data-feedback-sent]');
    expect((await submissions(page)).at(-1)?.screenshot).toBeNull();
  });
});
