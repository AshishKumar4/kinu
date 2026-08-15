// Subordinates — roster, identity, admission and the orchestration policy over
// them. Moved here with the module it covers (core/src/subordinates/support.ts);
// the tests that assert how the Cloudflare backend WIRES it stayed behind in
// cf-backend, because those read that backend's source.
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  buildDrainBatch,
  EventLog,
  eventContentPath,
  initEventsHubTables,
  renderForLLM,
  spillEventContent,
  SubordinateIdentityStore,
  SubordinateRosterStore,
  admitSubordinateReport,
  admitSubordinateTask,
  createTeamToolDeps,
  describeSubordinateHandoff,
  normalizeReportContent,
  parentAdmitsSubordinateReport,
  readSubordinateLiveStatus,
  receiveSubordinateEvent,
  subordinateRelaysTurnEnd,
  type SerializedMessage,
  type SqlExec,
  type SubordinateDelivery,
  type SubordinateHandoff,
  type SubordinateReportOrigin,
  type SubordinateReportPayload,
  type SubordinateReportStatus,
  type SubordinateRosterEntry,
  type SubordinateRuntime,
  type ProteusEvent,
} from '../src/index.js';
import { createMemoryVfs } from '@proteus/test-utils';
import { makeSqlExec } from './helpers.js';

function makeSql(): SqlExec {
  return makeSqlExec(new Database(':memory:'));
}

function reportPayload(event: ProteusEvent | undefined): SubordinateReportPayload {
  if (!event) throw new Error('expected subordinate report event');
  if (event.variant !== 'subordinate_report') throw new Error('expected subordinate report payload');
  return v.parse(v.object({
    from_subordinate: v.string(),
    status: v.picklist(['progress', 'completed', 'blocked']),
    content: v.string(),
    task: v.optional(v.string()),
    content_path: v.optional(v.string()),
    proteus_mode: v.picklist(['build', 'plan']),
  }), event.payload);
}
const identityInput = {
  name: 'researcher',
  displayName: 'Researcher',
  role: 'market researcher',
  mission: 'Map the market.',
  parentWorkspace: 'proteus-main',
  ownerUserId: 'owner-123',
};

describe('subordinate identity', () => {
  test('seed is immutable while allowing an identical parent retry', () => {
    const identity = new SubordinateIdentityStore(makeSql());
    identity.ensureSchema();

    identity.seed(identityInput);
    identity.seed(identityInput);

    expect(identity.read()).toEqual(identityInput);
    expect(identity.ownerUserId()).toBe('owner-123');
    expect(identity.workspaceName()).toBe('proteus-main');
    expect(() => identity.seed({ ...identityInput, ownerUserId: 'attacker' }))
      .toThrow('already initialized');
    expect(identity.read()).toEqual(identityInput);
  });
});
const initialRosterEntry: SubordinateRosterEntry = {
  name: 'researcher',
  displayName: 'Researcher',
  role: 'market researcher',
  createdBy: 'orchestrator',
  status: 'working',
  currentTask: 'Map the market.',
  createdAt: 100,
  dismissedAt: null,
};

describe('workspace subordinate roster', () => {
  test('owns closed status transitions and can restore an exact snapshot', () => {
    const roster = new SubordinateRosterStore(makeSql());
    roster.ensureSchema();
    roster.create(initialRosterEntry);

    roster.applyReport('researcher', 'blocked');
    expect(roster.requireActive('researcher')).toMatchObject({
      status: 'awaiting_input', currentTask: 'Map the market.',
    });

    roster.resumeAfterMessage('researcher');
    expect(roster.requireActive('researcher').status).toBe('working');

    roster.applyReport('researcher', 'completed');
    expect(roster.requireActive('researcher')).toMatchObject({ status: 'idle', currentTask: null });

    // Progress without an assignment must not invent work in the roster.
    roster.applyReport('researcher', 'progress');
    expect(roster.requireActive('researcher').status).toBe('idle');

    roster.assign('researcher', 'Compare vendors');
    roster.applyReport('researcher', 'progress');
    expect(roster.requireActive('researcher')).toMatchObject({
      status: 'working', currentTask: 'Compare vendors',
    });

    const beforeDismiss = roster.requireActive('researcher');
    roster.dismiss('researcher', 200);
    roster.dismiss('researcher', 300); // a storage-wipe retry preserves the original retirement time
    expect(roster.list()).toEqual([]);
    expect(roster.listAll()).toEqual([
      { ...beforeDismiss, status: 'dismissed', currentTask: null, dismissedAt: 200 },
    ]);
    expect(() => roster.requireActive('researcher')).toThrow('dismissed');

    roster.restore(beforeDismiss);
    expect(roster.get('researcher')).toEqual(beforeDismiss);
    expect(() => roster.requireExisting('missing')).toThrow('unknown subordinate');
  });
});

describe('subordinate live status', () => {
  test('returns the latest activity and bounded recent step summaries', () => {
    const sql = makeSql();
    sql.exec(`CREATE TABLE activity_log (
      id TEXT PRIMARY KEY,
      event TEXT NOT NULL,
      detail TEXT,
      elapsed_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    for (let index = 1; index <= 7; index++) {
      sql.exec(
        `INSERT INTO activity_log (id, event, detail, elapsed_ms, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        `id-${index}`,
        `step-${index}`,
        index === 7 ? 'Integrated auth findings' : `detail-${index}`,
        index * 10,
        index * 100,
      );
    }

    expect(readSubordinateLiveStatus(sql)).toEqual({
      lastActivity: 700,
      recentSteps: [
        { event: 'step-7', summary: 'Integrated auth findings', elapsedMs: 70, createdAt: 700 },
        { event: 'step-6', summary: 'detail-6', elapsedMs: 60, createdAt: 600 },
        { event: 'step-5', summary: 'detail-5', elapsedMs: 50, createdAt: 500 },
        { event: 'step-4', summary: 'detail-4', elapsedMs: 40, createdAt: 400 },
        { event: 'step-3', summary: 'detail-3', elapsedMs: 30, createdAt: 300 },
      ],
    });
  });
});

const fakeHandoff = (delivery: SubordinateDelivery): SubordinateHandoff => ({
  eventId: `evt-${delivery}`,
  delivery,
  phase: { busy: delivery === 'queued', lastActivityAt: null, workingOn: null },
});

interface TeamHarness {
  roster: SubordinateRosterStore;
  team: ReturnType<typeof createTeamToolDeps>;
  calls: string[];
  assignments: Array<{ body: string; inheritedContext?: string }>;
  broadcasts: number[];
  tasks: Array<{ subordinate: string; content: string; timestamp: number }>;
  failures: Set<keyof SubordinateRuntime>;
}

function makeTeamHarness(inheritedContext: SerializedMessage[] = []): TeamHarness {
  const roster = new SubordinateRosterStore(makeSql());
  roster.ensureSchema();
  const calls: string[] = [];
  const assignments: Array<{ body: string; inheritedContext?: string }> = [];
  const broadcasts: number[] = [];
  const tasks: Array<{ subordinate: string; content: string; timestamp: number }> = [];
  const failures = new Set<keyof SubordinateRuntime>();
  const fail = (operation: keyof SubordinateRuntime) => {
    if (failures.has(operation)) throw new Error(`${operation} failed`);
  };
  const runtime: SubordinateRuntime = {
    async spawn(input) { calls.push(`spawn:${input.name}:${input.mission}`); fail('spawn'); },
    async assign(name, input) {
      calls.push(`assign:${name}:${input.body}`);
      assignments.push(input);
      fail('assign');
      return fakeHandoff('starts_now');
    },
    async status(name) {
      fail('status');
      return {
        lastActivity: name.length,
        recentSteps: [{ event: 'beforeturn', summary: 'streamText() called next', elapsedMs: 12, createdAt: 34 }],
      };
    },
    async message(name, content) {
      calls.push(`message:${name}:${content}`);
      fail('message');
      return fakeHandoff('queued');
    },
    async dismiss(name, keepHistory) { calls.push(`dismiss:${name}:${keepHistory}`); fail('dismiss'); },
  };
  const team = createTeamToolDeps({
    roster,
    runtime,
    createName: () => 'researcher-a1b2c3',
    now: () => 1_700_000_000_000,
    inheritedContext: () => inheritedContext,
    broadcast: () => { broadcasts.push(Date.now()); },
    broadcastTask: (event) => { tasks.push(event); },
  });
  return { roster, team, calls, assignments, broadcasts, tasks, failures };
}

describe('team action routing', () => {
  test('owner creation seeds an idle identity without starting work or mirroring a task', async () => {
    const h = makeTeamHarness();

    expect(await h.team.create({ role: 'research partner', mission: 'Understand the domain.' })).toEqual({
      name: 'researcher-a1b2c3', displayName: 'Research Partner',
      subordinate: {
        name: 'researcher-a1b2c3', displayName: 'Research Partner', role: 'research partner',
        createdBy: 'user', status: 'idle', currentTask: null,
        createdAt: 1_700_000_000_000, dismissedAt: null,
      },
    });
    expect(h.roster.requireActive('researcher-a1b2c3')).toMatchObject({
      createdBy: 'user', status: 'idle', currentTask: null,
    });
    expect(h.calls).toEqual(['spawn:researcher-a1b2c3:Understand the domain.']);
    expect(h.assignments).toEqual([]);
    expect(h.tasks).toEqual([]);
    expect(h.broadcasts).toHaveLength(1);
  });

  test('only the owner can dismiss an owner-created subordinate', async () => {
    const h = makeTeamHarness();
    await h.team.create({ role: 'researcher', mission: 'Own this role.' });

    await expect(h.team.dismiss({ name: 'researcher-a1b2c3' }))
      .rejects.toThrow('only the owner can dismiss it');
    expect(h.roster.requireActive('researcher-a1b2c3').status).toBe('idle');
    expect(h.calls).not.toContain('dismiss:researcher-a1b2c3:true');

    await expect(h.team.dismiss({ name: 'researcher-a1b2c3', requestedBy: 'user' }))
      .resolves.toMatchObject({ ok: true, historyKept: true });
  });

  test('spawn gives the subordinate a filtered inherited-context digest before its first mission', async () => {
    const inheritedContext: SerializedMessage[] = [
      { id: 's1', role: 'system', content: 'Internal system policy', createdAt: 1 },
      { id: 'u1', role: 'user', content: 'Fix auth and billing in parallel.', createdAt: 2 },
      { id: 't1', role: 'tool', content: 'Very noisy tool output', createdAt: 3 },
      { id: 'a1', role: 'assistant', content: 'I will split the independent workstreams.', createdAt: 4 },
    ];
    const h = makeTeamHarness(inheritedContext);

    await h.team.spawn({ mode: 'build', role: 'auth engineer', mission: 'Repair the auth flow.' });

    const digest = h.assignments[0]?.inheritedContext;
    expect(digest).toContain('<inherited_context>');
    expect(digest).toContain('[user] Fix auth and billing in parallel.');
    expect(digest).toContain('[assistant] I will split the independent workstreams.');
    expect(digest).not.toContain('Internal system policy');
    expect(digest).not.toContain('Very noisy tool output');
    expect(digest?.length).toBeLessThanOrEqual(2400);

    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);
    admitSubordinateTask(log, {
      fromWorkspace: 'proteus-main',
      kind: 'task',
      body: 'Repair the auth flow.',
      inheritedContext: digest,
      mode: 'build',
      now: 10,
    });
    const turn = buildDrainBatch(log.pending({ variant: 'subordinate_task' }));
    expect(turn?.text.indexOf('<inherited_context>')).toBeLessThan(
      turn?.text.indexOf('task: Repair the auth flow.') ?? -1,
    );
  });

  test('successful actions expose one canonical roster and nested live status', async () => {
    const h = makeTeamHarness();

    expect(await h.team.spawn({ mode: 'build', role: 'market researcher', mission: 'Map the market.' })).toEqual({
      name: 'researcher-a1b2c3', displayName: 'Market Researcher',
    });
    expect(await h.team.list()).toEqual([{
      name: 'researcher-a1b2c3', displayName: 'Market Researcher', role: 'market researcher',
      createdBy: 'orchestrator', status: 'working', currentTask: 'Map the market.',
      createdAt: 1_700_000_000_000, dismissedAt: null,
    }]);
    expect(h.calls.slice(0, 2)).toEqual([
      'spawn:researcher-a1b2c3:Map the market.',
      'assign:researcher-a1b2c3:Map the market.',
    ]);
    expect(h.tasks).toEqual([{
      subordinate: 'researcher-a1b2c3', content: 'Map the market.', timestamp: 1_700_000_000_000,
    }]);

    await h.team.assign({ mode: 'build', name: 'researcher-a1b2c3', task: 'Compare vendors' });
    expect(h.tasks.at(-1)).toEqual({
      subordinate: 'researcher-a1b2c3', content: 'Compare vendors', timestamp: 1_700_000_000_000,
    });
    expect(await h.team.status({ name: 'researcher-a1b2c3' })).toEqual({
      roster: h.roster.requireActive('researcher-a1b2c3'),
      live: {
        lastActivity: 'researcher-a1b2c3'.length,
        recentSteps: [{ event: 'beforeturn', summary: 'streamText() called next', elapsedMs: 12, createdAt: 34 }],
      },
    });

    h.roster.applyReport('researcher-a1b2c3', 'blocked');
    await h.team.message({ mode: 'build', name: 'researcher-a1b2c3', content: 'Include pricing.' });
    expect(h.roster.requireActive('researcher-a1b2c3').status).toBe('working');

    await h.team.dismiss({ name: 'researcher-a1b2c3', keepHistory: false });
    expect(await h.team.list()).toEqual([]);
    expect(h.roster.requireExisting('researcher-a1b2c3').status).toBe('dismissed');
    expect(h.broadcasts).toHaveLength(4);
  });

  test('runtime failures roll the roster back and never broadcast partial state', async () => {
    const operations: Array<keyof Pick<SubordinateRuntime, 'spawn' | 'assign' | 'message' | 'dismiss'>> = [
      'spawn', 'assign', 'message', 'dismiss',
    ];

    for (const operation of operations) {
      const h = makeTeamHarness();
      if (operation !== 'spawn') await h.team.spawn({ mode: 'build', role: 'researcher', mission: 'Initial mission' });
      if (operation === 'message') h.roster.applyReport('researcher-a1b2c3', 'blocked');
      const before = h.roster.get('researcher-a1b2c3');
      const broadcastsBefore = h.broadcasts.length;
      h.failures.add(operation);

      const action = operation === 'spawn'
        ? h.team.spawn({ mode: 'build', role: 'researcher', mission: 'Mission' })
        : operation === 'assign'
          ? h.team.assign({ mode: 'build', name: 'researcher-a1b2c3', task: 'Replacement' })
          : operation === 'message'
            ? h.team.message({ mode: 'build', name: 'researcher-a1b2c3', content: 'Continue' })
            : h.team.dismiss({ name: 'researcher-a1b2c3' });

      await expect(action).rejects.toThrow(`${operation} failed`);
      expect(h.roster.get('researcher-a1b2c3')).toEqual(before);
      expect(h.broadcasts).toHaveLength(broadcastsBefore);
      expect(h.tasks).toHaveLength(operation === 'spawn' ? 0 : 1);
    }
  });

  test('a rejected initial mission deletes the new facet and leaves no roster row', async () => {
    const h = makeTeamHarness();
    h.failures.add('assign');

    await expect(h.team.spawn({ mode: 'build', role: 'researcher', mission: 'Mission' }))
      .rejects.toThrow('assign failed');
    expect(h.roster.get('researcher-a1b2c3')).toBeNull();
    expect(h.calls).toEqual([
      'spawn:researcher-a1b2c3:Mission',
      'assign:researcher-a1b2c3:Mission',
      'dismiss:researcher-a1b2c3:false',
    ]);
    expect(h.broadcasts).toEqual([]);
  });

  test('a failed facet cleanup preserves the roster handle needed to retry retirement', async () => {
    const h = makeTeamHarness();
    h.failures.add('assign');
    h.failures.add('dismiss');

    await expect(h.team.spawn({ mode: 'build', role: 'researcher', mission: 'Mission' }))
      .rejects.toThrow('facet cleanup also failed');
    expect(h.roster.get('researcher-a1b2c3')).toMatchObject({
      status: 'working',
      currentTask: 'Mission',
    });
    expect(h.broadcasts).toEqual([]);
  });

  test('publishes roster transitions before invoking the corresponding facet action', async () => {
    const roster = new SubordinateRosterStore(makeSql());
    roster.ensureSchema();
    const observed: Array<{ operation: string; roster: SubordinateRosterEntry | null }> = [];
    const runtime: SubordinateRuntime = {
      async spawn() {},
      async assign(name) {
        observed.push({ operation: 'assign', roster: roster.get(name) });
        return fakeHandoff('starts_now');
      },
      async status() { return { lastActivity: null, recentSteps: [] }; },
      async message(name) {
        observed.push({ operation: 'message', roster: roster.get(name) });
        return fakeHandoff('starts_now');
      },
      async dismiss(name) { observed.push({ operation: 'dismiss', roster: roster.get(name) }); },
    };
    const team = createTeamToolDeps({
      roster,
      runtime,
      createName: () => 'researcher-a1b2c3',
      now: () => 123,
      inheritedContext: () => [],
      broadcast: () => {},
      broadcastTask: () => {},
    });

    await team.spawn({ mode: 'build', role: 'researcher', mission: 'Initial mission' });
    await team.assign({ mode: 'build', name: 'researcher-a1b2c3', task: 'Replacement' });
    roster.applyReport('researcher-a1b2c3', 'blocked');
    await team.message({ mode: 'build', name: 'researcher-a1b2c3', content: 'Continue' });
    await team.dismiss({ name: 'researcher-a1b2c3' });

    expect(observed).toEqual([
      { operation: 'assign', roster: expect.objectContaining({ status: 'working', currentTask: 'Initial mission' }) },
      { operation: 'assign', roster: expect.objectContaining({ status: 'working', currentTask: 'Replacement' }) },
      { operation: 'message', roster: expect.objectContaining({ status: 'working', currentTask: 'Replacement' }) },
      { operation: 'dismiss', roster: expect.objectContaining({ status: 'dismissed', currentTask: null }) },
    ]);
  });

  test('status preserves roster authority and isolates an unavailable facet', async () => {
    const h = makeTeamHarness();
    await h.team.spawn({ mode: 'build', role: 'researcher', mission: 'Mission' });
    h.failures.add('status');

    expect(await h.team.status({})).toEqual([{
      roster: h.roster.requireActive('researcher-a1b2c3'),
      live: null,
      liveError: 'status failed',
    }]);
  });

  test('EVICTION FIX: a completed subordinate stays in the roster and answers a follow-up task', async () => {
    // The reported bug: subordinates disappeared after completing their task.
    // Completion must land the subordinate at idle — still listed, still
    // addressable — and a follow-up assignment must run on the SAME facet
    // with its context intact (no respawn, no deletion anywhere).
    const h = makeTeamHarness();
    await h.team.spawn({ mode: 'build', role: 'researcher', mission: 'Map the market.' });

    h.roster.applyReport('researcher-a1b2c3', 'completed');
    const afterCompletion = await h.team.list();
    expect(afterCompletion).toHaveLength(1);
    expect(afterCompletion[0]).toMatchObject({ name: 'researcher-a1b2c3', status: 'idle', currentTask: null });

    await h.team.assign({ mode: 'build', name: 'researcher-a1b2c3', task: 'One more comparison' });
    expect(h.roster.requireActive('researcher-a1b2c3')).toMatchObject({
      status: 'working', currentTask: 'One more comparison',
    });
    // The follow-up reached the existing facet — no dismiss, no fresh spawn.
    expect(h.calls).toEqual([
      'spawn:researcher-a1b2c3:Map the market.',
      'assign:researcher-a1b2c3:Map the market.',
      'assign:researcher-a1b2c3:One more comparison',
    ]);
  });

  test('EVICTION FIX: dismissal archives by default — storage wipe only on explicit keepHistory=false', async () => {
    const h = makeTeamHarness();
    await h.team.spawn({ mode: 'build', role: 'researcher', mission: 'Mission' });

    expect(await h.team.dismiss({ name: 'researcher-a1b2c3' }))
      .toEqual({ ok: true, name: 'researcher-a1b2c3', historyKept: true });
    // The runtime seam receives keepHistory=true → the orchestrator's
    // deleteSubAgent branch (the storage wipe) is not taken.
    expect(h.calls.at(-1)).toBe('dismiss:researcher-a1b2c3:true');
  });
});

describe('subordinate event admission', () => {
  test('canonical tasks and reports enter the standard drain rail', () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);

    const task = admitSubordinateTask(log, {
      fromWorkspace: 'proteus-main', kind: 'task', body: 'Investigate',
      deliverable: 'Report', deadlineHint: 'today', mode: 'build', now: 10,
    });
    const report = admitSubordinateReport(log, {
      fromSubordinate: 'researcher', status: 'completed', content: 'Done', task: 'Investigate', mode: 'build', now: 11,
    });

    expect(task.admitted).toBe(true);
    expect(report.admitted).toBe(true);
    expect(log.pending({ variant: 'subordinate_task' })[0]).toMatchObject({
      trust: 'authenticated', priority: 'normal',
      payload: {
        from_workspace: 'proteus-main', kind: 'task', body: 'Investigate',
        deliverable: 'Report', deadline_hint: 'today', proteus_mode: 'build',
      },
    });
    expect(log.pending({ variant: 'subordinate_report' })[0]).toMatchObject({
      trust: 'authenticated', priority: 'background',
      payload: {
        from_subordinate: 'researcher', status: 'completed', content: 'Done', task: 'Investigate', proteus_mode: 'build',
      },
    });
  });

  // The sender used to be handed a fixed sentence and told nothing about what
  // happened to the work. Everything below was already known at admission.
  test('the sender is told the event id its report will cite', () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);
    const admission = admitSubordinateTask(log, {
      fromWorkspace: 'proteus-main', kind: 'task', body: 'Investigate', mode: 'build', now: 10,
    });

    const handoff = describeSubordinateHandoff({
      admission,
      turnInFlight: false,
      live: { lastActivity: null, recentSteps: [] },
    });

    expect(handoff.eventId).toBe(admission.id);
  });

  test('a busy subordinate queues a mode-homogeneous turn, while an idle one starts now', () => {
    const live = { lastActivity: 34, recentSteps: [{ event: 'beforeturn', summary: 'reading src/auth.ts', elapsedMs: 12, createdAt: 34 }] };
    const admission = { id: 'evt-1', admitted: true };

    expect(describeSubordinateHandoff({ admission, turnInFlight: true, live })).toEqual({
      eventId: 'evt-1',
      delivery: 'queued',
      phase: { busy: true, lastActivityAt: 34, workingOn: 'reading src/auth.ts' },
    });
    expect(describeSubordinateHandoff({ admission, turnInFlight: false, live }).delivery).toBe('starts_now');
  });

  test('an admission the log rejected as a duplicate is queued, not claimed as a fresh start', () => {
    // `admitted: false` means the event was already in the log, so this
    // publish scheduled no drain of its own — it rides whatever is waiting.
    // Busy or idle is irrelevant to that, hence both.
    for (const turnInFlight of [true, false]) {
      expect(describeSubordinateHandoff({
        admission: { id: 'evt-existing', admitted: false },
        turnInFlight,
        live: { lastActivity: null, recentSteps: [] },
      })).toMatchObject({ eventId: 'evt-existing', delivery: 'queued' });
    }
  });

  test('a subordinate that has done nothing yet reports no work in progress', () => {
    const handoff = describeSubordinateHandoff({
      admission: { id: 'evt-1', admitted: true },
      turnInFlight: false,
      live: { lastActivity: null, recentSteps: [] },
    });

    expect(handoff.phase).toEqual({ busy: false, lastActivityAt: null, workingOn: null });
  });

  test('empty actor identities and bodies are rejected before EventLog admission', () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);

    expect(() => admitSubordinateTask(log, {
      fromWorkspace: ' ', kind: 'task', body: 'work', mode: 'build', now: 1,
    })).toThrow('fromWorkspace');
    expect(() => admitSubordinateTask(log, {
      fromWorkspace: 'main', kind: 'task', body: ' ', mode: 'build', now: 1,
    })).toThrow('body');
    expect(() => admitSubordinateReport(log, {
      fromSubordinate: 'researcher', status: 'progress', content: ' ', mode: 'build', now: 1,
    })).toThrow('content');
    expect(log.pending()).toEqual([]);
  });
});

describe('the owner talking to a subordinate does not wake its parent', () => {
  /**
   * Both hops of the real path, composed in the order production runs them:
   * the subordinate decides whether a finished turn owes the parent an answer
   * (subordinate-agent `onChatResponse`), then the parent decides whether what
   * arrives enters the rail that wakes it (orchestrator
   * `receiveSubordinateEvent`). The assertions read the parent's event log,
   * because that log IS the wake — a report that never lands there bills no
   * turn and enters no context.
   */
  function scenario() {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);
    const roster = new SubordinateRosterStore(makeSql());
    roster.ensureSchema();
    // Spawned with a mission, so the parent starts out waiting on an answer.
    roster.create(initialRosterEntry);

    const arrivesAtParent = (
      origin: SubordinateReportOrigin,
      content: string,
      status: SubordinateReportStatus,
    ) => {
      const entry = roster.requireActive('researcher');
      if (!parentAdmitsSubordinateReport({ entry })) return;
      admitSubordinateReport(log, { fromSubordinate: 'researcher', status, content, mode: 'build', now: 1 });
      roster.applyReport('researcher', status);
    };

    return {
      roster,
      /** A subordinate turn finishes. */
      turnEnds(input: { ownerDriven: boolean; assistantText: string; reportedThisTurn?: boolean }) {
        if (!subordinateRelaysTurnEnd({ reportedThisTurn: false, ...input })) return;
        arrivesAtParent('turn_end', input.assistantText, 'progress');
      },
      /** The subordinate chooses to speak, via the `report` tool. */
      reportTool: (content: string, status: SubordinateReportStatus = 'completed') =>
        arrivesAtParent('report_tool', content, status),
      /** A detached background job settles (the subordinate's `notifyOwner`). */
      jobSettles: (content: string) => arrivesAtParent('turn_end', content, 'progress'),
      /** What the parent was actually woken with. */
      woken: () => log.pending({ variant: 'subordinate_report' })
        .map((event) => reportPayload(event).content),
    };
  }

  test('the owner’s own conversation reaches the parent never, however long it runs', () => {
    const scene = scenario();

    // Note the parent HAS an open assignment throughout: the answer is withheld
    // because of who asked, not because the parent is idle.
    for (const reply of ['Hi — what do you need?', 'Here are three angles.', 'Done.']) {
      scene.turnEnds({ ownerDriven: true, assistantText: reply });
    }

    expect(scene.woken()).toEqual([]);
  });

  test('the answer to the parent’s own assignment still arrives automatically', () => {
    const scene = scenario();

    scene.turnEnds({ ownerDriven: false, assistantText: 'Mapped 14 competitors.' });
    // A turn that said nothing has no answer to relay.
    scene.turnEnds({ ownerDriven: false, assistantText: '   ' });

    expect(scene.woken()).toEqual(['Mapped 14 competitors.']);
  });

  test('a report tool cannot wake the parent after the assignment is complete', () => {
    const scene = scenario();
    scene.reportTool('Market mapped.', 'completed');
    expect(scene.roster.requireActive('researcher').currentTask).toBeNull();

    scene.turnEnds({ ownerDriven: true, assistantText: 'Sure, I can dig into pricing.' });
    scene.reportTool('You should see this: incumbent pricing just moved.');

    expect(scene.woken()).toEqual(['Market mapped.']);
  });

  test('work the owner’s conversation detached cannot smuggle it upward one hop later', () => {
    const scene = scenario();
    scene.reportTool('Market mapped.', 'completed');

    // A >30s tool the owner's chat turn detached: the job settles, and its wake
    // drives a turn that IS programmatic — the discriminator the subordinate
    // alone can read says "not the owner", and only the roster knows better.
    scene.jobSettles('Background run job completed.');
    scene.turnEnds({ ownerDriven: false, assistantText: 'The crawl finished: 402 pages.' });

    expect(scene.woken()).toEqual(['Market mapped.']);
  });

  test('the same job settling under a live assignment does reach the parent', () => {
    const scene = scenario();

    scene.jobSettles('Background run job completed.');

    expect(scene.woken()).toEqual(['Background run job completed.']);
  });

  test('a turn the report tool already spoke for is not relayed twice', () => {
    const scene = scenario();

    scene.reportTool('Done — 14 competitors.', 'completed');
    scene.turnEnds({
      ownerDriven: false,
      assistantText: 'Done — 14 competitors.',
      reportedThisTurn: true,
    });

    expect(scene.woken()).toEqual(['Done — 14 competitors.']);
  });
});

describe('oversize subordinate reports stay reachable', () => {
  /** The parent's ingress, in the order orchestrator.receiveSubordinateEvent
   *  runs it: normalize → spill (async, outside the storage transaction) →
   *  admit with the citation. */
  async function admitFromSubordinate(log: EventLog, vfs: Parameters<typeof spillEventContent>[0], raw: string) {
    const content = normalizeReportContent(raw);
    const contentPath = await spillEventContent(vfs, content);
    const input = {
      fromSubordinate: 'researcher', status: 'completed', content,
      task: 'Survey auth', mode: 'build', now: 11,
    } satisfies Parameters<typeof admitSubordinateReport>[1];
    if (contentPath) Object.assign(input, { contentPath });
    return admitSubordinateReport(log, input);
  }

  function freshLog(): EventLog {
    const sql = makeSql();
    initEventsHubTables(sql);
    return new EventLog(sql);
  }

  test('a report past the brief budget spills whole and the parent brief cites it', async () => {
    const log = freshLog();
    const { vfs } = createMemoryVfs();
    const content = 'seam found in the auth module; '.repeat(60).trim();

    // The wire text carries the trailing newline a model's report usually has.
    expect((await admitFromSubordinate(log, vfs, `${content}\n`)).admitted).toBe(true);

    const event = log.pending({ variant: 'subordinate_report' })[0];
    const path = reportPayload(event).content_path;
    // Normalized before spilling: the cited file is byte-for-byte the content
    // the brief truncates, never the untrimmed wire text.
    expect(path).toBe(eventContentPath(content));
    if (!path) throw new Error('expected spilled report path');
    expect(await vfs.readFile(path)).toBe(content);

    expect(renderForLLM(event).brief).toEndWith(` — full report: ${path}`);
    const batch = buildDrainBatch([event]);
    if (!batch) throw new Error('expected subordinate report drain batch');
    expect(batch.text).toContain(path);
  });

  test('a report within the brief budget writes nothing and renders exactly as before', async () => {
    const log = freshLog();
    const { vfs, files } = createMemoryVfs();

    await admitFromSubordinate(log, vfs, 'Survey done — three seams found; note written.');

    const event = log.pending({ variant: 'subordinate_report' })[0];
    expect(reportPayload(event).content_path).toBeUndefined();
    expect(files.size).toBe(0);
    expect(renderForLLM(event).brief)
      .toBe('completed [re: Survey auth]: Survey done — three seams found; note written.');
  });
});

describe('the parent ingress, in the order it runs', () => {
  /** One parent, with an open assignment out to `researcher`. */
  function parent() {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);
    const roster = new SubordinateRosterStore(makeSql());
    roster.ensureSchema();
    roster.create(initialRosterEntry);
    const { vfs, files } = createMemoryVfs();
    const seen: string[] = [];
    const announced: Array<{ id: string; content: string }> = [];
    return {
      log, roster, files, seen, announced,
      deps: {
        log,
        roster,
        vfs,
        transaction: <T,>(body: () => T): T => { seen.push('transaction'); return body(); },
        announce: (report: { id: string; content: string }) => {
          seen.push('announce');
          announced.push({ id: report.id, content: report.content });
        },
        onAdmitted: () => { seen.push('drain'); },
      },
    };
  }

  test('spills before opening the storage transaction, so the async write is never inside it', async () => {
    const scene = parent();
    const content = 'seam found in the auth module; '.repeat(60).trim();
    const spilled = eventContentPath(content);
    // The VFS write is async and the transaction body is not: observing the
    // file already on the plane when the transaction opens is what proves the
    // ordering, not the shape of the source.
    const transaction = scene.deps.transaction;
    scene.deps.transaction = <T,>(body: () => T): T => {
      expect(scene.files.has(spilled)).toBe(true);
      return transaction(body);
    };

    const result = await receiveSubordinateEvent(scene.deps, {
      fromSubordinate: 'researcher', status: 'completed', content: `${content}\n`,
      origin: 'report_tool', mode: 'build',
    }, 11);

    expect(result.admitted).toBe(true);
    // Normalized before spilling: the cited file is the content the brief
    // truncates, never the untrimmed wire text.
    expect(await scene.files.get(spilled)).toBe(content);
    const event = scene.log.pending({ variant: 'subordinate_report' })[0];
    expect(reportPayload(event).content_path).toBe(spilled);
    // …and the roster write shares the transaction the admit opened.
    expect(scene.seen).toEqual(['transaction', 'announce', 'drain']);
    expect(scene.roster.requireActive('researcher')).toMatchObject({ status: 'idle', currentTask: null });
  });

  test('drops what the parent is not waiting on before the spill, leaving no file behind', async () => {
    const scene = parent();
    scene.roster.applyReport('researcher', 'completed');   // no open assignment left

    const result = await receiveSubordinateEvent(scene.deps, {
      fromSubordinate: 'researcher', status: 'progress', content: 'x'.repeat(4000),
      origin: 'turn_end', mode: 'build',
    }, 12);

    expect(result).toEqual({ id: '', admitted: false });
    expect(scene.files.size).toBe(0);
    expect(scene.seen).toEqual([]);
    expect(scene.log.pending({ variant: 'subordinate_report' })).toEqual([]);
  });

  test('a report from a subordinate this parent does not have is refused, not admitted', async () => {
    const scene = parent();
    await expect(receiveSubordinateEvent(scene.deps, {
      fromSubordinate: 'ghost', status: 'progress', content: 'hello', origin: 'report_tool', mode: 'build',
    }, 13)).rejects.toThrow('unknown subordinate "ghost"');
    expect(scene.files.size).toBe(0);
  });
});
