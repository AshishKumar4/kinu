/**
 * `agent.*`: the agent's own lifecycle, for its programs. Its curriculum, scaffold, schedules, budgets, background jobs
 * and quality; delegation is `agents.*`.
 */
import * as v from 'valibot';
import { PROPOSED_TASK_STATUSES } from '../types/proposals';
import { BACKGROUND_POLICY } from '../types/jobs';
import { JsonObjectSchema } from '../utils/json';
import { defineOperation, type Operation } from './operation';

const described = <S extends v.GenericSchema>(schema: S, text: string) => v.pipe(schema, v.description(text));

const Count = (text: string) => v.optional(described(v.pipe(v.number(), v.integer(), v.minValue(1)), text));

const Id = v.pipe(v.string(), v.nonEmpty());

const agentOp = <const I extends v.StrictObjectSchema<v.ObjectEntries, undefined>, const O extends v.GenericSchema>(
  op: Pick<Operation<I, O>, 'name' | 'help' | 'impact' | 'input' | 'output'> & { readonly plan?: boolean },
) => defineOperation({ ns: 'agent', slate: false, ...op });

const BACKGROUND_HELP = 'A background job\'s settled result. A search backgrounds the moment it spawns on a live chat '
  + 'session; other long calls background once they outrun this turn\'s threshold '
  + `(${String(BACKGROUND_POLICY.interactive.detachAfterMs / 1000)}s on a chat turn a person is watching, `
  + `${String(BACKGROUND_POLICY['one-shot'].detachAfterMs / 1000)}s on a turn an event, a timer or a job woke). `
  + 'The call hands back { jobId } and you are woken with the result when the job settles: the wake is the delivery. '
  + 'Read the job a wake named, or an old result again; a job still running has no result to read.';

export const AGENT = {
  proposeCurriculum: agentOp({
    name: 'proposeCurriculum', help: 'Propose self-curriculum tasks for your own improvement.', impact: 'mutate', plan: true,
    input: v.strictObject({ count: Count('How many; the host chooses when absent.') }), output: v.unknown(),
  }),
  listCurriculum: agentOp({
    name: 'listCurriculum', help: 'Your proposed curriculum tasks, by status when given.', impact: 'observe',
    input: v.strictObject({ status: v.optional(v.picklist(PROPOSED_TASK_STATUSES)) }), output: v.unknown(),
  }),
  acceptCurriculumTask: agentOp({
    name: 'acceptCurriculumTask', help: 'Accept a proposed curriculum task, so it becomes runnable.', impact: 'mutate',
    input: v.strictObject({ id: Id }), output: v.unknown(),
  }),
  proposeScaffold: agentOp({
    name: 'proposeScaffold', impact: 'administer',
    help: 'A new version of your scaffold: `code` exports `async function* run(rt, task)` and reaches the host only through '
      + '`host.*`; `rationale` is at least 50 characters. It goes live only after winning a shadow evaluation against the '
      + 'current version; `baseVersion` branches from an archived one.',
    input: v.strictObject({
      rationale: v.pipe(v.string(), v.nonEmpty()), code: v.pipe(v.string(), v.nonEmpty()),
      baseVersion: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    }),
    output: v.unknown(),
  }),
  proposeWorkspace: agentOp({
    name: 'proposeWorkspace', impact: 'administer',
    help: 'A new workspace under your owner\'s account, which your owner approves once in the Work tab before it exists. '
      + '`name` titles it (one line), `brief` is its mission, which its first turn acts on, and `soul` is the rest of its '
      + 'SOUL.md: who it is and how it works. The call answers { status: "pending" }; the decision wakes you, with the '
      + 'new workspace\'s link when it is approved.',
    input: v.strictObject({
      name: v.pipe(v.string(), v.nonEmpty()), soul: v.string(), brief: v.pipe(v.string(), v.nonEmpty()),
    }),
    output: v.strictObject({ status: v.literal('pending'), proposal: v.string(), note: v.string() }),
  }),
  scaffoldVersions: agentOp({
    name: 'scaffoldVersions', help: 'Your scaffold versions with status, lineage and shadow-evaluation record.', impact: 'observe',
    input: v.strictObject({ limit: Count('Most versions to list.') }), output: v.unknown(),
  }),
  schedule: agentOp({
    name: 'schedule', impact: 'mutate',
    help: 'A future turn: `cron` recurs, `atMs` (epoch ms) fires once. `budgetUsd`/`budgetTokens` cap everything its turns '
      + 'spend, across fires; `budgetLabel` shares one ledger between schedules.',
    input: v.strictObject({
      cron: v.optional(v.pipe(v.string(), v.nonEmpty())), atMs: v.optional(v.pipe(v.number(), v.finite())),
      label: v.optional(v.string()), payload: v.optional(JsonObjectSchema),
      budgetUsd: v.optional(v.number()), budgetTokens: v.optional(v.number()), budgetLabel: v.optional(v.string()),
    }),
    output: v.unknown(),
  }),
  cancelSchedule: agentOp({
    name: 'cancelSchedule', help: 'Cancel a schedule by id; cancelling again changes nothing.', impact: 'mutate',
    input: v.strictObject({ id: Id }), output: v.strictObject({ ok: v.boolean(), changed: v.boolean(), error: v.optional(v.string()) }),
  }),
  budget: agentOp({
    name: 'budget', help: 'One mission budget, or with no label every budget this turn spends against; [] when uncapped.', impact: 'observe',
    input: v.strictObject({ label: v.optional(v.string()) }), output: v.unknown(),
  }),
  jobResult: agentOp({
    name: 'jobResult', help: BACKGROUND_HELP, impact: 'observe',
    input: v.strictObject({ jobId: Id }), output: v.unknown(),
  }),
  backgroundJobs: agentOp({
    name: 'backgroundJobs', help: 'Your recent background jobs, newest first, with their status.', impact: 'observe',
    input: v.strictObject({ limit: Count('Most jobs to list.') }), output: v.unknown(),
  }),
  compactNow: agentOp({
    name: 'compactNow', impact: 'mutate', plan: true,
    help: 'Compact the conversation when the next turn is assembled, rather than waiting for the token trigger; use it at a '
      + 'phase boundary. The folded range stays archived.',
    input: v.strictObject({}), output: v.strictObject({ armed: v.literal(true), appliesAt: v.literal('next-turn-assembly') }),
  }),
  quality: agentOp({
    name: 'quality', impact: 'observe',
    help: 'How satisfied people were with your turns, one row per day over the last `days` (default 30), oldest first: the mean '
      + 'rating from 1 to 5 with its 95% interval.',
    input: v.strictObject({ days: Count('Days to read; default 30.') }), output: v.unknown(),
  }),
} as const;
