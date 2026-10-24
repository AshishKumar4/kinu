/**
 * `agent.*`: the agent's own curriculum, scaffold, schedules and background jobs, served from the catalog's declarations
 * over the host both backends build (orchestrator/agent-self-host.ts). `forkAgent` is not here: it clones the actor and
 * refuses mid-turn.
 */
import { Effect } from 'effect';
import type { CodemodeProvider } from '../types/codemode';
import { readMissionLimits, type MissionGovernor } from '../mission-budget';
import { nextCronFire } from '../events/hub/cron';
import type { BackgroundJob } from '../types/jobs';
import { PROPOSED_TASK_STATUSES, type ProposedTask } from '../types/proposals';
import type { ModifyResult, ScaffoldVersionView } from '../types/scaffold';
import type { QualityDay } from '../types/quality';
import type { TimerTrigger } from '../events/ingress/triggers';
import type { PushWatcher, PushWatcherOpts } from '../events/ingress/webhook';
import type * as v from 'valibot';
import type { WatchCheck } from '../types/watch';
import type { TrustLevel } from '../events/hub/types';
import { nanoid } from '../utils/nanoid';
import { safeJsonParse, type JsonObject, type JsonValue } from '../utils/json';
import { KinuError } from '../obs/index';
import type { AgentWorkspaceInput, AgentWorkspaceReceipt } from '../identity/agent-workspaces';
import { serve } from '../operations/operation';
import { AGENT } from '../operations/agent';
import { codemodeNamespace } from './operation-surfaces';
import type { OwnerWait } from '../types/owner-waits';

type CurriculumStatus = (typeof PROPOSED_TASK_STATUSES)[number];

/** The narrow slice of the agent the `agent.*` tools call through to, built
 *  once for both backends by `agentSelfHost` (orchestrator/agent-self-host.ts),
 *  so every tool answers the same shape on each. */
export interface AgentSelfHost {
  proposeCurriculumTasks(count?: number): Promise<ProposedTask[]>;
  listCurriculumTasks(status?: CurriculumStatus): Promise<ProposedTask[]>;
  setCurriculumTaskStatus(id: string, status: CurriculumStatus): Promise<{ ok: boolean }>;
  proposeScaffold(rationale: string, code: string, baseVersion?: number): Promise<ModifyResult>;
  listScaffoldVersions(limit?: number): Promise<ScaffoldVersionView[]>;
  createTimerTrigger(opts: {
    cron?: string; atMs?: number; label?: string; payload?: JsonObject;
    missionLabel?: string; check?: WatchCheck;
  }): Promise<TimerTrigger>;
  /** A watcher run by GitHub's deliveries for a repository, its hook made by the account's GitHub connection; absent
   *  where GitHub cannot reach the workspace (a local session). */
  readonly createPushWatcher?: (opts: PushWatcherOpts) => Effect.Effect<PushWatcher, KinuError>;
  /** The cumulative spend governor — a schedule declares its mission budget
   *  here, and `agent.budget` reads it back. */
  readonly budget: MissionGovernor;
  /** `caller` has no default: operator surfaces pass `'owner'`, this tool `'self'`, so a turn
   *  cannot revoke an owner-created webhook. */
  cancelTrigger(id: string, caller: TrustLevel): Promise<{ ok: boolean; changed: boolean; error?: string }>
    | { ok: boolean; changed: boolean; error?: string };
  jobResult(jobId: string): Promise<BackgroundJob | null>;
  listBackgroundJobs(limit?: number): Promise<BackgroundJob[]>;
  getQuality(days?: number): Promise<QualityDay[]>;
  /** Arm the compaction ladder's forced rebuild for this session's NEXT turn
   *  assembly — the same one-shot flag overflow recovery uses — where that assembly reads it. */
  armCompactNow(): Promise<void>;
  /** Parks a proposed workspace for the owner; absent where no owner account can hold one (a local session). */
  readonly createWorkspace?: (input: AgentWorkspaceInput) => Effect.Effect<AgentWorkspaceReceipt, KinuError>;
  /** What waits on the owner, every row of it, and this agent's wake. */
  readonly ownerWaits: OwnerWaitsHost;
}

/**
 * What waits on the owner, as one agent reads it, and its one-shot wake (read-models/owner-waits.ts): the workspace's
 * own agent's, over every row; a hire's, over its own. Both backends build it over the queue and reads they already hold.
 */
export interface OwnerWaitsHost {
  list(): Promise<OwnerWait[]>;
  /** Armed unless it is already met; replaces an earlier wait. */
  wakeWhenDone(key: string | null): Promise<{ readonly armed: true } | { readonly already: true }>;
}

/** A running job reads as the wake contract, not an empty row, so a poll loop has nothing to spin on. */
interface RunningJobRead {
  id: string;
  kind: string;
  label?: string;
  status: 'running';
  note: string;
}

/** A job as a program reads it: its result is the value it returned, not the JSON text it is stored as, which inside
 *  a program's own result was a string to parse again (staging 5c522f12d: 5 programs parsed at the wrong level). */
interface JobRead extends Omit<BackgroundJob, 'result'> {
  result: JsonValue;
}

function jobRead(job: BackgroundJob): JobRead {
  return { ...job, result: job.result === null ? null : safeJsonParse(job.result) };
}

/** The recent jobs an unknown id is answered with: enough to see a misquoted id beside the one it meant. */
const RECENT_JOBS_NAMED = 5;

function formatJobRead(job: BackgroundJob): JobRead | RunningJobRead {
  if (job.status !== 'running') return jobRead(job);

  return {
    id: job.id,
    kind: job.kind,
    label: job.label ?? undefined,
    status: 'running',
    note:
      'Not settled yet: there is no result to read, and reading again will not make it finish. '
      + 'You are woken automatically with the full result the moment this job settles. '
      + 'Do other work if you have any; otherwise end your turn and let the wake bring the result.',
  };
}

/** The two members a program reads its owner's waits through, with whichever host it is. */
type ScheduleOpts = v.InferOutput<typeof AGENT.schedule.input>;

/** A repository as GitHub names it (docs.github.com: owner up to 39, repository up to 100 characters). */
const GITHUB_REPOSITORY = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/u;

/** What a schedule spends against, declared before its trigger so the first fire carries the label; a named label
 *  re-enters its row, and a blank one names no sub-ledger: the generated one keeps it addressable. */
function declaredBudget(host: AgentSelfHost, opts: ScheduleOpts) {
  const limits = readMissionLimits({ budget_usd: opts.budgetUsd, budget_tokens: opts.budgetTokens });
  const declaredLabel = opts.budgetLabel?.trim();
  const label = declaredLabel === undefined || declaredLabel === '' ? `schedule-${nanoid()}` : declaredLabel;

  return limits === null ? { missionLabel: undefined, budget: undefined } : { missionLabel: label, budget: host.budget.declare(label, limits) };
}

/** A watcher GitHub's deliveries for a repository run, where the workspace can be reached by them. */
function schedulePush(host: AgentSelfHost, opts: ScheduleOpts & { readonly push: NonNullable<ScheduleOpts['push']> }) {
  return Effect.gen(function* () {
    if (opts.cron !== undefined || opts.atMs !== undefined) {
      return yield* new KinuError('bad_input', 'agent.schedule: a push watcher runs on GitHub\'s deliveries; give it no cron or atMs.');
    }

    if (!GITHUB_REPOSITORY.test(opts.push.github)) return yield* new KinuError('bad_input', 'agent.schedule: push.github names a repository as owner/repo.');

    // A push watcher's check is what keeps a repository's content from waking a turn of its own (Plan, budget, parking).
    if (opts.check === undefined) return yield* new KinuError('bad_input', 'agent.schedule: a push watcher needs a check, which reads each delivery and decides whether it fires.');

    if (host.createPushWatcher === undefined) {
      return yield* new KinuError('unsupported', 'agent.schedule: a push watcher needs the cloud workspace, where GitHub can reach it; this session has none.');
    }

    const { missionLabel, budget } = declaredBudget(host, opts);

    const watcher = yield* host.createPushWatcher({
      repo: opts.push.github, events: opts.push.events ?? ['push'],
      ...(opts.label !== undefined && { label: opts.label }), ...(opts.payload !== undefined && { payload: opts.payload }),
      ...(missionLabel !== undefined && { missionLabel }), check: opts.check,
    });

    return budget === undefined ? watcher : { ...watcher, budget };
  });
}

function ownerWaitMembers(waits: OwnerWaitsHost) {
  return [
    serve(AGENT.waitingOnOwner, async () => await waits.list()),
    serve(AGENT.wakeWhenOwnerDone, async ({ key }) => await waits.wakeWhenDone(key ?? null)),
  ];
}

/**
 * `agent.*` for a hire: what waits on its owner from its own work, and the wake, and nothing else of the workspace's
 * agent's (a hire is confined: delegation-turn-reach.ts `ActorReach`).
 */
export function createHireOwnerWaitsProvider(waits: OwnerWaitsHost): CodemodeProvider {
  return codemodeNamespace('agent', 'You yourself: what waits on your owner from your own work.', ownerWaitMembers(waits));
}

export function createAgentSelfProvider(host: AgentSelfHost): CodemodeProvider {
  return codemodeNamespace('agent', 'You yourself: schedules, background jobs, budget, scaffolds, curriculum, new workspaces and what waits on your owner.', [
    ...ownerWaitMembers(host.ownerWaits),
    serve(AGENT.proposeCurriculum, async ({ count }) => await host.proposeCurriculumTasks(count)),
    serve(AGENT.listCurriculum, async ({ status }) => await host.listCurriculumTasks(status)),
    serve(AGENT.acceptCurriculumTask, async ({ id }) => await host.setCurriculumTaskStatus(id, 'accepted')),
    serve(AGENT.proposeScaffold, async ({ rationale, code, baseVersion }) => await host.proposeScaffold(rationale, code, baseVersion)),
    serve(AGENT.createWorkspace, (input) => host.createWorkspace?.(input)
      ?? Effect.fail(new KinuError('unsupported', 'agent.createWorkspace: this session has no owner account to create a workspace under'))),
    serve(AGENT.scaffoldVersions, async ({ limit }) => await host.listScaffoldVersions(limit)),
    serve(AGENT.schedule, (opts) => Effect.gen(function* () {
      const { cron, atMs } = opts;

      if (opts.push !== undefined) return yield* schedulePush(host, { ...opts, push: opts.push });

      if (cron === undefined && atMs === undefined) return yield* new KinuError('bad_input', 'agent.schedule: provide { cron } or { atMs }');

      if (cron !== undefined && nextCronFire(cron, Date.now()) === null) return yield* new KinuError('bad_input', `agent.schedule: unsupported cron expression: ${cron}`);

      if (atMs !== undefined && atMs <= Date.now()) return yield* new KinuError('bad_input', 'agent.schedule: atMs must be in the future');
      const { missionLabel, budget } = declaredBudget(host, opts);
      const trigger = yield* Effect.promise(() => host.createTimerTrigger({ cron, atMs, missionLabel, label: opts.label, payload: opts.payload, ...(opts.check !== undefined && { check: opts.check }) }));

      return budget === undefined ? trigger : { ...trigger, budget };
    })),
    serve(AGENT.cancelSchedule, async ({ id }) => await host.cancelTrigger(id, 'self')),
    serve(AGENT.budget, async ({ label }) => host.budget.snapshot(label)),
    serve(AGENT.jobResult, ({ jobId }) => Effect.gen(function* () {
      const job = yield* Effect.promise(async () => host.jobResult(jobId));

      if (job !== null) return formatJobRead(job);
      // No job of this agent's has the id: a null would read as a result already taken, so the platform says what it
      // has instead, and a misquoted id shows beside the one it meant.
      const recent = yield* Effect.promise(async () => host.listBackgroundJobs(RECENT_JOBS_NAMED));
      const named = recent.map((each) => `${each.id} (${each.kind}, ${each.status})`).join(', ');

      return yield* new KinuError('missing', `agent.jobResult: no job ${jobId} is yours. ${recent.length === 0 ? 'You have no background jobs.' : `Your recent jobs: ${named}.`}`);
    })),
    serve(AGENT.backgroundJobs, async ({ limit }) => (await host.listBackgroundJobs(limit)).map(jobRead)),
    serve(AGENT.compactNow, async () => {
      await host.armCompactNow();

      return { armed: true as const, appliesAt: 'next-turn-assembly' as const };
    }),
    serve(AGENT.quality, async ({ days }) => await host.getQuality(days)),
  ]);
}
