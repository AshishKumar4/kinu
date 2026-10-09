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
import type { TrustLevel } from '../events/hub/types';
import { nanoid } from '../utils/nanoid';
import type { JsonObject } from '../utils/json';
import { KinuError } from '../obs/index';
import type { WorkspaceProposalInput, WorkspaceProposalReceipt } from '../safety/workspace-proposals';
import { serve } from '../operations/operation';
import { AGENT } from '../operations/agent';
import { codemodeNamespace } from './operation-surfaces';

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
    missionLabel?: string;
  }): Promise<TimerTrigger>;
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
   *  assembly — the same one-shot flag overflow recovery uses. */
  armCompactNow(): void;
  /** Parks a proposed workspace for the owner; absent where no owner account can hold one (a local session). */
  readonly proposeWorkspace?: (proposal: WorkspaceProposalInput) => Effect.Effect<WorkspaceProposalReceipt, KinuError>;
}

/** A running job reads as the wake contract, not an empty row, so a poll loop has nothing to spin on. */
interface RunningJobRead {
  id: string;
  kind: string;
  label?: string;
  status: 'running';
  note: string;
}

function formatJobRead(job: BackgroundJob | null): BackgroundJob | RunningJobRead | null {
  if (job?.status !== 'running') return job;

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

export function createAgentSelfProvider(host: AgentSelfHost): CodemodeProvider {
  return codemodeNamespace('agent', 'You yourself: schedules, background jobs, budget, scaffolds, curriculum and new workspaces.', [
    serve(AGENT.proposeCurriculum, async ({ count }) => await host.proposeCurriculumTasks(count)),
    serve(AGENT.listCurriculum, async ({ status }) => await host.listCurriculumTasks(status)),
    serve(AGENT.acceptCurriculumTask, async ({ id }) => await host.setCurriculumTaskStatus(id, 'accepted')),
    serve(AGENT.proposeScaffold, async ({ rationale, code, baseVersion }) => await host.proposeScaffold(rationale, code, baseVersion)),
    serve(AGENT.proposeWorkspace, (proposal) => host.proposeWorkspace?.(proposal)
      ?? Effect.fail(new KinuError('unsupported', 'agent.proposeWorkspace: this session has no owner account to create a workspace under'))),
    serve(AGENT.scaffoldVersions, async ({ limit }) => await host.listScaffoldVersions(limit)),
    serve(AGENT.schedule, (opts) => Effect.gen(function* () {
      const { cron, atMs } = opts;

      if (cron === undefined && atMs === undefined) return yield* new KinuError('bad_input', 'agent.schedule: provide { cron } or { atMs }');

      if (cron !== undefined && nextCronFire(cron, Date.now()) === null) return yield* new KinuError('bad_input', `agent.schedule: unsupported cron expression: ${cron}`);

      if (atMs !== undefined && atMs <= Date.now()) return yield* new KinuError('bad_input', 'agent.schedule: atMs must be in the future');
      // Declared before the trigger so the first fire carries the label; a named label re-enters its row.
      const limits = readMissionLimits({ budget_usd: opts.budgetUsd, budget_tokens: opts.budgetTokens });
      const declaredLabel = opts.budgetLabel?.trim();
      // A blank label names no sub-ledger; the generated one keeps it addressable.
      const label = declaredLabel === undefined || declaredLabel === '' ? `schedule-${nanoid()}` : declaredLabel;
      const missionLabel = limits === null ? undefined : label;
      const budget = limits === null ? undefined : host.budget.declare(label, limits);
      const trigger = yield* Effect.promise(() => host.createTimerTrigger({ cron, atMs, missionLabel, label: opts.label, payload: opts.payload }));

      return budget === undefined ? trigger : { ...trigger, budget };
    })),
    serve(AGENT.cancelSchedule, async ({ id }) => await host.cancelTrigger(id, 'self')),
    serve(AGENT.budget, async ({ label }) => host.budget.snapshot(label)),
    serve(AGENT.jobResult, async ({ jobId }) => formatJobRead(await host.jobResult(jobId))),
    serve(AGENT.backgroundJobs, async ({ limit }) => await host.listBackgroundJobs(limit)),
    serve(AGENT.compactNow, async () => {
      host.armCompactNow();

      return { armed: true as const, appliesAt: 'next-turn-assembly' as const };
    }),
    serve(AGENT.quality, async ({ days }) => await host.getQuality(days)),
  ]);
}
