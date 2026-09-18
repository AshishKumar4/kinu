#!/usr/bin/env bun
/**
 * Cut the README's planning walkthrough GIF from the PRODUCT.
 *
 * Every frame is a Chrome screenshot of the real client talking to the real
 * Worker in workerd over real Durable Objects (`live-app-harness`), driven
 * through the controls a person uses: the composer's Plan segment, the
 * composer, Send, and the plan's own Approve control found by role and name.
 * The only stand-in is the provider — a local scripted model
 * (`scripted-model.ts`), because a local run has none. The README's caption can
 * therefore say where the film comes from, and name the build it was cut from.
 *
 *   bun scripts/plan-demo-film.ts                    # docs/assets/kinu-plan-demo.gif
 *   bun scripts/plan-demo-film.ts --out /tmp/x.gif --evidence /tmp/stills
 *
 * The drive is shared with the live-app tier's own row over the same script
 * (`drivePlanReview`): the row asserts the walkthrough, this program
 * photographs it, and neither can drift from the other. A beat's pacing is the
 * run's own — the hold a frame gets is the time the product spent on it,
 * clamped — so the animation plays at the speed the product answered.
 *
 * Frames are captured as PNGs and muxed to GIF with the system ffmpeg's
 * palettegen/paletteuse two-pass (ffmpeg + ffprobe on PATH are host
 * prerequisites, nothing this script installs): GitHub's README renderer
 * animates GIF everywhere, and the palette pass keeps the dark theme's ink
 * clean under 256 colours. Frame durations ride in the concat manifest, so a
 * held beat costs one screenshot, not one per tick.
 *
 * Every shot settles the page's animations first — a one-shot animation is
 * photographed finished, a looping one parked at its first frame — so two
 * screenshots of the same state are the same bytes and fold into one held
 * frame instead of flickering.
 */
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Page } from 'puppeteer';
import * as v from 'valibot';

import { withLiveApp, createWorkspace, type LiveApp } from './live-app-harness';
import {
  PLAN_MISSION, SCRIPTED_MODEL_SPEC, SLATE_TITLE,
  planWalkthrough, registerScriptedModel, startScriptedModel,
} from './scripted-model';
import { scratchDir } from '../packages/test-utils/src/scratch';

const REPO = resolve(import.meta.dir, '..');

/** Where the README reads the animation from. */
export const DEFAULT_OUT = resolve(REPO, 'docs/assets/kinu-plan-demo.gif');

/** The theme the README shows the film in. */
const THEME = 'dark';

/** 16:10, the aspect the README's image tag reserves. */
export const VIEWPORT = { width: 1440, height: 900 } as const;

/** The published width; the height follows the viewport's aspect. */
export const GIF_WIDTH = 1200;

/** The workspace's standing brief — what the workspace IS, shown by the empty
 *  conversation before the first turn. The mission is sent, not this. */
const WORKSPACE_PURPOSE = 'Fix the checkout coupon 500 and report on the support queue';

/** How many distinct frames the film may hold. A turn that takes longer than
 *  expected must cost hold time, never an unbounded palette. */
const FRAME_BUDGET = 170;

/**
 * The tick a hold is priced in. Measured with ffmpeg 8.0 / ffprobe on this
 * host, 2026-09-18: the concat demuxer truncates every `duration` to a whole
 * 1/25 s tick, so a planned 0.07 s frame reaches the GIF as 0.04 s. Holds are
 * therefore snapped DOWN onto this grid before the manifest states them —
 * the film's plan and the file's packets then agree exactly, and the
 * verification below can fail on a real drift of one tick.
 */
const FRAME_TICK_MS = 40;

/** A hold below this reads as a stutter, above it as a stall. */
const MIN_HOLD_MS = FRAME_TICK_MS;

const MAX_HOLD_MS = 1_400;

/** The settled state, held before the loop restarts. */
const TAIL_HOLD_MS = 2_600;

/** The cursor's travel to a control: dense enough to read as a movement. */
const TRAVEL_STEPS = 6;

/** How often a waiting beat photographs the product while it works. */
const SAMPLE_MS = 180;

/** A shut inspector column: the library leaves a 0px box. */
const SHUT_PX = 1;

/* ── The recorded cursor ──────────────────────────────────────────────────
   Chrome never paints a pointer into a screenshot, so the film draws one:
   an overlay moved to the same coordinates the real mouse is moved to, and
   pressed when the real mouse presses. The arrow is the landing walkthrough's
   own, so the two animations show one product. */

const CURSOR_SCRIPT = `(() => {
  const existing = document.getElementById('kinu-film-cursor');

  if (existing !== null) return;
  const host = document.createElement('div');
  host.id = 'kinu-film-cursor';
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;opacity:0;'
    + 'filter:drop-shadow(0 1px 2px rgba(0,0,0,.6));transition:none';
  host.innerHTML = '<svg width="20" height="22" viewBox="0 0 20 22">'
    + '<path d="M2 1 L2 17 L6.5 13.5 L9.5 20 L12.5 18.7 L9.6 12.4 L15.5 12 Z"'
    + ' fill="var(--c-text)" stroke="var(--c-bg)" stroke-width="1.4" stroke-linejoin="round" /></svg>';
  const ripple = document.createElement('div');
  ripple.id = 'kinu-film-ripple';
  ripple.setAttribute('aria-hidden', 'true');
  ripple.style.cssText = 'position:fixed;left:0;top:0;width:40px;height:40px;border-radius:9999px;'
    + 'border:2px solid var(--c-accent);z-index:2147483646;pointer-events:none;opacity:0';
  document.body.append(host, ripple);
})()`;

/** Paint the overlay at a point. `press` draws the click's ring. */
function cursorAt(x: number, y: number, press: boolean): string {
  return `(() => {
    const cursor = document.getElementById('kinu-film-cursor');
    const ripple = document.getElementById('kinu-film-ripple');

    if (cursor === null || ripple === null) return;
    cursor.style.opacity = '1';
    cursor.style.transform = 'translate(${String(Math.round(x))}px, ${String(Math.round(y))}px)';
    ripple.style.opacity = ${press ? "'.55'" : "'0'"};
    ripple.style.transform = 'translate(${String(Math.round(x) - 20)}px, ${String(Math.round(y) - 20)}px) scale(${press ? '1' : '.35'})';
  })()`;
}

/* ── Measurements the drive reports ──────────────────────────────────────── */

/** The inspector column's box, `-1` when the document holds no such panel. */
const INSPECTOR_WIDTH = `(() => {
  const column = document.getElementById('inspector');

  return column === null ? -1 : Math.round(column.getBoundingClientRect().width);
})()`;

/** The inspector strip's tab labels, in order. */
const STRIP_LABELS = `[...document.querySelectorAll('#inspector .p-tabstrip button')]
  .map((button) => (button.textContent ?? '').trim()).filter((label) => label.length > 0)`;

/**
 * Tool cards standing in the transcript — what a turn that ran tools leaves.
 *
 * `data-tool-state` is on EVERY call's card; `data-tool-group` is only on the
 * header a run of two or more shares (core's `MIN_GROUP`), so counting groups
 * read zero for the plan turn's single `submit_plan` and missed the whole
 * point of the count.
 */
const TOOL_CARDS = `document.querySelectorAll('#chat [data-tool-state]').length`;

const PLAN_STATUS = `(document.querySelector('#inspector [data-plan-status]')?.textContent ?? '').trim()`;

/** What the walkthrough did, as the product showed it. Every field is read off
 *  the rendered document, never off the script that drove it. */
export interface WalkthroughVerdict {
  /** The column's width while the plan turn was still running. */
  readonly inspectorBeforePlan: number;
  /** The column's width once the plan arrived. */
  readonly inspectorOnPlan: number;
  /** The plan's own review surface stood in the column. */
  readonly planReviewShown: boolean;
  /** The accessible name of the control the approval went through. */
  readonly approveControl: string;
  /** `[data-plan-status]` after the decision. */
  readonly planStatus: string;
  readonly toolCardsBeforeApproval: number;
  /** Tool cards after the approved turn ran — the enqueued handoff's work. */
  readonly toolCardsAfterImplement: number;
  /** The strip once the slate exists. */
  readonly stripLabels: readonly string[];
}

/** Called after every shot-worthy moment; the recorder photographs, a test
 *  that only wants the verdict passes a no-op. */
export type OnFrame = (beat: string) => Promise<void>;

const PointSchema = v.object({ x: v.number(), y: v.number() });

const ControlSchema = v.object({ x: v.number(), y: v.number(), name: v.string() });

/**
 * The first visible control whose accessible name matches, scoped to a
 * container: its centre in viewport coordinates and the name that matched.
 * Role and NAME only — the accessible name: `aria-label`, else the control's
 * own text, else `title` — so a relabelled control still answers and a copied
 * sentence never does.
 *
 * The match is scrolled into its own scroller before it is measured, because
 * the press is a real mouse click at real coordinates: a long plan puts
 * `Approve & implement` ~600 px below a 900 px viewport inside the
 * inspector's `overflow-y-auto` column, and the coordinates of an element
 * outside the viewport belong to nothing — Chrome delivers that click to
 * `<html>` and the product never sees it. `nearest` scrolls the least amount
 * that makes the control clickable, so the film pans only where a person
 * would. A control still outside the viewport after that is named as such
 * rather than clicked into the void.
 */
async function control(page: Page, input: { within: string; name: string }): Promise<v.InferOutput<typeof ControlSchema>> {
  const found = await page.evaluate(`(() => {
    const scope = document.querySelector(${JSON.stringify(input.within)});

    if (scope === null) return { candidates: [] };
    const pattern = new RegExp(${JSON.stringify(input.name)}, 'iu');
    const candidates = [];

    for (const element of scope.querySelectorAll('button, [role="button"]')) {
      const text = (element.textContent ?? '').trim();
      const name = element.getAttribute('aria-label') ?? (text.length > 0 ? text : (element.getAttribute('title') ?? ''));
      const shut = element.disabled === true;
      candidates.push(name + (shut ? ' [disabled]' : '') + (element.getClientRects().length === 0 ? ' [hidden]' : ''));

      if (shut || element.getClientRects().length === 0 || !pattern.test(name)) continue;
      element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });

      const box = element.getBoundingClientRect();
      const x = Math.round(box.x + box.width / 2);
      const y = Math.round(box.y + box.height / 2);

      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
        return { unreachable: name + ' at ' + String(x) + ',' + String(y) };
      }

      return { x, y, name };
    }

    return { candidates };
  })()`);

  const control = v.safeParse(ControlSchema, found);

  if (!control.success) {
    const offscreen = v.safeParse(v.object({ unreachable: v.string() }), found);

    if (offscreen.success) {
      throw new Error(`the ${input.name} control inside ${input.within} stays outside the viewport: ${offscreen.output.unreachable}`);
    }

    const seen = v.parse(v.object({ candidates: v.array(v.string()) }), found);

    throw new Error(`no ${input.name} control inside ${input.within}; saw ${JSON.stringify(seen.candidates)}`);
  }

  return control.output;
}

/** Settle CSS animations so two shots of one state are the same bytes. */
const SETTLE_SCRIPT = `(() => {
  for (const animation of document.getAnimations()) {
    if (animation.effect?.getTiming().iterations === Number.POSITIVE_INFINITY) {
      animation.currentTime = 0;
      animation.pause();
    } else {
      animation.finish();
    }
  }
})()`;

/** Move the real mouse to a point, the drawn cursor with it, photographing
 *  the travel. The click is a real press at real coordinates: a control the
 *  layout covers or shifts cannot be clicked by accident. */
async function travelTo(page: Page, target: { x: number; y: number }, from: { x: number; y: number }, onFrame: OnFrame, beat: string): Promise<void> {
  for (let step = 1; step <= TRAVEL_STEPS; step += 1) {
    const progress = step / TRAVEL_STEPS;
    const x = from.x + (target.x - from.x) * progress;
    const y = from.y + (target.y - from.y) * progress;
    await page.mouse.move(x, y);
    await page.evaluate(cursorAt(x, y, false));
    await onFrame(beat);
  }
}

async function pressAt(page: Page, point: { x: number; y: number }, onFrame: OnFrame, beat: string): Promise<void> {
  await page.evaluate(cursorAt(point.x, point.y, true));
  await onFrame(beat);
  await page.mouse.click(point.x, point.y);
  await page.evaluate(cursorAt(point.x, point.y, false));
  await onFrame(beat);
}

/** How long the film waits for one beat of the product before it says what it
 *  was waiting for. Not a deadline on the turn — the turn owns its own time —
 *  but the recorder's patience: a beat that never lands must fail with the
 *  page's state, not hang a browser forever. */
const BEAT_PATIENCE_MS = 90_000;

/** What the page can say about where the walkthrough got to. */
const WHERE = `JSON.stringify({
  mode: [...document.querySelectorAll('[aria-label="Turn mode"] button')].map((b) => b.textContent + '=' + String(b.getAttribute('aria-pressed'))),
  planStatus: document.querySelector('#inspector [data-plan-status]')?.textContent ?? null,
  toolCards: document.querySelectorAll('#chat [data-tool-group]').length,
  strip: [...document.querySelectorAll('#inspector .p-tabstrip button')].map((b) => (b.textContent ?? '').trim()),
  notices: [...document.querySelectorAll('[role="alert"], [role="status"]')].map((n) => (n.textContent ?? '').trim()).slice(0, 4),
  chatTail: (document.querySelector('#chat')?.textContent ?? '').slice(-400),
})`;

/** Photograph the product while it works, until the condition holds. */
async function until(page: Page, condition: string, onFrame: OnFrame, beat: string): Promise<void> {
  process.stderr.write(`plan-demo-film: ${beat}\n`);
  const deadline = Date.now() + BEAT_PATIENCE_MS;
  const settled = page.waitForFunction(condition, { polling: 100, timeout: BEAT_PATIENCE_MS });
  let done = false;
  const stop = settled.then(() => { done = true; }, () => { done = true; });

  while (!done) {
    await onFrame(beat);
    await Promise.race([stop, new Promise((wake) => setTimeout(wake, SAMPLE_MS))]);

    if (!done && Date.now() > deadline) break;
  }

  if (!done || Date.now() > deadline) {
    const where = String(await page.evaluate(WHERE));

    throw new Error(`the ${beat} beat never landed: ${condition.replace(/\s+/gu, ' ')} — ${where}`);
  }

  await settled;
  await onFrame(beat);
}

/**
 * Drive the plan review end to end through the product's own controls, on the
 * workspace the caller created: Plan mode, the mission, the plan that comes
 * back, the approval, and the slate the approved turn writes.
 */
export async function drivePlanReview(
  page: Page, origin: string, workspace: string, onFrame: OnFrame,
): Promise<WalkthroughVerdict> {
  await page.setViewport(VIEWPORT);
  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: THEME },
    { name: 'prefers-reduced-motion', value: 'no-preference' },
  ]);
  await page.evaluateOnNewDocument((theme: string) => {
    localStorage.setItem('theme', theme);
  }, THEME);
  await page.goto(`${origin}/workspace/${workspace}`, { waitUntil: 'load' });
  await page.waitForFunction(`[...document.querySelectorAll('#chat textarea')].some((area) => !area.disabled)`, { polling: 100 });
  await page.waitForFunction(`document.fonts.status === 'loaded'`, { polling: 100 });
  await page.evaluate(CURSOR_SCRIPT);
  await onFrame('open');
  await onFrame('open');

  const origin0 = { x: VIEWPORT.width - 80, y: VIEWPORT.height - 60 };

  const planMode = await control(page, { within: '[aria-label="Turn mode"]', name: '^Plan$' });
  await travelTo(page, planMode, origin0, onFrame, 'plan-mode');
  await pressAt(page, planMode, onFrame, 'plan-mode');

  const composer = v.parse(v.nullable(PointSchema), await page.evaluate(`(() => {
    const area = [...document.querySelectorAll('#chat textarea')].find((element) => !element.disabled);

    if (area === undefined) return null;
    const box = area.getBoundingClientRect();

    return { x: Math.round(box.x + 40), y: Math.round(box.y + box.height / 2) };
  })()`));

  if (composer === null) throw new Error('the workspace has no live composer');
  await travelTo(page, composer, planMode, onFrame, 'mission');
  await page.mouse.click(composer.x, composer.y);

  for (const [index, letter] of [...PLAN_MISSION].entries()) {
    await page.keyboard.type(letter);

    if (index % 3 === 0) await onFrame('mission');
  }

  await onFrame('mission');

  const send = await control(page, { within: '#chat', name: '^Send$' });
  await travelTo(page, send, composer, onFrame, 'send');
  const toolCardsBeforeApproval0 = Number(await page.evaluate(TOOL_CARDS));
  await pressAt(page, send, onFrame, 'send');

  const inspectorBeforePlan = Number(await page.evaluate(INSPECTOR_WIDTH));
  await until(page, `document.querySelector('#chat [data-tool-group]') !== null
    || document.querySelector('#inspector [data-plan-status]') !== null`, onFrame, 'turn');
  await until(page, `document.querySelector('#inspector [data-plan-decisions] button:not([disabled])') !== null`, onFrame, 'turn');

  const inspectorOnPlan = Number(await page.evaluate(INSPECTOR_WIDTH));
  const planReviewShown = await page.evaluate(`document.querySelector('#inspector [data-plan-body]') !== null`) === true;
  await onFrame('review');
  await onFrame('review');

  const approve = await control(page, { within: '#inspector [data-plan-decisions]', name: 'approve' });
  await travelTo(page, approve, send, onFrame, 'approve');
  const toolCardsBeforeApproval = Number(await page.evaluate(TOOL_CARDS));
  await pressAt(page, approve, onFrame, 'approve');
  await until(page, `${PLAN_STATUS} === 'Approved'`, onFrame, 'approved');
  const planStatus = String(await page.evaluate(PLAN_STATUS));
  await until(page, `${STRIP_LABELS}.includes(${JSON.stringify(SLATE_TITLE)})`, onFrame, 'implement');

  const stripLabels = v.parse(v.array(v.string()), await page.evaluate(STRIP_LABELS));
  const toolCardsAfterImplement = Number(await page.evaluate(TOOL_CARDS));
  await page.evaluate(cursorAt(origin0.x, origin0.y, false));
  await onFrame('slate');

  return {
    inspectorBeforePlan,
    inspectorOnPlan,
    planReviewShown,
    approveControl: approve.name,
    planStatus,
    toolCardsBeforeApproval: Math.max(toolCardsBeforeApproval, toolCardsBeforeApproval0),
    toolCardsAfterImplement,
    stripLabels,
  };
}

/** One distinct frame of the manifest — named by basename, since the
 *  manifest lives in the frames directory itself and relative names never
 *  need quoting — and how long it is held. */
export interface ManifestEntry {
  readonly file: string;
  holdMs: number;
}

/** The reel: every shot the drive asks for, deduplicated. A held beat
 *  screenshots identically twice, and the second shot becomes hold time on the
 *  first rather than a second palette entry. The hold a frame gets is the time
 *  the product spent before the next shot, so the film plays at the pace the
 *  run had. */
function reel(page: Page, framesDir: string) {
  const entries: ManifestEntry[] = [];
  const beats = new Map<string, string>();
  let previous: Uint8Array | null = null;
  let shotAt = 0;

  const shoot = async (beat: string): Promise<void> => {
    if (entries.length >= FRAME_BUDGET) return;

    await page.evaluate(SETTLE_SCRIPT);
    const shot = await page.screenshot({ type: 'png' });
    const bytes = new Uint8Array(shot);
    const now = Date.now();
    const last = entries[entries.length - 1];

    if (last !== undefined) {
      const spent = Math.min(MAX_HOLD_MS, Math.max(MIN_HOLD_MS, now - shotAt));
      last.holdMs = FRAME_TICK_MS * Math.floor(spent / FRAME_TICK_MS);
    }

    shotAt = now;

    if (previous !== null && last !== undefined
      && bytes.length === previous.length && bytes.every((byte, index) => byte === previous?.[index])) {
      return;
    }

    const file = `frame-${String(entries.length).padStart(3, '0')}.png`;
    writeFileSync(join(framesDir, file), shot);
    entries.push({ file, holdMs: TAIL_HOLD_MS });
    beats.set(beat, file);
    previous = bytes;
  };

  return { shoot, entries, beats };
}

/** The concat manifest: every distinct frame with its hold, the final file
 *  repeated once so ffmpeg honours the last duration. The demuxer prices the
 *  trailing entry at its own 40ms tick — a constant phantom frame per loop,
 *  invisible in the animation and reported by probeGif's per-packet list. */
export function concatManifest(entries: readonly ManifestEntry[]): string {
  const lines: string[] = [];

  for (const entry of entries) {
    lines.push(`file '${entry.file}'`, `duration ${String(entry.holdMs / 1000)}`);
  }

  const last = entries[entries.length - 1];

  if (last !== undefined) lines.push(`file '${last.file}'`);

  return `${lines.join('\n')}\n`;
}

/** ffmpeg two-pass: concat the held frames, build a palette from them, then
 *  encode the GIF through it at the published width. The scale runs in BOTH
 *  passes: a palette built from the full-size frames quantizes colours the
 *  resampler never produces. */
export function muxGif(framesDir: string, manifestPath: string, out: string, width = GIF_WIDTH): void {
  const palette = join(framesDir, 'palette.png');
  const scale = `scale=${String(width)}:-1:flags=lanczos`;

  execFileSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'concat', '-safe', '0', '-i', manifestPath,
    '-vf', `${scale},palettegen=stats_mode=full`,
    palette,
  ]);
  execFileSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'concat', '-safe', '0', '-i', manifestPath,
    '-i', palette,
    // ffmpeg's default gifflags — offsetting and transdiff — are the GIF's
    // own delta encoding: a frame may crop to its changed rectangle and mark
    // unchanged pixels transparent, which is legal under disposal 0/1. The
    // film test's parser bounds what that means; frame 0's opacity is proven
    // by decoding it in plan-demo-film.test.ts.
    '-lavfi', `[0:v]${scale}[s];[s][1:v]paletteuse=dither=bayer:bayer_scale=4`,
    out,
  ]);
}

// ffprobe's JSON prints most numbers as strings ("duration": "15.400000")
// and answers "N/A" for the ones it cannot read — so every field is taken as
// string-or-number and each read is finite-checked: a parse that returns
// NaN/Infinity would pass a width assertion onto a broken file.
const ProbeOutputSchema = v.object({
  streams: v.array(v.object({
    width: v.union([v.number(), v.string()]),
    height: v.union([v.number(), v.string()]),
    nb_read_frames: v.union([v.number(), v.string()]),
    duration: v.union([v.number(), v.string()]),
  })),
});

/** Strictly-positive integer, or throws — the GIF's geometry and frame count
 *  must be real before a caller can trust them. */
function positiveInt(value: number, field: string, out: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`ffprobe's ${field} for ${out} is ${String(value)}, not a positive integer`);
  }

  return value;
}

/** Finite and non-negative, or throws — durations may be 0, never NaN/N/A. */
function finiteSeconds(value: number, field: string, out: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`ffprobe's ${field} for ${out} is ${String(value)}, not a finite duration`);
  }

  return value;
}

export interface GifFacts {
  readonly width: number;
  readonly height: number;
  readonly frames: number;
  readonly durationS: number;
  /** Each packet's own duration in seconds — including the concat demuxer's
   *  40ms trailing phantom — so a caller can assert every hold individually
   *  instead of trusting a summed duration. */
  readonly packetDurations: readonly number[];
}

/** What ffprobe says about the produced GIF — the verification the artifact
 *  carries its own evidence for. */
export function probeGif(out: string): GifFacts {
  const raw = execFileSync('ffprobe', [
    '-v', 'error',
    '-count_frames',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,nb_read_frames,duration',
    '-of', 'json',
    out,
  ]).toString();

  const probe = v.parse(ProbeOutputSchema, JSON.parse(raw));
  const stream = probe.streams[0];

  if (stream === undefined) throw new Error(`ffprobe found no video stream in ${out}`);

  const packetsRaw = execFileSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'packet=duration_time',
    '-of', 'csv=p=0',
    out,
  ]).toString();

  const packetDurations = packetsRaw.split('\n').filter((line) => line.length > 0)
    .map((line, index) => finiteSeconds(Number(line), `packet ${String(index)} duration`, out));

  return {
    width: positiveInt(Number(stream.width), 'width', out),
    height: positiveInt(Number(stream.height), 'height', out),
    frames: positiveInt(Number(stream.nb_read_frames), 'frame count', out),
    durationS: finiteSeconds(Number(stream.duration), 'duration', out),
    packetDurations,
  };
}

export interface FilmResult {
  readonly out: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly frames: number;
  readonly durationS: number;
  readonly verdict: WalkthroughVerdict;
}

/** Record the walkthrough on a booted live app and mux the README's GIF. */
export async function filmPlanReview(
  app: LiveApp, out: string, evidenceDir?: string,
): Promise<FilmResult> {
  const framesDir = scratchDir(`plan-demo-${String(process.pid)}`);
  const page = await app.newPage();
  const film = reel(page, framesDir);

  const workspace = await createWorkspace(
    app.origin, `plan-demo-${crypto.randomUUID().slice(0, 8)}`, WORKSPACE_PURPOSE, SCRIPTED_MODEL_SPEC);

  const verdict = await drivePlanReview(page, app.origin, workspace, film.shoot);
  await page.close();

  const entries = film.entries;
  const last = entries[entries.length - 1];

  if (last === undefined) throw new Error('the walkthrough produced no frames');
  last.holdMs = TAIL_HOLD_MS;

  const manifestPath = join(framesDir, 'frames.txt');
  writeFileSync(manifestPath, concatManifest(entries));
  muxGif(framesDir, manifestPath, out);

  const facts = probeGif(out);
  const planned = entries.reduce((sum, entry) => sum + entry.holdMs, 0) / 1000;

  if (facts.packetDurations.length !== entries.length + 1) {
    throw new Error(`GIF has ${String(facts.packetDurations.length)} packets for ${String(entries.length)} held frames plus the phantom`);
  }

  for (const [index, entry] of entries.entries()) {
    // Every hold is already on the demuxer's tick, so plan and packet agree
    // exactly; the slack is under one tick, and a frame off by a tick fails.
    if (Math.abs((facts.packetDurations[index] ?? 0) - entry.holdMs / 1000) > 0.03) {
      throw new Error(`GIF packet ${String(index)} holds ${String(facts.packetDurations[index])}s, the film planned ${String(entry.holdMs / 1000)}s`);
    }
  }

  if (Math.abs(facts.durationS - planned) > 0.5) {
    throw new Error(`GIF runs ${String(facts.durationS)}s, the film planned ${String(planned)}s`);
  }

  if (verdict.inspectorBeforePlan > SHUT_PX) {
    throw new Error(`the inspector was ${String(verdict.inspectorBeforePlan)}px wide before the plan arrived`);
  }

  if (evidenceDir !== undefined) {
    // One still per beat the film tells, so a review can see what the
    // animation says without decoding it.
    for (const [beat, file] of film.beats) {
      writeFileSync(join(evidenceDir, `kinu-plan-demo-${beat}.png`), await Bun.file(join(framesDir, file)).bytes());
    }
  }

  return {
    out,
    width: facts.width,
    height: facts.height,
    bytes: await Bun.file(out).size,
    frames: facts.frames,
    durationS: facts.durationS,
    verdict,
  };
}

if (import.meta.main) {
  const flag = process.argv.indexOf('--out');
  const named = flag >= 0 ? process.argv[flag + 1] : undefined;
  const out = named === undefined ? DEFAULT_OUT : resolve(named);
  const evidenceFlag = process.argv.indexOf('--evidence');
  const evidenceDir = evidenceFlag >= 0 ? resolve(process.argv[evidenceFlag + 1] ?? '') : undefined;
  const model = await startScriptedModel(planWalkthrough);

  const result = await withLiveApp(async (app) => {
    await registerScriptedModel(app.origin, model.port);

    return filmPlanReview(app, out, evidenceDir);
  });

  await model.stop();
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}
