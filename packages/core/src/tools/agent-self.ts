/**
 * `agent.*` codemode namespace: the agent's own curriculum and scheduled turns. Every method calls
 * the host, so both backends register this one provider. `forkAgent` is excluded (it clones the DO
 * and rejects mid-turn); delegation is `agents.*` (delegation/agents-codemode.ts).
 */
import * as v from 'valibot';
import type { CodemodeProvider } from './sandbox-contract';
import { readMissionLimits, type MissionGovernor } from '../mission-budget';
import { nextCronFire } from '../events/hub/cron';
import { BACKGROUND_POLICY } from '../types/jobs';
import type { BackgroundJob } from '../types/jobs';
import { PROPOSED_TASK_STATUSES, type ProposedTask } from '../types/proposals';
import type { ModifyResult } from '../types/scaffold';
import type { ScaffoldVersionView } from '../types/scaffold';
import type { ReplayEvalSummary } from '../types/evolution';
import type { TimerTrigger } from '../events/ingress/triggers';
import type { TrustLevel } from '../events/hub/types';
import { nanoid } from '../utils/nanoid';
import { TOOL_REACH } from './registry';
import { decodeJsonValue, JsonObjectSchema, type JsonObject, type JsonValue } from '../utils/json';
import { KinuError } from '../obs/index';

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
  getReplayEvals(limit?: number): Promise<ReplayEvalSummary[]>;
  /** Arm the compaction ladder's forced rebuild for this session's NEXT turn
   *  assembly — the same one-shot flag overflow recovery uses. */
  armCompactNow(): void;
}

const CURRICULUM_STATUS_UNION = PROPOSED_TASK_STATUSES.map((s) => `'${s}'`).join(' | ');

const TYPES = `/** Your own lifecycle. */
export declare const agent: {
  proposeCurriculum(count?: number): Promise<unknown>;
  listCurriculum(status?: ${CURRICULUM_STATUS_UNION}): Promise<unknown>;
  acceptCurriculumTask(id: string): Promise<unknown>;
  /** A new version of your scaffold: \`code\` exports \`async function* run(rt, task)\` and reaches the host
   *  only through \`host.*\`; \`rationale\` is at least 50 characters. It goes live only after winning a
   *  shadow evaluation against the current version. \`baseVersion\` branches from an archived one. */
  proposeScaffold(rationale: string, code: string, baseVersion?: number):
    Promise<{ ok: boolean; version?: number; error?: string; stage?: number } | Refusal>;
  /** Your scaffold versions with status, lineage and shadow-evaluation record. */
  scaffoldVersions(limit?: number): Promise<unknown>;
  /** A future turn: \`cron\` recurs, \`atMs\` (epoch ms) fires once. \`budget_usd\`/\`budget_tokens\` cap
   *  everything its turns spend, across fires; \`budget_label\` shares one ledger between schedules. */
  schedule(opts: {
    cron?: string; atMs?: number; label?: string; payload?: object;
    budget_usd?: number; budget_tokens?: number; budget_label?: string;
  }): Promise<{ id: string; kind: string; nextFireAt: number | null; budget?: unknown } | Refusal>;
  cancelSchedule(id: string): Promise<{ ok: boolean; changed: boolean } | Refusal>;
  /** One mission budget, or with no label every budget this turn spends against; [] when uncapped. */
  budget(label?: string): Promise<unknown>;
  /** A background job's row. A running job has no result yet; its result wakes you when it settles. */
  jobResult(jobId: string): Promise<{ id: string; kind: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; result?: string | null; error?: string | null; note?: string } | null | Refusal>;
  backgroundJobs(limit?: number): Promise<unknown>;
  /** Compact the conversation when the next turn is assembled; the folded range stays archived. */
  compactNow(): Promise<{ armed: boolean; appliesAt: 'next-turn-assembly' } | Refusal>;
  /** Past turns replayed against your current config, newest first: loss = 1 − mean score, with a 95% interval. */
  replayEvals(limit?: number): Promise<unknown>;
};
`;

/** Thresholds read from BACKGROUND_POLICY: the provider is built once per DO but the threshold is per turn. */
const BACKGROUND_DESCRIPTION =
  'Read a background job\'s settled result. A fork backgrounds the moment it spawns on a live chat '
  + 'session; other long tool calls background once they outrun this turn\'s threshold '
  + `(${BACKGROUND_POLICY.interactive.detachAfterMs / 1000}s on a chat turn a human is watching, `
  + `${BACKGROUND_POLICY['one-shot'].detachAfterMs / 1000}s on an autonomous turn woken by an event, `
  + 'a timer or a job). Either way the call hands back { jobId } and you are WOKEN with the result '
  + 'when the job settles — the wake is the delivery. Call this for the job a wake named, or to '
  + 're-read an old result; a job still running has no result to read.';

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
      'Not settled yet — there is no result to read, and reading again will not make it finish. '
      + 'You are woken automatically with the full result the moment this job settles. '
      + 'Do other work if you have any; otherwise end your turn and let the wake bring the result.',
  };
}

const OptionalNumberSchema = v.optional(v.number());

const OptionalCurriculumStatusSchema = v.optional(
  v.picklist(PROPOSED_TASK_STATUSES),
);

const NonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));

const OptionalBaseVersionSchema = v.optional(
  v.pipe(v.number(), v.integer(), v.minValue(0)),
);

const ScheduleOptionsSchema = v.object({
  cron: v.optional(v.pipe(v.string(), v.minLength(1))),
  atMs: v.optional(v.pipe(v.number(), v.finite())),
  label: v.optional(v.string()),
  payload: v.optional(JsonObjectSchema),
  budget_usd: v.optional(v.number()),
  budget_tokens: v.optional(v.number()),
  budget_label: v.optional(v.string()),
});


export function createAgentSelfProvider(host: AgentSelfHost): CodemodeProvider {
  return {
    name: TOOL_REACH.agent.codemode,
    types: TYPES,
    positionalArgs: true,
    tools: {
      proposeCurriculum: {
        description: 'Propose N self-curriculum tasks (Voyager-style) for your own improvement; returns the proposals.',
        execute: async (...args: unknown[]) => {
          const parsed = v.safeParse(OptionalNumberSchema, args[0]);

          if (!parsed.success) throw new KinuError('bad_input', 'agent.proposeCurriculum: count must be a number when given');
          const count = parsed.output;

          return await host.proposeCurriculumTasks(count);
        },
      },
      listCurriculum: {
        description: 'List your proposed curriculum tasks, optionally filtered by status (pending/accepted/rejected/completed).',
        execute: async (...args: unknown[]) => {
          const parsed = v.safeParse(OptionalCurriculumStatusSchema, args[0]);

          if (!parsed.success) throw new KinuError('bad_input', 'agent.listCurriculum: invalid status');
          const status = parsed.output;

          return await host.listCurriculumTasks(status);
        },
      },
      acceptCurriculumTask: {
        description: 'Accept a proposed curriculum task by id so it becomes runnable.',
        execute: async (...args: unknown[]) => {
          const parsed = v.safeParse(NonEmptyStringSchema, args[0]);

          if (!parsed.success) throw new KinuError('bad_input', 'agent.acceptCurriculumTask: id must be a non-empty string');

          return await host.setCurriculumTaskStatus(parsed.output, 'accepted');
        },
      },
      proposeScaffold: {
        description: 'Propose a new version of your own agentic-loop scaffold. Routed through the 4-gate validation + misevolution gate + shadow evaluation; only goes live after winning the promotion gate. rationale ≥ 50 chars; code must export async function* run(rt, task) and use the host.* bridge. Optional baseVersion branches from an archived variant.',
        execute: async (...args: unknown[]) => {
          const [rationale, code, baseVersion] = args;
          const parsedRationale = v.safeParse(NonEmptyStringSchema, rationale);

          if (!parsedRationale.success) throw new KinuError('bad_input', 'agent.proposeScaffold: rationale must be a non-empty string');
          const parsedCode = v.safeParse(NonEmptyStringSchema, code);

          if (!parsedCode.success) throw new KinuError('bad_input', 'agent.proposeScaffold: code must be a non-empty string');
          const parsedBase = v.safeParse(OptionalBaseVersionSchema, baseVersion);

          if (!parsedBase.success) throw new KinuError('bad_input', 'agent.proposeScaffold: baseVersion must be a non-negative integer when given');

          return await host.proposeScaffold(parsedRationale.output, parsedCode.output, parsedBase.output);
        },
      },
      scaffoldVersions: {
        description: 'Read-only scaffold archive: versions with status, lineage (parent_version) and shadow-eval record — the stepping stones proposeScaffold can branch from.',
        execute: async (...args: unknown[]) => {
          const parsed = v.safeParse(OptionalNumberSchema, args[0]);

          if (!parsed.success) throw new KinuError('bad_input', 'agent.scaffoldVersions: limit must be a number when given');

          return await host.listScaffoldVersions(parsed.output);
        },
      },
      schedule: {
        description: 'Schedule a future autonomous turn: { cron } recurring OR { atMs } one-shot (epoch ms), with optional label/payload. The reactor wakes you when it fires. Optional budget_usd / budget_tokens give the whole schedule a cumulative host-enforced spend cap covering every turn it wakes and everything those turns spawn.',
        execute: async (...args: unknown[]) => {
          const parsed = v.safeParse(ScheduleOptionsSchema, args[0] ?? {});

          if (!parsed.success) throw new KinuError('bad_input', 'agent.schedule: invalid schedule options');
          const opts = parsed.output;
          const { cron, atMs } = opts;

          if (!cron && atMs === undefined) throw new KinuError('bad_input', 'agent.schedule: provide { cron } or { atMs }');

          if (cron && nextCronFire(cron, Date.now()) === null) throw new KinuError('bad_input', `agent.schedule: unsupported cron expression: ${cron}`);

          if (atMs !== undefined && atMs <= Date.now()) throw new KinuError('bad_input', 'agent.schedule: atMs must be in the future');
          // Declared before the trigger so the first fire carries the label; a named label re-enters its row.
          const limits = readMissionLimits(opts);

          const declaredLabel = opts.budget_label?.trim();
          let missionLabel: string | undefined;

          // A blank label names no sub-ledger; the generated one keeps it addressable.
          if (limits) missionLabel = declaredLabel === undefined || declaredLabel === '' ? `schedule-${nanoid()}` : declaredLabel;

          const budget = limits && missionLabel ? host.budget.declare(missionLabel, limits) : undefined;

          const result: TimerTrigger & { budget?: JsonValue } = await host.createTimerTrigger({
              cron, atMs, missionLabel,
              label: opts.label,
              payload: opts.payload,
            });

          if (budget) result.budget = decodeJsonValue({ value: budget });

          return result;
        },
      },
      budget: {
        description: 'Read a mission budget: pass a label, or omit to read whatever the current turn spends against. Returns [] when this run is uncapped (the default).',
        execute: async (...args: unknown[]) => {
          const parsed = v.safeParse(v.optional(v.string()), args[0]);

          if (!parsed.success) throw new KinuError('bad_input', 'agent.budget: label must be a string when given');

          return host.budget.snapshot(parsed.output);
        },
      },
      cancelSchedule: {
        description: 'Cancel a previously-scheduled trigger by id (idempotent).',
        execute: async (...args: unknown[]) => {
          const parsed = v.safeParse(NonEmptyStringSchema, args[0]);

          if (!parsed.success) throw new KinuError('bad_input', 'agent.cancelSchedule: id must be a non-empty string');

          return await host.cancelTrigger(parsed.output, 'self');
        },
      },
      jobResult: {
        description: BACKGROUND_DESCRIPTION,
        execute: async (...args: unknown[]) => {
          const parsed = v.safeParse(NonEmptyStringSchema, args[0]);

          if (!parsed.success) throw new KinuError('bad_input', 'agent.jobResult: jobId must be a non-empty string');

          return formatJobRead(await host.jobResult(parsed.output));
        },
      },
      backgroundJobs: {
        description: 'List your recent background jobs (newest first) with their status.',
        execute: async (...args: unknown[]) => {
          const parsed = v.safeParse(OptionalNumberSchema, args[0]);

          if (!parsed.success) throw new KinuError('bad_input', 'agent.backgroundJobs: limit must be a number when given');

          return await host.listBackgroundJobs(parsed.output);
        },
      },
      compactNow: {
        description: 'Fold the conversation now: arm the compaction ladder so your NEXT turn is assembled from a fresh handoff checkpoint instead of waiting for the token trigger. Use it at a phase boundary. The folded range is archived verbatim and listed in the checkpoint\'s Compaction Archive manifest, so nothing is lost.',
        execute: async () => {
          host.armCompactNow();

          return { armed: true, appliesAt: 'next-turn-assembly' };
        },
      },
      replayEvals: {
        description: 'Read your replay-eval loss curve (newest first): past outcome-labeled turns re-run against the current config, scored against how they originally landed. Each entry carries the 95% confidence interval on its mean score — a move inside the interval is noise, not progress.',
        execute: async (...args: unknown[]) => {
          const parsed = v.safeParse(OptionalNumberSchema, args[0]);

          if (!parsed.success) throw new KinuError('bad_input', 'agent.replayEvals: limit must be a number when given');

          return await host.getReplayEvals(parsed.output);
        },
      },
    },
  };
}
