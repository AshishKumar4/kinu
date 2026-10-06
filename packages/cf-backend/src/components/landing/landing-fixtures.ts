/** Fixture state for the landing page's frames, which mount the product's own components.
 *  Nothing here is served; only the install command comes from the deployment. */
import type { UIMessage } from 'ai';
import * as v from 'valibot';
import { JsonValueSchema, SubordinateInspectionRequestSchema, type JsonValue, type PanelAgent, type PendingAction, type PlanReview, type SlateSummary, type TabPresence } from '@kinu.run/core';
import type { Rpc } from '@kinu.run/core';
import type { BackgroundJob } from '@kinu.run/core/protocol';
import type { ModelMenuEntry, RosterPage, UserProfile } from '@/lib/user-api';

const NOW = Date.now();

/** A declared interface never satisfies `JsonValue`'s index signature, so product types are named. */
type FixtureReply =
  | JsonValue
  | undefined
  | BackgroundJob
  | PlanReview
  | readonly FixtureReply[]
  | { readonly [field: string]: FixtureReply };

/** Round-trips through JSON as a real RPC would. */
function answer<T>(value: FixtureReply): Promise<T> {
  return new Response(JSON.stringify(v.parse(JsonValueSchema, value))).json<T>();
}

const JobIdArgsSchema = v.tuple([v.string()]);

const DecideArgsSchema = v.tuple([v.string(), v.number(), v.picklist(['request_changes', 'approve']), v.optional(v.string())]);

export const LANDING_MODEL = 'anthropic/claude-opus-4';

export const LANDING_MODELS: ModelMenuEntry[] = [
  { spec: LANDING_MODEL, label: 'Claude Opus 4', provider: 'Anthropic' },
  { spec: 'workers-ai/llama-4', label: 'Llama 4 (Workers AI)', provider: 'Workers AI' },
];

export const LANDING_WORKSPACE = 'checkout-fixes';

/** No exploration runs, so `surfaceHasContent` hides Swarms. */
export const LANDING_TAB_PRESENCE: TabPresence = { explorations: false, work: true };

const NO_FIGURES = { activeMs: 0, cacheEma: null };

/** A project's day-to-day chats. */
export const LANDING_CHATS: readonly PanelAgent[] = [
  { key: 'main', label: 'Main', category: 'main', activity: 'working', parent: null, open: { kind: 'chat', path: null }, tab: true, input: true, figures: NO_FIGURES },
  { key: 'actor-gift-cards', label: 'Should checkout support gift cards?', category: 'user', activity: 'waiting', parent: 'main', open: { kind: 'chat', path: 'gift-cards' }, tab: true, input: true, figures: NO_FIGURES },
  { key: 'actor-cart', label: 'Speed up cart render', category: 'user', activity: 'working', parent: 'main', open: { kind: 'chat', path: 'cart-render' }, tab: true, input: true, figures: NO_FIGURES },
];

/** Served by the `landing.tsx` fetch shim; the frame's workspace is first so the rail marks it open. */
const QUIET = { activity: 'idle', decisionsWaiting: 0, hasUpdates: false, latestRun: null } as const;

export const LANDING_ROSTER = {
  entries: [
    { name: 'checkout-fixes', displayName: 'Storefront', createdAt: NOW - 7 * 864e5, lastVisited: NOW - 60e3 },
    { name: 'perf-audit', displayName: 'Dew', createdAt: NOW - 3 * 864e5, lastVisited: NOW - 2 * 36e5 },
    { name: 'email-triage', displayName: 'Support inbox', createdAt: NOW - 30 * 864e5, lastVisited: NOW - 864e5 },
  ].map((entry) => ({ ...entry, overview: { ...QUIET, slates: [], shares: [] }, decisions: 0 })),
  total: 3,
  nextCursor: null,
  counts: { all: 3, needs: 0, working: 0, idle: 3, unreported: 0, decisions: 0 },
} satisfies RosterPage;

/** workspaceCount must equal the roster's total: the gate reads both. */
export const LANDING_PROFILE: UserProfile = {
  email: 'ashish@example.com',
  displayName: 'Ashish',
  createdAt: NOW - 90 * 864e5,
  lastSeenAt: NOW,
  onboardedAt: NOW - 90 * 864e5,
  workspaceCount: LANDING_ROSTER.total,
};

export const CHECKOUT_FRAME_CAPTION = 'Sample workspace';

export const CHECKOUT_MESSAGES: UIMessage[] = [
  {
    id: 'landing-checkout-user',
    role: 'user',
    parts: [{ type: 'text', text: 'Audit the checkout flow, find why the SAVE20 coupon 500s, and fix it. Deploy to staging when green.' }],
  },
  {
    id: 'landing-checkout-agent',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Fixed the SAVE20 coupon 500 — migration 0042 patched, 14 tests green.' },
      { type: 'tool-run', toolCallId: 'landing-run', state: 'output-available', input: { runtime: 'sandbox', command: "curl -s -X POST localhost:8788/api/cart/apply -d '{\"code\":\"SAVE20\"}'" }, output: 'HTTP 500' },
      { type: 'tool-eval', toolCallId: 'landing-query', state: 'output-available', input: { code: '// Inspect coupon rows to find the missing kind\nconst rows = await sql`SELECT code, kind, value FROM coupons`;\nreturn rows;' }, output: '[{"code":"SAVE20","kind":null,"value":20}]' },
      { type: 'tool-file', toolCallId: 'landing-read', state: 'output-available', input: { action: 'read', path: 'packages/checkout/migrations/0042_coupon_kind.sql' }, output: '…' },
      { type: 'tool-file', toolCallId: 'landing-edit', state: 'output-error', input: { action: 'edit', path: 'packages/checkout/migrations/0042_coupon_kind.sql', edits: [{}, {}] }, errorText: 'old_text not found or not unique' },
      { type: 'tool-file', toolCallId: 'landing-reread', state: 'output-available', input: { action: 'read', path: 'packages/checkout/migrations/0042_coupon_kind.sql' }, output: '…' },
      { type: 'tool-file', toolCallId: 'landing-patch', state: 'output-available', input: { action: 'edit', path: 'packages/checkout/migrations/0042_coupon_kind.sql', edits: [{ old_text: "WHERE kind = 'fixed'", new_text: 'WHERE kind IS NULL' }] }, output: 'ok' },
      { type: 'tool-file', toolCallId: 'landing-write', state: 'output-available', input: { action: 'write', path: 'packages/checkout/tests/coupon-kind.test.ts' }, output: 'ok' },
      { type: 'tool-run', toolCallId: 'landing-tests', state: 'output-available', input: { runtime: 'sandbox', command: 'bun test packages/checkout --filter coupon' }, output: '14 passed' },
      { type: 'tool-tasks', toolCallId: 'landing-task', state: 'output-available', input: { action: 'update', id: 't4', status: 'done' }, output: 'ok' },
    ],
  },
];

const CHECKOUT_TASKS = [
  { id: 't1', parentId: null, title: 'Reproduce the SAVE20 coupon 500', status: 'done', updatedAt: NOW - 44e5, note: null, subtasks: [] },
  {
    id: 't2', parentId: null, title: 'Patch the coupon kind backfill', status: 'active', updatedAt: NOW - 8e5, note: null,
    subtasks: [
      { id: 't5', parentId: 't2', title: 'Backfill kind for percentage coupons', status: 'done', updatedAt: NOW - 21e5, note: null },
      { id: 't6', parentId: 't2', title: 'Re-run the migration on a copy', status: 'active', updatedAt: NOW - 6e5, note: null },
    ],
  },
  { id: 't3', parentId: null, title: 'Deploy to staging when the suite is green', status: 'open', updatedAt: NOW - 52e5, note: null, subtasks: [] },
  { id: 't4', parentId: null, title: 'Add a regression test for the percentage case', status: 'done', updatedAt: NOW - 4e5, note: null, subtasks: [] },
];

const LANDING_OWNER = { actorId: 'actor-main', name: 'main', title: 'main', retired: false, path: [] };

const CHECKOUT_CHANGELOG = {
  seenAt: NOW - 30e5,
  unseenCount: 0,
  entries: [
    { id: 'cl_1', kind: 'tool', at: NOW - 26e5, scaffoldVersion: null, revert: true, summary: 'Learned a tool: coupon_replay', evidence: 'extracted from 3 successful turns · quality 0.61' },
    { id: 'cl_2', kind: 'fact', at: NOW - 50e5, scaffoldVersion: null, revert: true, summary: "Remembered: percentage coupons carry kind:null after Tuesday's migration", evidence: null },
  ],
};

const CHECKOUT_JOBS: BackgroundJob[] = [
  { id: 'bgjob-7c1e4a92', kind: 'eval', label: 'bun test packages/checkout', workMode: 'build', status: 'running', result: null, error: null, createdAt: NOW - 9e5, settledAt: null },
  { id: 'bgjob-9d3c6e11', kind: 'shell', label: 'bun test packages/checkout --filter coupon', workMode: 'build', status: 'failed', result: null, error: 'exit 1: 2 failed — percentage coupons still read kind:null', createdAt: NOW - 61e5, settledAt: NOW - 58e5 },
];

const CHECKOUT_PENDING: PendingAction[] = [
  { id: 'defer-coupon-kind', kind: 'deferred_action', at: NOW - 3e5, title: 'Approve: a command the agent wants to run on device', detail: 'bun run db:migrate 0042' },
];

export interface WorkFixture {
  readonly rpc: Rpc;
  readonly jobs: () => BackgroundJob[];
  readonly pending: () => PendingAction[];
}

export function checkoutWorkFixture(onChange: () => void): WorkFixture {
  let jobs = CHECKOUT_JOBS;
  let pending = CHECKOUT_PENDING;

  const rpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
    if (method === 'getExecutorDiff') return answer({ files: [], mode: 'vfs-baseline' });

    if (method === 'inspectSubordinate') {
      const request = v.parse(SubordinateInspectionRequestSchema, args?.[0]);

      return answer({ view: request.view, path: request.path, page: { status: 'end', items: [] } });
    }

    if (method === 'listWorkspaceWork') return answer({ plans: [], tasks: [{ owner: LANDING_OWNER, plan: null, tasks: CHECKOUT_TASKS }] });

    if (method === 'getEvolutionChangelog') return answer(CHECKOUT_CHANGELOG);

    if (method === 'listBackgroundJobs') return answer(jobs);

    if (method === 'retryBackgroundJob' || method === 'dismissBackgroundJob') {
      const named = v.safeParse(JobIdArgsSchema, args);

      if (!named.success) return answer({ ok: false, error: 'no job named' });
      const [id] = named.output;
      const retryId = `bgjob-${id.slice(-8)}r`;
      jobs = method === 'retryBackgroundJob'
        ? [
          ...jobs.map((job) => (job.id === id ? { ...job, retriedBy: retryId } : job)),
          { id: retryId, kind: 'shell', label: 'wrangler deploy --env staging --dry-run', workMode: 'build', status: 'running', result: null, error: null, createdAt: Date.now(), settledAt: null },
        ]
        : jobs.filter((job) => job.id !== id);
      pending = pending.filter((action) => action.id !== id);
      onChange();

      return answer({ ok: true });
    }

    if (method === 'getExposedPorts') return answer({ ports: [] });

    if (method.startsWith('list') || method.startsWith('get')) return answer([]);

    return answer({ ok: true });
  };

  return { rpc, jobs: () => jobs, pending: () => pending };
}


const PLAN_MARKDOWN = `# Repair the \`applyCoupon\` eligibility guard

The checkout accepts archived coupons because the eligibility guard reads the campaign state after the discount has already been applied. This plan moves the guard ahead of mutation and keeps the current response contract.

## Scope

- Read the coupon and campaign in one transaction.
- Reject archived or expired campaigns before any cart row changes.
- Keep the existing error code for clients that already handle an ineligible coupon.

## Implementation

1. Move the eligibility check before the cart update in \`applyCoupon\`.
2. Return the existing \`coupon_ineligible\` result when the campaign is archived or expired.
3. Keep the route adapter unchanged; it already maps that result to the public response.

## Verification

- Run the focused checkout test with active, archived, and expired campaigns.
- Confirm that a refused coupon leaves the cart total and discount rows unchanged.`;

export const PLAN_FIXTURE: PlanReview = {
  id: 'landing-plan',
  sessionId: 'default',
  revision: 1,
  content: PLAN_MARKDOWN,
  status: 'pending',
  annotations: [{
    id: 'landing-plan-note',
    blockId: 'block-3',
    startOffset: 0,
    endOffset: 46,
    type: 'COMMENT',
    text: 'Read both rows with FOR UPDATE, or a second request can apply the same coupon.',
    originalText: 'Read the coupon and campaign in one transaction.',
    createdA: NOW - 6e4,
    author: 'You',
  }],
  feedback: null,
  handoffAccepted: false,
  createdAt: NOW - 3e5,
  updatedAt: NOW - 6e4,
};

/** `base` null means no plan submitted yet: the Plans read answers empty and annotations or
 *  decisions refuse rather than report a success. */
export function planRpc(onDecide: (plan: PlanReview) => void, base: PlanReview | null = PLAN_FIXTURE): Rpc {
  return async <T,>(method: string, args?: unknown[]): Promise<T> => {
    if (method === 'getExecutorDiff') return answer({ files: [], mode: 'vfs-baseline' });

    if (method === 'inspectSubordinate') {
      const request = v.parse(SubordinateInspectionRequestSchema, args?.[0]);

      if (request.view === 'planTasks') return answer({ view: 'planTasks', path: request.path, tasks: [] });

      return answer({ view: request.view, path: request.path, page: { status: 'end', items: request.view === 'plans' && base !== null ? [base] : [] } });
    }

    // Same plan as the pane, so the two cannot disagree about whether a plan exists.
    if (method === 'listWorkspaceWork') {
      return answer({
        plans: base === null ? [] : [{ owner: LANDING_OWNER, plan: base, tasks: [] }],
        tasks: [],
      });
    }

    if (method === 'getEvolutionChangelog') return answer({ seenAt: NOW, unseenCount: 0, entries: [] });

    if (method === 'savePlanReviewAnnotations') {
      if (base === null) return answer({ ok: false, error: 'no plan under review', plan: null });

      return answer({ ok: true, plan: base });
    }

    if (method === 'decidePlanReview') {
      const [, , decision, feedback] = v.parse(DecideArgsSchema, args);

      if (base === null) return answer({ ok: false, error: 'no plan under review', plan: null });

      const decided: PlanReview = {
        ...base,
        status: decision === 'approve' ? 'approved' : 'changes_requested',
        feedback: feedback ?? null,
        handoffAccepted: true,
        updatedAt: Date.now(),
      };

      onDecide(decided);

      return answer({ ok: true, plan: decided, queued: true });
    }

    if (method === 'dismissPlanReview') {
      if (base === null) return answer({ ok: false, error: 'no plan under review', plan: null });
      const dismissed: PlanReview = { ...base, status: 'dismissed', updatedAt: Date.now() };
      onDecide(dismissed);

      return answer({ ok: true, plan: dismissed });
    }

    if (method === 'getExposedPorts') return answer({ ports: [] });

    if (method.startsWith('list') || method.startsWith('get')) return answer([]);

    return answer({ ok: true });
  };
}

export const SLATE_SUMMARY: SlateSummary = { id: 'support-queue', title: 'Support queue', bindings: ['ISSUES'] };

/** Production preview hostname shape: `<port>-<sandbox>-<token>` under the app's zone. */
export const SLATE_PREVIEW_URL = 'https://8789-support-queue-sample.kinu.run/';

export const SLATE_MESSAGES: UIMessage[] = [
  {
    id: 'landing-slate-user',
    role: 'user',
    parts: [{ type: 'text', text: 'Build me a dashboard over the support tickets in the GitHub connection: open by label, weekly opened vs closed, and the oldest ones waiting.' }],
  },
  {
    id: 'landing-slate-agent',
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: 'A slate under /slates/support-queue with one MCP binding to the GitHub connection, narrowed to list_issues. The server fetches through env.ISSUES and the client draws the charts.' },
      { type: 'tool-file', toolCallId: 'landing-slate-manifest', state: 'output-available', input: { action: 'write', path: '/slates/support-queue/package.json' }, output: 'ok' },
      { type: 'tool-file', toolCallId: 'landing-slate-server', state: 'output-available', input: { action: 'write', path: '/slates/support-queue/server.ts' }, output: 'ok' },
      { type: 'tool-file', toolCallId: 'landing-slate-client', state: 'output-available', input: { action: 'write', path: '/slates/support-queue/client.tsx' }, output: 'ok' },
      { type: 'tool-eval', toolCallId: 'landing-slate-preview', state: 'output-available', input: { code: "// Boot the preview and hand back its URL\nreturn await workspace.slates['support-queue'].$preview();" }, output: JSON.stringify({ url: SLATE_PREVIEW_URL, port: 8789 }) },
      { type: 'text', text: 'The dashboard is open in the Support queue tab. It reads issues through the ISSUES binding, which only reaches `list_issues` on your GitHub connection.' },
    ],
  },
];
