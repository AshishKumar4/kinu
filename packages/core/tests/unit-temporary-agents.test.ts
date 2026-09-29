// `lifetime:'task'` hires through the public surfaces (native dispatch and sandbox namespace). A hire returns at once;
// its answer is one `subordinate_report` on the hirer's rail, which wakes it, and the child retires after its turn.
import { Database } from 'bun:sqlite';
import type { ModelMessage } from 'ai';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  DELEGATION_MAX_DEPTH,
  ROOT_DELEGATION_BUDGET,
  delegationExhausted,
  SubordinateRosterStore,
  TEMPORARY_LIFETIME,
  EventLog,
  TASK_TURN_ENDINGS,
  agentsActionsFor,
  initEventsHubTables,
  terminalTaskReport,
  createAgentsCodemodeProvider,
  createTeamToolDeps,
  createTemporaryAgentPort,
  taskAnswerIsLater,
  deriveChildDelegationBudget, delegationDepthRefusal,
  receiveSubordinateEvent,
  type SubordinateEventResult,
  type SubordinateReportHandoff,
  renderAgentsToolDescription,
  TOOL_REACH,
  type AgentsToolDeps,
  type AgentsProfileContext,
  type VFS,
  type SubordinateHandoff,
  type SubordinateRuntime,
  type TemporaryAgentPort,
  type WorkMode,
  type AgentsToolAction,
  type AgentsToolInput,
  type CodemodeResult,
  BUILTIN_PROFILE_CATALOG,
  profileCatalogDigest,
  DEFAULT_WORKERS_AI_MODEL_SPEC, recoverSubordinateLifecycles,
} from '../src/index';
import { dispatchAgentsAction, parseAgentsToolInput } from '../src/delegation/agents-tool';
import { createMemoryVfs } from '@kinu.run/test-utils';
import { makeSql, makeExecRaw, makeSqlExec } from './helpers';
import type { ActorReference } from '../src/identity/actor-handle';
import { createTestActors, present } from '@kinu.run/test-utils';

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
  };
}

/** A hire chain `depth` levels below the root. */
const budgetAt = (depth: number) =>
  Array.from({ length: depth }, () => 0).reduce((budget) => deriveChildDelegationBudget(budget), ROOT_DELEGATION_BUDGET);

const NOW = 1_700_000_000_000;

type SandboxMember = (...args: unknown[]) => Promise<CodemodeResult>;

type SandboxNamespace = Partial<Record<AgentsToolAction, SandboxMember>>;

const HANDOFF: SubordinateHandoff = {
  eventId: 'evt-1',
  delivery: 'starts_now',
  phase: { busy: false, lastActivityAt: null, workingOn: null },
};

const TEMP_NAME = 'ask-auditor-a1b2c3';

/** A `subordinate_report` row's payload, as its hirer reads it. */
const ReportRowSchema = v.looseObject({
  status: v.string(), content: v.string(), concerns: v.optional(v.array(v.string())),
});

interface Scene {
  deps: AgentsToolDeps;
  temporary: TemporaryAgentPort;
  roster: SubordinateRosterStore;
  /** The hirer's own rail. */
  log: EventLog;
  recover(clearFailure?: boolean): Promise<boolean>;
  /** Every child-substrate operation, in order. */
  calls: string[];
  briefs: string[];
  assignments: Array<Parameters<SubordinateRuntime['assign']>[1]>;
  /** Counts `subordinate_report` rows on the real event log. */
  published(): number;
  /** The newest `subordinate_report` row's payload. */
  lastReport(): v.InferOutput<typeof ReportRowSchema> | undefined;
  /** Every retire the port scheduled for after a child's turn, run. */
  released(): Promise<void>;
  wakes: number[];
  report(input: {
    from?: string;
    status?: 'progress' | 'completed' | 'blocked';
    content: string;
    origin?: 'report_tool' | 'turn_end';
    handoff?: SubordinateReportHandoff;
    quiet?: true;
  }): Promise<SubordinateEventResult>;
  call(input: AgentsToolInput, signal?: AbortSignal): Promise<object>;
  sandbox(): SandboxNamespace;
  files: VFS;
  /** A registered task hire named `name`, for a roster row written directly. */
  hired(name: string): ActorReference;
}

/** `actor_subordinates` is keyed by parent so one actor cannot touch another's child by name. */
/** The roster and the actor directory over one database: a hire's origin is read from its actor row. */
function rosterWorld(db: Database) {
  const actors = createTestActors(makeSql(db), makeExecRaw(db));

  return { roster: new SubordinateRosterStore(makeSqlExec(db), actors.main), directory: actors.directory };
}

function makeScene(options: {
  fail?: keyof SubordinateRuntime;
  failRelease?: boolean;
  delegation?: { depth: number };
  duringAssignment?: () => Promise<void>;
  withoutTemporary?: boolean;
  originContext?: ModelMessage[];
} = {}): Scene {
  const eventDb = new Database(':memory:');
  const { roster, directory } = rosterWorld(eventDb);
  roster.ensureSchema();
  const { vfs: files } = createMemoryVfs();
  const calls: string[] = [];
  const briefs: string[] = [];
  const assignments: Array<Parameters<SubordinateRuntime['assign']>[1]> = [];
  let sequence = 0;
  const wakes: number[] = [];
  const eventSql = makeSqlExec(eventDb);
  initEventsHubTables(eventSql);
  const log = new EventLog(eventSql, directory.main());

  const runtime: SubordinateRuntime = {
    async spawn(input) {
      calls.push(`spawn:${input.name}`);

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
    broadcast: () => { /* no listeners in this scene */ },
    broadcastTask: () => { /* no listeners in this scene */ },
  };

  // Absent, not empty: every gate reads the key's presence.
  if (!options.withoutTemporary) Object.assign(teamInput, { temporary });
  const team = createTeamToolDeps(teamInput);

  const deps: AgentsToolDeps = {
    mode: 'build' satisfies WorkMode,
    team,
    profile: () => testProfile(),
  };

  return {
    recover: async (clearFailure) => {
      if (clearFailure) { delete options.fail; delete options.failRelease; }

      return recoverSubordinateLifecycles(roster, runtime);
    },
    deps,
    temporary,
    roster,
    log,
    calls,
    briefs,
    assignments,
    files,
    hired: (name) => {
      const live = directory.list().find((record) => record.name === name && record.deletedAt === null);

      return live === undefined
        ? directory.apply(directory.main(), [], { action: 'register', name, creationId: `fixture-${name}`, origin: 'agent', lifetime: 'task' }).reference
        : { actorId: live.actorId, workspaceId: live.workspaceId, parentActorId: live.parentActorId };
    },
    published: () => log.pending().filter((event) => event.variant === 'subordinate_report').length,
    lastReport: () => {
      const last = log.pending().filter((event) => event.variant === 'subordinate_report').at(-1);

      return last === undefined ? undefined : v.parse(ReportRowSchema, last.payload);
    },
    released: async () => { await Promise.all(retires); },
    wakes,
    report: (input) => receiveSubordinateEvent({
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
      fromSubordinate: input.from ?? TEMP_NAME,
      status: input.status ?? 'completed',
      content: input.content,
      origin: input.origin ?? 'report_tool',
      handoff: input.handoff,
      ...(input.quiet === true && { quiet: true }),
      // The ingress dedupes on this, so each report needs its own.
      sequenceId: `temp:${++sequence}`,
      mode: 'build',
    }, NOW),
    call: (input, signal) => dispatchAgentsAction(
      deps,
      input,
      signal ? { abortSignal: signal } : undefined,
    ),
    sandbox: () => {
      const provider = createAgentsCodemodeProvider(() => deps);
      const members: SandboxNamespace = {};

      for (const action of agentsActionsFor(deps)) {
        const entry = provider.tools[action];

        if (entry) members[action] = entry.execute;
      }

      return members;
    },
  };
}

/** A task hire, which returns at once with its child working. */
async function startRun(scene: Scene, input: Omit<AgentsToolInput, 'action'>): Promise<v.InferOutput<typeof WorkingOutcome>> {
  return v.parse(WorkingOutcome, await scene.call({ action: 'hire', lifetime: 'task', ...input }));
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
    expect(await startRun(scene, { role: 'auditor', mission: 'Audit the ledger.', context: 'inherit' })).toMatchObject({ status: 'working', transcript: 'kept' });
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
    await expect(scene.call({ action: 'hire', role: 'auditor', mission: 'Continue the audit.', context: 'inherit' }))
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
    await startRun(scene, { role: 'auditor', mission: 'Audit the ledger.' });
    await scene.report({ content: 'The ledger balances.' });
    expect(scene.roster.list()).toEqual([]);

    const hired = await scene.call({ action: 'hire', role: 'auditor', mission: 'Audit the ledger.' });
    expect(hired).toMatchObject({ name: expect.any(String) });
    expect(hired).not.toHaveProperty('answer');
    expect(scene.roster.list().map((entry) => entry.lifetime)).toEqual(['durable']);
  });

  test('the call says the agent is working, and its answer is one rail event that wakes the hirer', async () => {
    const scene = makeScene();

    expect(await startRun(scene, { role: 'auditor', mission: 'Is the migration reversible?' })).toEqual({
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

  test('the same call from codemode takes NO action field and starts identically', async () => {
    const scene = makeScene();
    const hire = present(scene.sandbox().hire, 'the codemode hire entry');
    expect(v.parse(WorkingOutcome, await hire({ lifetime: 'task', role: 'auditor', mission: 'Is the migration reversible?' })))
      .toMatchObject({ status: 'working', agent: TEMP_NAME, lifetime: 'task' });
  });

  test('a child that reports blocked delivers its own words as the message', async () => {
    const scene = makeScene();
    await startRun(scene, { role: 'auditor', mission: 'Check the invoice totals.' });
    await scene.report({ status: 'blocked', content: 'The ledger export is missing for March.' });
    expect(scene.lastReport()).toMatchObject({ status: 'blocked', content: 'The ledger export is missing for March.' });
    expect(scene.roster.list()).toEqual([]);
  });

  // Review P1 (integration/0963): the hire had settled and left the roster, but its answer was still unread on the
  // hirer's rail, and a task hirer answered from the turn it spent on something else.
  test('a task hirer\'s answer is a later turn\'s while a hire\'s report waits unread on its rail', async () => {
    const scene = makeScene();
    await startRun(scene, { role: 'auditor', mission: 'Audit the ledger.' });
    expect(taskAnswerIsLater({ roster: scene.roster, log: scene.log })).toBe(true);

    await scene.report({ content: 'Totals reconcile.' });
    expect(scene.roster.list()).toEqual([]);
    expect(taskAnswerIsLater({ roster: scene.roster, log: scene.log })).toBe(true);

    // Read by the turn that takes it up: nothing is owed any more.
    for (const row of scene.log.pending({ variant: 'subordinate_report' })) scene.log.markConsumed(row.id, 'turn-read', 0, NOW);
    expect(taskAnswerIsLater({ roster: scene.roster, log: scene.log })).toBe(false);
  });

  // Review P1 (integration/0963): the durable-only guard was the waiter's, and it kept the owner from deleting one.
  test('the owner deletes a working task hire, and it leaves the roster', async () => {
    const scene = makeScene();
    await startRun(scene, { role: 'auditor', mission: 'Audit the ledger.' });

    await present(scene.deps.team, 'the scene\'s team port').dismiss({ name: TEMP_NAME, keepHistory: false, requestedBy: 'user' });

    expect(scene.roster.list()).toEqual([]);
    expect(scene.calls).toContain(`dismiss:${TEMP_NAME}:false`);
  });

  test('a mid-work progress note does not settle the task agent; its answer is the second message', async () => {
    const scene = makeScene();
    await startRun(scene, { role: 'auditor', mission: 'Audit the ledger.' });
    await scene.report({ status: 'progress', content: 'Reading the March export.', origin: 'report_tool' });
    expect(scene.published()).toBe(1);
    expect(await scene.call({ action: 'list' })).toMatchObject({
      subordinates: [{ name: TEMP_NAME, lifetime: 'task', status: 'working' }],
    });
    await scene.report({ content: 'Totals reconcile.' });
    expect(scene.published()).toBe(2);
    expect(scene.roster.list()).toEqual([]);
  });

  test('the finished turn relay settles the task agent without a report tool call', async () => {
    const scene = makeScene();
    await startRun(scene, { role: 'auditor', mission: 'Summarise the incident.' });
    await scene.report({ status: 'progress', origin: 'turn_end', content: 'Root cause: an unregistered callback URL.' });
    expect(scene.lastReport()).toMatchObject({ content: 'Root cause: an unregistered callback URL.' });
    expect(scene.roster.list()).toEqual([]);
  });

  test('a structured handoff travels on the message', async () => {
    const scene = makeScene();
    await startRun(scene, { role: 'auditor', mission: 'Audit the ledger.' });
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

    expect(await startRun(scene, { role: 'auditor', mission: 'Audit the ledger.' })).toMatchObject({ status: 'working' });
    expect(scene.lastReport()).toMatchObject({ content: 'The answer reaches the parent before its assignment acknowledgement.' });
    expect(scene.wakes).toEqual([1]);
    expect(await scene.call({ action: 'list' })).toMatchObject({ subordinates: [] });
  });

  test('running under lifetime task, released into history, never a subordinate', async () => {
    const scene = makeScene();
    expect(await scene.call({ action: 'list' })).toEqual({
      subordinates: [],
      note: 'No helper agents yet: create one with action:"hire".',
    });

    await startRun(scene, { role: 'auditor', mission: 'Audit the ledger.' });
    const running = await scene.call({ action: 'list' });
    expect(running).toMatchObject({
      subordinates: [{
        name: TEMP_NAME,
        lifetime: 'task',
        status: 'working',
        currentTask: 'Audit the ledger.',
        createdAt: NOW,
        dismissedAt: null,
        taskEventId: 'evt-1',
      }],
    });
    expect(running).not.toHaveProperty('temporary');
    expect(running).not.toHaveProperty('note');

    await scene.report({ content: 'Totals reconcile.' });

    const after = await scene.call({ action: 'list' });
    expect(after).toMatchObject({ subordinates: [] });
    expect(after).not.toHaveProperty('temporary_history');
    expect(scene.roster.listAll()).toMatchObject([{
      name: TEMP_NAME, lifetime: 'task', status: 'dismissed', dismissedAt: NOW,
    }]);
  });

  // The detail arm must resolve released names, not only the active roster.
  test('a released temporary agent still resolves by name through list, while staying unaddressable', async () => {
    const scene = makeScene();
    await startRun(scene, { role: 'auditor', mission: 'Audit the ledger.' });
    await scene.report({ content: 'Totals reconcile.' });

    expect(await scene.call({ action: 'list' })).toMatchObject({ subordinates: [] });
    expect(await scene.call({ action: 'list', agent: TEMP_NAME })).toMatchObject({
      roster: { name: TEMP_NAME, lifetime: 'task', status: 'dismissed' },
    });
    await expect(scene.call({ action: 'hire', agent: TEMP_NAME, message: 'one more thing' }))
      .rejects.toMatchObject({ code: 'bad_input' });
  });

  test('a lost spawn acknowledgement retains its admitted birth for recovery', async () => {
    const scene = makeScene({ fail: 'spawn' });
    const failed = v.parse(FailedOutcome, await scene.call({ action: 'hire', lifetime: 'task', role: 'auditor', mission: 'Audit the ledger.' }));
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

    const failed = v.parse(FailedOutcome, await scene.call({
      action: 'hire', lifetime: 'task', role: 'auditor', mission: 'Audit the ledger.',
    }));

    expect(failed.status).toBe('failed');
    expect(failed.transcript).toBe('none');
    expect(scene.roster.listAll()).toEqual(before);
    expect(scene.roster.list().map((entry) => [entry.name, entry.lifetime]))
      .toEqual([[TEMP_NAME, 'durable']]);
    expect(scene.calls).toEqual([]);
  });

  test('a lost first-assignment acknowledgement retains the same issued actor', async () => {
    const scene = makeScene({ fail: 'assign' });
    const failed = v.parse(FailedOutcome, await scene.call({ action: 'hire', lifetime: 'task', role: 'auditor', mission: 'Audit the ledger.' }));
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
    const failed = v.parse(FailedOutcome, await scene.call({ action: 'hire', lifetime: 'task', role: 'auditor', mission: 'Audit the ledger.' }));
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
    scene.roster.create({ name: TEMP_NAME, actorReference: scene.hired(TEMP_NAME), birth: null, deleteRequested: false, status: 'working', currentTask: 'Audit the ledger.', createdAt: NOW, dismissedAt: null, lifetime: 'task', taskEventId: 'evt-1' });

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

  test('a mid-work report_tool progress note leaves the task row working', async () => {
    const scene = makeScene();
    scene.roster.create({ name: TEMP_NAME, actorReference: scene.hired(TEMP_NAME), birth: null, deleteRequested: false, status: 'working', currentTask: 'Audit the ledger.', createdAt: NOW, dismissedAt: null, lifetime: 'task', taskEventId: 'evt-1' });
    await scene.report({ status: 'progress', origin: 'report_tool', content: 'Reading March.' });
    expect(scene.roster.list()).toMatchObject([{
      name: TEMP_NAME, lifetime: 'task', status: 'working',
    }]);
  });

  test('a durable subordinate is left in the roster by the very report that releases a task one', async () => {
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
      await startRun(scene, { role: 'auditor', mission: 'Audit the ledger.' });
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
  test('a task-lifetime hire refuses a name, because the row is archived before anyone could use it', async () => {
    const scene = makeScene();

    const pending = scene.call({
      action: 'hire', lifetime: 'task', agent: 'named-helper', role: 'auditor', mission: 'go',
    });

    await expect(pending).rejects.toMatchObject({ code: 'bad_input' });
    await expect(pending).rejects.toThrow('never addressable');
    expect(scene.calls).toEqual([]);
    expect(scene.roster.listAll()).toEqual([]);
  });

  test('naming neither target is refused by naming both options', async () => {
    const scene = makeScene();
    const pending = scene.call({ action: 'hire' });
    await expect(pending).rejects.toMatchObject({ code: 'bad_input' });
    await expect(pending).rejects.toThrow('`role`');
    await expect(pending).rejects.toThrow('`agent`');
  });

  test('a hire to an existing agent is unchanged: it reports back later, it does not resolve here', async () => {
    const scene = makeScene();
    await present(scene.deps.team, 'the scene\'s team port').spawn({
      name: 'researcher', role: 'researcher',
      mission: 'Investigate.', mode: 'build',
    });
    scene.calls.length = 0;
    expect(await scene.call({ action: 'hire', agent: 'researcher', message: 'Find the cause.' }))
      .toMatchObject({ status: 'working', agent: 'researcher', event_id: 'evt-1' });
    expect(scene.roster.list().map((entry) => [entry.name, entry.lifetime]))
      .toEqual([['researcher', 'durable']]);
  });

  test('the advertised variants state the lifetime the dispatch routes on', () => {
    const scene = makeScene();
    const description = renderAgentsToolDescription(scene.deps);
    expect(description).toContain('lifetime:"task"');
    expect(description).not.toContain('context_ref');
    const types = createAgentsCodemodeProvider(() => scene.deps).types ?? '';
    expect(types).toContain('role: string;');
    expect(types).toContain('lifetime?: "durable" | "task";');
    expect(types).not.toContain('context_ref');
  });
});

describe('bulk material travels by path, not by field', () => {
  test('a path named in the mission reaches the child brief and the bytes never do', async () => {
    const scene = makeScene();
    await scene.files.writeFile('/spill/tool-output.txt', 'x'.repeat(5000));

    await startRun(scene, {
      role: 'auditor',
      mission: 'What failed in /spill/tool-output.txt? Read it yourself.',
    });

    await scene.report({ content: 'A timeout on the third request.' });
    const brief = scene.briefs[0] ?? '';
    expect(brief).toContain('/spill/tool-output.txt');
    expect(brief).not.toContain('x'.repeat(200));
  });

  test('the retired fields are refused by name before any agent is created', () => {
    const scene = makeScene();
    expect(() => parseAgentsToolInput({ input: {
      action: 'hire', lifetime: 'task', role: 'auditor', mission: 'Summarise', context_ref: ['/spill/missing.txt'],
    } })).toThrow('unknown field "context_ref"');
    expect(() => parseAgentsToolInput({ input: {
      action: 'hire', agent: 'researcher', message: 'Survey auth', deadline_hint: 'today',
    } })).toThrow('unknown field "deadline_hint"');
    expect(scene.calls).toEqual([]);
    expect(scene.roster.list()).toEqual([]);
  });
});

describe('the rung is structural, and so is its absence', () => {
  test('without the port the task lifetime is absent from the surface and denied at the seam', async () => {
    const scene = makeScene({ withoutTemporary: true });
    const types = createAgentsCodemodeProvider(() => scene.deps).types ?? '';
    expect(types).toContain('hire(');
    expect(types).not.toContain('lifetime');
    const pending = scene.call({ action: 'hire', lifetime: 'task', role: 'auditor', mission: 'go' });
    await expect(pending).rejects.toMatchObject({ code: 'denied' });
    await expect(pending).rejects.toThrow('lifetime:"task"');
    expect(agentsActionsFor(scene.deps)).toContain('hire');
  });

  // A task hire adds a depth level like a durable one; this covers toolsets cached before the child's depth was seeded.
  test('at the cap a task-lifetime hire is refused exactly as a durable one is', async () => {
    const capped = makeScene({ delegation: { depth: DELEGATION_MAX_DEPTH } });
    expect(delegationExhausted(present(capped.deps.team, 'the capped scene\'s team port').delegation)).toBe(true);

    const team = capped.deps.team;

    if (!team) throw new Error('the depth fixture has no team');
    const expected = delegationDepthRefusal(team.delegation);
    const taskRefusal = capped.call({ action: 'hire', lifetime: 'task', role: 'auditor', mission: 'Audit the ledger.' });
    await expect(taskRefusal).rejects.toMatchObject({ code: expected.reason, message: expected.error });
    const hireRefusal = capped.call({ action: 'hire', role: 'auditor', mission: 'Audit the ledger.' });
    await expect(hireRefusal).rejects.toMatchObject({ code: expected.reason, message: expected.error });
    expect(capped.calls).toEqual([]);
    expect(capped.roster.listAll()).toEqual([]);

    // Handing work to an existing agent adds no depth, so it stays available at the cap.
    await expect(capped.call({ action: 'hire', agent: 'nobody', message: 'x' }))
      .rejects.toMatchObject({ code: 'bad_input' });
    // An empty role is a handoff, not a spawn, on both sides of the cap.
    await expect(capped.call({ action: 'hire', agent: 'nobody', role: '', message: 'x' }))
      .rejects.toMatchObject({ code: 'bad_input' });
  });

  test('the depth refusal suggests only calls the surface accepts', () => {
    // Both advertised remedies must survive the model-facing parse, or the refusal teaches an unwinnable retry.
    const remedy = delegationDepthRefusal({ depth: DELEGATION_MAX_DEPTH, maxDepth: 0 }).error;
    expect(remedy).toContain('config:{context:"inherit"}');
    expect(remedy).toContain('`hire` naming `agent`');
    expect(remedy).not.toContain('ask by');
    expect(parseAgentsToolInput({ input: { action: 'hire', agent: 'a', message: 'm' } }))
      .toMatchObject({ action: 'hire', agent: 'a', message: 'm' });
    expect(parseAgentsToolInput({ input: { action: 'swarm', task: 't', config: { context: 'inherit' } } }))
      .toMatchObject({ action: 'swarm', task: 't', config: { context: 'inherit' } });
    expect(() => parseAgentsToolInput({ input: { action: 'swarm', task: 't', context: 'fork' } })).toThrow();
  });

  test('a task child is a real agent: it can hire a role of its own until the cap', () => {
    for (const depth of [1, 2, 3]) {
      const child = makeScene({ delegation: { depth } });
      expect(present(child.deps.team, 'the child scene\'s team port').temporary).toBeDefined();
      expect(agentsActionsFor(child.deps)).toContain('hire');
    }

    const leaf: AgentsToolDeps = { mode: 'build' };
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
