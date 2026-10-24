/**
 * `agent.*`: the agent's own lifecycle, for its programs. Its curriculum, scaffold, schedules, budgets, background jobs
 * and quality; delegation is `agents.*`.
 */
import * as v from 'valibot';
import { PROPOSED_TASK_STATUSES } from '../types/proposals';
import { BACKGROUND_POLICY } from '../types/jobs';
import { JsonObjectSchema } from '../utils/json';
import { WatchCheckSchema } from '../types/watch';
import { described, namespace } from './operation';
import { OwnerWaitSchema } from '../types/owner-waits';

const Count = (text: string) => v.optional(described(v.pipe(v.number(), v.integer(), v.minValue(1)), text));

const Id = v.pipe(v.string(), v.nonEmpty());

const agentOp = namespace('agent', { slate: false });

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
      + '`host.*`; `rationale` is at least 50 characters. It lands pending and goes live only when your owner promotes it; '
      + 'one proposal is pending at a time. `baseVersion` branches from an archived one.',
    input: v.strictObject({
      rationale: v.pipe(v.string(), v.nonEmpty()), code: v.pipe(v.string(), v.nonEmpty()),
      baseVersion: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    }),
    output: v.unknown(),
  }),
  createWorkspace: agentOp({
    name: 'createWorkspace', impact: 'administer',
    help: 'A new workspace in your owner\'s account, created now: no approval, and it shows in their Changelog. `name` '
      + 'titles it (one line), `brief` is its mission, which its first turn acts on, and `soul` is the rest of its '
      + 'SOUL.md: who it is and how it works ("" for none). Answers its address and link; reach it with `agents.message`.',
    input: v.strictObject({
      name: v.pipe(v.string(), v.nonEmpty()), brief: v.pipe(v.string(), v.nonEmpty()), soul: v.string(),
    }),
    output: v.strictObject({ workspace: v.string(), url: v.string() }),
  }),
  scaffoldVersions: agentOp({
    name: 'scaffoldVersions', help: 'Your scaffold versions with their status and lineage.', impact: 'observe',
    input: v.strictObject({ limit: Count('Most versions to list.') }), output: v.unknown(),
  }),
  schedule: agentOp({
    name: 'schedule', impact: 'mutate',
    help: 'A future turn: `cron` recurs, `atMs` (epoch ms) fires once. `budgetUsd`/`budgetTokens` cap everything its turns '
      + 'spend, across fires; `budgetLabel` shares one ledger between schedules. With `check` it is a watcher: at each firing '
      + 'the program runs first, reading only the namespaces `reads` names (their observing members) and `state`, what it '
      + 'last answered, and returns { fire: false, state? } or { fire: true, brief, state? }; only a fire starts the turn, '
      + 'with `brief` in it, and a check costs no model call. With `push: { github: "owner/repo" }` in place of `cron`/`atMs`, '
      + 'it runs on each delivery GitHub sends for that repository of one `event` (default "push"; one watcher per event): '
      + 'the check\'s input is { event, delivery, payload }. The account\'s GitHub connection makes the repository\'s hook, '
      + 'so it needs admin rights there; cancelling deletes the hook.',
    input: v.strictObject({
      cron: v.optional(v.pipe(v.string(), v.nonEmpty())), atMs: v.optional(v.pipe(v.number(), v.finite())),
      push: v.optional(v.strictObject({
        github: v.pipe(v.string(), v.nonEmpty()),
        event: v.optional(v.pipe(v.string(), v.regex(/^[a-z_]{1,64}$/, 'a GitHub event name, as `push` or `pull_request`'))),
      })),
      label: v.optional(v.string()), payload: v.optional(JsonObjectSchema),
      budgetUsd: v.optional(v.number()), budgetTokens: v.optional(v.number()), budgetLabel: v.optional(v.string()),
      check: v.optional(WatchCheckSchema),
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
  waitingOnOwner: agentOp({
    name: 'waitingOnOwner', impact: 'observe',
    help: 'What waits on your owner now, newest first: parked commands and file writes, plans to approve, proposed '
      + 'workspaces, device consents and open questions, each with its `key`, what it is, since when and which agent '
      + 'asked. The workspace agent reads them all; a hire, only its own. Account-memory proposals are not listed: '
      + 'your owner\'s account holds them, and this workspace is never told when they are decided.',
    input: v.strictObject({}), output: v.array(OwnerWaitSchema),
  }),
  wakeWhenOwnerDone: agentOp({
    name: 'wakeWhenOwnerDone', impact: 'mutate',
    help: 'Be woken once your owner has handled everything `waitingOnOwner` lists for you, or, with `key`, that one '
      + 'item: the wake arrives as a system event in your chat, once. Answers { armed: true } and you end your turn, '
      + 'or { already: true } when nothing waits. Arming again replaces the earlier wait.',
    input: v.strictObject({ key: v.optional(described(v.pipe(v.string(), v.nonEmpty()), 'One item\'s key, from waitingOnOwner.')) }),
    output: v.union([v.strictObject({ armed: v.literal(true) }), v.strictObject({ already: v.literal(true) })]),
  }),
  quality: agentOp({
    name: 'quality', impact: 'observe',
    help: 'How satisfied people were with your turns, one row per day over the last `days` (default 30), oldest first: the mean '
      + 'rating from 1 to 5 with its 95% interval.',
    input: v.strictObject({ days: Count('Days to read; default 30.') }), output: v.unknown(),
  }),
} as const;
