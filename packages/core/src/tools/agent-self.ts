/**
 * `agent.*` — the agent's self-direction codemode namespace.
 *
 * Lets the LLM steer ITSELF from inside execute_tools: propose + accept its own
 * Voyager-style curriculum, and schedule future autonomous turns (delivered by
 * the event→turn reactor). Registered exactly like the RLM provider — zero new
 * top-level builtins, so it respects the 6-tool surface.
 *
 * Every method here calls back into the host, so nothing about it is
 * platform-shaped and both backends register the same provider. Written twice,
 * it drifted the way tool surfaces do: the local copy accepted a cron
 * expression its scheduler could never fire, and told the model nothing about
 * the threshold that hands it a { jobId } instead of a result. Neither is a
 * crash — they are an agent quietly worse at steering itself.
 *
 * Deliberately NOT here: `forkAgent` — the workspace-clone RPC behind the UI's
 * fork-chat, which copies the whole agent DO at a message and rejects while a
 * turn is in flight. Cloning the actor mid-script is not delegation.
 *
 * Delegation itself is NOT absent from the sandbox — it just isn't duplicated
 * here. The `agents.*` namespace projects the existing `agents` tool over the
 * actor's own deps (core tools/agents-codemode.ts), so there is still exactly
 * one spawn/join implementation, with one more caller.
 */
import * as v from 'valibot';
import type { CodemodeProvider } from '../rlm';
import { readMissionLimits, type MissionGovernor } from '../mission-budget';
import { nextCronFire } from '../events/hub/cron';
import { BACKGROUND_POLICY } from '../jobs/index';
import type { BackgroundJob } from '../jobs/store';
import type { ProposedTask } from '../curriculum/proposer';
import type { ModifyResult } from '../scaffold/modify';
import type { ScaffoldVersionView } from '../evolution/control';
import type { ReplayEvalSummary } from '../evolution/replay';
import type { TimerTrigger } from '../events/ingress/triggers';
import { nanoid } from '../utils/nanoid';
import { TOOL_REACH } from './registry';
import { decodeJsonValue, JsonObjectSchema, type JsonObject, type JsonValue } from '../utils/json';
import { renderThrownChain } from '../obs/index';

type CurriculumStatus = 'pending' | 'accepted' | 'rejected' | 'completed';

/** The narrow slice of the agent the `agent.*` tools call through to — all
 *  existing methods on both backends, so there's no duplicated logic. */
export interface AgentSelfHost {
  proposeCurriculumTasks(count?: number): Promise<ProposedTask[] | { proposals: ProposedTask[] }>;
  listCurriculumTasks(status?: CurriculumStatus): Promise<ProposedTask[] | { tasks: ProposedTask[] }>;
  setCurriculumTaskStatus(id: string, status: CurriculumStatus): Promise<{ ok: boolean }>;
  proposeScaffold(rationale: string, code: string, baseVersion?: number): Promise<ModifyResult>;
  listScaffoldVersions(limit?: number): Promise<ScaffoldVersionView[]> | ScaffoldVersionView[];
  createTimerTrigger(opts: {
    cron?: string; atMs?: number; label?: string; payload?: JsonObject;
    missionLabel?: string;
  }): Promise<TimerTrigger>;
  /** The cumulative spend governor — a schedule declares its mission budget
   *  here, and `agent.budget` reads it back. */
  readonly budget: MissionGovernor;
  cancelTrigger(id: string): Promise<{ ok: boolean; changed: boolean }> | { ok: boolean; changed: boolean };
  jobResult(jobId: string): Promise<BackgroundJob | null>;
  listBackgroundJobs(limit?: number): Promise<BackgroundJob[]>;
  getReplayEvals(limit?: number): Promise<ReplayEvalSummary[]>;
  /** Arm the compaction ladder's forced rebuild for this session's NEXT turn
   *  assembly — the same one-shot flag overflow recovery uses. */
  armCompactNow(): void;
}

const TYPES = `export declare const agent: {
  /** Propose N self-curriculum tasks (Voyager-style); returns the proposals. */
  proposeCurriculum(count?: number): Promise<unknown>;
  /** List your proposed curriculum tasks, optionally filtered by status. */
  listCurriculum(status?: 'pending' | 'accepted' | 'rejected' | 'completed'): Promise<unknown>;
  /** Accept a proposed task by id (it becomes runnable). */
  acceptCurriculumTask(id: string): Promise<unknown>;
  /** Propose a new version of your own scaffold (the agentic loop). Routed
   *  through the existing 4-gate validation + the fixed misevolution gate; an
   *  accepted proposal becomes the pending version, is scored by shadow
   *  evaluation against the live scaffold, and only goes live after winning
   *  the promotion gate. The code must export \`async function* run(rt, task)\`
   *  and reach the host only via the \`host.*\` bridge; rationale must be
   *  ≥ 50 chars. Pass \`baseVersion\` to branch from an archived variant
   *  (see scaffoldVersions) instead of the live current. */
  proposeScaffold(rationale: string, code: string, baseVersion?: number):
    Promise<{ ok: boolean; version?: number; error?: string; stage?: number }>;
  /** Read-only scaffold archive: your versions with status (current/pending/
   *  historical/rolled_back), lineage (parent_version) and shadow-eval record
   *  (wins/losses/ties/win_rate). Stepping stones for proposeScaffold. */
  scaffoldVersions(limit?: number): Promise<unknown>;
  /** Schedule a future autonomous turn. Pass { cron } for recurring OR
   *  { atMs } (epoch ms) for one-shot; optional label + payload. The reactor
   *  wakes you when it fires.
   *  Optionally give the whole schedule a CUMULATIVE spend cap with
   *  budget_usd / budget_tokens: every turn it wakes, every fork those turns
   *  run and everything they spawn debit one durable ledger, and the host
   *  declines further model calls and spawns once it is spent — a long
   *  autonomous run cannot outspend it by writing code that forgets to stop.
   *  Recurring schedules accumulate across fires; name budget_label to share
   *  one ledger across several schedules. Omit for no cap. */
  schedule(opts: {
    cron?: string; atMs?: number; label?: string; payload?: object;
    budget_usd?: number; budget_tokens?: number; budget_label?: string;
  }): Promise<{ id: string; kind: string; nextFireAt: number | null; budget?: unknown }>;
  /** Cancel a previously-scheduled trigger by id. Idempotent: changed is
   *  false when it was already revoked. */
  cancelSchedule(id: string): Promise<{ ok: boolean; changed: boolean }>;
  /** Read a mission budget: one label, or everything the CURRENT turn spends
   *  against when called with no argument. Returns [] when this run is
   *  uncapped, which is the default. */
  budget(label?: string): Promise<unknown>;
  /** Read a background job. A SETTLED job returns its full row — result or
   *  error. When a job backgrounds you get a { jobId } and are woken with the
   *  result when it settles: the wake is the delivery, so call this for the
   *  job a wake named (or to re-read an old one), never in a loop — a job
   *  still running has no result to read. */
  jobResult(jobId: string): Promise<{ id: string; kind: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; result?: string | null; error?: string | null; note?: string } | null>;
  /** List your recent background jobs (newest first). */
  backgroundJobs(limit?: number): Promise<unknown>;
  /** Fold the conversation NOW: arm the compaction ladder so your next turn is
   *  assembled from a fresh handoff checkpoint instead of waiting for the
   *  token trigger. Call it at a phase boundary — a piece of work finished and
   *  its tool traffic is no longer worth carrying. Nothing is lost: the folded
   *  range is archived verbatim and listed in the checkpoint's Compaction
   *  Archive manifest, so exact prior wording stays one workspace.readFile
   *  away. One fold per call, applied at the next turn assembly. */
  compactNow(): Promise<{ armed: boolean; appliesAt: 'next-turn-assembly' }>;
  /** Read-only loss curve: replay-eval entries (newest first) — outcome-
   *  labeled past turns re-run against your CURRENT config and scored
   *  against how they originally landed. loss = 1 − mean score, and every
   *  entry carries an 'interval' field — the 95% CI on that mean. Read them
   *  together. */
  replayEvals(limit?: number): Promise<unknown>;
};
`;

/**
 * What the model is told about auto-backgrounding.
 *
 * Both thresholds, named with the rule that picks them, and read from
 * BACKGROUND_POLICY rather than written down: the surface is a property of the
 * TURN on this backend, and this provider is built once per DO, so a single
 * hardcoded number was necessarily wrong on half the turns the agent serves.
 */
const BACKGROUND_DESCRIPTION =
  'Read a background job\'s settled result. A fork backgrounds the moment it spawns on a live chat '
  + 'session; other long tool calls background once they outrun this turn\'s threshold '
  + `(${BACKGROUND_POLICY.interactive.detachAfterMs / 1000}s on a chat turn a human is watching, `
  + `${BACKGROUND_POLICY['one-shot'].detachAfterMs / 1000}s on an autonomous turn woken by an event, `
  + 'a timer or a job). Either way the call hands back { jobId } and you are WOKEN with the result '
  + 'when the job settles — the wake is the delivery. Call this for the job a wake named, or to '
  + 're-read an old result; a job still running has no result to read.';

/** What a jobResult read hands the model. A SETTLED job is the row itself —
 *  the result is there to read. A job still RUNNING is NOT an empty row to
 *  re-poll: the read states the wake contract instead, so a poll loop has
 *  nothing to spin on. (The measured lesson behind the shape: prose alone
 *  converts at 0%, mechanisms do — this return value is the mechanism.) */
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
  v.picklist(['pending', 'accepted', 'rejected', 'completed']),
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
          if (!parsed.success) return { error: 'agent.proposeCurriculum: count must be a number when given' };
          const count = parsed.output;
          try { return await host.proposeCurriculumTasks(count); }
          catch (err) { return { error: `agent.proposeCurriculum: ${renderThrownChain({ cause: err })}` }; }
        },
      },
      listCurriculum: {
        description: 'List your proposed curriculum tasks, optionally filtered by status (pending/accepted/rejected/completed).',
        execute: async (...args: unknown[]) => {
          const parsed = v.safeParse(OptionalCurriculumStatusSchema, args[0]);
          if (!parsed.success) return { error: 'agent.listCurriculum: invalid status' };
          const status = parsed.output;
          try { return await host.listCurriculumTasks(status); }
          catch (err) { return { error: `agent.listCurriculum: ${renderThrownChain({ cause: err })}` }; }
        },
      },
      acceptCurriculumTask: {
        description: 'Accept a proposed curriculum task by id so it becomes runnable.',
        execute: async (...args: unknown[]) => {
          const parsed = v.safeParse(NonEmptyStringSchema, args[0]);
          if (!parsed.success) return { error: 'agent.acceptCurriculumTask: id must be a non-empty string' };
          try { return await host.setCurriculumTaskStatus(parsed.output, 'accepted'); }
          catch (err) { return { error: `agent.acceptCurriculumTask: ${renderThrownChain({ cause: err })}` }; }
        },
      },
      proposeScaffold: {
        description: 'Propose a new version of your own agentic-loop scaffold. Routed through the 4-gate validation + misevolution gate + shadow evaluation; only goes live after winning the promotion gate. rationale ≥ 50 chars; code must export async function* run(rt, task) and use the host.* bridge. Optional baseVersion branches from an archived variant.',
        execute: async (...args: unknown[]) => {
          const [rationale, code, baseVersion] = args;
          const parsedRationale = v.safeParse(NonEmptyStringSchema, rationale);
          if (!parsedRationale.success) return { error: 'agent.proposeScaffold: rationale must be a non-empty string' };
          const parsedCode = v.safeParse(NonEmptyStringSchema, code);
          if (!parsedCode.success) return { error: 'agent.proposeScaffold: code must be a non-empty string' };
          const parsedBase = v.safeParse(OptionalBaseVersionSchema, baseVersion);
          if (!parsedBase.success) return { error: 'agent.proposeScaffold: baseVersion must be a non-negative integer when given' };
          try { return await host.proposeScaffold(parsedRationale.output, parsedCode.output, parsedBase.output); }
          catch (err) { return { error: `agent.proposeScaffold: ${renderThrownChain({ cause: err })}` }; }
        },
      },
      scaffoldVersions: {
        description: 'Read-only scaffold archive: versions with status, lineage (parent_version) and shadow-eval record — the stepping stones proposeScaffold can branch from.',
        execute: async (...args: unknown[]) => {
          const parsed = v.safeParse(OptionalNumberSchema, args[0]);
          if (!parsed.success) return { error: 'agent.scaffoldVersions: limit must be a number when given' };
          try { return await host.listScaffoldVersions(parsed.output); }
          catch (err) { return { error: `agent.scaffoldVersions: ${renderThrownChain({ cause: err })}` }; }
        },
      },
      schedule: {
        description: 'Schedule a future autonomous turn: { cron } recurring OR { atMs } one-shot (epoch ms), with optional label/payload. The reactor wakes you when it fires. Optional budget_usd / budget_tokens give the whole schedule a cumulative host-enforced spend cap covering every turn it wakes and everything those turns spawn.',
        execute: async (...args: unknown[]) => {
          const parsed = v.safeParse(ScheduleOptionsSchema, args[0] ?? {});
          if (!parsed.success) return { error: 'agent.schedule: invalid schedule options' };
          const opts = parsed.output;
          const { cron, atMs } = opts;
          if (!cron && atMs === undefined) return { error: 'agent.schedule: provide { cron } or { atMs }' };
          if (cron && nextCronFire(cron, Date.now()) === null) return { error: `agent.schedule: unsupported cron expression: ${cron}` };
          if (atMs !== undefined && atMs <= Date.now()) return { error: 'agent.schedule: atMs must be in the future' };
          // The ledger is declared BEFORE the trigger so the schedule can carry
          // its label from the first fire; a named label re-enters the existing
          // cumulative row rather than starting a fresh one.
          const limits = readMissionLimits(opts);
          const missionLabel = limits
            ? (opts.budget_label?.trim() || `schedule-${nanoid()}`)
            : undefined;
          try {
            const budget = limits && missionLabel ? host.budget.declare(missionLabel, limits) : undefined;
            const result: TimerTrigger & { budget?: JsonValue } = await host.createTimerTrigger({
                cron, atMs, missionLabel,
                label: opts.label,
                payload: opts.payload,
              });
            if (budget) result.budget = decodeJsonValue({ value: budget });
            return result;
          } catch (err) { return { error: `agent.schedule: ${renderThrownChain({ cause: err })}` }; }
        },
      },
      budget: {
        description: 'Read a mission budget: pass a label, or omit to read whatever the current turn spends against. Returns [] when this run is uncapped (the default).',
        execute: async (...args: unknown[]) => {
          const parsed = v.safeParse(v.optional(v.string()), args[0]);
          if (!parsed.success) return { error: 'agent.budget: label must be a string when given' };
          try { return host.budget.snapshot(parsed.output); }
          catch (err) { return { error: `agent.budget: ${renderThrownChain({ cause: err })}` }; }
        },
      },
      cancelSchedule: {
        description: 'Cancel a previously-scheduled trigger by id (idempotent).',
        execute: async (...args: unknown[]) => {
          const parsed = v.safeParse(NonEmptyStringSchema, args[0]);
          if (!parsed.success) return { error: 'agent.cancelSchedule: id must be a non-empty string' };
          try { return await host.cancelTrigger(parsed.output); }
          catch (err) { return { error: `agent.cancelSchedule: ${renderThrownChain({ cause: err })}` }; }
        },
      },
      jobResult: {
        description: BACKGROUND_DESCRIPTION,
        execute: async (...args: unknown[]) => {
          const parsed = v.safeParse(NonEmptyStringSchema, args[0]);
          if (!parsed.success) return { error: 'agent.jobResult: jobId must be a non-empty string' };
          try { return formatJobRead(await host.jobResult(parsed.output)); }
          catch (err) { return { error: `agent.jobResult: ${renderThrownChain({ cause: err })}` }; }
        },
      },
      backgroundJobs: {
        description: 'List your recent background jobs (newest first) with their status.',
        execute: async (...args: unknown[]) => {
          const parsed = v.safeParse(OptionalNumberSchema, args[0]);
          if (!parsed.success) return { error: 'agent.backgroundJobs: limit must be a number when given' };
          try { return await host.listBackgroundJobs(parsed.output); }
          catch (err) { return { error: `agent.backgroundJobs: ${renderThrownChain({ cause: err })}` }; }
        },
      },
      compactNow: {
        description: 'Fold the conversation now: arm the compaction ladder so your NEXT turn is assembled from a fresh handoff checkpoint instead of waiting for the token trigger. Use it at a phase boundary. The folded range is archived verbatim and listed in the checkpoint\'s Compaction Archive manifest, so nothing is lost.',
        execute: async () => {
          try {
            host.armCompactNow();
            return { armed: true, appliesAt: 'next-turn-assembly' };
          } catch (err) { return { error: `agent.compactNow: ${renderThrownChain({ cause: err })}` }; }
        },
      },
      replayEvals: {
        description: 'Read your replay-eval loss curve (newest first): past outcome-labeled turns re-run against the current config, scored against how they originally landed. Each entry carries the 95% confidence interval on its mean score — a move inside the interval is noise, not progress.',
        execute: async (...args: unknown[]) => {
          const parsed = v.safeParse(OptionalNumberSchema, args[0]);
          if (!parsed.success) return { error: 'agent.replayEvals: limit must be a number when given' };
          try { return await host.getReplayEvals(parsed.output); }
          catch (err) { return { error: `agent.replayEvals: ${renderThrownChain({ cause: err })}` }; }
        },
      },
    },
  };
}
