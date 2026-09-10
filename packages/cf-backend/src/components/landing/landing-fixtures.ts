/**
 * Fixture state for the landing page's workspace frames. The frames mount the
 * product's own components (WorkspaceBar, SubordinateTabs, MessageView,
 * Composer, WorkSurface) and feed them this state the way `gallery.tsx` feeds
 * its frames: transcripts as `UIMessage`s, the Work tab through an in-memory
 * `Rpc`, and a plan review as a `PlanReview` row.
 *
 * Nothing here is served. The install command is the only string on the
 * landing page that comes from the deployment.
 */
import type { UIMessage } from 'ai';
import * as v from 'valibot';
import { JsonValueSchema, SubordinateInspectionRequestSchema, seekPage, type PageRequest, type PendingAction, type PlanReview, type RunSummary, type SlateSummary } from '@kinu.run/core';
import type { BackgroundJob, Rpc, SubordinateRosterEntry } from '@/lib/protocol';
import type { ModelMenuEntry, UserProfile, WorkspaceEntry } from '@/lib/user-api';

const NOW = Date.now();

/** `retryBackgroundJob(id)` and `dismissBackgroundJob(id)`, as the Work tab calls them. */
const JobIdArgsSchema = v.tuple([v.string()]);
/** `decidePlanReview(planId, revision, decision, feedback?)`, as the plan review calls it. */
const DecideArgsSchema = v.tuple([v.string(), v.number(), v.picklist(['request_changes', 'approve']), v.optional(v.string())]);

export const LANDING_MODEL = 'anthropic/claude-opus-4';
export const LANDING_MODELS: ModelMenuEntry[] = [
  { spec: LANDING_MODEL, label: 'Claude Opus 4', provider: 'Anthropic' },
  { spec: 'workers-ai/llama-4', label: 'Llama 4 (Workers AI)', provider: 'Workers AI' },
];
export const LANDING_WORKSPACE = 'checkout-fixes';

export const LANDING_SUBORDINATES: readonly SubordinateRosterEntry[] = [
  { name: 'coupon-tester', displayName: 'Coupon tester', role: 'QA', createdBy: 'orchestrator', status: 'working', currentTask: 'Running the checkout regression suite', createdAt: NOW - 36e5, dismissedAt: null },
  { name: 'migration-review', displayName: 'Migration review', role: 'Reviewer', createdBy: 'orchestrator', status: 'awaiting_input', currentTask: 'Needs a call on the backfill order', createdAt: NOW - 72e5, dismissedAt: null },
];

/**
 * The rail's roster, answered the way `gallery.tsx` answers it: the same
 * entries the app lists, with the frame's workspace first so the rail marks
 * the open one. Served by the `landing.tsx` fetch shim, read through the
 * real `listWorkspaces` transport and `WorkspaceRosterProvider`.
 */
export const LANDING_ROSTER = {
  entries: [
    { name: 'checkout-fixes', displayName: 'Checkout coupon bug', createdAt: NOW - 7 * 864e5, lastVisited: NOW - 60e3, archivedAt: null },
    { name: 'perf-audit', displayName: 'Perf audit — landing', createdAt: NOW - 3 * 864e5, lastVisited: NOW - 2 * 36e5, archivedAt: null },
    { name: 'email-triage', displayName: 'Email triage automation', createdAt: NOW - 30 * 864e5, lastVisited: NOW - 864e5, archivedAt: null },
  ],
  total: 3,
} satisfies { entries: WorkspaceEntry[]; total: number };

/** The rail's user row, served by the same shim and read through `getProfile`. */
export const LANDING_PROFILE: UserProfile = {
  email: 'ashish@example.com',
  displayName: 'Ashish',
  createdAt: NOW - 90 * 864e5,
  lastSeenAt: NOW,
};

/* ── The checkout workspace: a Build turn, mid-fix ─────────────────────── */

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
      { type: 'reasoning', text: 'The coupon path goes through /api/cart/apply. I should reproduce first, then inspect the handler and migration.' },
      { type: 'tool-run', toolCallId: 'landing-run', state: 'output-available', input: { runtime: 'sandbox', command: "curl -s -X POST localhost:8788/api/cart/apply -d '{\"code\":\"SAVE20\"}'" }, output: 'HTTP 500' },
      { type: 'tool-execute_tools', toolCallId: 'landing-query', state: 'output-available', input: { code: '// Inspect coupon rows to find the missing kind\nconst rows = await sql`SELECT code, kind, value FROM coupons`;\nreturn rows;' }, output: '[{"code":"SAVE20","kind":null,"value":20}]' },
      { type: 'text', text: "Tuesday's migration backfilled `kind` for fixed coupons only. I will patch the migration, add a regression test, and run the focused suite." },
      { type: 'tool-file', toolCallId: 'landing-read', state: 'output-available', input: { action: 'read', path: 'packages/checkout/migrations/0042_coupon_kind.sql' }, output: '…' },
      { type: 'tool-file', toolCallId: 'landing-edit', state: 'output-error', input: { action: 'edit', path: 'packages/checkout/migrations/0042_coupon_kind.sql', edits: [{}, {}] }, errorText: 'old_text not found or not unique' },
      { type: 'tool-file', toolCallId: 'landing-write', state: 'output-available', input: { action: 'write', path: 'packages/checkout/tests/coupon-kind.test.ts' }, output: 'ok' },
      { type: 'tool-tasks', toolCallId: 'landing-task', state: 'output-available', input: { action: 'update', id: 't4', status: 'done' }, output: 'ok' },
    ],
  },
];

const CHECKOUT_TASKS = [
  { id: 't1', parentId: null, title: 'Reproduce the SAVE20 coupon 500', status: 'done', createdAt: NOW - 52e5, updatedAt: NOW - 44e5, subtasks: [] },
  {
    id: 't2', parentId: null, title: 'Patch the coupon kind backfill', status: 'active', createdAt: NOW - 52e5, updatedAt: NOW - 8e5,
    subtasks: [
      { id: 't5', parentId: 't2', title: 'Backfill kind for percentage coupons', status: 'done', createdAt: NOW - 30e5, updatedAt: NOW - 21e5 },
      { id: 't6', parentId: 't2', title: 'Re-run the migration on a copy', status: 'active', createdAt: NOW - 30e5, updatedAt: NOW - 6e5 },
    ],
  },
  { id: 't3', parentId: null, title: 'Deploy to staging when the suite is green', status: 'open', createdAt: NOW - 52e5, updatedAt: NOW - 52e5, subtasks: [] },
  { id: 't4', parentId: null, title: 'Add a regression test for the percentage case', status: 'done', createdAt: NOW - 52e5, updatedAt: NOW - 4e5, subtasks: [] },
];

const CHECKOUT_CHANGELOG = {
  seenAt: NOW - 30e5,
  unseenCount: 0,
  entries: [
    { id: 'cl_1', kind: 'tool', at: NOW - 26e5, scaffoldVersion: null, revert: true, summary: 'Learned a tool: coupon_replay', evidence: 'extracted from 3 successful turns · quality 0.61' },
    { id: 'cl_2', kind: 'fact', at: NOW - 50e5, scaffoldVersion: null, revert: true, summary: "Remembered: percentage coupons carry kind:null after Tuesday's migration", evidence: null },
  ],
};

const CHECKOUT_JOBS: BackgroundJob[] = [
  { id: 'bgjob-7c1e4a92', kind: 'execute_tools', label: 'bun test packages/checkout', workMode: 'build', status: 'running', result: null, error: null, createdAt: NOW - 9e5, settledAt: null },
  { id: 'bgjob-9d3c6e11', kind: 'run', label: 'wrangler deploy --env staging --dry-run', workMode: 'build', status: 'failed', result: null, error: 'exit 1: binding VECTORIZE not found in wrangler.jsonc', createdAt: NOW - 61e5, settledAt: NOW - 58e5 },
];

const CHECKOUT_PENDING: PendingAction[] = [
  { id: 'bgjob-9d3c6e11', kind: 'failed_job', at: NOW - 58e5, title: 'run failed', detail: 'exit 1: binding VECTORIZE not found in wrangler.jsonc' },
];

/** The Work tab's state, held in memory so its controls do what they do in the
 *  product: a failed job's Retry records a retry, a decision leaves the queue. */
export interface WorkFixture {
  readonly rpc: Rpc;
  readonly jobs: () => BackgroundJob[];
  readonly pending: () => PendingAction[];
}

export function checkoutWorkFixture(onChange: () => void): WorkFixture {
  let jobs = CHECKOUT_JOBS;
  let pending = CHECKOUT_PENDING;
  const rpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
    const answer = <Value,>(value: Value): Promise<T> => new Response(JSON.stringify(v.parse(JsonValueSchema, value))).json<T>();
    if (method === 'getExecutorDiff') return answer({ files: [], mode: 'vfs-baseline' });
    if (method === 'inspectSubordinate') {
      const request = v.parse(SubordinateInspectionRequestSchema, args?.[0]);
      return answer({ view: request.view, path: request.path, page: { status: 'end', items: [] } });
    }
    if (method === 'listAgentTasks') return answer(CHECKOUT_TASKS);
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
          { id: retryId, kind: 'run', label: 'wrangler deploy --env staging --dry-run', workMode: 'build', status: 'running', result: null, error: null, createdAt: Date.now(), settledAt: null },
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

/* ── The Supervise altitude: curriculum, run history, evolution, automations ─ */

const SUPERVISE_TASKS = [
  {
    id: 'cur_1', task: 'Learn the checkout coupon schema well enough to fix the kind:null regression',
    rationale: 'Three of the last five failures traced back to the same migration.',
    predictedSuccess: 0.72, targetsSkills: ['sql', 'regression-triage'], proposedAt: NOW - 2 * 36e5, status: 'pending',
  },
  {
    id: 'cur_2', task: 'Write a smoke check for the deploy-failed webhook',
    rationale: 'The trigger has fired 41 times and nothing asserts its shape.',
    predictedSuccess: 0.44, targetsSkills: ['testing'], proposedAt: NOW - 9 * 36e5, status: 'accepted',
  },
];

const SUPERVISE_RUNS: RunSummary[] = [
  { runId: 'run_9c1', startedAt: NOW - 45 * 60e3, causedBy: 'chat', userMessage: 'Why does the percentage coupon drop off at checkout?', status: 'completed', eventCount: 62, turnsWithoutUsage: 0, usage: { input: 184_320, output: 9_140, cacheRead: 121_400 } },
  { runId: 'run_9b7', startedAt: NOW - 6 * 36e5, causedBy: 'timer', userMessage: null, status: 'completed', eventCount: 18, usage: {}, turnsWithoutUsage: 3 },
  ...Array.from({ length: 12 }, (_, index): RunSummary => {
    const asked = ['Which migration dropped the coupon index?', 'Show me every reader of rules[kind]', 'Run the checkout suite against the fix', null];
    const asking = asked[index % asked.length] ?? null;
    return {
      runId: `run_8${String(99 - index).padStart(2, '0')}`,
      startedAt: NOW - (7 + index) * 36e5,
      causedBy: asking === null ? 'timer' : 'chat',
      userMessage: asking,
      status: 'completed',
      eventCount: 12 + ((index * 7) % 50),
      usage: { input: 12_000 + index * 1_400, output: 800 + index * 60, cacheRead: 6_000 + index * 900 },
      turnsWithoutUsage: 0,
    };
  }),
];

const SUPERVISE_TRIGGERS = [
  {
    id: '01K5ZQ8F2P0000000000000WH1', kind: 'webhook_durable', state: 'active', created_at: NOW - 12 * 864e5,
    spec: { label: 'deploy-failed' }, rate_limit_per_min: 30, fire_count: 41, last_fire_at: NOW - 3 * 36e5, next_fire_at: null,
    url: '/api/workspaces/checkout-fixes/webhook/01K5ZQ8F2P0000000000000WH1/v1-4f1c9a02d7b64e8fa3105c6d29be7a41',
  },
  {
    id: 'trg_tm1', kind: 'timer_cron', state: 'active', created_at: NOW - 30 * 864e5,
    spec: { cron: '0 9 * * 1' }, fire_count: 4, last_fire_at: NOW - 3 * 864e5, next_fire_at: NOW + 4 * 864e5,
  },
];

const PageRequestSchema: v.GenericSchema<PageRequest> = v.object({
  cursor: v.optional(v.object({ after: v.string() })),
  limit: v.optional(v.number()),
});

export const superviseRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
  const answer = <Value,>(value: Value): Promise<T> => new Response(JSON.stringify(v.parse(JsonValueSchema, value))).json<T>();
  if (method === 'listCurriculumTasks') return answer({ tasks: SUPERVISE_TASKS });
  if (method === 'getRunSummaries') {
    const request = v.parse(PageRequestSchema, args?.[0] ?? {});
    const limit = request.limit ?? 30;
    const after = request.cursor?.after;
    const start = after === undefined ? 0 : SUPERVISE_RUNS.findIndex((run) => run.runId === after) + 1;
    return answer(seekPage(SUPERVISE_RUNS.slice(start, start + limit + 1), limit, (run) => run.runId));
  }
  if (method === 'listTriggers') return answer({ triggers: SUPERVISE_TRIGGERS });
  if (method === 'listBackgroundJobs') return answer(CHECKOUT_JOBS);
  if (method.startsWith('list') || method.startsWith('get')) return answer([]);
  return answer({ ok: true });
};

/* ── A Plan turn: the agent submits a plan, the owner annotates it ──────── */

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
  decidedAt: null,
};

/** The plan's decisions, answered the way the product answers them: a saved
 *  annotation stays, a decision records and the next turn is queued. `base` is
 *  the plan under review — the static frame's annotated one by default, the
 *  movie's clean one when the walkthrough drives it. */
export function planRpc(onDecide: (plan: PlanReview) => void, base: PlanReview = PLAN_FIXTURE): Rpc {
  return async <T,>(method: string, args?: unknown[]): Promise<T> => {
    const answer = <Value,>(value: Value): Promise<T> => new Response(JSON.stringify(v.parse(JsonValueSchema, value))).json<T>();
    if (method === 'getExecutorDiff') return answer({ files: [], mode: 'vfs-baseline' });
    if (method === 'inspectSubordinate') {
      const request = v.parse(SubordinateInspectionRequestSchema, args?.[0]);
      if (request.view === 'planTasks') return answer({ view: 'planTasks', path: request.path, tasks: [] });
      return answer({ view: request.view, path: request.path, page: { status: 'end', items: request.view === 'plans' ? [base] : [] } });
    }
    if (method === 'getEvolutionChangelog') return answer({ seenAt: NOW, unseenCount: 0, entries: [] });
    if (method === 'savePlanReviewAnnotations') return answer({ ok: true, plan: base });
    if (method === 'decidePlanReview') {
      const [, , decision, feedback] = v.parse(DecideArgsSchema, args);
      const decided: PlanReview = {
        ...base,
        status: decision === 'approve' ? 'approved' : 'changes_requested',
        feedback: feedback ?? null,
        handoffAccepted: true,
        updatedAt: Date.now(),
        decidedAt: Date.now(),
      };
      onDecide(decided);
      return answer({ ok: true, plan: decided, queued: true });
    }
    if (method === 'getExposedPorts') return answer({ ports: [] });
    if (method.startsWith('list') || method.startsWith('get')) return answer([]);
    return answer({ ok: true });
  };
}

/* ── A slate: the agent writes a dashboard over an MCP source ──────────── */

export const SLATE_SUMMARY: SlateSummary = { id: 'support-queue', title: 'Support queue', bindings: ['ISSUES'] };

/** The shape a preview hostname takes in production: `<port>-<sandbox>-<token>`
 *  under the app's zone. This one is a sample and serves nothing. */
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
      { type: 'reasoning', text: 'A slate under /home/user/slates/support-queue with one MCP binding to the GitHub connection, narrowed to list_issues. The server fetches through env.ISSUES and the client draws the charts.' },
      { type: 'tool-file', toolCallId: 'landing-slate-manifest', state: 'output-available', input: { action: 'write', path: '/home/user/slates/support-queue/package.json' }, output: 'ok' },
      { type: 'tool-file', toolCallId: 'landing-slate-server', state: 'output-available', input: { action: 'write', path: '/home/user/slates/support-queue/server.ts' }, output: 'ok' },
      { type: 'tool-file', toolCallId: 'landing-slate-client', state: 'output-available', input: { action: 'write', path: '/home/user/slates/support-queue/client.tsx' }, output: 'ok' },
      { type: 'tool-execute_tools', toolCallId: 'landing-slate-preview', state: 'output-available', input: { code: "// Boot the preview and hand back its URL\nconst preview = await workspace.slate({ op: 'preview', id: 'support-queue' });\nreturn preview;" }, output: JSON.stringify({ ok: true, value: { url: SLATE_PREVIEW_URL, port: 8789 } }) },
      { type: 'text', text: 'The dashboard is open in the Support queue tab. It reads issues through the ISSUES binding, which only reaches `list_issues` on your GitHub connection.' },
    ],
  },
];
