/**
 * The plan frame's walkthrough as data: every cue and every cursor position,
 * with pure time-indexed functions over them. The component
 * (`LandingWorkspaceFrame`) paints this timeline onto the real workspace
 * components and owns no story of its own.
 *
 * The mechanism is the deleted `bugfix-demo-timeline.ts` re-pointed at the
 * product UI: `cursorAt` / `cueCountAt` / `discreteAt` over declared `MOVIE_CUES`,
 * an imperative per-frame paint of cursor + ripple + pressed state + progress
 * into `data-*` attributes, `IntersectionObserver` play-once with a settled
 * hold, replay only on a deliberate click, and a static settled state under
 * `prefers-reduced-motion` with no playback and no cursor.
 *
 * The journey, in the owner's order: the user types a request into the real
 * `Composer`, the agent makes tool calls streaming into the real `MessageView`,
 * it submits a plan, the plan appears in the right-hand panel, the cursor
 * clicks Approve, the agent makes more tool calls and builds a slate, and the
 * slate opens in its own tab — the settled final state.
 */
import type { UIMessage } from 'ai';

import type { PlanReview, SlateSummary, JsonObject, JsonValue } from '@kinu.run/core';
import { PLAN_FIXTURE, SLATE_PREVIEW_URL, SLATE_SUMMARY } from './landing-fixtures';

/** The surfaces the walkthrough ever selects: the Work tab, then the slate it
 *  builds in its own tab. Structurally the product `SurfaceKind` subset it is
 *  assigned into — `LandingWorkspaceFrame` feeds this straight to
 *  `WorkSurface`, so the backend check fails if the two ever disagree. This
 *  lives here rather than as an import so the module stays free of
 *  component-land: the scripts gate typechecks this file under its own JSX
 *  runtime, and even a type-only component import would drag the product's
 *  DOM components into that program. */
export type MovieSurface = 'Work' | `slate:${string}`;

/** `SLATE_PREFIX` in `components/surfaces/presence.ts`, restated for the same
 *  reason: one literal, and the `MovieSurface` assignment above is the trip
 *  wire if it ever drifts. */
const SLATE_PREFIX = 'slate:';

/** Named beats, in absolute movie milliseconds. Order is the story. Spacing
 *  follows the deleted demo's `DEMO_CUES` calibration (`CURSOR_ENTER_AT` kept). */
export const MOVIE_CUES = {
  typeStart: 300,
  sent: 2_600,
  reasoning: 3_000,
  readStart: 3_400,
  readDone: 4_200,
  searchStart: 4_400,
  searchDone: 5_200,
  submitted: 5_600,
  planReady: 6_200,
  approve: 8_600,
  approvedText: 9_200,
  manifestStart: 9_600,
  manifestDone: 10_200,
  serverStart: 10_400,
  serverDone: 11_200,
  clientStart: 11_400,
  clientDone: 12_200,
  previewStart: 12_400,
  previewDone: 13_000,
  slateOpen: 13_400,
  finalText: 13_800,
  end: 15_400,
} as const;

export const MOVIE_END = MOVIE_CUES.end;

/** Everything the cursor can point at. Resolved to pixels by the frame. */
export type MovieTarget = 'cursor-origin' | 'composer' | 'approve' | 'slate-tab';

interface CursorWaypoint {
  readonly at: number;
  readonly target: MovieTarget;
  readonly click: boolean;
}

/** The cursor dwells on a target, then travels for `CURSOR_TRAVEL_MS` ending
 *  exactly at the next waypoint's `at`. Clicks land on arrival. */
const CURSOR_TRAVEL_MS = 700;
const CURSOR_PRESS_MS = 180;
const CURSOR_RIPPLE_MS = 420;
export const CURSOR_ENTER_AT = 4_700;

const CURSOR_WAYPOINTS: readonly CursorWaypoint[] = [
  { at: CURSOR_ENTER_AT, target: 'cursor-origin', click: false },
  { at: MOVIE_CUES.submitted, target: 'composer', click: false },
  { at: MOVIE_CUES.approve, target: 'approve', click: true },
  { at: MOVIE_CUES.finalText, target: 'slate-tab', click: false },
] as const;

export interface MovieCursor {
  readonly visible: boolean;
  /** Where the cursor is coming from and going to, plus eased progress 0..1. */
  readonly from: MovieTarget;
  readonly to: MovieTarget;
  readonly progress: number;
  /** Target currently held pressed, if a click just landed. */
  readonly pressed: MovieTarget | null;
  /** Click ripple on `to`, progress 0..1, or null when none is live. */
  readonly ripple: number | null;
}

function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - ((-2 * x + 2) ** 3) / 2;
}

export function cursorAt(t: number): MovieCursor {
  const first = CURSOR_WAYPOINTS[0];
  const last = CURSOR_WAYPOINTS[CURSOR_WAYPOINTS.length - 1];
  if (first === undefined || last === undefined) throw new Error('empty cursor waypoints');
  if (t < first.at || t >= MOVIE_END) {
    return { visible: false, from: first.target, to: first.target, progress: 1, pressed: null, ripple: null };
  }
  let from = first;
  let to = first;
  for (const waypoint of CURSOR_WAYPOINTS) {
    if (waypoint.at <= t) { from = waypoint; to = waypoint; continue; }
    to = waypoint;
    break;
  }
  const dwelling = to === from || t <= to.at - CURSOR_TRAVEL_MS;
  const progress = dwelling
    ? 1
    : easeInOutCubic(Math.min(1, (t - (to.at - CURSOR_TRAVEL_MS)) / CURSOR_TRAVEL_MS));
  return {
    visible: true,
    from: from.target,
    to: dwelling ? from.target : to.target,
    progress,
    pressed: from.click && t - from.at < CURSOR_PRESS_MS ? from.target : null,
    ripple: from.click && t - from.at < CURSOR_RIPPLE_MS ? (t - from.at) / CURSOR_RIPPLE_MS : null,
  };
}

/* ── the story fixtures ─────────────────────────────────────────────────── */

export const MOVIE_ASK
  = 'Archived coupons still apply at checkout. Plan the fix, then build the support-queue dashboard.';

const PLAN_REASONING
  = 'Plan mode: I can read the handler and the tests, but not edit them. I need the order of the eligibility check and the cart write.';

const PLAN_READY_TEXT
  = 'The plan is ready for review. Approve it, or mark the lines that need to change.';

const APPROVED_TEXT
  = 'Plan r1 approved. Writing the support-queue slate now.';

const SLATE_DONE_TEXT
  = 'The dashboard is open in the Support queue tab. It reads issues through the ISSUES binding, which only reaches `list_issues` on your GitHub connection.';

/** The clean plan the movie submits: no annotations, so Approve is the live
 *  affordance and the cursor's click drives the same decision the product does. */
export const MOVIE_PLAN: PlanReview = {
  ...PLAN_FIXTURE,
  id: 'landing-movie-plan',
  annotations: [],
};

/** The composer's draft at `t`: the request typed out, then cleared on send. */
export function composerTextAt(t: number): string {
  if (t <= MOVIE_CUES.typeStart || t >= MOVIE_CUES.sent) return '';
  const done = (t - MOVIE_CUES.typeStart) / (MOVIE_CUES.sent - MOVIE_CUES.typeStart);
  return MOVIE_ASK.slice(0, Math.floor(done * MOVIE_ASK.length));
}

export type MoviePhase = 'asking' | 'investigating' | 'plan-review' | 'implementing' | 'done';

export interface MovieDiscrete {
  readonly phase: MoviePhase;
  readonly phaseLabel: string;
  readonly composerText: string;
  readonly messages: readonly UIMessage[];
  /** Null until the plan beat: appearing here is what "pops up automatically
   *  in right sidebar" means — the product's own plan view, fed a `PlanReview`. */
  readonly plan: PlanReview | null;
  readonly surface: MovieSurface;
  readonly slates: readonly SlateSummary[];
  readonly streaming: boolean;
  readonly settled: boolean;
}

/** How many cues have fired by `t` — the discrete-state cache key. A React
 *  memo keyed on this rebuilds messages only at beat boundaries, never per
 *  animation frame. */
export function cueCountAt(t: number): number {
  let count = 0;
  for (const at of Object.values(MOVIE_CUES)) if (at <= t) count += 1;
  return count;
}

type MoviePart = UIMessage['parts'][number];

interface ToolPartInit {
  readonly tool: string;
  readonly id: string;
  readonly startAt: number;
  readonly doneAt: number;
  readonly input: JsonObject;
  readonly output: JsonValue;
}

function toolPart(t: number, init: ToolPartInit): MoviePart | null {
  if (t < init.startAt) return null;
  if (t < init.doneAt) {
    return { type: `tool-${init.tool}`, toolCallId: init.id, state: 'input-available', input: init.input };
  }
  return { type: `tool-${init.tool}`, toolCallId: init.id, state: 'output-available', input: init.input, output: init.output };
}

function messagesAt(t: number): UIMessage[] {
  const messages: UIMessage[] = [];
  if (t >= MOVIE_CUES.sent) {
    messages.push({
      id: 'movie-user',
      role: 'user',
      parts: [{ type: 'text', text: MOVIE_ASK }],
    });
  }
  const investigation: MoviePart[] = [];
  if (t >= MOVIE_CUES.reasoning) investigation.push({ type: 'reasoning', text: PLAN_REASONING });
  const read = toolPart(t, {
    tool: 'file', id: 'movie-read',
    startAt: MOVIE_CUES.readStart, doneAt: MOVIE_CUES.readDone,
    input: { action: 'read', path: 'packages/checkout/src/apply-coupon.ts' },
    output: '…',
  });
  if (read !== null) investigation.push(read);
  const search = toolPart(t, {
    tool: 'file', id: 'movie-search',
    startAt: MOVIE_CUES.searchStart, doneAt: MOVIE_CUES.searchDone,
    input: { action: 'search', path: 'packages/checkout', query: 'coupon_ineligible' },
    output: '3 matches',
  });
  if (search !== null) investigation.push(search);
  if (t >= MOVIE_CUES.submitted) {
    investigation.push({
      type: 'tool-submit_plan', toolCallId: 'movie-submit', state: 'output-available',
      input: { edits: [{ start: 1, content: MOVIE_PLAN.content }] },
      output: { ok: true, revision: 1, status: 'pending', message: 'Plan submitted and awaiting review. Do not implement or produce a preview; end this turn now.' },
    });
    investigation.push({ type: 'text', text: PLAN_READY_TEXT });
  }
  if (investigation.length > 0) {
    messages.push({ id: 'movie-agent-plan', role: 'assistant', parts: investigation });
  }
  const build: MoviePart[] = [];
  if (t >= MOVIE_CUES.approvedText) build.push({ type: 'text', text: APPROVED_TEXT });
  for (const [id, path, startAt, doneAt] of [
    ['movie-manifest', '/home/user/slates/support-queue/package.json', MOVIE_CUES.manifestStart, MOVIE_CUES.manifestDone],
    ['movie-server', '/home/user/slates/support-queue/server.ts', MOVIE_CUES.serverStart, MOVIE_CUES.serverDone],
    ['movie-client', '/home/user/slates/support-queue/client.tsx', MOVIE_CUES.clientStart, MOVIE_CUES.clientDone],
  ] as const) {
    const write = toolPart(t, {
      tool: 'file', id, startAt, doneAt,
      input: { action: 'write', path },
      output: 'ok',
    });
    if (write !== null) build.push(write);
  }
  const preview = toolPart(t, {
    tool: 'execute_tools', id: 'movie-preview',
    startAt: MOVIE_CUES.previewStart, doneAt: MOVIE_CUES.previewDone,
    input: { code: "// Boot the preview and hand back its URL\nconst preview = await workspace.slate({ op: 'preview', id: 'support-queue' });\nreturn preview;" },
    output: JSON.stringify({ ok: true, value: { url: SLATE_PREVIEW_URL, port: 8789 } }),
  });
  if (preview !== null) build.push(preview);
  if (t >= MOVIE_CUES.finalText) build.push({ type: 'text', text: SLATE_DONE_TEXT });
  if (build.length > 0) {
    messages.push({ id: 'movie-agent-build', role: 'assistant', parts: build });
  }
  return messages;
}

interface MoviePhaseLabel {
  readonly phase: MoviePhase;
  readonly label: string;
}

function phaseAt(t: number): MoviePhaseLabel {
  if (t >= MOVIE_END) return { phase: 'done', label: 'Done' };
  if (t >= MOVIE_CUES.approve) return { phase: 'implementing', label: 'Implementing' };
  if (t >= MOVIE_CUES.planReady) return { phase: 'plan-review', label: 'Plan review' };
  if (t >= MOVIE_CUES.reasoning) return { phase: 'investigating', label: 'Investigating' };
  return { phase: 'asking', label: 'New task' };
}

export function discreteAt(t: number): MovieDiscrete {
  const { phase, label } = phaseAt(t);
  return {
    phase,
    phaseLabel: label,
    composerText: composerTextAt(t),
    messages: messagesAt(t),
    plan: t >= MOVIE_CUES.planReady ? MOVIE_PLAN : null,
    surface: t >= MOVIE_CUES.slateOpen ? `${SLATE_PREFIX}${SLATE_SUMMARY.id}` : 'Work',
    slates: t >= MOVIE_CUES.previewDone ? [SLATE_SUMMARY] : [],
    streaming: (t >= MOVIE_CUES.reasoning && t < MOVIE_CUES.submitted)
      || (t >= MOVIE_CUES.approvedText && t < MOVIE_CUES.finalText),
    settled: t >= MOVIE_END,
  };
}

/** The movie's deterministic drive, installed on `window` by the plan frame.
 *  The public-page tests drive the SAME timeline through it — never a second
 *  copy of the story. */
export interface LandingMovieHandle {
  readonly duration: number;
  readonly cues: typeof MOVIE_CUES;
  /** Jump the timeline. Resolves once the beat's DOM is settled — the plan
   *  chunk mounted, the approve click decided where the beat expects it — so
   *  a caller can assert immediately. */
  seek(at: number): Promise<void>;
  play(): void;
  pause(): void;
  state(): { t: number; playing: boolean; settled: boolean };
}

declare global {
  interface Window {
    __kinuLandingMovie?: LandingMovieHandle;
  }
}
