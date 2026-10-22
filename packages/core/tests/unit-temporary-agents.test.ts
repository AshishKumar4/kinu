import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
// `lifetime:'task'` hires through the public surfaces (native dispatch and sandbox namespace). A hire returns at once;
// its answer is one `subagent_report` on the hirer's rail, which wakes it, and the child retires after its turn.
import { readModelTree, ROOT_DELEGATION_BUDGET } from './helpers-agents';
import { Database } from 'bun:sqlite';
import { asSchema, type ModelMessage } from 'ai';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { DELEGATION_MAX_DEPTH, delegationExhausted, SubagentRosterStore, TEMPORARY_LIFETIME, EventLog, TASK_TURN_ENDINGS, agentsActionsFor, initEventsHubTables, terminalTaskReport, createAgentsCodemodeProvider, createTeamToolDeps, createTemporaryAgentPort, taskAnswerIsLater, delegationDepthRefusal, receiveSubagentEvent, type SubagentEventResult, type SubagentReportHandoff, TOOL_REACH, type AgentsToolDeps, type AgentsProfileContext, type SubagentHandoff, type SubagentRuntime, type TemporaryAgentPort, type WorkMode, type AgentsOp, type CodemodeResult, callOperation, BUILTIN_PROFILE_CATALOG, profileCatalogDigest, DEFAULT_WORKERS_AI_MODEL_SPEC, recoverSubagentLifecycles, codemodeFunction, failedToolOutcome, successfulToolOutcome, withCodemodeProgram } from '../src/index';
import { createAgentsTool } from '../src/delegation/agents-operations';
import { createMemoryVfs, seedFiles } from '@kinu.run/test-utils';
import { makeSql, makeExecRaw, makeSqlExec } from './helpers';
import type { ActorReference } from '../src/identity/actor-handle';
import { createTestActors, present, toolExecute } from '@kinu.run/test-utils';
import type { JsonObject, JsonValue } from '../src/utils/json';

const TEST_MODEL = DEFAULT_WORKERS_AI_MODEL_SPEC;

function testProfile(): AgentsProfileContext {
  const catalog = {
    roles: BUILTIN_PROFILE_CATALOG.roles,
    tiers: {
      default: { model: TEST_MODEL },
      fast: { model: TEST_MODEL },
      deep: { model: TEST_MODEL },
    },
  };

  return {
    envelope: {
      authority: { kind: 'local' } as const,
      version: 0,
      digest: profileCatalogDigest(catalog),
      catalog,
    },
    provider: { revision: 'test-1', availableModels: [TEST_MODEL] },
    roleId: 'auditor',
    availableTools: [],
    pins: {},
  };
}

/** A hire chain `depth` levels below the root. */
const budgetAt = (depth: number) => ({ depth, maxDepth: Math.max(0, DELEGATION_MAX_DEPTH - depth) });

const NOW = 1_700_000_000_000;

type SandboxMember = (...args: unknown[]) => Promise<CodemodeResult>;

type SandboxNamespace = Partial<Record<string, SandboxMember>>;

const HANDOFF: SubagentHandoff = {
  eventId: 'evt-1',
  delivery: 'starts_now',
  phase: { busy: false, lastActivityAt: null, workingOn: null },
};

const TEMP_NAME = 'ask-auditor-a1b2c3';

/** A `subagent_report` row's payload, as its hirer reads it. */
const ReportRowSchema = v.looseObject({
  status: v.string(), content: v.string(), concerns: v.optional(v.array(v.string())),
});

interface Scene {
  deps: AgentsToolDeps;
  temporary: TemporaryAgentPort;
  roster: SubagentRosterStore;
  /** The hirer's own rail. */
  log: EventLog;
  recover(clearFailure?: boolean): Promise<boolean>;
  /** Every child-substrate operation, in order. */
  calls: string[];
  briefs: string[];
  assignments: Array<Parameters<SubagentRuntime['assign']>[1]>;
  /** Each child as it was born. */
  births: Array<Parameters<SubagentRuntime['spawn']>[0]>;
  /** Counts `subagent_report` rows on the real event log. */
  published(): number;
  /** The newest `subagent_report` row's payload. */
  lastReport(): v.InferOutput<typeof ReportRowSchema> | undefined;
  /** Every retire the port scheduled for after a child's turn, run. */
  released(): Promise<void>;
  wakes: number[];
  report(input: {
    from?: string;
    status?: 'progress' | 'completed' | 'blocked';
    content: string;
    origin?: 'report_tool' | 'turn_end';
    handoff?: SubagentReportHandoff;
    quiet?: true;
  }): Promise<SubagentEventResult>;
  /** One served `agents` operation, as a program calls it. */
  call(op: AgentsOp, fields: JsonObject, signal?: AbortSignal): Promise<JsonValue>;
  sandbox(): SandboxNamespace;
  files: VFS;
  /** A registered task hire named `name`, for a roster row written directly. */
  hired(name: string): ActorReference;
}

/** `actor_subagents` is keyed by parent so one actor cannot touch another's child by name. */
/** The roster and the actor directory over one database: a hire's origin is read from its actor row. */
function rosterWorld(db: Database) {
  const actors = createTestActors(makeSql(db), makeExecRaw(db));

  return { roster: new SubagentRosterStore(makeSqlExec(db), actors.main), directory: actors.directory, main: actors.main };
}

function makeScene(options: {
  fail?: keyof SubagentRuntime;
  failRelease?: boolean;
  delegation?: { depth: number };
  duringAssignment?: () => Promise<void>;
  withoutTemporary?: boolean;
  originContext?: ModelMessage[];
} = {}): Scene {
  const eventDb = new Database(':memory:');
  const world = rosterWorld(eventDb);
  const { roster, directory } = world;
  roster.ensureSchema();
  const { vfs: files } = createMemoryVfs();
  const calls: string[] = [];
  const briefs: string[] = [];
  const assignments: Array<Parameters<SubagentRuntime['assign']>[1]> = [];
  const births: Array<Parameters<SubagentRuntime['spawn']>[0]> = [];
  let sequence = 0;
  let callSequence = 0;
  const wakes: number[] = [];
  const eventSql = makeSqlExec(eventDb);
  initEventsHubTables(eventSql);
  const log = new EventLog(eventSql, directory.main());

  const runtime: SubagentRuntime = {
    async spawn(input) {
      calls.push(`spawn:${input.name}`);
      births.push(input);

      if (options.fail === 'spawn') throw new Error('the facet substrate is unavailable');

      return directory.apply(directory.main(), [], { action: 'register', name: input.name, creationId: input.creationId, origin: input.origin, lifetime: input.lifetime }).reference;
    },
    async cancelBirth(input) {
      const actor = directory.apply(directory.main(), [], { action: 'cancelCreation', name: input.name, creationId: input.creationId, origin: input.origin, lifetime: input.lifetime });

      if (actor.state !== 'deleted') directory.apply(directory.main(), [], { action: 'release', name: input.name, reference: actor.reference });

      return actor.reference;
    },
    async assign(name, input) {
      calls.push(`assign:${name}`);
      briefs.push(input.body);
      assignments.push(input);

      if (options.fail === 'assign') throw new Error('admission refused');
      await options.duringAssignment?.();

      return HANDOFF;
    },
    async status() {
      return { lastActivity: null, recentSteps: [] };
    },
    async message() { return HANDOFF; },
    async dismiss(name, { keepHistory }) {
      calls.push(`dismiss:${name}:${keepHistory}`);

      if (options.failRelease) throw new Error('the release failed');

      return { stoppedJobs: [] };
    },
    async rename() { /* not reached by this rung */ },
  };

  const retires: Promise<void>[] = [];

  const portInput: Parameters<typeof createTemporaryAgentPort>[0] = {
    roster,
    runtime,
    createName: (role: string) => `${role}-a1b2c3`,
    now: () => NOW,
    afterTurn: (_child, work) => { retires.push(work()); },
  };

  const temporary = createTemporaryAgentPort(portInput);

  const teamInput: Parameters<typeof createTeamToolDeps>[0] = {
    delegation: options.delegation
      ? budgetAt(options.delegation.depth)
      : ROOT_DELEGATION_BUDGET,
    roster,
    runtime,
    createName: (role) => `${role}-a1b2c3`,
    now: () => NOW,
    inheritedContext: async () => [],
    originContext: async () => options.originContext ?? [],
    ownMission: () => 'Keep the release train moving.',
    rosterMoved: () => { /* no listeners in this scene */ },
    ...readModelTree(eventDb, world, log),
    broadcastTask: () => { /* no listeners in this scene */ },
  };

  // Absent, not empty: every gate reads the key's presence.
  if (!options.withoutTemporary) Object.assign(teamInput, { temporary });
  const team = createTeamToolDeps(teamInput);

  const deps: AgentsToolDeps = {
    mode: 'build' satisfies WorkMode,
    swarms: true,
    team,
    profile: () => testProfile(),
  };

  return {
    recover: async (clearFailure) => {
      if (clearFailure) { delete options.fail; delete options.failRelease; }

      return recoverSubagentLifecycles(roster, runtime);
    },
    deps,
    temporary,
    roster,
    log,
    calls,
    briefs,
    assignments,
    births,
    files,
    hired: (name) => {
      const live = directory.list().find((record) => record.name === name && record.deletedAt === null);

      return live === undefined
        ? directory.apply(directory.main(), [], { action: 'register', name, creationId: `fixture-${name}`, origin: 'agent', lifetime: 'task' }).reference
        : { actorId: live.actorId, workspaceId: live.workspaceId, parentActorId: live.parentActorId };
    },
    published: () => log.pending().filter((event) => event.variant === 'subagent_report').length,
    lastReport: () => {
      const last = log.pending().filter((event) => event.variant === 'subagent_report').at(-1);

      return last === undefined ? undefined : v.parse(ReportRowSchema, last.payload);
    },
    released: async () => { await Promise.all(retires); },
    wakes,
    report: (input) => receiveSubagentEvent({
      log,
      roster,
      vfs: files,
      transaction: (body) => body(),
      announce: () => { /* the rail row is the record; see `published()` */ },
      onAdmitted: () => { wakes.push(1); },
      evolutionAnswerStored: () => undefined,
      onEvolutionAnswer: () => undefined,
      temporary,
    }, {
      fromSubagent: input.from ?? TEMP_NAME,
      status: input.status ?? 'completed',
      content: input.content,
      origin: input.origin ?? 'report_tool',
      handoff: input.handoff,
      ...(input.quiet === true && { quiet: true }),
      // The ingress dedupes on this, so each report needs its own.
      sequenceId: `temp:${++sequence}`,
      mode: 'build',
    }, NOW),
    call: async (op, fields, signal) =>
      (await callOperation([createAgentsCodemodeProvider(() => deps)], `agents.${op}`, fields, { callId: `call-${++callSequence}`, signal })).value,
    sandbox: () => {
      const provider = createAgentsCodemodeProvider(() => deps);
      const members: SandboxNamespace = {};

      for (const [name, entry] of Object.entries(provider.tools)) members[name] = entry.execute;

      return members;
    },
  };
}

/** What the native `agents` tool says of a call its schema refuses, or null when it takes it. */
function nativeRefusal(deps: AgentsToolDeps, input: JsonObject): string | null {
  const checked = v.parse(v.object({ success: v.boolean(), error: v.optional(v.instance(Error)) }),
    present(asSchema(createAgentsTool(deps).inputSchema).validate, 'the agents tool validates').call(null, input));

  return checked.success ? null : checked.error?.message ?? '';
}

/** What the turn records of a call that threw. */
async function thrownOutcome<Result>(pending: Promise<Result>) {
  try { await pending; }
  catch (cause) { return failedToolOutcome({ cause }); }

  throw new Error('the call did not fail');
}

/** A task hire, which returns at once with its child working. */
async function startRun(scene: Scene, input: JsonObject): Promise<v.InferOutput<typeof WorkingOutcome>> {
  return v.parse(WorkingOutcome, await scene.call('hire', { lifetime: 'task', ...input }));
}

const WorkingOutcome = v.object({
  status: v.literal('working'),
  agent: v.string(),
  lifetime: v.literal(TEMPORARY_LIFETIME),
  role: v.string(),
  answer: v.string(),
  transcript: v.literal('kept'),
});

const FailedOutcome = v.object({
  status: v.literal('failed'),
  agent: v.string(),
  lifetime: v.literal(TEMPORARY_LIFETIME),
  role: v.string(),
  answer: v.string(),
  transcript: v.picklist(['kept', 'none']),
  reason: v.string(),
});

describe('a task-lifetime hire returns at once and its answer arrives as a message', () => {
  test('a forked task hire starts with its birth-time conversation intact, and retires after its answer', async () => {
    const conversation: ModelMessage[] = [{ role: 'user', content: 'The ledger uses integer cents.' }];
    const scene = makeScene({ originContext: conversation });
    expect(await startRun(scene, { role: 'auditor', message: 'Audit the ledger.', context: 'inherit' })).toMatchObject({ status: 'working', transcript: 'kept' });
    conversation[0] = { role: 'user', content: 'Changed after dispatch.' };
    expect(scene.assignments[0]?.inheritedContext).toEqual({ kind: 'fork', messages: [
      { id: 'ctx-0', role: 'user', content: 'The ledger uses integer cents.', createdAt: 0 },
    ] });
    await scene.report({ content: 'The ledger balances.' });
    await scene.released();
    expect(scene.roster.list()).toEqual([]);
    expect(scene.calls).toEqual([`spawn:${TEMP_NAME}`, `assign:${TEMP_NAME}`, `dismiss:${TEMP_NAME}:true`]);
  });

  test('a forked hire persists the bounded dispatch conversation before birth and re-drives that copy', async () => {
    const conversation: ModelMessage[] = Array.from({ length: 51 }, () => ({ role: 'user', content: 'Earlier turn.' }));
    conversation.push({ role: 'assistant', content: 'A'.repeat(1000) + 'B'.repeat(1000) });
    const scene = makeScene({ fail: 'spawn', originContext: conversation });
    await expect(scene.call('hire', { role: 'auditor', message: 'Continue the audit.', context: 'inherit' }))
      .rejects.toMatchObject({ code: 'unavailable' });
    const inherited = scene.roster.requireExisting('auditor-a1b2c3').birth?.assignment?.inheritedContext;
    expect(inherited?.kind).toBe('fork');

    if (inherited?.kind !== 'fork') throw new Error('No fork survived admission.');
    expect(inherited.messages).toHaveLength(51);
    expect(inherited.messages[0]).toEqual({ id: 'ctx-omitted', role: 'system', createdAt: -1,
      content: '(2 earlier messages omitted from inherited context: durable state lives in the workspace files)' });
    expect(inherited.messages.at(-1)).toEqual({ id: 'ctx-49', role: 'assistant', createdAt: 49,
      content: 'A'.repeat(800) + '\n[... 400 chars omitted from the middle ...]\n' + 'B'.repeat(800) });
    conversation.splice(0, conversation.length, { role: 'user', content: 'After the interruption.' });
    await scene.recover(true);
    expect(scene.assignments[0]?.inheritedContext).toEqual(inherited);
    expect(scene.roster.requireExisting('auditor-a1b2c3').birth).toBeNull();
    await present(scene.deps.team, 'the scene\'s team port').assign({ name: 'auditor-a1b2c3', task: 'One more question.', mode: 'build' });
    expect(scene.assignments[1]?.inheritedContext?.kind).not.toBe('fork');
  });

  test('lifetime decides the roster: a task hire leaves no live row after its answer and a durable hire does', async () => {
    const scene = makeScene();
    await startRun(scene, { role: 'auditor', message: 'Audit the ledger.' });
    await scene.report({ content: 'The ledger balances.' });
    expect(scene.roster.list()).toEqual([]);

    const hired = await scene.call('hire', { role: 'auditor', message: 'Audit the ledger.' });
    expect(hired).toMatchObject({ name: expect.any(String) });
    expect(hired).not.toHaveProperty('answer');
    expect(scene.roster.list().map((entry) => entry.lifetime)).toEqual(['durable']);
  });

  // The schema offers `name` on every hire; on staging 5c522f12d a task hire refused it 6 times, Luna naming 3 parallel
  // subagents to tell their answers apart.
  test('a task hire takes the name it is given, as the subagent it shows', async () => {
    const scene = makeScene();
    const started = await startRun(scene, { role: 'auditor', message: 'Count signups by country.', name: 'signup-country-tally' });

    expect(scene.births).toEqual([expect.objectContaining({ name: started.agent, displayName: 'signup-country-tally', nameOrigin: 'user' })]);
  });

  test('the call says the agent is working, and its answer is one rail event that wakes the hirer', async () => {
    const scene = makeScene();

    expect(await startRun(scene, { role: 'auditor', message: 'Is the migration reversible?' })).toEqual({
      status: 'working', agent: TEMP_NAME, lifetime: 'task', role: 'auditor', answer: expect.stringContaining('arrives later'), transcript: 'kept',
    });
    expect(scene.calls).toEqual([`spawn:${TEMP_NAME}`, `assign:${TEMP_NAME}`]);

    const delivered = await scene.report({ content: 'Yes — the down migration is tested.' });
    expect(delivered.disposition).toBe('admitted');
    expect(delivered.id).not.toBe('');
    expect(scene.published()).toBe(1);
    expect(scene.lastReport()).toMatchObject({ status: 'completed', content: 'Yes — the down migration is tested.' });
    expect(scene.wakes).toEqual([1]);

    await scene.released();
    expect(scene.roster.list()).toEqual([]);
    expect(scene.roster.listAll()).toMatchObject([{ name: TEMP_NAME, lifetime: 'task', status: 'dismissed' }]);
    expect(scene.calls).toEqual([`spawn:${TEMP_NAME}`, `assign:${TEMP_NAME}`, `dismiss:${TEMP_NAME}:true`]);
  });

  test('the same hire from codemode starts identically', async () => {
    const scene = makeScene();
    const hire = present(scene.sandbox().hire, 'the codemode hire entry');
    expect(v.parse(WorkingOutcome, await hire('auditor', 'Is the migration reversible?', { lifetime: 'task' })))
      .toMatchObject({ status: 'working', agent: TEMP_NAME, lifetime: 'task' });
  });

  test('a child that reports blocked delivers its own words as the message', async () => {
    const scene = makeScene();
    await startRun(scene, { role: 'auditor', message: 'Check the invoice totals.' });
    await scene.report({ status: 'blocked', content: 'The ledger export is missing for March.' });
    expect(scene.lastReport()).toMatchObject({ status: 'blocked', content: 'The ledger export is missing for March.' });
    expect(scene.roster.list()).toEqual([]);
  });

  // Review P1 (integration/0963): the hire had settled and left the roster, but its answer was still unread on the
  // hirer's rail, and a task hirer answered from the turn it spent on something else.
  test('a task hirer\'s answer is a later turn\'s while a hire\'s report waits unread on its rail', async () => {
    const scene = makeScene();
    await startRun(scene, { role: 'auditor', message: 'Audit the ledger.' });
    expect(taskAnswerIsLater({ roster: scene.roster, log: scene.log })).toBe(true);

    await scene.report({ content: 'Totals reconcile.' });
    expect(scene.roster.list()).toEqual([]);
    expect(taskAnswerIsLater({ roster: scene.roster, log: scene.log })).toBe(true);

    // Read by the turn that takes it up: nothing is owed any more.
    for (const row of scene.log.pending({ variant: 'subagent_report' })) scene.log.markConsumed(row.id, 'turn-read', 0, NOW);
    expect(taskAnswerIsLater({ roster: scene.roster, log: scene.log })).toBe(false);
  });

  // Review P1 (integration/0963): the durable-only guard was the waiter's, and it kept the owner from deleting one.
  test('the owner deletes a working task hire, and it leaves the roster', async () => {
    const scene = makeScene();
    await startRun(scene, { role: 'auditor', message: 'Audit the ledger.' });

    await present(scene.deps.team, 'the scene\'s team port').dismiss({ name: TEMP_NAME, keepHistory: false, requestedBy: 'user' });

    expect(scene.roster.list()).toEqual([]);
    expect(scene.calls).toContain(`dismiss:${TEMP_NAME}:false`);
  });

  test('a mid-work progress note does not settle the task agent; its answer is the second message', async () => {
    const scene = makeScene();
    await startRun(scene, { role: 'auditor', message: 'Audit the ledger.' });
    await scene.report({ status: 'progress', content: 'Reading the March export.', origin: 'report_tool' });
    expect(scene.published()).toBe(1);
    expect(await scene.call('list', {})).toMatchObject({
      tree: [{ name: 'main', you: true }, { name: TEMP_NAME, kind: 'hired', depth: 1, doing: 'Audit the ledger.' }],
    });
    await scene.report({ content: 'Totals reconcile.' });
    expect(scene.published()).toBe(2);
    expect(scene.roster.list()).toEqual([]);
  });

  test('the finished turn relay settles the task agent without a report tool call', async () => {
    const scene = makeScene();
    await startRun(scene, { role: 'auditor', message: 'Summarise the incident.' });
    await scene.report({ status: 'progress', origin: 'turn_end', content: 'Root cause: an unregistered callback URL.' });
    expect(scene.lastReport()).toMatchObject({ content: 'Root cause: an unregistered callback URL.' });
    expect(scene.roster.list()).toEqual([]);
  });

  test('a structured handoff travels on the message', async () => {
    const scene = makeScene();
    await startRun(scene, { role: 'auditor', message: 'Audit the ledger.' });
    await scene.report({
      content: 'Totals reconcile.',
      handoff: { concerns: ['March is reconciled against a copy, not the source export'] },
    });

    expect(scene.lastReport()).toMatchObject({
      content: 'Totals reconcile.', concerns: ['March is reconciled against a copy, not the source export'],
    });
  });
});

describe('the roster shows a temporary agent while it runs and keeps its history after', () => {
  test('an answer before the assignment acknowledgement still lands as the message', async () => {
    const scene = makeScene({
      duringAssignment: async () => {
        await scene.report({ content: 'The answer reaches the parent before its assignment acknowledgement.' });
      },
    });

    expect(await startRun(scene, { role: 'auditor', message: 'Audit the ledger.' })).toMatchObject({ status: 'working' });
    expect(scene.lastReport()).toMatchObject({ content: 'The answer reaches the parent before its assignment acknowledgement.' });
    expect(scene.wakes).toEqual([1]);
    expect(await scene.call('list', {})).toMatchObject({ tree: [{ name: 'main' }], counts: { retired: 1 } });
  });

  test('running under lifetime task, released into history, listed only when retired agents are asked for', async () => {
    const scene = makeScene();
    expect(await scene.call('list', {})).toMatchObject({
      tree: [{ name: 'main', you: true }],
      note: 'No subagents yet: create one with op:"hire".',
    });

    await startRun(scene, { role: 'auditor', message: 'Audit the ledger.' });
    const running = await scene.call('list', {});
    expect(running).toMatchObject({
      tree: [{ name: 'main' }, { name: TEMP_NAME, kind: 'hired', depth: 1, doing: 'Audit the ledger.' }],
      counts: { retired: 0 },
    });
    expect(running).not.toHaveProperty('note');

    await scene.report({ content: 'Totals reconcile.' });

    const after = await scene.call('list', {});
    expect(after).toMatchObject({ tree: [{ name: 'main' }], counts: { idle: 0, retired: 1 } });
    expect(await scene.call('list', { retired: true })).toMatchObject({ tree: [{ name: 'main' }, { name: TEMP_NAME, status: 'dismissed' }] });
    expect(scene.roster.listAll()).toMatchObject([{
      name: TEMP_NAME, lifetime: 'task', status: 'dismissed', dismissedAt: NOW,
    }]);
  });

  // The detail arm must resolve released names, not only the active roster.
  test('a released temporary agent still resolves by name through list, while staying unaddressable', async () => {
    const scene = makeScene();
    await startRun(scene, { role: 'auditor', message: 'Audit the ledger.' });
    await scene.report({ content: 'Totals reconcile.' });

    expect(await scene.call('list', {})).toMatchObject({ tree: [{ name: 'main' }], counts: { retired: 1 } });
    expect(await scene.call('list', { agent: TEMP_NAME })).toMatchObject({
      roster: { name: TEMP_NAME, lifetime: 'task', status: 'dismissed' },
    });
    await expect(scene.call('assign', { agent: TEMP_NAME, message: 'one more thing' }))
      .rejects.toMatchObject({ code: 'bad_input' });
  });

  test('a lost spawn acknowledgement retains its admitted birth for recovery', async () => {
    const scene = makeScene({ fail: 'spawn' });
    const failed = v.parse(FailedOutcome, await scene.call('hire', { lifetime: 'task', role: 'auditor', message: 'Audit the ledger.' }));
    expect(failed.status).toBe('failed');
    expect(failed.reason).toBe('unavailable');
    expect(failed.answer).toContain('the facet substrate is unavailable');
    const birth = scene.roster.requireExisting(TEMP_NAME).birth;
    expect(birth?.seed.mission).toBe('Audit the ledger.');
    await scene.recover(true);
    expect(scene.roster.requireExisting(TEMP_NAME).birth).toBeNull();
    expect(scene.roster.requireExisting(TEMP_NAME).taskEventId).toBe(HANDOFF.eventId);
  });

  // Cleanup after a failed `create` must remove only a row this call wrote, never the colliding agent's.
  test('a name collision on create leaves the colliding agent\'s row untouched', async () => {
    const scene = makeScene();
    await present(scene.deps.team, 'the scene\'s team port').spawn({
      name: TEMP_NAME, role: 'auditor',
      mission: 'Investigate.', mode: 'build',
    });
    const before = scene.roster.listAll();
    expect(before).toHaveLength(1);
    scene.calls.length = 0;

    const failed = v.parse(FailedOutcome, await scene.call('hire', { lifetime: 'task', role: 'auditor', message: 'Audit the ledger.' }));

    expect(failed.status).toBe('failed');
    expect(failed.transcript).toBe('none');
    expect(scene.roster.listAll()).toEqual(before);
    expect(scene.roster.list().map((entry) => [entry.name, entry.lifetime]))
      .toEqual([[TEMP_NAME, 'durable']]);
    expect(scene.calls).toEqual([]);
  });

  test('a lost first-assignment acknowledgement retains the same issued actor', async () => {
    const scene = makeScene({ fail: 'assign' });
    const failed = v.parse(FailedOutcome, await scene.call('hire', { lifetime: 'task', role: 'auditor', message: 'Audit the ledger.' }));
    expect(failed.reason).toBe('unavailable');
    expect(failed.answer).toContain('admission refused');
    const actor = scene.roster.requireExisting(TEMP_NAME).actorReference;
    await scene.recover(true);
    expect(scene.roster.requireExisting(TEMP_NAME).actorReference).toEqual(actor);
    expect(scene.roster.requireExisting(TEMP_NAME).birth).toBeNull();
    expect(scene.roster.requireExisting(TEMP_NAME).taskEventId).toBe(HANDOFF.eventId);
  });

  test('a failed recovery cleanup preserves both failure evidence and deletion intent', async () => {
    const scene = makeScene({ fail: 'assign', failRelease: true });
    const failed = v.parse(FailedOutcome, await scene.call('hire', { lifetime: 'task', role: 'auditor', message: 'Audit the ledger.' }));
    expect(failed.answer).toContain('admission refused');
    const actor = scene.roster.requireExisting(TEMP_NAME).actorReference;

    if (!actor) throw new Error('The acknowledged seed has no actor reference.');
    scene.roster.requestDeletion(TEMP_NAME, actor, NOW);
    await expect(scene.recover()).rejects.toThrow('the release failed');
    expect(scene.roster.requireExisting(TEMP_NAME).actorReference).toEqual(actor);
    expect(scene.roster.requireExisting(TEMP_NAME).deleteRequested).toBe(true);
    await scene.recover(true);
    expect(scene.roster.get(TEMP_NAME)).toBeNull();
  });
});

describe('a task answer finds its row wherever its hire started', () => {
  // The turn-end relay reports `progress`; `temporaryRunSettles` must treat it as the answer.
  test('a turn_end answer with no waiter releases the row too, not just a terminal report', async () => {
    const scene = makeScene();
    scene.roster.create({ name: TEMP_NAME, actorReference: scene.hired(TEMP_NAME), birth: null, deleteRequested: false, status: 'working', currentTask: 'Audit the ledger.', createdAt: NOW, dismissedAt: null, taskEventId: 'evt-1' });

    const delivered = await scene.report({
      status: 'progress', origin: 'turn_end', content: 'Totals reconcile.',
    });

    expect(delivered.disposition).toBe('admitted');
    expect(scene.published()).toBe(1);
    expect(scene.roster.list()).toEqual([]);
    expect(scene.roster.listAll()).toMatchObject([{
      name: TEMP_NAME, lifetime: 'task', status: 'dismissed', dismissedAt: NOW,
    }]);
  });

  test('a task agent stays working until its settling report, even after a turn ends', async () => {
    const scene = makeScene();
    scene.roster.create({ name: TEMP_NAME, actorReference: scene.hired(TEMP_NAME), birth: null, deleteRequested: false, status: 'working', currentTask: 'Audit the ledger.', createdAt: NOW, dismissedAt: null, taskEventId: 'evt-1' });
    await scene.report({ status: 'progress', origin: 'report_tool', content: 'Reading March.' });
    scene.roster.finishTurn(TEMP_NAME, 'answered', NOW);
    expect(scene.roster.list()).toMatchObject([{
      name: TEMP_NAME, lifetime: 'task', status: 'working',
    }]);
  });

  test('a durable subagent is left in the roster by the very report that releases a task one', async () => {
    const scene = makeScene();
    await present(scene.deps.team, 'the scene\'s team port').spawn({
      name: 'researcher', role: 'researcher',
      mission: 'Investigate.', mode: 'build',
    });
    await scene.report({ from: 'researcher', content: 'Root cause found.' });
    expect(scene.published()).toBe(1);
    expect(scene.roster.list()).toMatchObject([{
      name: 'researcher', lifetime: 'durable', status: 'idle', currentTask: null,
    }]);
  });
});

describe('a child that cannot answer still settles its hire', () => {
  // Every task turn ending settles the row; a failure is delivered as the message, a Stop settles quietly.
  for (const ending of TASK_TURN_ENDINGS) {
    if (ending === 'answered') continue;
    test(`a ${ending} turn settles the row and ${ending === 'interrupted' ? 'wakes no one' : 'delivers its failure'}`, async () => {
      const scene = makeScene();
      await startRun(scene, { role: 'auditor', message: 'Audit the ledger.' });
      const report = present(await terminalTaskReport({ lifetime: 'task', ending, assistantText: '', narration: async () => [] }), 'the child\'s terminal report');
      await scene.report({ status: report.status, origin: 'turn_end', content: report.content, ...(report.quiet === true && { quiet: true }) });
      await scene.released();

      expect(scene.published()).toBe(ending === 'interrupted' ? 0 : 1);
      expect(scene.roster.list()).toEqual([]);
      expect(scene.calls).toContain(`dismiss:${TEMP_NAME}:true`);
    });
  }

  /** An answer, or a child that owes no such report, never reads its steps' words. */
  const unread = (): Promise<readonly string[]> => { throw new Error('the narration was read'); };

  test('an answered ending carries the child\'s own words as the answer', async () => {
    expect(await terminalTaskReport({ lifetime: 'task', ending: 'answered', assistantText: '  done  ', narration: unread }))
      .toEqual({ status: 'completed', content: 'done' });
    expect(await terminalTaskReport({ lifetime: 'task', ending: 'answered', assistantText: '   ', narration: unread }))
      .toMatchObject({ status: 'blocked' });
  });

  test('a stopped or failed ending reports each step\'s words apart, a repeat once, then why it ended', async () => {
    const found = 'Step 2: two refunds lack a receipt:\n- r-17\n- r-22';
    const steps = ['Step 1: the ledger totals match.', '', 'Let me check the refunds.', 'Let me check the refunds.', found];
    const stopped = present(await terminalTaskReport({ lifetime: 'task', ending: 'interrupted', assistantText: found, narration: async () => steps }), 'the report');

    expect(stopped.status).toBe('blocked');
    expect(stopped.content).toStartWith(`Step 1: the ledger totals match.\n\nLet me check the refunds.\n\n${found}\n\n`);
    // Three steps and the reason: the repeat is said once, and the closing words that are a step are not said again.
    expect(stopped.content.split('\n\n')).toHaveLength(4);
    // A runner's own summary that is not one of the steps' words follows them.
    const failed = present(await terminalTaskReport({ lifetime: 'task', ending: 'errored', assistantText: 'Head h1 errored: out of budget', narration: async () => steps }), 'the report');

    expect(failed.content).toContain(`${found}\n\nHead h1 errored: out of budget\n\n`);
  });

  test('a durable child owes its failure, a quiet note for a Stop, and nothing extra for an answer', async () => {
    expect(await terminalTaskReport({ lifetime: 'durable', ending: 'answered', assistantText: 'x', narration: unread })).toBeNull();
    expect(await terminalTaskReport({ lifetime: 'durable', ending: 'errored', assistantText: '', narration: async () => [] }))
      .toMatchObject({ status: 'blocked' });
    expect(await terminalTaskReport({ lifetime: 'durable', ending: 'interrupted', assistantText: '', narration: async () => [] }))
      .toMatchObject({ status: 'blocked', quiet: true });
  });
});

describe('the two hire targets are decided by `role`', () => {
  test('a blank message is a failed call natively and in a program\'s failure census, and no agent is created', async () => {
    const scene = makeScene();

    // What the turn records of a native call that threw.
    expect(await thrownOutcome(toolExecute<JsonObject, JsonValue>(createAgentsTool(scene.deps))({ op: 'hire', lifetime: 'task', role: 'auditor', message: '   ' })))
      .toEqual({ success: false, reason: 'bad_input' });

    const hire = present(scene.sandbox().hire, 'the codemode hire entry');
    const census = [{ success: false as const, reason: 'bad_input' as const, error: expect.any(String), tool: 'agents', op: 'hire' }];

    // Bound inside the program, as a program binds its members when it starts. One that goes on is told of it; one that
    // returns the refusal fails with it.
    const recovered = await withCodemodeProgram(async () => {
      await codemodeFunction('agents', 'hire', hire)('auditor', '   ', { lifetime: 'task' });

      return { result: null };
    }, { call: 'call-test' });

    expect(successfulToolOutcome('eval', { output: recovered })).toEqual({ success: true, failures: census });
    expect(await thrownOutcome(withCodemodeProgram(async () => ({ result: await codemodeFunction('agents', 'hire', hire)('auditor', '   ', { lifetime: 'task' }) }), { call: 'call-test' })))
      .toMatchObject({ success: false, reason: 'bad_input', failures: census });
    // The port refuses a brief with no role the same way, for the hirers that are not this tool.
    await expect(scene.temporary.start({ role: 'auditor', roleLabel: ' ', task: 'Survey auth', mode: 'build' })).rejects.toMatchObject({ code: 'bad_input' });
    expect(scene.roster.listAll()).toEqual([]);
  });

  test('a hire to an existing agent is unchanged: it reports back later, it does not resolve here', async () => {
    const scene = makeScene();
    await present(scene.deps.team, 'the scene\'s team port').spawn({
      name: 'researcher', role: 'researcher',
      mission: 'Investigate.', mode: 'build',
    });
    scene.calls.length = 0;
    expect(await scene.call('assign', { agent: 'researcher', message: 'Find the cause.' }))
      .toMatchObject({ status: 'working', agent: 'researcher', event_id: 'evt-1' });
    expect(scene.roster.list().map((entry) => [entry.name, entry.lifetime]))
      .toEqual([['researcher', 'durable']]);
  });

  test('the advertised hire states the lifetime the dispatch routes on', () => {
    const scene = makeScene();
    const hire = JSON.stringify(asSchema(createAgentsTool(scene.deps).inputSchema).jsonSchema);
    expect(hire).toContain('"lifetime"');
    expect(hire).not.toContain('context_ref');
    const declared = present(createAgentsCodemodeProvider(() => scene.deps).declarations?.hire, 'agents.hire is declared').full;
    expect(declared).toContain('hire(role: string, message: string, options?: {');
    expect(declared).toContain('lifetime?: "durable" | "task";');
    expect(declared).not.toContain('context_ref');
  });
});

describe('bulk material travels by path, not by field', () => {
  test('a path named in the message reaches the child brief and the bytes never do', async () => {
    const scene = makeScene();
    await seedFiles(scene.files, { '/spill/tool-output.txt': 'x'.repeat(5000) });

    await startRun(scene, {
      role: 'auditor',
      message: 'What failed in /spill/tool-output.txt? Read it yourself.',
    });

    await scene.report({ content: 'A timeout on the third request.' });
    const brief = scene.briefs[0] ?? '';
    expect(brief).toContain('/spill/tool-output.txt');
    expect(brief).not.toContain('x'.repeat(200));
  });

  test('the retired fields are refused by name before any agent is created', () => {
    const scene = makeScene();
    expect(nativeRefusal(scene.deps, { op: 'hire', lifetime: 'task', role: 'auditor', message: 'Summarise', context_ref: ['/spill/missing.txt'] }))
      .toContain('unknown field "context_ref"');
    expect(nativeRefusal(scene.deps, { op: 'assign', agent: 'researcher', message: 'Survey auth', deadline_hint: 'today' }))
      .toContain('unknown field "deadline_hint"');
    expect(scene.calls).toEqual([]);
    expect(scene.roster.list()).toEqual([]);
  });
});

describe('the rung is structural, and so is its absence', () => {
  test('without the port the task lifetime is absent from the surface and denied at the seam', async () => {
    const scene = makeScene({ withoutTemporary: true });
    const declared = present(createAgentsCodemodeProvider(() => scene.deps).declarations?.hire, 'agents.hire is declared').full;
    expect(declared).toContain('hire(');
    expect(declared).not.toContain('lifetime');
    // The field is not on the surface it reaches, so the call is refused before any agent is created.
    const pending = scene.call('hire', { lifetime: 'task', role: 'auditor', message: 'go' });
    await expect(pending).rejects.toMatchObject({ code: 'bad_input' });
    await expect(pending).rejects.toThrow('unknown field "lifetime"');
    expect(agentsActionsFor(scene.deps)).toContain('hire');
  });

  // A task hire adds a depth level like a durable one; this covers toolsets cached before the child's depth was seeded.
  test('at the cap a task-lifetime hire is refused exactly as a durable one is', async () => {
    const capped = makeScene({ delegation: { depth: DELEGATION_MAX_DEPTH } });
    expect(delegationExhausted(present(capped.deps.team, 'the capped scene\'s team port').delegation)).toBe(true);

    const team = capped.deps.team;

    if (!team) throw new Error('the depth fixture has no team');

    // At the cap the agent has no team at all: neither hire is an operation it has, and nothing is spawned.
    const refusals = await Promise.allSettled([
      capped.call('hire', { lifetime: 'task', role: 'auditor', message: 'Audit the ledger.' }),
      capped.call('hire', { role: 'auditor', message: 'Audit the ledger.' }),
    ]);

    const codes = refusals.map((settled) => (settled.status === 'rejected' ? v.parse(v.object({ code: v.string() }), settled.reason).code : null));

    expect({ refused: codes.every((code) => code !== null), alike: codes[0] === codes[1] }).toEqual({ refused: true, alike: true });
    expect(capped.calls).toEqual([]);
    expect(capped.roster.listAll()).toEqual([]);
  });

  test('the depth refusal suggests no call the capped surface refuses', () => {
    // The refusal teaches only what the capped agent can do, or it teaches an unwinnable retry: at the cap it has no
    // team and no search, so it names neither and says to do the work itself.
    const remedy = delegationDepthRefusal({ depth: DELEGATION_MAX_DEPTH, maxDepth: 0 }).error;
    expect(remedy).toContain('do the work yourself');
    expect(remedy).not.toContain('op:"swarm"');
    expect(remedy).not.toContain('op:"assign"');
    expect(remedy).not.toContain('ask by');
  });

  test('a task child is a real agent: it can hire a role of its own until the cap', () => {
    for (const depth of [1, 2, 3]) {
      const child = makeScene({ delegation: { depth } });
      expect(present(child.deps.team, 'the child scene\'s team port').temporary).toBeDefined();
      expect(agentsActionsFor(child.deps)).toContain('hire');
    }

    const leaf: AgentsToolDeps = { mode: 'build', swarms: true };
    expect(agentsActionsFor(leaf)).not.toContain('hire');
  });

});

describe('the standalone recursive-LM namespace is gone', () => {
  test('no tool declares an `rlm` reach', () => {
    expect(Object.keys(TOOL_REACH)).not.toContain('rlm');
    expect(Object.values(TOOL_REACH).map((reach) => reach.codemode)).not.toContain('rlm');
  });

  test('the sandbox namespace an actor gets never declares rlm', () => {
    const scene = makeScene();
    const provider = createAgentsCodemodeProvider(() => scene.deps);
    expect(provider.types ?? '').not.toContain('rlm');
    expect(Object.keys(provider.tools)).not.toContain('query');
  });
});
