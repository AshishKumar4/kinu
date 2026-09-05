// THE TEMPORARY RUNG — `agents({action:'ask', role, message})`, and its codemode
// twin `agents.ask({role, message})`.
//
// Everything here goes through the PUBLIC surfaces: the native dispatch and the
// sandbox namespace, over the same deps a backend wires. Nothing reads the
// register directly except to prove what a roster read already showed, because
// the contract is what a caller and a roster reader can see:
//
//   one answer, one shape, returned HERE rather than as an event;
//   visible while it runs, historical afterwards, never in the durable roster;
//   the child is a real agent, so it recurses until the depth cap removes it.
import { Database } from 'bun:sqlite';
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
  delegationBudgetAtDepth,
  receiveSubordinateEvent,
  type SubordinateEventResult,
  renderAgentsToolDescription,
  TOOL_REACH,
  type AgentsToolDeps,
  type VFS,
  type SubordinateHandoff,
  type SubordinateRuntime,
  type TemporaryAgentPort,
  type WorkMode,
  type AgentsToolAction,
  type AgentsToolInput,
  type CodemodeResult,
} from '../src/index';
import { dispatchAgentsAction } from '../src/tools/agents-tool';
import { createMemoryVfs } from '@kinu.run/test-utils';
import { makeSql as makeTagged, makeSqlExec } from './helpers';

const NOW = 1_700_000_000_000;

/** One member of the sandbox namespace, at the executor's own signature. Named
 *  rather than inlined as an `unknown` dictionary so a member that stops
 *  existing is a type error and not an undefined call. */
type SandboxMember = (...args: unknown[]) => Promise<CodemodeResult>;
type SandboxNamespace = Partial<Record<AgentsToolAction, SandboxMember>>;

const HANDOFF: SubordinateHandoff = {
  eventId: 'evt-1',
  delivery: 'starts_now',
  phase: { busy: false, lastActivityAt: null, workingOn: null },
};

/** The name every run in this file gets, so an assertion can name the agent
 *  the register listed without reading the register to find out. */
const TEMP_NAME = 'ask-auditor-a1b2c3';

interface Scene {
  deps: AgentsToolDeps;
  temporary: TemporaryAgentPort;
  roster: SubordinateRosterStore;
  /** Every child-substrate operation, in order — the proof that a temporary run
   *  rides the SAME runtime a hire does. */
  calls: string[];
  /** Every assignment body handed to a child, whole. */
  briefs: string[];
  /** This actor's REAL event log. `published()` counts the `subordinate_report`
   *  rows on it, which is how "a settled answer never reaches the rail" is a
   *  measurement rather than a stub's opinion. */
  published(): number;
  /** One entry per rail admission that asked for a drain. */
  wakes: number[];
  /** Deliver a report to the parent through the real ingress, the way a child
   *  does. Returns what the ingress answered. */
  report(input: {
    from?: string;
    status?: 'progress' | 'completed' | 'blocked';
    content: string;
    origin?: 'report_tool' | 'turn_end';
  }): Promise<SubordinateEventResult>;
  /** Native `agents` dispatch, at the width the tool calls it. */
  call(input: AgentsToolInput, signal?: AbortSignal): Promise<object>;
  /** The `agents.*` sandbox namespace, whose members take NO action field. */
  sandbox(): SandboxNamespace;
  files: VFS;
}

/** The roster store needs BOTH sql forms — `reconcileColumns` binds the table
 *  name into `pragma_table_info` through the tagged one. */
function makeRosterStore(): SubordinateRosterStore {
  const db = new Database(':memory:');
  return new SubordinateRosterStore(makeSqlExec(db), makeTagged(db));
}

function makeScene(options: {
  /** Refuse one child operation, to observe a run that cannot start. */
  fail?: keyof SubordinateRuntime;
  /** Fail the release too, to observe a run whose cleanup also throws. */
  failRelease?: boolean;
  delegation?: { depth: number };
  duringAssignment?: () => Promise<void>;
  /** Leave the temporary port UNWIRED — the actor with no child substrate. */
  withoutTemporary?: boolean;
} = {}): Scene {
  const roster = makeRosterStore();
  roster.ensureSchema();
  const { vfs: files } = createMemoryVfs();
  const calls: string[] = [];
  const briefs: string[] = [];
  let sequence = 0;
  const wakes: number[] = [];
  const eventDb = new Database(':memory:');
  const eventSql = makeSqlExec(eventDb);
  initEventsHubTables(eventSql);
  const log = new EventLog(eventSql);
  const runtime: SubordinateRuntime = {
    async spawn(input) {
      calls.push(`spawn:${input.name}`);
      if (options.fail === 'spawn') throw new Error('the facet substrate is unavailable');
    },
    async assign(name, input) {
      calls.push(`assign:${name}`);
      briefs.push(input.body);
      if (options.fail === 'assign') throw new Error('admission refused');
      await options.duringAssignment?.();
      return HANDOFF;
    },
    async status() {
      return { lastActivity: null, recentSteps: [] };
    },
    async message() { return HANDOFF; },
    async dismiss(name, keepHistory) {
      calls.push(`dismiss:${name}:${keepHistory}`);
      if (options.failRelease) throw new Error('the release failed');
    },
    async rename() { /* not reached by this rung */ },
  };
  const portInput: Parameters<typeof createTemporaryAgentPort>[0] = {
    roster,
    runtime,
    createName: (role: string) => `${role}-a1b2c3`,
    now: () => NOW,
    renderInheritedContext: () => undefined,
    statRef: async (path: string) => (await files.stat(path)) !== null,
  };
  const temporary = createTemporaryAgentPort(portInput);
  const teamInput: Parameters<typeof createTeamToolDeps>[0] = {
    delegation: options.delegation
      ? delegationBudgetAtDepth(options.delegation.depth)
      : ROOT_DELEGATION_BUDGET,
    roster,
    runtime,
    createName: (role) => `${role}-a1b2c3`,
    now: () => NOW,
    inheritedContext: () => [],
    ownMission: () => 'Keep the release train moving.',
    broadcast: () => { /* no listeners in this scene */ },
    broadcastTask: () => { /* no listeners in this scene */ },
  };
  // Absent, not empty: the rung's every gate reads the KEY's presence, so a
  // scene without the port must not carry it at all.
  if (!options.withoutTemporary) Object.assign(teamInput, { temporary });
  const team = createTeamToolDeps(teamInput);
  const deps: AgentsToolDeps = {
    mode: 'build' satisfies WorkMode,
    team,
  };
  return {
    deps,
    temporary,
    roster,
    calls,
    briefs,
    files,
    published: () => log.pending().filter((event) => event.variant === 'subordinate_report').length,
    wakes,
    report: (input) => receiveSubordinateEvent({
      log,
      roster,
      vfs: files,
      transaction: (body) => body(),
      announce: () => { /* the rail row is the record; see `published()` */ },
      onAdmitted: () => { wakes.push(1); },
      temporary,
    }, {
      fromSubordinate: input.from ?? TEMP_NAME,
      status: input.status ?? 'completed',
      content: input.content,
      origin: input.origin ?? 'report_tool',
      // The ingress dedupes on this, so every report in a suite needs its own —
      // two sharing one would have the second read back as already held.
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

/** Start a run and hand back the pending promise WITHOUT awaiting it — the only
 *  way to observe a temporary agent while it is still running, which is half of
 *  what the roster contract promises. */
function startRun(scene: Scene, input: Omit<AgentsToolInput, 'action'>, signal?: AbortSignal) {
  const settled = scene.call({ action: 'ask', ...input }, signal);
  // Observe the assignment acknowledgement rather than counting asynchronous turns.
  const ready = (async () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (scene.roster.get(TEMP_NAME)?.taskEventId) return;
      await Promise.resolve();
    }
    throw new Error('the temporary run never recorded its assignment id');
  })();
  return { settled, ready };
}

const CompletedOutcome = v.object({
  status: v.literal('completed'),
  agent: v.string(),
  lifetime: v.literal(TEMPORARY_LIFETIME),
  role: v.string(),
  answer: v.string(),
  transcript: v.literal('kept'),
  elapsed_ms: v.number(),
});

const FailedOutcome = v.object({
  status: v.literal('failed'),
  agent: v.string(),
  lifetime: v.literal(TEMPORARY_LIFETIME),
  role: v.string(),
  answer: v.string(),
  transcript: v.picklist(['kept', 'none']),
  elapsed_ms: v.number(),
  reason: v.string(),
});

const Refusal = v.object({ reason: v.string(), error: v.string() });

describe('a role-targeted ask returns one completed answer', () => {
  test('the answer comes back from the CALL, in the one shape, and nothing enters the roster', async () => {
    const scene = makeScene();
    const run = startRun(scene, { role: 'auditor', message: 'Is the migration reversible?' });
    await run.ready;
    const delivered = await scene.report({ content: 'Yes — the down migration is tested.' });
    // The ingress ADMITTED it, to the waiting call: no event id, because no
    // event was published. Counted on a REAL event log, not asserted on a stub.
    expect(delivered).toEqual({ id: '', disposition: 'admitted' });
    expect(scene.published()).toBe(0);
    expect(scene.wakes).toEqual([]);

    expect(v.parse(CompletedOutcome, await run.settled)).toEqual({
      status: 'completed',
      agent: TEMP_NAME,
      lifetime: 'task',
      role: 'auditor',
      answer: 'Yes — the down migration is tested.',
      transcript: 'kept',
      elapsed_ms: 0,
    });

    // The whole point of the rung: a helper that answered and left no colleague
    // behind. It is in the ONE roster, ARCHIVED — never a live team member, and
    // never copied into a register of its own.
    expect(scene.roster.list()).toEqual([]);
    expect(scene.roster.listAll()).toMatchObject([{
      name: TEMP_NAME, lifetime: 'task', status: 'dismissed',
    }]);
    // And it rode the same child substrate a hire does — spawn, assign, dismiss
    // — with history KEPT on the way out.
    expect(scene.calls).toEqual([
      `spawn:${TEMP_NAME}`,
      `assign:${TEMP_NAME}`,
      `dismiss:${TEMP_NAME}:true`,
    ]);
  });

  test('the same call from codemode takes NO action field and answers identically', async () => {
    const scene = makeScene();
    const ask = scene.sandbox().ask;
    expect(ask).toBeDefined();
    const settled = ask!({ role: 'auditor', message: 'Is the migration reversible?' });
    await Promise.resolve().then(() => Promise.resolve());
    await scene.report({ content: 'Yes.' });
    expect(v.parse(CompletedOutcome, await settled)).toMatchObject({
      status: 'completed', agent: TEMP_NAME, lifetime: 'task', answer: 'Yes.',
    });
  });

  test("a child that reports blocked fails in the SAME shape, carrying its own words", async () => {
    const scene = makeScene();
    const run = startRun(scene, { role: 'auditor', message: 'Check the invoice totals.' });
    await run.ready;
    await scene.report({ status: 'blocked', content: 'The ledger export is missing for March.' });
    expect(v.parse(FailedOutcome, await run.settled)).toMatchObject({
      status: 'failed',
      reason: 'unavailable',
      answer: 'The ledger export is missing for March.',
      transcript: 'kept',
    });
    // Released from the working set, archived in the same roster.
    expect(scene.roster.list()).toEqual([]);
  });

  test('a mid-work progress note does not settle the run — a temporary agent answers once', async () => {
    const scene = makeScene();
    const run = startRun(scene, { role: 'auditor', message: 'Audit the ledger.' });
    await run.ready;
    // A deliberate mid-work note is NOT the answer, so it stays an ordinary
    // correlated report on the rail — the same thing a durable subordinate's
    // progress note is.
    await scene.report({ status: 'progress', content: 'Reading the March export.', origin: 'report_tool' });
    expect(scene.published()).toBe(1);
    // Still listed, still running.
    const roster = await scene.call({ action: 'list' });
    expect(roster).toMatchObject({
      subordinates: [{ name: TEMP_NAME, lifetime: 'task', status: 'working' }],
    });
    await scene.report({ content: 'Totals reconcile.' });
    expect(v.parse(CompletedOutcome, await run.settled)).toMatchObject({ answer: 'Totals reconcile.' });
    // The ANSWER did not reach the rail: it was this call's return value, and
    // publishing it too would bill a turn to read something already in hand. So
    // the rail still holds exactly the ONE progress note.
    expect(scene.published()).toBe(1);
  });

  // The automatic relay of a finished assigned turn IS the answer for this rung:
  // a temporary agent that never calls `report` still answers.
  test('the finished turn relay settles the run without a report tool call', async () => {
    const scene = makeScene();
    const run = startRun(scene, { role: 'auditor', message: 'Summarise the incident.' });
    await run.ready;
    await scene.report({ status: 'progress', origin: 'turn_end', content: 'Root cause: an unregistered callback URL.' });
    expect(v.parse(CompletedOutcome, await run.settled)).toMatchObject({
      status: 'completed', answer: 'Root cause: an unregistered callback URL.',
    });
  });
});

describe('the roster shows a temporary agent while it runs and keeps its history after', () => {
  test('an answer before the assignment acknowledgement settles the ask before later cancellation', async () => {
    const controller = new AbortController();
    const scene = makeScene({
      duringAssignment: async () => {
        await scene.report({ content: 'The answer reaches the parent before its assignment acknowledgement.' });
        controller.abort();
      },
    });
    const outcome = await scene.call({ action: 'ask', role: 'auditor', message: 'Audit the ledger.' }, controller.signal);
    expect(outcome).toMatchObject({
      status: 'completed', answer: 'The answer reaches the parent before its assignment acknowledgement.',
      transcript: 'kept',
    });
    expect(scene.published()).toBe(0);
    expect(scene.wakes).toEqual([]);
    expect(await scene.call({ action: 'list' })).toMatchObject({ subordinates: [] });
  });

  test('running under lifetime task, released into history, never a subordinate', async () => {
    const scene = makeScene();
    expect(await scene.call({ action: 'list' })).toEqual({
      subordinates: [],
      note: 'No helper agents yet — create one with action:"hire".',
    });

    const run = startRun(scene, { role: 'auditor', message: 'Audit the ledger.' });
    await run.ready;
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
    // ONE roster: there is no parallel temporary register to read.
    expect(running).not.toHaveProperty('temporary');
    // Not "no helper agents yet" — an agent spending the owner's money right
    // now is a helper, and the roster read that called it empty was the bug
    // this half of the contract exists against.
    expect(running).not.toHaveProperty('note');

    await scene.report({ content: 'Totals reconcile.' });
    await run.settled;

    const after = await scene.call({ action: 'list' });
    // Gone from the working set...
    expect(after).toMatchObject({ subordinates: [] });
    expect(after).not.toHaveProperty('temporary_history');
    // ...and kept in the SAME roster as an archived row, which is what names the
    // actor whose transcript still holds the work. No second table, no copy.
    expect(scene.roster.listAll()).toMatchObject([{
      name: TEMP_NAME, lifetime: 'task', status: 'dismissed', dismissedAt: NOW,
    }]);
  });

  /**
   * THE PROVENANCE READ, THROUGH THE TOOL. Every outcome says `transcript:'kept'`
   * and names the agent; this is the call that makes that name mean something.
   * The tests around it read `roster.listAll()` directly, which is exactly why a
   * dead-ended `list` lookup went unnoticed once: the detail arm gated on the
   * ACTIVE roster, so a released name fell through to the peer path.
   */
  test('a released temporary agent still resolves by name through list, while staying unaddressable', async () => {
    const scene = makeScene();
    const run = startRun(scene, { role: 'auditor', message: 'Audit the ledger.' });
    await run.ready;
    await scene.report({ content: 'Totals reconcile.' });
    await run.settled;

    // Not in the working set...
    expect(await scene.call({ action: 'list' })).toMatchObject({ subordinates: [] });
    // ...and still readable by the name the outcome reported.
    expect(await scene.call({ action: 'list', agent: TEMP_NAME })).toMatchObject({
      roster: { name: TEMP_NAME, lifetime: 'task', status: 'dismissed' },
    });
    // Readable is not addressable: it cannot be handed new work.
    expect(await scene.call({ action: 'ask', agent: TEMP_NAME, message: 'one more thing' }))
      .toMatchObject({ reason: 'bad_input' });
  });

  test('a run that could not start is released, not left listed as running', async () => {
    const scene = makeScene({ fail: 'spawn' });
    const failed = v.parse(FailedOutcome, await scene.call({
      action: 'ask', role: 'auditor', message: 'Audit the ledger.',
    }));
    expect(failed.status).toBe('failed');
    expect(failed.answer).toContain('could not be created');
    // No child was born, so there is no transcript to claim and no archived row
    // naming an agent that never existed.
    expect(failed.transcript).toBe('none');
    expect(scene.roster.listAll()).toEqual([]);
    expect(await scene.call({ action: 'list' })).toMatchObject({ subordinates: [] });
    expect(scene.roster.list()).toEqual([]);
  });

  /**
   * A COLLIDING NAME MUST NOT COST SOMEBODY ELSE THEIR ROSTER ROW.
   *
   * The generated name is `ask-<role>-<6 chars>`, so a primary-key collision with
   * an existing agent is unlikely and reachable. When `create` itself throws, the
   * cleanup must remove only a row THIS call wrote — re-reading the roster by
   * name found the OTHER agent's row and deleted it, orphaning a live durable
   * subordinate from the roster while its actor kept running.
   */
  test('a name collision on create leaves the colliding agent\'s row untouched', async () => {
    const scene = makeScene();
    // The name the scene's `createName` will generate, already taken by a
    // durable hire.
    await scene.deps.team!.spawn({
      name: TEMP_NAME, role: { kind: 'legacy', text: 'auditor' },
      mission: 'Investigate.', mode: 'build',
    });
    const before = scene.roster.listAll();
    expect(before).toHaveLength(1);
    scene.calls.length = 0;

    const failed = v.parse(FailedOutcome, await scene.call({
      action: 'ask', role: 'auditor', message: 'Audit the ledger.',
    }));
    expect(failed.status).toBe('failed');
    expect(failed.transcript).toBe('none');
    // The pre-existing agent is STILL THERE, unchanged, and still addressable.
    expect(scene.roster.listAll()).toEqual(before);
    expect(scene.roster.list().map((entry) => [entry.name, entry.lifetime]))
      .toEqual([[TEMP_NAME, 'durable']]);
    // And no child was spawned or dismissed on the way out.
    expect(scene.calls).toEqual([]);
  });

  test('a run whose work could not be admitted releases BOTH the row and the child', async () => {
    const scene = makeScene({ fail: 'assign' });
    const failed = v.parse(FailedOutcome, await scene.call({
      action: 'ask', role: 'auditor', message: 'Audit the ledger.',
    }));
    expect(failed.answer).toContain('could not be given the work');
    expect(scene.roster.list()).toEqual([]);
    expect(scene.calls).toEqual([
      `spawn:${TEMP_NAME}`,
      `assign:${TEMP_NAME}`,
      `dismiss:${TEMP_NAME}:true`,
    ]);
  });

  test('a run whose release also fails keeps BOTH errors in the answer', async () => {
    const scene = makeScene({ fail: 'assign', failRelease: true });
    const failed = v.parse(FailedOutcome, await scene.call({
      action: 'ask', role: 'auditor', message: 'Audit the ledger.',
    }));
    expect(failed.status).toBe('failed');
    // The assignment failure that caused the release, not the release failure
    // that a throwing cleanup would have replaced it with.
    expect(failed.answer).toContain('could not be given the work');
    expect(failed.answer).toContain('admission refused');
    expect(failed.answer).toContain('the release failed');
    expect(scene.calls).toEqual([
      `spawn:${TEMP_NAME}`,
      `assign:${TEMP_NAME}`,
      `dismiss:${TEMP_NAME}:true`,
    ]);
  });
});

describe('an answer that outlives its waiter', () => {
  /**
   * THE EVICTION PATH. The waiter is in-memory, so an activation that dies
   * between the assignment and the report loses the RETURN VALUE. Nothing else
   * may be lost, and nothing may be left behind:
   *
   *   the answer  — becomes an ordinary correlated `subordinate_report` event on
   *                 the parent's rail, which is what wakes it, exactly like a
   *                 durable subordinate's answer;
   *   the row     — is RELEASED by the roster's own report policy. Without that
   *                 a task-lifetime row sat idle in the roster forever: listed
   *                 as a live helper, never retired, contradicting the lifetime
   *                 that created it.
   */
  test('an answer that outlives its waiter becomes a normal event and still releases the row', async () => {
    const scene = makeScene();
    const controller = new AbortController();
    const run = startRun(scene, { role: 'auditor', message: 'Audit the ledger.' }, controller.signal);
    await run.ready;
    // Cancel the caller: the run is torn down and its waiter is gone, which is
    // the same state an evicted activation leaves behind.
    controller.abort();
    await run.settled;
    // Re-open the row to stand in for the assignment the evicted activation had
    // already made — the ingress must handle a report for a task row nobody
    // awaits, however that row came to be.
    scene.roster.restore({
      name: TEMP_NAME,
      createdBy: 'orchestrator',
      status: 'working',
      currentTask: 'Audit the ledger.',
      createdAt: NOW,
      dismissedAt: null,
      lifetime: 'task',
      taskEventId: 'evt-1',
    });

    const delivered = await scene.report({ content: 'Totals reconcile.' });
    // ADMITTED TO THE RAIL this time, with a real event id — not swallowed.
    expect(delivered.disposition).toBe('admitted');
    expect(delivered.id).not.toBe('');
    expect(scene.published()).toBe(1);
    // And released, not left listed as an idle helper nobody can address.
    expect(scene.roster.list()).toEqual([]);
    expect(scene.roster.listAll()).toMatchObject([{
      name: TEMP_NAME, lifetime: 'task', status: 'dismissed', dismissedAt: NOW,
    }]);
  });

  /**
   * THE TURN-END ANSWER, WITH NO WAITER — the shape that made the release policy
   * wrong once.
   *
   * The automatic relay of a finished assigned turn reports `progress`
   * (`sendReport('progress', assistantText, 'turn_end')`), so a release keyed on
   * `completed`/`blocked` missed it entirely and left the row `working` forever.
   * Both paths now ask ONE predicate — `temporaryRunSettles` — so the port and
   * the roster agree about which report was the answer.
   */
  test('a turn_end answer with no waiter releases the row too, not just a terminal report', async () => {
    const scene = makeScene();
    scene.roster.create({
      name: TEMP_NAME,
      createdBy: 'orchestrator',
      status: 'working',
      currentTask: 'Audit the ledger.',
      createdAt: NOW,
      dismissedAt: null,
      lifetime: 'task',
      taskEventId: 'evt-1',
    });
    // `progress` + `turn_end` — exactly what a finished child turn relays.
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

  /** And a deliberate mid-work note still does NOT release it: the run is open. */
  test('a mid-work report_tool progress note leaves the task row working', async () => {
    const scene = makeScene();
    scene.roster.create({
      name: TEMP_NAME,
      createdBy: 'orchestrator',
      status: 'working',
      currentTask: 'Audit the ledger.',
      createdAt: NOW,
      dismissedAt: null,
      lifetime: 'task',
      taskEventId: 'evt-1',
    });
    await scene.report({ status: 'progress', origin: 'report_tool', content: 'Reading March.' });
    expect(scene.roster.list()).toMatchObject([{
      name: TEMP_NAME, lifetime: 'task', status: 'working',
    }]);
  });

  /** The same policy must NOT touch a durable subordinate: it is meant to stay. */
  test('a durable subordinate is left in the roster by the very report that releases a task one', async () => {
    const scene = makeScene();
    await scene.deps.team!.spawn({
      name: 'researcher', role: { kind: 'legacy', text: 'researcher' },
      mission: 'Investigate.', mode: 'build',
    });
    await scene.report({ from: 'researcher', content: 'Root cause found.' });
    expect(scene.published()).toBe(1);
    expect(scene.roster.list()).toMatchObject([{
      name: 'researcher', lifetime: 'durable', status: 'idle', currentTask: null,
    }]);
  });
});

describe('a child that cannot answer still ends the call', () => {
  /**
   * NO DEADLINE, AND NO SILENCE EITHER — the two halves of one guarantee.
   *
   * A delegation is never cut off by a clock here, so what makes the wait
   * terminate has to be the CHILD: a `lifetime:'task'` child owes exactly one
   * terminal report for every way its turn can end, and `terminalTaskReport` is
   * the closed map that says which. These cases drive each ending through the
   * real ingress in the shape the child produces, and assert the call returns.
   */
  for (const ending of TASK_TURN_ENDINGS) {
    if (ending === 'answered') continue;
    test(`a ${ending} turn returns one classified failure and releases the row`, async () => {
      const scene = makeScene();
      const run = startRun(scene, { role: 'auditor', message: 'Audit the ledger.' });
      await run.ready;
      // Exactly what the child now emits for this ending.
      const report = terminalTaskReport({ lifetime: 'task', ending, assistantText: '' });
      expect(report).not.toBeNull();
      await scene.report({ status: report!.status, origin: 'turn_end', content: report!.content });

      const failed = v.parse(FailedOutcome, await run.settled);
      expect(failed).toMatchObject({ status: 'failed', reason: 'unavailable', transcript: 'kept' });
      // The child's own explanation reaches the caller — never a bare timeout.
      expect(failed.answer.length).toBeGreaterThan(0);
      // No hang, and nothing left listed.
      expect(scene.roster.list()).toEqual([]);
      expect(scene.calls).toContain(`dismiss:${TEMP_NAME}:true`);
    });
  }

  /** A finished turn with words IS the answer, whatever the relay's status word. */
  test('an answered ending carries the child\'s own words as the answer', () => {
    expect(terminalTaskReport({ lifetime: 'task', ending: 'answered', assistantText: '  done  ' }))
      .toEqual({ status: 'completed', content: 'done' });
    // An `answered` ending with nothing in it is a silent one that mislabelled
    // itself: the CONTENT decides, so no caller can produce an empty answer.
    expect(terminalTaskReport({ lifetime: 'task', ending: 'answered', assistantText: '   ' }))
      .toMatchObject({ status: 'blocked' });
  });

  /** And the policy is a no-op for a durable child, which keeps its selective
   *  relay: this is the one line that proves the durable rung is untouched. */
  test('a durable child owes nothing extra — the policy returns null for it', () => {
    for (const ending of TASK_TURN_ENDINGS) {
      expect(terminalTaskReport({ lifetime: 'durable', ending, assistantText: 'x' })).toBeNull();
    }
  });
});

describe('the two ask targets are exclusive', () => {
  test('naming both agent and role is refused by naming the choice', async () => {
    const scene = makeScene();
    const refusal = v.parse(Refusal, await scene.call({
      action: 'ask', agent: 'researcher', role: 'auditor', message: 'go',
    }));
    expect(refusal.reason).toBe('bad_input');
    expect(refusal.error).toContain('ONE target');
    expect(scene.calls).toEqual([]);
  });

  test('naming neither is refused by naming both options', async () => {
    const scene = makeScene();
    const refusal = v.parse(Refusal, await scene.call({ action: 'ask' }));
    expect(refusal.reason).toBe('bad_input');
    expect(refusal.error).toContain('`role`');
    expect(refusal.error).toContain('`agent`');
    // A caller that named a message but no target reads the UNCHANGED
    // existing-agent refusal: that half of the surface did not move.
    expect(v.parse(Refusal, await scene.call({ action: 'ask', message: 'go' })).error)
      .toBe('ask requires agent and message');
  });

  test('an existing-agent ask is unchanged: it reports back later, it does not resolve here', async () => {
    const scene = makeScene();
    await scene.deps.team!.spawn({
      name: 'researcher', role: { kind: 'legacy', text: 'researcher' },
      mission: 'Investigate.', mode: 'build',
    });
    scene.calls.length = 0;
    expect(await scene.call({ action: 'ask', agent: 'researcher', message: 'Find the cause.' }))
      .toMatchObject({ status: 'working', agent: 'researcher', event_id: 'evt-1' });
    // No task-lifetime row was opened, and the subordinate is still in the roster.
    expect(scene.roster.list().map((entry) => [entry.name, entry.lifetime]))
      .toEqual([['researcher', 'durable']]);
  });

  test('the advertised variants state the exclusivity the dispatch enforces', () => {
    const scene = makeScene();
    const description = renderAgentsToolDescription(scene.deps);
    expect(description).toContain('Ask a ROLE');
    expect(description).toContain('context_ref');
    // The sandbox declaration renders the same two targets, from the same table.
    const types = createAgentsCodemodeProvider(() => scene.deps).types ?? '';
    expect(types).toContain('role: string;');
    expect(types).toContain('context_ref?: string[];');
  });
});

describe('context refs stay workspace-authorized and out of the caller', () => {
  test('a resolvable path is named in the child brief and never read by the caller', async () => {
    const scene = makeScene();
    await scene.files.writeFile('/spill/tool-output.txt', 'x'.repeat(5000));
    const run = startRun(scene, {
      role: 'auditor',
      message: 'What failed in this output?',
      context_ref: ['/spill/tool-output.txt'],
    });
    await run.ready;
    await scene.report({ content: 'A timeout on the third request.' });
    await run.settled;
    const brief = scene.briefs[0] ?? '';
    expect(brief).toContain('/spill/tool-output.txt');
    expect(brief).toContain('read it yourself');
    // The BYTES did not travel: the brief names the path and nothing else.
    expect(brief).not.toContain('x'.repeat(200));
  });

  test('an unresolvable path is refused BY NAME, and no agent is created for it', async () => {
    const scene = makeScene();
    const refusal = v.parse(Refusal, await scene.call({
      action: 'ask', role: 'auditor', message: 'Summarise', context_ref: ['/spill/missing.txt'],
    }));
    expect(refusal.reason).toBe('missing');
    expect(refusal.error).toContain('/spill/missing.txt');
    expect(scene.calls).toEqual([]);
    expect(scene.roster.list()).toEqual([]);
  });
});

describe('the rung is structural, and so is its absence', () => {
  test('without the port the role target is absent from the surface and denied at the seam', async () => {
    const scene = makeScene({ withoutTemporary: true });
    const types = createAgentsCodemodeProvider(() => scene.deps).types ?? '';
    expect(types).toContain('ask(');
    expect(types).not.toContain('context_ref');
    const refusal = v.parse(Refusal, await scene.call({ action: 'ask', role: 'auditor', message: 'go' }));
    expect(refusal.reason).toBe('denied');
    expect(refusal.error).toContain('temporary agent');
    // The existing-agent target still works there — this rung's absence takes
    // nothing else with it.
    expect(agentsActionsFor(scene.deps)).toContain('ask');
  });

  /**
   * THE CAP COVERS BOTH SPAWNING RUNGS.
   *
   * A role-targeted ask births a child through the identical substrate, so it
   * adds a level exactly as a hire does. A cap that covered only `hire` was a cap
   * the other rung walked past — one call per level, each spending real money,
   * which is the unbounded expansion `DELEGATION_MAX_DEPTH` exists to prevent.
   *
   * Structural absence is still the primary containment (a backend at the cap
   * wires no port), and this is the seam that covers the window absence cannot:
   * a toolset cached from before the child's depth was seeded.
   */
  test('at the cap a role-targeted ask is refused exactly as a hire is', async () => {
    const capped = makeScene({ delegation: { depth: DELEGATION_MAX_DEPTH } });
    expect(delegationExhausted(capped.deps.team!.delegation)).toBe(true);

    const askRefusal = v.parse(Refusal, await capped.call({
      action: 'ask', role: 'auditor', message: 'Audit the ledger.',
    }));
    const hireRefusal = v.parse(Refusal, await capped.call({
      action: 'hire', role: 'auditor', mission: 'Audit the ledger.',
    }));
    // The SAME refusal: one cap, one classification, one remedy.
    expect(askRefusal).toEqual(hireRefusal);
    expect(askRefusal.reason).toBe('denied');
    expect(askRefusal.error).toContain('ask by `role`');
    // And nothing was created on the way to being refused.
    expect(capped.calls).toEqual([]);
    expect(capped.roster.listAll()).toEqual([]);

    // Asking an agent that ALREADY EXISTS adds no depth, so it stays available
    // at the cap — an actor there must still be able to use its own team.
    expect(await capped.call({ action: 'ask', agent: 'nobody', message: 'x' }))
      .toMatchObject({ reason: 'bad_input' });
    // …and an EMPTY role is not a spawn either, on either side of the cap: the
    // seam and the dispatch arm read the same truthiness, so this routes as the
    // ask-by-name it is rather than drawing the depth refusal.
    expect(await capped.call({ action: 'ask', agent: 'nobody', role: '', message: 'x' }))
      .toMatchObject({ reason: 'bad_input' });
  });

  test('a temporary child is a real agent: it can ask a role of its own until the cap', () => {
    // Depth 1 through 3: the child's own team deps carry the port, so the rung
    // recurses. This is the same derivation a hire follows, because it IS the
    // same substrate.
    for (const depth of [1, 2, 3]) {
      const child = makeScene({ delegation: { depth } });
      expect(child.deps.team!.temporary).toBeDefined();
      expect(agentsActionsFor(child.deps)).toContain('ask');
    }
    // At the cap the backend wires no team deps at all, so the rung is not
    // refused — it is not there. A leaf answers directly.
    const leaf: AgentsToolDeps = { mode: 'build' };
    expect(agentsActionsFor(leaf)).not.toContain('ask');
  });

  test('cancelling the caller ends the run as cancelled and clears the active roster', async () => {
    const scene = makeScene();
    const controller = new AbortController();
    const run = startRun(scene, { role: 'auditor', message: 'Audit the ledger.' }, controller.signal);
    await run.ready;
    expect(await scene.call({ action: 'list' }))
      .toMatchObject({ subordinates: [{ name: TEMP_NAME, lifetime: 'task' }] });
    controller.abort();
    const failed = v.parse(FailedOutcome, await run.settled);
    expect(failed).toMatchObject({ status: 'failed', reason: 'cancelled', transcript: 'kept' });
    expect(scene.roster.list()).toEqual([]);
    expect(scene.calls).toContain(`dismiss:${TEMP_NAME}:true`);
  });
});

describe('the standalone recursive-LM namespace is gone', () => {
  test('nothing declares an `rlm` reach any more', () => {
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
