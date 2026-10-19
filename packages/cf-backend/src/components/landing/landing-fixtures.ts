/** Fixture state for the landing page's frames, which mount the product's own components.
 *  Nothing here is served; only the install command comes from the deployment. */
import type { UIMessage } from 'ai';
import * as v from 'valibot';
import { JsonValueSchema, mainPanelAgent, SubordinateInspectionRequestSchema, type JsonValue, type PanelAgent, type PendingAction, type PlanReview, type SlateSummary, type TabPresence, type ModelMenuEntry, type RosterPage } from '@kinu.run/core';
import type { UserProfile } from '@/lib/user-api';
import { workspaceRpc, type SocketCall, type WorkspaceRpc } from '@/lib/workspace-rpc';
import type { BackgroundJob } from '@kinu.run/core/protocol';

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

export const LANDING_MODEL = 'opencode-go/muse-spark-1.3-contributor';

export const LANDING_MODELS: ModelMenuEntry[] = [
  { spec: LANDING_MODEL, label: 'Muse Spark 1.3', provider: 'OpenCode Go' },
  { spec: 'workers-ai/llama-4', label: 'Llama 4 (Workers AI)', provider: 'Workers AI' },
];

export const LANDING_WORKSPACE = 'api-worker';

/** No exploration runs, so `surfaceHasContent` hides Swarms. */
export const LANDING_TAB_PRESENCE: TabPresence = { explorations: false, work: true };

const NO_FIGURES = { activeMs: 0, cacheEma: null };

/** A project's day-to-day chats. */
export const LANDING_CHATS: readonly PanelAgent[] = [
  mainPanelAgent({ activity: 'working' }),
  { colour: 1, key: 'actor-cron', label: 'Should the nightly sweep move to a cron trigger?', category: 'user', activity: 'waiting', parent: 'main', open: { kind: 'chat', path: 'cron-sweep' }, tab: true, input: true, figures: NO_FIGURES },
  { colour: 2, key: 'actor-logs', label: 'Read last night\'s error logs', category: 'user', activity: 'working', parent: 'main', open: { kind: 'chat', path: 'error-logs' }, tab: true, input: true, figures: NO_FIGURES },
];

/** Served by the `landing.tsx` fetch shim; the frame's workspace is first so the rail marks it open. */
const QUIET = { activity: 'idle', awaitsSettings: false, decisionsWaiting: 0, hasUpdates: false, latestRun: null } as const;

export const LANDING_ROSTER = {
  entries: [
    { name: 'api-worker', displayName: 'API Worker', createdAt: NOW - 7 * 864e5, lastVisited: NOW - 60e3 },
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
  controlPlane: false,
};

export const WORK_FRAME_CAPTION = 'Sample workspace';

export const WORKER_MESSAGES: UIMessage[] = [
  {
    id: 'landing-worker-user',
    role: 'user',
    parts: [{ type: 'text', text: 'The api Worker has answered 500 on /api/health since the last deploy. Find out why and fix it. Deploy to staging when green.' }],
  },
  {
    id: 'landing-worker-agent',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Fixed the 500: `openDb` read the sessions database by its old binding. 18 tests green, staging deploying.' },
      { type: 'tool-run', toolCallId: 'landing-run', state: 'output-available', input: { runtime: 'computer', command: 'bunx wrangler tail api --status error' }, output: "TypeError: Cannot read properties of undefined (reading 'prepare') at openDb (src/db.ts:12)" },
      { type: 'tool-eval', toolCallId: 'landing-query', state: 'output-available', input: { code: '// Which binding names does each environment give the database?\nconst config = JSON.parse(await fs.read("workers/api/wrangler.jsonc"));\nreturn config.d1_databases.map((db) => db.binding);' }, output: '["SESSIONS_DB"]' },
      { type: 'tool-file', toolCallId: 'landing-read', state: 'output-available', input: { op: 'read', path: 'workers/api/src/db.ts' }, output: '…' },
      { type: 'tool-file', toolCallId: 'landing-edit', state: 'output-error', input: { op: 'edit', path: 'workers/api/src/db.ts', edits: [{}, {}] }, errorText: 'old_text not found or not unique' },
      { type: 'tool-file', toolCallId: 'landing-reread', state: 'output-available', input: { op: 'read', path: 'workers/api/src/db.ts' }, output: '…' },
      { type: 'tool-file', toolCallId: 'landing-patch', state: 'output-available', input: { op: 'edit', path: 'workers/api/src/db.ts', edits: [{ old_text: 'return env.DB;', new_text: 'return env.SESSIONS_DB ?? env.DB;' }] }, output: 'ok' },
      { type: 'tool-file', toolCallId: 'landing-write', state: 'output-available', input: { op: 'write', path: 'workers/api/test/integration/sessions-binding.test.ts' }, output: 'ok' },
      { type: 'tool-run', toolCallId: 'landing-tests', state: 'output-available', input: { runtime: 'computer', command: 'bun test workers/api' }, output: '18 passed' },
      { type: 'tool-tasks', toolCallId: 'landing-task', state: 'output-available', input: { op: 'update', id: 't4', status: 'done' }, output: 'ok' },
    ],
  },
];

const WORKER_TASKS = [
  { id: 't1', parentId: null, title: 'Reproduce the 500 on /api/health', status: 'done', updatedAt: NOW - 44e5, note: null, subtasks: [] },
  {
    id: 't2', parentId: null, title: 'Read the sessions database by its new binding', status: 'active', updatedAt: NOW - 8e5, note: null,
    subtasks: [
      { id: 't5', parentId: 't2', title: 'Fix openDb and the webhook route', status: 'done', updatedAt: NOW - 21e5, note: null },
      { id: 't6', parentId: 't2', title: 'Bind the new name on staging too', status: 'active', updatedAt: NOW - 6e5, note: null },
    ],
  },
  { id: 't3', parentId: null, title: 'Deploy to staging when the suite is green', status: 'open', updatedAt: NOW - 52e5, note: null, subtasks: [] },
  { id: 't4', parentId: null, title: 'Add a test for a missing binding', status: 'done', updatedAt: NOW - 4e5, note: null, subtasks: [] },
];

export const LANDING_OWNER = { actorId: 'actor-main', name: 'main', title: 'main', retired: false, path: [] };

const WORKER_CHANGELOG = {
  seenAt: NOW - 30e5,
  unseenCount: 0,
  entries: [
    { id: 'cl_1', kind: 'fact', at: NOW - 26e5, scaffoldVersion: null, revert: true, summary: 'Remembered: staging still binds the sessions database as DB', evidence: null },
    { id: 'cl_2', kind: 'fact', at: NOW - 50e5, scaffoldVersion: null, revert: true, summary: "Remembered: the api Worker's sessions database is bound as SESSIONS_DB since the Sept 22 deploy", evidence: null },
  ],
};

/** A first drive: never interrupted, never retried, serving nothing. */
const FIRST_DRIVE = { epoch: 0, retriedBy: null, resumeAfter: null, serves: null } as const;

const WORKER_JOBS: BackgroundJob[] = [
  { id: 'bgjob-7c1e4a92', kind: 'eval', label: 'bun test workers/api', workMode: 'build', status: 'running', result: null, error: null, createdAt: NOW - 9e5, attemptStartedAt: NOW - 9e5, settledAt: null, ...FIRST_DRIVE },
  { id: 'bgjob-9d3c6e11', kind: 'shell', label: 'bun test workers/api --filter binding', workMode: 'build', status: 'failed', result: null, error: 'exit 1: 2 failed — openDb still reads env.DB', createdAt: NOW - 61e5, attemptStartedAt: NOW - 61e5, settledAt: NOW - 58e5, ...FIRST_DRIVE },
];

const WORKER_PENDING: PendingAction[] = [
  { id: 'defer-sessions-migration', kind: 'deferred_action', at: NOW - 3e5, title: 'Approve: a command the agent wants to run on device', detail: 'bunx wrangler d1 migrations apply SESSIONS_DB --remote' },
];

export interface WorkFixture {
  readonly rpc: WorkspaceRpc;
  readonly jobs: () => BackgroundJob[];
  readonly pending: () => PendingAction[];
}

export function workerWorkFixture(onChange: () => void): WorkFixture {
  let jobs = WORKER_JOBS;
  let pending = WORKER_PENDING;

  const rpc: SocketCall = async <T,>(method: string, args?: unknown[]): Promise<T> => {
    if (method === 'getExecutorDiff') return answer({ files: [], mode: 'vfs-baseline' });

    if (method === 'inspectSubordinate') {
      const request = v.parse(SubordinateInspectionRequestSchema, args?.[0]);

      return answer({ view: request.view, path: request.path, page: { status: 'end', items: [] } });
    }

    if (method === 'listWorkspaceWork') return answer({ plans: [], tasks: [{ owner: LANDING_OWNER, plan: null, tasks: WORKER_TASKS }] });

    if (method === 'getEvolutionChangelog') return answer(WORKER_CHANGELOG);

    if (method === 'listBackgroundJobs') return answer(jobs);

    if (method === 'retryBackgroundJob' || method === 'dismissBackgroundJob') {
      const named = v.safeParse(JobIdArgsSchema, args);

      if (!named.success) return answer({ ok: false, error: 'no job named' });
      const [id] = named.output;
      const retryId = `bgjob-${id.slice(-8)}r`;
      jobs = method === 'retryBackgroundJob'
        ? [
          ...jobs.map((job) => (job.id === id ? { ...job, retriedBy: retryId } : job)),
          {
            id: retryId, kind: 'shell', label: 'wrangler deploy --env staging --dry-run', workMode: 'build', status: 'running', result: null, error: null,
            createdAt: Date.now(), attemptStartedAt: Date.now(), settledAt: null, ...FIRST_DRIVE,
          },
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

  return { rpc: workspaceRpc(rpc), jobs: () => jobs, pending: () => pending };
}


const PLAN_MARKDOWN = `# Read the sessions database as \`SESSIONS_DB\`

The api Worker fails every request that opens its database: the config renamed the D1 binding to \`SESSIONS_DB\`, but \`openDb\` still reads \`env.DB\`. This plan reads it by the new name and keeps the health route's response.

## Scope

- Read the sessions database by one binding name everywhere.
- Fail by the binding's name when an environment binds neither.
- Keep \`/api/health\`'s response for the monitors that already poll it.

## Implementation

1. Read \`env.SESSIONS_DB\` in \`openDb\`, falling back to \`env.DB\` until every environment has redeployed.
2. Move \`routes/webhooks.ts\` onto \`openDb\`; it is the one route that reads the binding itself.
3. Leave the health route unchanged; it already reports what \`openDb\` answers.

## Verification

- Run the Worker's tests with the binding present, renamed, and missing.
- Deploy to staging and watch \`wrangler tail\` for errors before production.`;

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
    endOffset: 58,
    type: 'COMMENT',
    text: 'Log each read through the old name too, so we hear when an environment still binds it.',
    originalText: 'Read the sessions database by one binding name everywhere.',
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
export function planRpc(onDecide: (plan: PlanReview) => void, base: PlanReview | null = PLAN_FIXTURE): WorkspaceRpc {
  return workspaceRpc(async <T,>(method: string, args?: unknown[]): Promise<T> => {
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
  });
}

export const SLATE_SUMMARY: SlateSummary = { id: 'support-queue', title: 'Support queue' };

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
      { type: 'reasoning', text: 'A slate under /slates/support-queue. The server reads the GitHub connection through this.env.workspace.mcp.github.list_issues and the client draws the charts.' },
      { type: 'tool-file', toolCallId: 'landing-slate-manifest', state: 'output-available', input: { op: 'write', path: '/slates/support-queue/package.json' }, output: 'ok' },
      { type: 'tool-file', toolCallId: 'landing-slate-server', state: 'output-available', input: { op: 'write', path: '/slates/support-queue/server.ts' }, output: 'ok' },
      { type: 'tool-file', toolCallId: 'landing-slate-client', state: 'output-available', input: { op: 'write', path: '/slates/support-queue/client.tsx' }, output: 'ok' },
      { type: 'tool-eval', toolCallId: 'landing-slate-preview', state: 'output-available', input: { code: "// Boot the preview and hand back its URL\nreturn await workspace.slates['support-queue'].$preview();" }, output: JSON.stringify({ url: SLATE_PREVIEW_URL, port: 8789 }) },
      { type: 'text', text: 'The dashboard is open in the Support queue tab. It reads issues with `list_issues` on your GitHub connection, as you.' },
    ],
  },
];
