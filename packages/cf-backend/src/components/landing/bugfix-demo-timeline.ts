/**
 * The bug-fix demo's one typed timeline.
 *
 * Everything the demo shows is a pure function of elapsed milliseconds `t`:
 * the transcript, the plan review, the candidate race, and the cursor. The
 * live landing component plays `t` forward; the capture script and the
 * public-page tests seek `t` directly through the same window handle. There
 * is no second copy of the story anywhere — the README animation is a
 * screenshot series of this timeline.
 */
import type { UIMessage } from 'ai';
import type { JsonObject } from '@kinu.run/core';

/** Named beats, in absolute demo milliseconds. Order is the story. */
export const DEMO_CUES = {
  userAsk: 300,
  reasoning: 1_000,
  curlStart: 1_700,
  curlDone: 2_500,
  sqlStart: 2_800,
  sqlDone: 3_600,
  rootCauseText: 4_000,
  planReady: 4_700,
  planOpen: 5_600,
  annotation: 6_900,
  requestChanges: 8_600,
  planRevised: 9_600,
  approve: 11_000,
  backToChat: 11_900,
  candidatesAppear: 12_400,
  candidateARun: 12_700,
  candidateBRun: 12_900,
  candidateCRun: 13_100,
  candidateAFail: 13_600,
  candidateBFail: 14_400,
  candidateCPass: 15_200,
  patchLands: 15_900,
  testStart: 16_600,
  testDone: 17_600,
  finalText: 18_100,
  end: 19_600,
} as const;


export const DEMO_END = DEMO_CUES.end;

/** Everything the fake cursor can point at. Resolved to pixels by the stage. */
export type DemoTarget =
  | 'cursor-origin'
  | 'review-plan'
  | 'plan-line'
  | 'request-changes'
  | 'approve'
  | 'candidates'
  | 'tests';

interface CursorWaypoint {
  readonly at: number;
  readonly target: DemoTarget;
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
  { at: DEMO_CUES.planOpen, target: 'review-plan', click: true },
  { at: DEMO_CUES.annotation, target: 'plan-line', click: true },
  { at: DEMO_CUES.requestChanges, target: 'request-changes', click: true },
  { at: DEMO_CUES.approve, target: 'approve', click: true },
  { at: DEMO_CUES.candidatesAppear + 600, target: 'candidates', click: false },
  { at: DEMO_CUES.testDone + 400, target: 'tests', click: false },
] as const;

export interface DemoCursor {
  readonly visible: boolean;
  /** Where the cursor is coming from and going to, plus eased progress 0..1. */
  readonly from: DemoTarget;
  readonly to: DemoTarget;
  readonly progress: number;
  /** Target currently held pressed, if a click just landed. */
  readonly pressed: DemoTarget | null;
  /** Click ripple on `to`, progress 0..1, or null when none is live. */
  readonly ripple: number | null;
}

function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - ((-2 * x + 2) ** 3) / 2;
}

export function cursorAt(t: number): DemoCursor {
  const first = CURSOR_WAYPOINTS[0];
  const last = CURSOR_WAYPOINTS[CURSOR_WAYPOINTS.length - 1];
  if (first === undefined || last === undefined) throw new Error('empty cursor waypoints');
  if (t < first.at || t >= DEMO_END) {
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

const DEMO_ASK
  = 'The SAVE20 coupon started returning 500 after Tuesday\'s deploy. Find the cause and fix it.';

const REASONING
  = 'The failure is in /api/cart/apply. Reproduce it first, then read the coupon rows and the migration that shipped on Tuesday.';

const ROOT_CAUSE_TEXT
  = 'Migration 0042 backfilled `kind` for fixed coupons only. Percent rows kept `kind = NULL`, and `applyCoupon` throws on that branch. I will submit a fix plan for review.';

const APPROVED_TEXT
  = 'Plan r2 approved. Three candidate patches now run in parallel; the focused suite picks the one that lands.';

const FINAL_TEXT
  = 'Fixed. The migration now backfills `kind` from `coupon_catalog` and refuses rows without a catalog entry. All seven focused tests pass.';

const PLAN_R1 = `# Fix the SAVE20 coupon 500

## Root cause
Migration \`0042_coupon_kind.sql\` backfills \`kind\` for fixed coupons only. Percent rows keep \`kind = NULL\`, and \`applyCoupon\` throws on the NULL branch, so \`/api/cart/apply\` returns 500.

## Change
1. Patch the migration to backfill \`kind = 'percent'\` where \`value <= 100\`.
2. Add \`coupon-kind.test.ts\` covering both coupon kinds.
3. Verify with \`bun test packages/checkout\`. All seven focused cases must pass.
`;

const PLAN_R2 = `# Fix the SAVE20 coupon 500

## Root cause
Migration \`0042_coupon_kind.sql\` backfills \`kind\` for fixed coupons only. Percent rows keep \`kind = NULL\`, and \`applyCoupon\` throws on the NULL branch, so \`/api/cart/apply\` returns 500.

## Change
1. Backfill \`kind\` from \`coupon_catalog\` by coupon code.
2. Refuse backfill rows with no catalog entry, so drifted coupons surface instead of guessing.
3. Add \`coupon-kind.test.ts\` covering percent, fixed, and a missing catalog row.
4. Verify with \`bun test packages/checkout\`. All seven focused cases must pass.
`;

export interface DemoAnnotation {
  readonly id: string;
  /** The reviewer's note. */
  readonly note: string;
  /** Exact rendered-text substring of the r1 plan the note anchors to. */
  readonly anchor: string;
}

export const DEMO_ANNOTATION: DemoAnnotation = {
  id: 'demo-note-1',
  note: 'Do not infer kind from value. coupon_catalog still has the original kind; backfill from it.',
  anchor: "backfill kind = 'percent' where value <= 100",
};

export type DemoPlanStatus = 'pending' | 'changes_requested' | 'approved';

export interface DemoPlan {
  readonly open: boolean;
  readonly revision: 1 | 2;
  readonly status: DemoPlanStatus;
  readonly markdown: string;
  readonly annotations: readonly DemoAnnotation[];
}

export type DemoCandidateState = 'running' | 'failed' | 'passed';

export interface DemoCandidate {
  readonly id: string;
  readonly name: string;
  readonly approach: string;
  readonly state: DemoCandidateState;
  /** Focused-suite score once settled. */
  readonly result: string | null;
  readonly selected: boolean;
}

export type DemoPhase =
  | 'asking'
  | 'investigating'
  | 'plan-review'
  | 'revising'
  | 'implementing'
  | 'verifying'
  | 'done';

export interface DemoDiscrete {
  readonly phase: DemoPhase;
  readonly phaseLabel: string;
  readonly messages: readonly UIMessage[];
  readonly surface: 'chat' | 'plan';
  readonly plan: DemoPlan | null;
  readonly needsYou: 'hidden' | 'pending' | 'approved';
  readonly candidates: readonly DemoCandidate[] | null;
  readonly patchLanded: boolean;
  readonly testsSettled: boolean;
  readonly settled: boolean;
}

/** How many cues have fired by `t` — the discrete-state cache key. A React
 *  memo keyed on this rebuilds messages only at beat boundaries, never per
 *  animation frame. */
export function cueCountAt(t: number): number {
  let count = 0;
  for (const at of Object.values(DEMO_CUES)) if (at <= t) count += 1;
  return count;
}

type DemoPart = UIMessage['parts'][number];

interface ToolPartInit {
  readonly tool: string;
  readonly id: string;
  readonly startAt: number;
  readonly doneAt: number;
  readonly input: JsonObject;
  readonly output: string;
}

function toolPart(t: number, init: ToolPartInit): DemoPart | null {
  if (t < init.startAt) return null;
  if (t < init.doneAt) {
    return { type: `tool-${init.tool}`, toolCallId: init.id, state: 'input-available', input: init.input };
  }
  return { type: `tool-${init.tool}`, toolCallId: init.id, state: 'output-available', input: init.input, output: init.output };
}

const CURL_PART: ToolPartInit = {
  tool: 'run',
  id: 'demo-curl',
  startAt: DEMO_CUES.curlStart,
  doneAt: DEMO_CUES.curlDone,
  input: { runtime: 'workspace', command: "curl -si -X POST localhost:8788/api/cart/apply -d '{\"code\":\"SAVE20\"}'" },
  output: 'HTTP/1.1 500 Internal Server Error\n{"error":"internal"}',
};

const SQL_PART: ToolPartInit = {
  tool: 'execute_tools',
  id: 'demo-sql',
  startAt: DEMO_CUES.sqlStart,
  doneAt: DEMO_CUES.sqlDone,
  input: { code: "// Which coupon rows lost their kind?\nconst rows = await sql`SELECT code, kind, value FROM coupons WHERE code = 'SAVE20'`;\nreturn rows;" },
  output: '[{"code":"SAVE20","kind":null,"value":20}]',
};

const EDIT_PART: ToolPartInit = {
  tool: 'file',
  id: 'demo-edit',
  startAt: DEMO_CUES.patchLands,
  doneAt: DEMO_CUES.patchLands,
  input: { action: 'edit', path: 'packages/checkout/migrations/0042_coupon_kind.sql', edits: [{}] },
  output: 'saved',
};

const TEST_PART: ToolPartInit = {
  tool: 'run',
  id: 'demo-test',
  startAt: DEMO_CUES.testStart,
  doneAt: DEMO_CUES.testDone,
  input: { runtime: 'workspace', command: 'bun test packages/checkout' },
  output: '7 pass, 0 fail (612ms)',
};

function messagesAt(t: number): UIMessage[] {
  const messages: UIMessage[] = [];
  if (t >= DEMO_CUES.userAsk) {
    messages.push({
      id: 'demo-user',
      role: 'user',
      parts: [{ type: 'text', text: DEMO_ASK }],
    });
  }
  const investigation: DemoPart[] = [];
  if (t >= DEMO_CUES.reasoning) investigation.push({ type: 'reasoning', text: REASONING });
  const curl = toolPart(t, CURL_PART);
  if (curl !== null) investigation.push(curl);
  const sql = toolPart(t, SQL_PART);
  if (sql !== null) investigation.push(sql);
  if (t >= DEMO_CUES.rootCauseText) investigation.push({ type: 'text', text: ROOT_CAUSE_TEXT });
  if (investigation.length > 0) {
    messages.push({ id: 'demo-agent-1', role: 'assistant', parts: investigation });
  }
  const landing: DemoPart[] = [];
  if (t >= DEMO_CUES.backToChat) landing.push({ type: 'text', text: APPROVED_TEXT });
  const edit = toolPart(t, EDIT_PART);
  if (edit !== null) landing.push(edit);
  const test = toolPart(t, TEST_PART);
  if (test !== null) landing.push(test);
  if (t >= DEMO_CUES.finalText) landing.push({ type: 'text', text: FINAL_TEXT });
  if (landing.length > 0) {
    messages.push({ id: 'demo-agent-2', role: 'assistant', parts: landing });
  }
  return messages;
}

function planAt(t: number): DemoPlan | null {
  if (t < DEMO_CUES.planReady) return null;
  const open = t >= DEMO_CUES.planOpen && t < DEMO_CUES.backToChat;
  if (t >= DEMO_CUES.planRevised) {
    return {
      open,
      revision: 2,
      status: t >= DEMO_CUES.approve ? 'approved' : 'pending',
      markdown: PLAN_R2,
      annotations: [],
    };
  }
  return {
    open,
    revision: 1,
    status: t >= DEMO_CUES.requestChanges ? 'changes_requested' : 'pending',
    markdown: PLAN_R1,
    annotations: t >= DEMO_CUES.annotation ? [DEMO_ANNOTATION] : [],
  };
}

function candidatesAt(t: number): readonly DemoCandidate[] | null {
  if (t < DEMO_CUES.candidatesAppear) return null;
  const candidate = (
    id: string,
    name: string,
    approach: string,
    settleAt: number,
    result: string,
    passed: boolean,
  ): DemoCandidate => ({
    id,
    name,
    approach,
    state: t < settleAt ? 'running' : passed ? 'passed' : 'failed',
    result: t < settleAt ? null : result,
    selected: passed && t >= settleAt,
  });
  return [
    candidate('a', 'update-join', 'single UPDATE joining the catalog', DEMO_CUES.candidateAFail, '6/7', false),
    candidate('b', 'guard-only', 'guard the NULL branch in applyCoupon', DEMO_CUES.candidateBFail, '5/7', false),
    candidate('c', 'join-and-refuse', 'backfill from catalog, refuse missing rows', DEMO_CUES.candidateCPass, '7/7', true),
  ];
}

interface DemoPhaseLabel {
  readonly phase: DemoPhase;
  readonly label: string;
}

function phaseAt(t: number): DemoPhaseLabel {
  if (t >= DEMO_END) return { phase: 'done', label: 'Done · 7/7' };
  if (t >= DEMO_CUES.testStart) return { phase: 'verifying', label: 'Verifying' };
  if (t >= DEMO_CUES.approve) return { phase: 'implementing', label: 'Implementing' };
  if (t >= DEMO_CUES.requestChanges) return { phase: 'revising', label: 'Revising the plan' };
  if (t >= DEMO_CUES.planReady) return { phase: 'plan-review', label: 'Plan review' };
  if (t >= DEMO_CUES.reasoning) return { phase: 'investigating', label: 'Investigating' };
  return { phase: 'asking', label: 'New task' };
}

export function discreteAt(t: number): DemoDiscrete {
  const { phase, label } = phaseAt(t);
  const plan = planAt(t);
  return {
    phase,
    phaseLabel: label,
    messages: messagesAt(t),
    surface: plan?.open === true ? 'plan' : 'chat',
    plan,
    needsYou: t < DEMO_CUES.planReady ? 'hidden' : t >= DEMO_CUES.approve ? 'approved' : 'pending',
    candidates: candidatesAt(t),
    patchLanded: t >= DEMO_CUES.patchLands,
    testsSettled: t >= DEMO_CUES.testDone,
    settled: t >= DEMO_END,
  };
}

/** One frame of the README capture: seek to `at`, screenshot, and give the
 *  frame `holdMs` of animation time. */
export interface DemoCaptureFrame {
  readonly at: number;
  readonly holdMs: number;
}

/** The capture plan the film script executes. Dense while the cursor travels
 *  or a beat just landed, sparse through holds — derived from the same cue
 *  and waypoint tables the live demo plays, so the asset cannot drift. The
 *  cadence is a budget: every frame is ~20 KB of animated WebP, and the whole
 *  asset must stay under the README's 2 MB ceiling. */
export function captureFrames(): readonly DemoCaptureFrame[] {
  const stamps = new Set<number>();
  for (let at = 0; at < DEMO_END; at += 560) stamps.add(at);
  for (const at of Object.values(DEMO_CUES)) stamps.add(Math.min(at + 40, DEMO_END));
  for (const waypoint of CURSOR_WAYPOINTS.slice(1)) {
    for (let at = Math.max(0, waypoint.at - CURSOR_TRAVEL_MS); at <= waypoint.at; at += 160) {
      stamps.add(at);
    }
    if (waypoint.click) stamps.add(waypoint.at + 200);
  }
  const ordered = [...stamps].filter((at) => at <= DEMO_END).sort((a, b) => a - b);
  return ordered.map((at, index) => {
    const next = ordered[index + 1];
    return { at, holdMs: next === undefined ? 2_600 : Math.max(30, next - at) };
  });
}

/** The live demo's deterministic drive, installed on `window` by the landing
 *  component. The public-page tests and the README capture script play the
 *  SAME timeline through it — never a second copy of the story. */
export interface BugFixDemoHandle {
  readonly duration: number;
  readonly cues: typeof DEMO_CUES;
  /** Jump the timeline. Resolves once the beat's DOM is settled — the plan
   *  chunk mounted and the annotation highlight painted where the beat
   *  expects them — so a caller can screenshot immediately. */
  seek(at: number): Promise<void>;
  play(): void;
  pause(): void;
  state(): { t: number; playing: boolean; settled: boolean };
  captureFrames(): readonly DemoCaptureFrame[];
}

declare global {
  interface Window {
    __kinuBugfixDemo?: BugFixDemoHandle;
  }
}
