/** Fixture state for the landing page's frames, which mount the product's own components.
 *  Nothing here is served; only the install command comes from the deployment. */
import { mainPanelAgent, satisfactionInterval, wilsonInterval, type ActivitySnapshot, type AgentStatus, type DirEntry, type EnvironmentInfo, type ExecutorInfo, type MemoryEntry, type TerminalPaneOutput, type PanelAgent, type PlanReview, type QualityWindow, type SlateSummary, type TabPresence, type ModelMenuEntry, type RosterPage } from '@kinu.run/core';
import type { Important } from '@/lib/mail-api';
import type { AccountMemoryState, DeviceConsent, UserDevice, UserProfile } from '@/lib/user-api';
import { answeringRpc, type WorkspaceRpc } from '@/lib/workspace-rpc';

const NOW = Date.now();

export const LANDING_MODEL = 'opencode-go/muse-spark-1.3-contributor';

export const LANDING_MODELS: ModelMenuEntry[] = [
  { spec: LANDING_MODEL, label: 'Muse Spark 1.3', provider: 'OpenCode Go' },
  { spec: 'workers-ai/llama-4', label: 'Llama 4 (Workers AI)', provider: 'Workers AI' },
];

export const LANDING_WORKSPACE = 'api-worker';

/** No exploration runs, so `surfaceHasContent` hides Swarms. */
export const LANDING_TAB_PRESENCE: TabPresence = { explorations: false, work: true };

/** One chat, so a phone's tab strip keeps room for the workspace's name. */
export const LANDING_CHATS: readonly PanelAgent[] = [mainPanelAgent({ activity: 'working' })];

/** The frame's workspace is first so the rail marks it open. */
const QUIET = { activity: 'idle', awaitsSettings: false, decisionsWaiting: 0, hasUpdates: false, latestRun: null } as const;

const LANDING_ROSTER = {
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
const LANDING_PROFILE: UserProfile = {
  email: 'ashish@example.com',
  displayName: 'Ashish',
  createdAt: NOW - 90 * 864e5,
  lastSeenAt: NOW,
  onboardedAt: NOW - 90 * 864e5,
  workspaceCount: LANDING_ROSTER.total,
  controlPlane: false,
};

/**
 * Every account read the landing's real components make, by path, each typed as its reader parses it. The `landing.tsx`
 * shim answers these and the settings under `/api/user/config/`, and refuses any other `/api/` request: a static page
 * has no session for a server to read.
 */
export const LANDING_ACCOUNT_READS: ReadonlyMap<string, object> = new Map<string, object>([
  ['/api/user/profile', LANDING_PROFILE],
  ['/api/user/workspaces', LANDING_ROSTER],
  ['/api/user/devices', [] satisfies UserDevice[]],
  ['/api/user/devices/consents', [] satisfies DeviceConsent[]],
  ['/api/user/memory', { facts: [], notes: [], pending: [] } satisfies AccountMemoryState],
  ['/api/user/mail/important', { enabled: false, unread: 0, items: [] } satisfies Important],
]);

export const LANDING_OWNER = { actorId: 'actor-main', name: 'main', title: 'main', retired: false, path: [] };

/** The sample workspace's agent as its Agent tab reads it: who it is, then what it has kept in memory. */
export const LANDING_AGENT: AgentStatus = {
  name: LANDING_WORKSPACE, displayName: 'API Worker',
  purpose: 'The api Worker on Cloudflare: keep it deployed, healthy and fast.', model: LANDING_MODEL,
  scaffoldVersion: 3, searchNodeCount: 0, messageCount: 24, soul: '# API Worker', forkLineage: null,
  layout: 'workbench', createdAt: NOW - 7 * 864e5, reasoningEffort: 'medium',
};

export const LANDING_MEMORY: MemoryEntry[] = [
  { path: 'memory/MEMORY.md', content: 'Every route that reads a session goes through openDb', matchScore: 1, updatedAt: '2026-09-15', savedBy: 'main' },
  { path: 'memory/MEMORY.md', content: 'The sessions database is bound as SESSIONS_DB since the rename', matchScore: 1, updatedAt: '2026-09-17', savedBy: 'main' },
];

/** The sample workspace's machines, both up, as Environment lists them: its own isolate and its computer. */
const LANDING_MOUNTS: EnvironmentInfo[] = [
  { name: 'workspace', prefix: 'workspace.*', live: true, policy: { readOnly: false, consistency: 'durable' }, reason: null },
  { name: 'computer', prefix: 'computer.*', live: true, policy: { readOnly: false, consistency: 'ephemeral' }, reason: null },
];

export const LANDING_EXECUTORS: ExecutorInfo[] = [
  { name: 'computer', kind: 'computer', available: true, configured: true, active: true, status: 'active', capabilities: ['shell', 'npm', 'git', 'fs_owned', 'process_long'] },
  { name: 'workspace', kind: 'workspace', available: true, configured: true, active: true, status: 'active', capabilities: ['javascript', 'typescript', 'shell', 'npm', 'fs_shared'] },
];

/** A run on a sample machine, `minutesAgo`, as its terminal replays it. */
function ran(id: string, command: string, stdout: string, minutesAgo: number): TerminalPaneOutput {
  return { id, command, stdout, stderr: '', stdout_len: stdout.length, stderr_len: 0, exit_code: 0, created_at: NOW - minutesAgo * 60e3 };
}

/** What each sample machine ran earlier: its terminal replays the runs, with no machine behind it. */
export const LANDING_TERMINALS: ReadonlyMap<string, readonly TerminalPaneOutput[]> = new Map([
  ['computer', [
    ran('landing-run', 'bunx wrangler tail api --status error', "TypeError: Cannot read properties of undefined (reading 'prepare') at openDb (src/db.ts:12)\n", 24),
    ran('landing-tests', 'bun test workers/api', '18 passed\n', 6),
  ]],
  ['workspace', [
    ran('landing-query', 'grep -n binding workers/api/wrangler.jsonc', '14:      "binding": "SESSIONS_DB",\n', 20),
  ]],
]);

export const LANDING_MEMORY_FILE = '## api Worker\n\n- Every route that reads a session goes through `openDb`.\n'
  + '- The sessions database is bound as `SESSIONS_DB` since the rename; `DB` is the old name.\n';

/** The api Worker's checkout, as the Files tab lists it: a folder at a time, by its path. */
const WORKER_TREE: ReadonlyMap<string, readonly DirEntry[]> = new Map([
  ['/', [
    { name: 'workers', type: 'dir' },
    { name: 'package.json', type: 'file', size: 642, mtimeMs: NOW - 9e6 },
    { name: 'README.md', type: 'file', size: 2214, mtimeMs: NOW - 4e7 },
  ]],
  ['/workers', [{ name: 'api', type: 'dir' }]],
  ['/workers/api', [
    { name: 'migrations', type: 'dir' },
    { name: 'src', type: 'dir' },
    { name: 'test', type: 'dir' },
    { name: 'wrangler.jsonc', type: 'file', size: 1186, mtimeMs: NOW - 26e5 },
  ]],
  ['/workers/api/src', [
    { name: 'routes', type: 'dir' },
    { name: 'db.ts', type: 'file', size: 904, mtimeMs: NOW - 18e5 },
    { name: 'index.ts', type: 'file', size: 1530, mtimeMs: NOW - 5e7 },
  ]],
  ['/workers/api/migrations', [{ name: '0006_sessions.sql', type: 'file', size: 388, mtimeMs: NOW - 9e8 }]],
  ['/workers/api/test', [{ name: 'sessions-binding.test.ts', type: 'file', size: 611, mtimeMs: NOW - 12e5 }]],
]);

/** The week's ratings, as an account no one has rated answers them (core `qualityWindow`). */
export const UNRATED_WEEK: QualityWindow = {
  from: new Date(NOW - 6 * 864e5).toISOString().slice(0, 10),
  to: new Date(NOW).toISOString().slice(0, 10),
  satisfaction: satisfactionInterval([]),
  corrected: wilsonInterval(0, 0),
  rated: 0,
  thumbs: 0,
  turns: 0,
};

/** No metered step yet: what a workspace's Activity reads before its agent has run one. */
export const QUIET_ACTIVITY: ActivitySnapshot = {
  latest: null,
  contextWindow: null,
  fill: null,
  telemetry: {
    steps: 0, windowLimit: 2000, tokens: {}, usd: 0, pricedSteps: 0, unpricedSteps: 0, stepsWithoutUsage: 0,
    cacheHit: { samples: 0, last: null, ema: null, mean: null, p95: null, p99: null, emaAlpha: 0.2, warms: 0 },
  },
  spend: {
    producers: [],
    total: { calls: 0, callsWithoutUsage: 0, usage: {}, unpricedCalls: 0 },
    coverage: { calls: 0, measured: 0, reported: null, silent: [], partial: [] },
    offTurnShare: null,
    missions: [],
    accounts: [],
  },
  log: [],
};

const PLAN_MARKDOWN = `# Fix the 500, then build the support-queue dashboard

The api Worker fails every request that opens its database: the config renamed the D1 binding to \`SESSIONS_DB\`, but \`openDb\` still reads \`env.DB\`.

## Fix

1. Read \`env.SESSIONS_DB\` in \`openDb\`, falling back to \`env.DB\` until every environment has redeployed.
2. Move \`routes/webhooks.ts\` onto \`openDb\`; it is the one route that reads the binding itself.
3. Run the Worker's tests with the binding present, renamed, and missing.

## Dashboard

4. Build a live app in its own tab: open issues by label, opened and closed each week, and the oldest ones waiting.
5. Read the issues through the GitHub connection's \`list_issues\`, and nothing else.`;

/** No annotations, so Approve is the live affordance. */
export const LANDING_PLAN: PlanReview = {
  id: 'landing-plan',
  sessionId: 'default',
  revision: 1,
  content: PLAN_MARKDOWN,
  status: 'pending',
  annotations: [],
  feedback: null,
  handoffAccepted: false,
  createdAt: NOW - 3e5,
  updatedAt: NOW - 6e4,
};

/**
 * Every read the frame's tabs make, each typed as the product answers it (`answeringRpc`). `plan` null means no plan
 * submitted yet: the Plans read answers empty, and annotations or decisions refuse rather than report a success.
 */
export function planRpc(onDecide: (plan: PlanReview) => void, plan: PlanReview | null): WorkspaceRpc {
  const refused = { ok: false, error: 'no plan under review', plan: null } as const;

  const decided = (next: PlanReview) => {
    onDecide(next);

    return next;
  };

  return answeringRpc({
    agentMail: () => null,
    getFacts: () => [],
    getActivitySnapshot: () => QUIET_ACTIVITY,
    getQuality: () => [],
    getQualityWindow: () => UNRATED_WEEK,
    getExecutorFiles: (_executor, path) => ({ path, entries: [...(WORKER_TREE.get(path) ?? [])] }),
    listMounts: () => LANDING_MOUNTS,
    listComputerSessions: () => null,
    getComputerSize: () => null,
    getExecutorDiff: () => ({ files: [], mode: 'vfs-baseline' }),
    getExecutorChangeCount: () => ({ files: 0 }),
    getExposedPorts: () => ({ ports: [] }),
    getEvolutionChangelog: () => ({ seenAt: NOW, unseenCount: 0, entries: [] }),
    listScaffoldVersions: () => [],
    listBackgroundJobs: () => [],
    listWorkspaceWork: () => ({ plans: plan === null ? [] : [{ owner: LANDING_OWNER, plan, tasks: [] }], tasks: [] }),
    savePlanReviewAnnotations: () => (plan === null ? refused : { ok: true, plan }),
    decidePlanReview: (_id, _revision, decision, feedback) => {
      if (plan === null) return refused;

      return {
        ok: true,
        queued: true,
        plan: decided({
          ...plan, status: decision === 'approve' ? 'approved' : 'changes_requested', feedback: feedback ?? null, handoffAccepted: true, updatedAt: Date.now(),
        }),
      };
    },
    dismissPlanReview: () => (plan === null ? refused : { ok: true, plan: decided({ ...plan, status: 'dismissed', updatedAt: Date.now() }) }),
  });
}

export const SLATE_SUMMARY: SlateSummary = { id: 'support-queue', title: 'Support queue' };

/** Production preview hostname shape: `<port>-<sandbox>-<token>` under the app's zone. */
export const SLATE_PREVIEW_URL = 'https://8789-support-queue-sample.kinu.run/';
