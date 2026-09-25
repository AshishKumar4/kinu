import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  buildDrainBatch,
  drainAssignments,
  subordinateTurnContext,
  type AdmittedAssignment,
  type DrainAssignmentsOptions,
  EventLog,
  eventContentPath,
  initEventsHubTables,
  renderForLLM,
  spillEventContent,
  SubordinateIdentityStore,
  SubordinateRosterStore,
  DELEGATION_MAX_DEPTH,
  ROOT_DELEGATION_BUDGET,
  delegationBudgetAtDepth, delegationBudgetOf,
  delegationDepthRefusal,
  delegationExhausted,
  deriveChildDelegationBudget,
  admitSubordinateReport,
  admitSubordinateTask,
  createTeamToolDeps,
  describeSubordinateHandoff,
  subordinateDescriptorSource,
  normalizeReportContent,
  parentAdmitsSubordinateReport,
  readSubordinateLiveStatus,
  receiveSubordinateEvent,
  SUBORDINATE_REPORT_HANDOFF_MAX_CHARS,
  type ReportToolDeps,
  type SubordinateIngressDeps,
  subordinateRelaysTurnEnd,
  type SerializedMessage,
  type SqlExec,
  type SubordinateDelivery,
  type SubordinateIdentity,
  type SubordinateHandoff,
  type SubordinateReportOrigin,
  type SubordinateReportPayload,
  type SubordinateReportStatus,
  type SubordinateRosterEntry,
  type SubordinatesChangedEvent,
  type SubordinateRuntime,
  type KinuEvent,
  WorkspaceActorDirectory, actorReferenceOf, recoverSubordinateLifecycles, type ActorReference,
  type ActorHandle,
  type AgentConfigStore,
} from '../src/index';
import { CODE_IS_REFUSAL, KinuError } from '../src/obs/index';
import { codenameFor } from '../src/identity/naming';
import { createMemoryVfs, createTestActors, type MemoryVfs } from '@kinu.run/test-utils';
import {
  makeSql as makeTagged, makeSqlExec, makeExecRaw, createTestActor, createTestWorkspace,
} from './helpers';
import type { z } from 'zod';
import { dispatchReport, ReportToolInputSchema, type ReportToolResult } from '../src/tools/report-tool';

const NOW = 1_700_000_000_000;

/** Port and actor over ONE Database: stores key on actor_id, so handles from two databases read an empty roster. */
function makeWorld(db: Database = new Database(':memory:')) {
  return {
    sql: makeSqlExec(db),
    actor: createTestActor(makeTagged(db), makeExecRaw(db), 'subordinates-workspace', 'main'),
  } satisfies { sql: SqlExec; actor: ActorHandle };
}

function makeRosterStore(db: Database = new Database(':memory:')): SubordinateRosterStore {
  const { sql, actor } = makeWorld(db);

  return new SubordinateRosterStore(sql, actor);
}

function makeIdentityStore(db: Database = new Database(':memory:')): SubordinateIdentityStore {
  const { sql, actor } = makeWorld(db);

  return new SubordinateIdentityStore(sql, actor);
}

function reportPayload(event: KinuEvent | undefined): SubordinateReportPayload {
  if (!event) throw new Error('expected subordinate report event');

  if (event.variant !== 'subordinate_report') throw new Error('expected subordinate report payload');

  return v.parse(v.object({
    from_subordinate: v.string(),
    status: v.picklist(['progress', 'completed', 'blocked']),
    content: v.string(),
    sequence_id: v.string(),
    task: v.optional(v.string()),
    content_path: v.optional(v.string()),
    // Both schemas strip unlisted fields, so a handoff field missing from either reads back undefined.
    concerns: v.optional(v.array(v.string())),
    deviations: v.optional(v.array(v.string())),
    findings: v.optional(v.array(v.string())),
    open_work: v.optional(v.array(v.string())),
    kinu_mode: v.picklist(['build', 'plan']),
  }), event.payload);
}

const identityInput: SubordinateIdentity = {
  name: 'researcher',
  mission: 'Map the market.',
  parentWorkspace: 'kinu-main',
  ownerUserId: 'owner-123',
  depth: 1,
  lifetime: 'durable',
};

describe('subordinate identity', () => {
  test('seed is immutable while allowing an identical parent retry', () => {
    const identity = makeIdentityStore();
    identity.ensureSchema();

    identity.seed(identityInput);
    identity.seed(identityInput);

    expect(identity.read()).toEqual(identityInput);
    expect(identity.ownerUserId()).toBe('owner-123');
    expect(identity.workspaceName()).toBe('kinu-main');
    expect(() => identity.seed({ ...identityInput, ownerUserId: 'attacker' }))
      .toThrow('already initialized');
    expect(identity.read()).toEqual(identityInput);
  });

  test('a retry cannot retarget the subordinate name or workspace', () => {
    const identity = makeIdentityStore();
    identity.ensureSchema();
    identity.seed(identityInput);

    expect(() => identity.seed({ ...identityInput, name: 'attacker' }))
      .toThrow('already initialized');
    expect(() => identity.seed({ ...identityInput, parentWorkspace: 'other-workspace' }))
      .toThrow('already initialized');
    expect(identity.read()).toEqual(identityInput);
  });

  // The cap is enforced from depth: a subordinate re-seeding itself shallower would get a fresh subtree.
  test('depth is part of the immutable identity, not a settable field', () => {
    const identity = makeIdentityStore();
    identity.ensureSchema();
    identity.seed({ ...identityInput, depth: 3, lifetime: 'durable' });

    expect(() => identity.seed({ ...identityInput, depth: 1, lifetime: 'durable' }))
      .toThrow('already initialized');
    expect(identity.read()?.depth).toBe(3);
  });

  // A Durable Object is evicted routinely, so depth must be durable; a second store over the same
  // database is exactly what a resumed facet does.
  test('depth survives a resume: a fresh store over the same storage reads it back', () => {
    const db = new Database(':memory:');
    const first = makeIdentityStore(db);
    first.ensureSchema();
    first.seed({ ...identityInput, depth: 3, lifetime: 'durable' });
    expect(first.delegationBudget()).toEqual({ depth: 3, maxDepth: 1 });

    const resumed = makeIdentityStore(db);
    resumed.ensureSchema();
    expect(resumed.read()?.depth).toBe(3);
    expect(resumed.delegationBudget()).toEqual({ depth: 3, maxDepth: 1 });
  });

  // Fail closed: an unseeded facet must not read as the root.
  test('an unseeded facet reads as exhausted rather than as the root', () => {
    const identity = makeIdentityStore();
    identity.ensureSchema();
    expect(identity.read()).toBeNull();
    expect(identity.delegationBudget().maxDepth).toBe(0);
    expect(delegationExhausted(identity.delegationBudget())).toBe(true);
  });

});

describe('the child descriptor authority', () => {
  // S2: presentation fields live only in the child's actor_config and must survive a cold reopen.
  function makeConfig(db: Database): AgentConfigStore {
    return createTestActor(makeTagged(db), makeExecRaw(db), crypto.randomUUID(), 'descriptor-test').config;
  }

  test('rename and role switch read back from actor_config after a cold reopen', () => {
    const db = new Database(':memory:');
    const config = makeConfig(db);
    config.setDisplayNameOrigin('Jarvis', 'user');
    config.setRoleSelection('researcher');
    config.setAssignedTier('deep');

    const cold = makeConfig(db);
    expect(subordinateDescriptorSource(cold).read()).toEqual({
      displayName: 'Jarvis',
      nameOrigin: 'user',
      role: 'researcher',
      tier: 'deep',
    });
  });

  test('an unset config reads as a blank auto-titled general-hire descriptor', () => {
    const source = subordinateDescriptorSource(makeConfig(new Database(':memory:')));
    expect(source.read()).toEqual({
      displayName: '',
      nameOrigin: 'auto',
      role: 'task',
      tier: null,
    });
  });


  // The identity row is immutable lineage: presentation changes never touch it.
  test('identity stays immutable lineage while presentation changes around it', () => {
    const db = new Database(':memory:');
    const identity = makeIdentityStore(db);
    identity.ensureSchema();
    identity.seed(identityInput);
    const config = makeConfig(db);
    config.setDisplayNameOrigin('New Name', 'user');

    expect(identity.read()).toEqual(identityInput);
    expect(() => identity.seed({ ...identityInput, mission: 'different' }))
      .toThrow('already initialized');
  });
});

describe('the delegation depth cap', () => {
  // Derived from the parent's numbers (heads/types.ts deriveChildBudget).
  test('a child budget is derived from its parent and runs out at the cap', () => {
    expect(DELEGATION_MAX_DEPTH).toBe(4);
    let budget = ROOT_DELEGATION_BUDGET;
    expect(budget).toEqual({ depth: 0, maxDepth: 4 });

    const chain = [budget];

    for (let i = 0; i < 4; i += 1) {
      expect(delegationExhausted(budget)).toBe(false);
      budget = deriveChildDelegationBudget(budget);
      chain.push(budget);
    }

    expect(chain.map((b) => b.depth)).toEqual([0, 1, 2, 3, 4]);
    expect(chain.map((b) => b.maxDepth)).toEqual([4, 3, 2, 1, 0]);
    expect(delegationExhausted(budget)).toBe(true);
  });

  test('the refusal names the depth reached and classifies as a refusal, not a defect', () => {
    const atCap = delegationBudgetAtDepth(4);
    const refusal = delegationDepthRefusal(atCap);
    expect(refusal.reason).toBe('denied');
    expect(CODE_IS_REFUSAL[refusal.reason]).toBe(true);
    expect(refusal.error).toContain('depth 4');
    expect(refusal.error).toContain('depth 5');
    expect(refusal.error).toContain('swarm');
  });

  // Clamping means a stored depth can only make an actor more restricted.
  test('a depth past the cap clamps to no room rather than to negative room', () => {
    expect(delegationBudgetAtDepth(9)).toEqual({ depth: 9, maxDepth: 0 });
  });

  test('a child derived at the cap clamps rather than going negative', () => {
    expect(deriveChildDelegationBudget(delegationBudgetAtDepth(4))).toEqual({ depth: 5, maxDepth: 0 });
  });

  test('a stored negative depth reads as the root instead of inflating room', () => {
    expect(delegationBudgetAtDepth(-2)).toEqual({ depth: 0, maxDepth: DELEGATION_MAX_DEPTH });
  });

  test('an actor\'s depth is walked off its directory row, and a missing parent ends the walk as a floor', () => {
    const rows = new Map<string, { parentActorId: string | null }>([
      ['root', { parentActorId: null }],
      ['d1', { parentActorId: 'root' }],
      ['d2', { parentActorId: 'd1' }],
      ['orphan', { parentActorId: 'gone' }],
    ]);

    const row = (actorId: string) => {
      const found = rows.get(actorId);

      if (!found) throw new Error(`no fixture row ${actorId}`);

      return found;
    };

    const describeActor = (actorId: string) => rows.get(actorId) ?? null;
    expect(delegationBudgetOf(describeActor, row('root'))).toEqual(ROOT_DELEGATION_BUDGET);
    expect(delegationBudgetOf(describeActor, row('d1'))).toEqual({ depth: 1, maxDepth: 3 });
    expect(delegationBudgetOf(describeActor, row('d2'))).toEqual({ depth: 2, maxDepth: 2 });
    expect(delegationBudgetOf(describeActor, row('orphan'))).toEqual({ depth: 1, maxDepth: 3 });
  });
});

const initialRosterEntry: SubordinateRosterEntry = { name: 'researcher', actorReference: null, birth: null, deleteRequested: false, createdBy: 'orchestrator', status: 'working', currentTask: 'Map the market.', createdAt: 100, dismissedAt: null, lifetime: 'durable', taskEventId: null };

describe('workspace subordinate roster', () => {
  test('owns closed status transitions and can restore an exact snapshot', () => {
    const roster = makeRosterStore();
    roster.ensureSchema();
    roster.create(initialRosterEntry);

    roster.applyReport('researcher', 'blocked', 'report_tool', NOW);
    expect(roster.requireActive('researcher')).toMatchObject({
      status: 'awaiting_input', currentTask: 'Map the market.',
    });

    roster.resumeAfterMessage('researcher');
    expect(roster.requireActive('researcher').status).toBe('working');

    roster.applyReport('researcher', 'completed', 'report_tool', NOW);
    expect(roster.requireActive('researcher')).toMatchObject({ status: 'idle', currentTask: null });

    roster.applyReport('researcher', 'progress', 'report_tool', NOW);
    expect(roster.requireActive('researcher').status).toBe('idle');

    roster.assign('researcher', 'Compare vendors');
    roster.applyReport('researcher', 'progress', 'report_tool', NOW);
    expect(roster.requireActive('researcher')).toMatchObject({
      status: 'working', currentTask: 'Compare vendors',
    });

    const beforeDismiss = roster.requireActive('researcher');
    roster.dismiss('researcher', 200);
    roster.dismiss('researcher', 300);
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
    // The production activity_log, keyed by (actor_id, id).
    const workspace = createTestWorkspace();
    const sql = makeSqlExec(workspace.db);
    const actors = createTestActors(workspace.sql, workspace.execRaw);

    const insert = (owner: string, index: number, detail: string): void => {
      sql.exec(
        `INSERT INTO activity_log (actor_id, id, event, detail, elapsed_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        owner,
        `id-${index}`,
        `step-${index}`,
        detail,
        index * 10,
        index * 100,
      );
    };

    for (let index = 1; index <= 7; index++) {
      insert(actors.main.actorId, index, index === 7 ? 'Integrated auth findings' : `detail-${index}`);
    }

    // A sibling's newer step in the same table: an unscoped read would report it as this child's.
    insert(actors.sibling('other').actorId, 9, 'someone else entirely');

    expect(readSubordinateLiveStatus(sql, actors.main)).toEqual({
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
  runtime: SubordinateRuntime;
  actorReference(): ActorReference;
  team: ReturnType<typeof createTeamToolDeps>;
  calls: string[];
  assignments: Array<Parameters<SubordinateRuntime['assign']>[1]>;
  seeds: Array<Parameters<SubordinateRuntime['spawn']>[0]>;
  broadcasts: number[];
  events: SubordinatesChangedEvent[];
  tasks: Array<{ subordinate: string; content: string; timestamp: number }>;
  failures: Set<keyof SubordinateRuntime>;
}

const HARNESS_OWN_MISSION = 'Keep the release train moving.';

function makeTeamHarness(inheritedContext: SerializedMessage[] = []): TeamHarness {
  const roster = makeRosterStore();
  roster.ensureSchema();
  const calls: string[] = [];
  const assignments: Array<Parameters<SubordinateRuntime['assign']>[1]> = [];
  const seeds: Array<Parameters<SubordinateRuntime['spawn']>[0]> = [];
  const broadcasts: number[] = [];
  const events: SubordinatesChangedEvent[] = [];
  const tasks: Array<{ subordinate: string; content: string; timestamp: number }> = [];
  const failures = new Set<keyof SubordinateRuntime>();

  const fail = (operation: keyof SubordinateRuntime) => {
    if (failures.has(operation)) throw new KinuError('unavailable', `${operation} failed`);
  };

  const actorDb = new Database(':memory:');
  const actorSql = makeTagged(actorDb);
  createTestActor(actorSql, makeExecRaw(actorDb), 'team-workspace', 'main');
  const directory = new WorkspaceActorDirectory(actorSql, { workspaceId: 'team-workspace', ownerUserId: '' });

  const runtime: SubordinateRuntime = {
    async spawn(input) {
      seeds.push(input);
      calls.push(`spawn:${input.name}:${input.mission}`);
      fail('spawn');

      return directory.apply(directory.main(), [], { action: 'register', creationId: input.creationId, name: input.name, kind: 'subordinate', lifetime: input.lifetime }).reference;
    },
    async cancelBirth(input) {
      const entry = directory.apply(directory.main(), [], { action: 'cancelCreation', creationId: input.creationId, name: input.name, kind: 'subordinate', lifetime: input.lifetime });

      if (entry.state !== 'deleted') directory.apply(directory.main(), [], { action: 'release', name: input.name, reference: entry.reference });

      return entry.reference;
    },
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
    async rename(name, displayName, nameOrigin) {
      calls.push(`rename:${name}:${displayName}:${nameOrigin}`);
      fail('rename');
    },
    async dismiss(name, keepHistory, reference) {
      calls.push(`dismiss:${name}:${keepHistory}`); fail('dismiss');

      if (!keepHistory) {
        directory.apply(directory.main(), [], { action: 'retire', name, reference });
        directory.apply(directory.main(), [], { action: 'release', name, reference });
      }
    },
  };

  const team = createTeamToolDeps({
    delegation: ROOT_DELEGATION_BUDGET,
    roster,
    runtime,
    createName: () => 'researcher-a1b2c3',
    now: () => 1_700_000_000_000,
    inheritedContext: async () => inheritedContext,
    ownMission: () => HARNESS_OWN_MISSION,
    broadcast: (event) => { broadcasts.push(Date.now()); events.push(event); },
    broadcastTask: (event) => { tasks.push(event); },
  });

  return { roster, runtime, team, calls, seeds, assignments, broadcasts, events, tasks, failures,
    actorReference: () => {
      const actor = directory.resolveChild(directory.main(), 'researcher-a1b2c3');

      if (!actor) throw new Error('The admitted actor is missing.');

      return actorReferenceOf(actor);
    } };
}

describe('team action routing', () => {
  test('owner creation seeds an idle identity without starting work or mirroring a task', async () => {
    const h = makeTeamHarness();

    expect(await h.team.create({ role: 'researcher', mission: 'Understand the domain.' })).toEqual({
      name: 'researcher-a1b2c3', displayName: 'Researcher',
      subordinate: { name: 'researcher-a1b2c3', actorReference: h.actorReference(), birth: null, deleteRequested: false, createdBy: 'user', status: 'idle', currentTask: null, createdAt: 1_700_000_000_000, dismissedAt: null, lifetime: 'durable', taskEventId: null },
    });
    expect(h.roster.requireActive('researcher-a1b2c3')).toMatchObject({
      createdBy: 'user', status: 'idle', currentTask: null,
    });
    expect(h.seeds[0]).toMatchObject({
      displayName: 'Researcher', nameOrigin: 'auto',
      role: 'researcher',
      // A hire seeds a durable child, which keeps selective relay; only task children always report.
      lifetime: 'durable',
    });
    expect(h.calls).toEqual(['spawn:researcher-a1b2c3:Understand the domain.']);
    expect(h.assignments).toEqual([]);
    expect(h.tasks).toEqual([]);
    expect(h.broadcasts).toHaveLength(1);
  });

  test('an owner-created agent with nothing said about it inherits the mission and the general catalog role', async () => {
    const h = makeTeamHarness();

    const created = await h.team.create({});

    expect(created.subordinate).toEqual({ name: 'researcher-a1b2c3', actorReference: h.actorReference(), birth: null, deleteRequested: false, createdBy: 'user', status: 'idle', currentTask: null, createdAt: 1_700_000_000_000, dismissedAt: null, lifetime: 'durable', taskEventId: null });
    expect(created.displayName).toBe(codenameFor('researcher-a1b2c3'));
    expect(h.seeds).toEqual([{
      creationId: expect.any(String), name: 'researcher-a1b2c3',
      displayName: codenameFor('researcher-a1b2c3'),
      nameOrigin: 'auto',
      mission: HARNESS_OWN_MISSION,
      role: 'task',
      lifetime: 'durable',
    }]);
    expect(h.assignments).toEqual([]);
    expect(h.tasks).toEqual([]);
  });

  test('an owner who names the agent owns that name; a role alone is only a derived one', async () => {
    const named = makeTeamHarness();
    await named.team.create({ displayName: 'Jarvis' });
    expect(named.seeds[0]).toMatchObject({ displayName: 'Jarvis', nameOrigin: 'user' });

    const byRole = makeTeamHarness();
    await byRole.team.create({ role: 'auditor' });
    expect(byRole.seeds[0]).toMatchObject({ displayName: 'Auditor', nameOrigin: 'auto' });
  });

  test('a model hire still refuses to invent a role or a mission', async () => {
    const h = makeTeamHarness();

    // A model's hire arrives as JSON, so this omits `role` to reach the runtime refusal.
    await expect(h.team.spawn(JSON.parse(JSON.stringify({ mission: 'Do the thing.', mode: 'build' }))))
      .rejects.toThrow('role must be non-empty');
    await expect(h.team.spawn({ role: 'auditor', mission: '   ', mode: 'build' }))
      .rejects.toThrow('mission must be non-empty');
    expect(h.seeds).toEqual([]);
    expect(h.roster.list()).toEqual([]);
  });

  test('a rename delegates to the child and refreshes the roster once', async () => {
    const h = makeTeamHarness();
    await h.team.create({});

    const renamed = await h.team.rename({ name: 'researcher-a1b2c3', displayName: '  Release Warden  ' });

    expect(renamed).toMatchObject({ ok: true, displayName: 'Release Warden' });
    expect(h.calls).toContain('rename:researcher-a1b2c3:Release Warden:user');
    expect(h.broadcasts).toHaveLength(2);
    expect('displayName' in h.roster.requireActive('researcher-a1b2c3')).toBe(false);
  });

  test('a rename the child refuses broadcasts nothing and writes nothing locally', async () => {
    const h = makeTeamHarness();
    await h.team.create({ displayName: 'Before' });
    h.failures.add('rename');

    await expect(h.team.rename({ name: 'researcher-a1b2c3', displayName: 'After' }))
      .rejects.toThrow('rename failed');
    expect(h.broadcasts).toHaveLength(1);
  });

  test('an empty rename is refused rather than blanking a name somebody chose', async () => {
    const h = makeTeamHarness();
    await h.team.create({ displayName: 'Jarvis' });

    await expect(h.team.rename({ name: 'researcher-a1b2c3', displayName: '  ' }))
      .rejects.toThrow('displayName must be non-empty');
    expect(h.calls).not.toContain(expect.stringContaining('rename:'));
  });

  test('a title the child settled on only refreshes the roster listeners', async () => {
    const h = makeTeamHarness();
    await h.team.create({});

    await h.team.recordTitle({ name: 'researcher-a1b2c3', displayName: 'Callback Audit' });

    expect(h.calls).toEqual(['spawn:researcher-a1b2c3:Keep the release train moving.']);
    expect(h.broadcasts).toHaveLength(2);
    expect('displayName' in h.roster.requireActive('researcher-a1b2c3')).toBe(false);
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

  test('a fresh hire is born from its mission alone, and its row wakes no reactor', async () => {
    const inheritedContext: SerializedMessage[] = [
      { id: 's1', role: 'system', content: 'Internal system policy', createdAt: 1 },
      { id: 'u1', role: 'user', content: 'Fix auth and billing in parallel.', createdAt: 2 },
      { id: 't1', role: 'tool', content: 'Very noisy tool output', createdAt: 3 },
      { id: 'a1', role: 'assistant', content: 'I will split the independent workstreams.', createdAt: 4 },
    ];

    const h = makeTeamHarness(inheritedContext);

    await h.team.spawn({ mode: 'build', role: 'researcher', mission: 'Repair the auth flow.' });

    // The cf pin (`unit-hire-fork.test.ts`) requires a fresh hire's first message to be its mission.
    expect(h.assignments[0]?.inheritedContext).toBeUndefined();
    expect(h.assignments[0]?.body).toBe('Repair the auth flow.');

    // `wakesADrain` excludes assignment rows, so no reactor hands the child a summary of its own brief.
    const { sql, actor } = makeWorld();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);
    admitSubordinateTask(log, {
      fromWorkspace: 'kinu-main',
      kind: 'task',
      body: 'Repair the auth flow.',
      mode: 'build',
      now: 10,
    });

    expect(log.pending({ variant: 'subordinate_task' })).toHaveLength(1);
    expect(buildDrainBatch(log.pending({ variant: 'subordinate_task' }))).toBeNull();
  });

  // S22: an assignment fires exactly one roster refresh and one task event.
  test('an assignment fires exactly one roster refresh and one task event', async () => {
    const h = makeTeamHarness();
    await h.team.spawn({ mode: 'build', role: 'researcher', mission: 'Map the market.' });
    expect(h.broadcasts).toHaveLength(1);
    expect(h.tasks).toHaveLength(1);

    await h.team.assign({ mode: 'build', name: 'researcher-a1b2c3', task: 'Compare vendors' });
    expect(h.broadcasts).toHaveLength(2);
    expect(h.tasks).toHaveLength(2);
    expect(h.events.every((event) => !('assignedTask' in event))).toBe(true);
  });

  test('successful actions expose one canonical roster and nested live status', async () => {
    const h = makeTeamHarness();

    expect(await h.team.spawn({ mode: 'build', role: 'researcher', mission: 'Map the market.' })).toEqual({
      name: 'researcher-a1b2c3', displayName: 'Researcher',
    });
    expect(await h.team.list()).toEqual([{
      name: 'researcher-a1b2c3', actorReference: h.actorReference(), birth: null, deleteRequested: false,
      createdBy: 'orchestrator', status: 'working', currentTask: 'Map the market.',
      createdAt: 1_700_000_000_000, dismissedAt: null,
      // A durable hire's row names its mission's event id, which its report will cite.
      lifetime: 'durable', taskEventId: 'evt-starts_now',
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

    h.roster.applyReport('researcher-a1b2c3', 'blocked', 'report_tool', NOW);
    await h.team.message({ mode: 'build', name: 'researcher-a1b2c3', content: 'Include pricing.' });
    expect(h.roster.requireActive('researcher-a1b2c3').status).toBe('working');

    await h.team.dismiss({ name: 'researcher-a1b2c3', keepHistory: false });
    expect(await h.team.list()).toEqual([]);
    expect(h.roster.get('researcher-a1b2c3')).toBeNull();
    expect(h.broadcasts).toHaveLength(4);
  });

  test('runtime failures roll the roster back and never broadcast partial state', async () => {
    const operations: Array<keyof Pick<SubordinateRuntime, 'spawn' | 'assign' | 'message' | 'dismiss'>> = [
      'spawn', 'assign', 'message', 'dismiss',
    ];

    for (const operation of operations) {
      const h = makeTeamHarness();

      if (operation !== 'spawn') await h.team.spawn({ mode: 'build', role: 'researcher', mission: 'Initial mission' });

      if (operation === 'message') h.roster.applyReport('researcher-a1b2c3', 'blocked', 'report_tool', NOW);
      const before = h.roster.get('researcher-a1b2c3');
      const broadcastsBefore = h.broadcasts.length;
      h.failures.add(operation);

      const actions = {
        spawn: () => h.team.spawn({ mode: 'build', role: 'researcher', mission: 'Mission' }),
        assign: () => h.team.assign({ mode: 'build', name: 'researcher-a1b2c3', task: 'Replacement' }),
        message: () => h.team.message({ mode: 'build', name: 'researcher-a1b2c3', content: 'Continue' }),
        dismiss: () => h.team.dismiss({ name: 'researcher-a1b2c3' }),
      };

      const action = actions[operation]();

      await expect(action).rejects.toMatchObject({ code: 'unavailable' });

      if (operation === 'spawn') expect(h.roster.requireExisting('researcher-a1b2c3').birth?.seed.mission).toBe('Mission');
      else expect(h.roster.get('researcher-a1b2c3')).toEqual(before);
      expect(h.broadcasts).toHaveLength(broadcastsBefore);
      expect(h.tasks).toHaveLength(operation === 'spawn' ? 0 : 1);
    }
  });

  test('an event write after admission still rolls the roster back to before', async () => {
    const h = makeTeamHarness();
    await h.team.spawn({ mode: 'build', role: 'researcher', mission: 'Initial mission' });
    const before = h.roster.get('researcher-a1b2c3');
    const broadcastsBefore = h.broadcasts.length;
    // Forcing this write to throw proves the rollback scope covers it.
    const recordAssignmentEvent = h.roster.recordAssignmentEvent.bind(h.roster);
    h.roster.recordAssignmentEvent = () => { throw new Error('event write failed'); };

    try {
      await expect(h.team.assign({ mode: 'build', name: 'researcher-a1b2c3', task: 'Replacement' }))
        .rejects.toThrow('event write failed');
    } finally {
      h.roster.recordAssignmentEvent = recordAssignmentEvent;
    }

    expect(h.roster.get('researcher-a1b2c3')).toEqual(before);
    expect(h.broadcasts).toHaveLength(broadcastsBefore);
    expect(h.tasks).toHaveLength(1);
  });

  test('the durable verbs refuse a task-lifetime row before trying anything', async () => {
    const h = makeTeamHarness();
    // A temporary run's report resolves a waiter on this id; retargeting the row would orphan it.
    h.roster.create({ name: 'ask-auditor-a1b2c3', actorReference: null, birth: null, deleteRequested: false, createdBy: 'orchestrator', status: 'working', currentTask: 'Is the migration reversible?', createdAt: 1_700_000_000_000, dismissedAt: null, lifetime: 'task', taskEventId: 'evt-1' });
    const before = h.roster.get('ask-auditor-a1b2c3');

    const attempts: Array<() => Promise<object>> = [
      () => h.team.assign({ mode: 'build', name: 'ask-auditor-a1b2c3', task: 'Other work' }),
      () => h.team.message({ mode: 'build', name: 'ask-auditor-a1b2c3', content: 'More context' }),
      () => h.team.dismiss({ name: 'ask-auditor-a1b2c3' }),
    ];

    for (const attempt of attempts) {
      const attempted = attempt();
      await expect(attempted).rejects.toBeInstanceOf(KinuError);
      await expect(attempted).rejects.toMatchObject({ code: 'bad_input' });
    }

    expect(h.roster.get('ask-auditor-a1b2c3')).toEqual(before);
    expect(h.calls).toEqual([]);
    expect(h.broadcasts).toEqual([]);
    expect(h.tasks).toEqual([]);
  });

  test('a lost initial admission remains recoverable under the same actor identity', async () => {
    const h = makeTeamHarness();
    h.failures.add('assign');
    await expect(h.team.spawn({ mode: 'build', role: 'researcher', mission: 'Mission' })).rejects.toMatchObject({ code: 'unavailable' });
    const before = h.roster.requireExisting('researcher-a1b2c3');
    expect(before.birth?.assignment?.body).toBe('Mission');
    h.failures.clear();
    await recoverSubordinateLifecycles(h.roster, h.runtime);
    const after = h.roster.requireExisting('researcher-a1b2c3');
    expect(after.actorReference).toEqual(before.actorReference);
    expect(after.birth).toBeNull();
    expect(after.taskEventId).toBe('evt-starts_now');
  });

  test('a failed physical deletion retains the exact row for retry', async () => {
    const h = makeTeamHarness();
    await h.team.spawn({ mode: 'build', role: 'researcher', mission: 'Mission' });
    const reference = h.actorReference();
    h.failures.add('dismiss');
    await expect(h.team.dismiss({ name: 'researcher-a1b2c3', keepHistory: false })).rejects.toMatchObject({ code: 'unavailable' });
    expect(h.roster.requireExisting('researcher-a1b2c3').actorReference).toEqual(reference);
    expect(h.roster.requireExisting('researcher-a1b2c3').deleteRequested).toBe(true);
    h.failures.clear();
    await recoverSubordinateLifecycles(h.roster, h.runtime);
    expect(h.roster.get('researcher-a1b2c3')).toBeNull();
  });

  test('publishes roster transitions before invoking the corresponding facet action', async () => {
    const roster = makeRosterStore();
    roster.ensureSchema();
    const observed: Array<{ operation: string; roster: SubordinateRosterEntry | null }> = [];
    const actorDb = new Database(':memory:');
    const actor = createTestActor(makeTagged(actorDb), makeExecRaw(actorDb), 'transition-workspace', 'main');

    const observe = (operation: 'assign' | 'message', name: string) => {
      observed.push({ operation, roster: roster.get(name) });

      return fakeHandoff('starts_now');
    };

    const runtime: SubordinateRuntime = {
      async spawn() { return actorReferenceOf(actor); },
      async cancelBirth() { return actorReferenceOf(actor); },
      async assign(name) { return observe('assign', name); },
      async status() { return { lastActivity: null, recentSteps: [] }; },
      async message(name) { return observe('message', name); },
      async rename(name) { observed.push({ operation: 'rename', roster: roster.get(name) }); },
      async dismiss(name) { observed.push({ operation: 'dismiss', roster: roster.get(name) }); },
    };

    const team = createTeamToolDeps({
      delegation: ROOT_DELEGATION_BUDGET,
      roster,
      runtime,
      createName: () => 'researcher-a1b2c3',
      now: () => 123,
      inheritedContext: async () => [],
      ownMission: () => HARNESS_OWN_MISSION,
      broadcast: () => {},
      broadcastTask: () => {},
    });

    await team.spawn({ mode: 'build', role: 'researcher', mission: 'Initial mission' });
    await team.assign({ mode: 'build', name: 'researcher-a1b2c3', task: 'Replacement' });
    roster.applyReport('researcher-a1b2c3', 'blocked', 'report_tool', NOW);
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
    const h = makeTeamHarness();
    await h.team.spawn({ mode: 'build', role: 'researcher', mission: 'Map the market.' });

    h.roster.applyReport('researcher-a1b2c3', 'completed', 'report_tool', NOW);
    const afterCompletion = await h.team.list();
    expect(afterCompletion).toHaveLength(1);
    expect(afterCompletion[0]).toMatchObject({ name: 'researcher-a1b2c3', status: 'idle', currentTask: null });

    await h.team.assign({ mode: 'build', name: 'researcher-a1b2c3', task: 'One more comparison' });
    expect(h.roster.requireActive('researcher-a1b2c3')).toMatchObject({
      status: 'working', currentTask: 'One more comparison',
    });
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
    // keepHistory=true skips the orchestrator's deleteSubAgent storage wipe.
    expect(h.calls.at(-1)).toBe('dismiss:researcher-a1b2c3:true');
  });
});

describe('subordinate event admission', () => {
  test('canonical tasks and reports enter the standard drain rail', () => {
    const { sql, actor } = makeWorld();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);

    const task = admitSubordinateTask(log, {
      fromWorkspace: 'kinu-main', kind: 'task', body: 'Investigate',
      deliverable: 'Report', mode: 'build', now: 10,
    });

    const report = admitSubordinateReport(log, {
      fromSubordinate: 'researcher', status: 'completed', content: 'Done', task: 'Investigate',
      sequenceId: 'settle:msg-1', mode: 'build', now: 11,
    });

    expect(task.admitted).toBe(true);
    expect(report.admitted).toBe(true);
    expect(log.pending({ variant: 'subordinate_task' })[0]).toMatchObject({
      trust: 'authenticated', priority: 'normal',
      payload: {
        from_workspace: 'kinu-main', kind: 'task', body: 'Investigate',
        deliverable: 'Report', kinu_mode: 'build',
      },
    });
    expect(log.pending({ variant: 'subordinate_report' })[0]).toMatchObject({
      trust: 'authenticated', priority: 'background',
      payload: {
        from_subordinate: 'researcher', status: 'completed', content: 'Done', task: 'Investigate',
        sequence_id: 'settle:msg-1', kinu_mode: 'build',
      },
    });
  });

  test('the sender is told the event id its report will cite', () => {
    const { sql, actor } = makeWorld();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);

    const admission = admitSubordinateTask(log, {
      fromWorkspace: 'kinu-main', kind: 'task', body: 'Investigate', mode: 'build', now: 10,
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
    // `admitted: false`: the event was already logged, so this publish scheduled no drain.
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
    const { sql, actor } = makeWorld();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);

    expect(() => admitSubordinateTask(log, {
      fromWorkspace: ' ', kind: 'task', body: 'work', mode: 'build', now: 1,
    })).toThrow('fromWorkspace');
    expect(() => admitSubordinateTask(log, {
      fromWorkspace: 'main', kind: 'task', body: ' ', mode: 'build', now: 1,
    })).toThrow('body');

    for (const blank of [
      { content: ' ', sequenceId: 'settle:msg-1', names: 'content' },
      { content: 'work', sequenceId: ' ', names: 'sequenceId' },
    ]) {
      expect(() => admitSubordinateReport(log, {
        fromSubordinate: 'researcher', status: 'progress', content: blank.content,
        sequenceId: blank.sequenceId, mode: 'build', now: 1,
      })).toThrow(blank.names);
    }

    expect(log.pending()).toEqual([]);
  });
});

describe('the owner talking to a subordinate does not wake its parent', () => {
  /** Both hops in production order; assertions read the parent's event log because that log is the wake. */
  function scenario() {
    const { sql, actor } = makeWorld();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);
    const roster = makeRosterStore();
    roster.ensureSchema();
    roster.create(initialRosterEntry);

    let sequence = 0;

    const arrivesAtParent = (
      origin: SubordinateReportOrigin,
      content: string,
      status: SubordinateReportStatus,
    ) => {
      const entry = roster.requireActive('researcher');

      if (!parentAdmitsSubordinateReport({ entry })) return;
      admitSubordinateReport(log, {
        fromSubordinate: 'researcher', status, content,
        sequenceId: `settle:msg-${++sequence}`, mode: 'build', now: 1,
      });
      roster.applyReport('researcher', status, origin, NOW);
    };

    return {
      roster,
      turnEnds(input: { ownerDriven: boolean; assistantText: string; reportedThisTurn?: boolean }) {
        if (!subordinateRelaysTurnEnd({ reportedThisTurn: false, ...input })) return;
        arrivesAtParent('turn_end', input.assistantText, 'progress');
      },
      reportTool: (content: string, status: SubordinateReportStatus = 'completed') =>
        arrivesAtParent('report_tool', content, status),
      jobSettles: (content: string) => arrivesAtParent('turn_end', content, 'progress'),
      woken: () => log.pending({ variant: 'subordinate_report' })
        .map((event) => reportPayload(event).content),
    };
  }

  test('the owner’s own conversation reaches the parent never, however long it runs', () => {
    const scene = scenario();

    for (const reply of ['Hi — what do you need?', 'Here are three angles.', 'Done.']) {
      scene.turnEnds({ ownerDriven: true, assistantText: reply });
    }

    expect(scene.woken()).toEqual([]);
  });

  test('the answer to the parent’s own assignment still arrives automatically', () => {
    const scene = scenario();

    scene.turnEnds({ ownerDriven: false, assistantText: 'Mapped 14 competitors.' });
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

    // A detached >30s tool job's wake is programmatic; only the roster knows it was the owner's.
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
  /** Parent ingress in orchestrator.receiveSubordinateEvent order: normalize, spill, admit. */
  async function admitFromSubordinate(log: EventLog, vfs: Parameters<typeof spillEventContent>[0], raw: string) {
    const content = normalizeReportContent(raw);
    const spilled = await spillEventContent(vfs, content);

    const input = {
      fromSubordinate: 'researcher', status: 'completed', content,
      sequenceId: 'settle:msg-1', task: 'Survey auth', mode: 'build', now: 11,
    } satisfies Parameters<typeof admitSubordinateReport>[1];

    if (spilled) Object.assign(input, { spilled });

    return admitSubordinateReport(log, input);
  }

  function freshLog(): EventLog {
    const { sql, actor } = makeWorld();
    initEventsHubTables(sql);

    return new EventLog(sql, actor);
  }

  test('a report past the brief budget spills whole and the parent brief cites it', async () => {
    const log = freshLog();
    const { vfs } = createMemoryVfs();
    const content = 'seam found in the auth module; '.repeat(60).trim();

    expect((await admitFromSubordinate(log, vfs, `${content}\n`)).admitted).toBe(true);

    const event = log.pending({ variant: 'subordinate_report' })[0];
    const path = reportPayload(event).content_path;
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

interface ParentScene {
  log: EventLog;
  roster: SubordinateRosterStore;
  files: MemoryVfs['files'];
  seen: string[];
  announced: Array<{ id: string; content: string }>;
  deps: SubordinateIngressDeps;
}

function parentScene(): ParentScene {
  const { sql, actor } = makeWorld();
  initEventsHubTables(sql);
  const log = new EventLog(sql, actor);
  const roster = makeRosterStore();
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
      transaction: <T,>(body: () => T): T => {
        seen.push('transaction');

        return body();
      },
      announce: (report) => {
        seen.push('announce');
        announced.push({ id: report.id, content: report.content });
      },
      onAdmitted: () => { seen.push('drain'); },
    },
  };
}

describe('the parent ingress, in the order it runs', () => {
  test('spills before opening the storage transaction, so the async write is never inside it', async () => {
    const scene = parentScene();
    const content = 'seam found in the auth module; '.repeat(60).trim();
    const spilled = eventContentPath(content);
    // The VFS write is async and the transaction body is not: the file must exist when the transaction opens.
    const transaction = scene.deps.transaction.bind(scene.deps);
    scene.deps.transaction = <T,>(body: () => T): T => {
      expect(scene.files.has(spilled)).toBe(true);

      return transaction(body);
    };

    const result = await receiveSubordinateEvent(scene.deps, {
      fromSubordinate: 'researcher', status: 'completed', content: `${content}\n`,
      origin: 'report_tool', sequenceId: 'settle:msg-1', mode: 'build',
    }, 11);

    expect(result.disposition).toBe('admitted');
    expect(await scene.files.get(spilled)).toBe(content);
    const event = scene.log.pending({ variant: 'subordinate_report' })[0];
    expect(reportPayload(event).content_path).toBe(spilled);
    expect(scene.seen).toEqual(['transaction', 'announce', 'drain']);
    expect(scene.roster.requireActive('researcher')).toMatchObject({ status: 'idle', currentTask: null });
  });

  test('drops what the parent is not waiting on before the spill, leaving no file behind', async () => {
    const scene = parentScene();
    scene.roster.applyReport('researcher', 'completed', 'report_tool', NOW);

    const result = await receiveSubordinateEvent(scene.deps, {
      fromSubordinate: 'researcher', status: 'progress', content: 'x'.repeat(4000),
      origin: 'turn_end', sequenceId: 'settle:msg-1', mode: 'build',
    }, 12);

    expect(result).toEqual({ id: '', disposition: 'not_awaited' });
    expect(scene.files.size).toBe(0);
    expect(scene.seen).toEqual([]);
    expect(scene.log.pending({ variant: 'subordinate_report' })).toEqual([]);
  });

  test('a report from a subordinate this parent does not have is not awaited, not admitted', async () => {
    const scene = parentScene();
    // An unknown name is a forgotten decision, not a delivery failure: throwing made the child retry forever.
    expect(await receiveSubordinateEvent(scene.deps, {
      fromSubordinate: 'ghost', status: 'progress', content: 'hello',
      origin: 'report_tool', sequenceId: 'settle:msg-1', mode: 'build',
    }, 13)).toEqual({ id: '', disposition: 'not_awaited' });
    expect(scene.files.size).toBe(0);
    expect(scene.log.pending({ variant: 'subordinate_report' })).toEqual([]);
  });

  // A report is replayed until the parent holds it; the sequence is the dedupe key.
  test('one sequence delivered twice wakes the parent once, and says the second was already held', async () => {
    const scene = parentScene();

    const deliver = () => receiveSubordinateEvent(scene.deps, {
      fromSubordinate: 'researcher', status: 'completed', content: 'Market mapped.',
      origin: 'turn_end', sequenceId: 'settle:msg-1', mode: 'build',
    }, 20);

    const first = await deliver();
    const replay = await deliver();

    expect(first.disposition).toBe('admitted');
    expect(replay).toEqual({ id: first.id, disposition: 'already_held' });
    expect(scene.log.pending({ variant: 'subordinate_report' })).toHaveLength(1);
    expect(scene.seen).toEqual(['transaction', 'announce', 'drain']);
    expect(scene.announced).toHaveLength(1);
  });

  test('two sequences from one subordinate are two parent events', async () => {
    const scene = parentScene();

    const deliver = (sequenceId: string, content: string) =>
      receiveSubordinateEvent(scene.deps, {
        fromSubordinate: 'researcher', status: 'progress', content,
        origin: 'turn_end', sequenceId, mode: 'build',
      }, 20);

    expect((await deliver('settle:msg-1', 'Mapped 8 so far.')).disposition).toBe('admitted');
    expect((await deliver('settle:msg-2', 'Mapped 14 now.')).disposition).toBe('admitted');

    expect(scene.log.pending({ variant: 'subordinate_report' }).map((e) => reportPayload(e).content))
      .toEqual(['Mapped 8 so far.', 'Mapped 14 now.']);
  });

  // The mode travels with the report: a cold replay outlives the child's turn metadata.
  test('the report carries the mode its sender stated', async () => {
    const scene = parentScene();
    await receiveSubordinateEvent(scene.deps, {
      fromSubordinate: 'researcher', status: 'progress', content: 'Three options, no code yet.',
      origin: 'turn_end', sequenceId: 'settle:msg-1', mode: 'plan',
    }, 20);

    const event = scene.log.pending({ variant: 'subordinate_report' })[0];
    expect(reportPayload(event).kinu_mode).toBe('plan');
    expect(reportPayload(event).sequence_id).toBe('settle:msg-1');
  });
});

/** The full report spine in production order: the tool's schema strips unnamed fields, so a dropped handoff only shows end to end. */
describe('the structured handoff a report carries', () => {
  function childReportingTo(scene: ParentScene): ReportToolDeps {
    return {
      report: async ({ status, content, handoff }) => {
        const relayed = await receiveSubordinateEvent(scene.deps, {
          fromSubordinate: 'researcher', status, content, handoff,
          origin: 'report_tool', sequenceId: `settle:${content.length}`, mode: 'build',
        }, 30);

        return { disposition: relayed.disposition };
      },
    };
  }

  /** Parsed as the SDK parses the native tool's input. */
  async function send(deps: ReportToolDeps, input: z.input<typeof ReportToolInputSchema>): Promise<ReportToolResult> {
    return await dispatchReport(deps, ReportToolInputSchema.parse(input));
  }

  function reportOn(scene: ParentScene): SubordinateReportPayload {
    return reportPayload(scene.log.pending({ variant: 'subordinate_report' })[0]);
  }

  test('what the child stated is on the parent’s event AND in the brief the parent reads', async () => {
    const scene = parentScene();

    await send(childReportingTo(scene), {
      status: 'completed',
      content: 'Rate limiter landed behind the existing flag.',
      concerns: ['  the 429 budget is a guess — no production trace to size it from ', '  '],
      findings: ['the gateway already limits per-account, so per-IP double-counts'],
    });

    expect(reportOn(scene)).toMatchObject({
      concerns: ['the 429 budget is a guess — no production trace to size it from'],
      findings: ['the gateway already limits per-account, so per-IP double-counts'],
    });
    expect(renderForLLM(scene.log.pending({ variant: 'subordinate_report' })[0]).brief).toBe(
      'completed [re: Map the market.]: Rate limiter landed behind the existing flag.'
      + '\nconcerns:\n  - the 429 budget is a guess — no production trace to size it from'
      + '\nfindings:\n  - the gateway already limits per-account, so per-IP double-counts',
    );
  });

  test('a report that states only status and content delivers exactly what it always did', async () => {
    const scene = parentScene();

    await send(childReportingTo(scene), {
      status: 'progress', content: 'Mapped 8 of the 14 so far.',
    });

    const payload = reportOn(scene);
    // An optional field is absent when unused, not an empty list.
    expect(payload.concerns).toBeUndefined();
    expect(payload.open_work).toBeUndefined();
    expect(renderForLLM(scene.log.pending({ variant: 'subordinate_report' })[0]).brief)
      .toBe('progress [re: Map the market.]: Mapped 8 of the 14 so far.');
  });

  test('a handoff over the shared budget is refused in words, and nothing reaches the parent', async () => {
    const scene = parentScene();

    // Refused rather than truncated: the handoff has no spill file.
    const oversize = send(childReportingTo(scene), {
      status: 'completed',
      content: 'Done.',
      open_work: [`x`.repeat(SUBORDINATE_REPORT_HANDOFF_MAX_CHARS + 1)],
    });

    await expect(oversize).rejects.toMatchObject({ code: 'bad_input' });
    await expect(oversize).rejects.toThrow(`${SUBORDINATE_REPORT_HANDOFF_MAX_CHARS}-character budget`);
    expect(scene.log.pending({ variant: 'subordinate_report' })).toEqual([]);
  });

  test('a destination that reads only the body is offered no handoff, and is handed none', async () => {
    const scene = parentScene();
    const bodyOnlyDestination = { ...childReportingTo(scene), bodyOnly: true } satisfies ReportToolDeps;

    await send(bodyOnlyDestination, {
      status: 'completed', content: 'Candidate submitted.',
      concerns: ['this should not travel to a destination that never declared it'],
    });

    expect(reportOn(scene).concerns).toBeUndefined();
  });
});

/** The delegation runner. B10: one assignment row, one runner, one turn. */
describe('drainAssignments', () => {
  function assignedWorld(inheritedContext?: SerializedMessage[]) {
    const { sql, actor } = makeWorld();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);

    const admission: Parameters<typeof admitSubordinateTask>[1] = {
      fromWorkspace: 'kinu-main', kind: 'task', body: 'Audit the auth flow.', mode: 'build', now: NOW,
    };

    if (inheritedContext) admission.inheritedContext = { kind: 'fork', messages: inheritedContext };
    admitSubordinateTask(log, admission);

    return log;
  }

  test('two concurrent sweeps spend one assignment exactly once', async () => {
    const forked: SerializedMessage[] = [
      { id: 'u1', role: 'user', content: 'Fix auth.', createdAt: 1 },
    ];

    const log = assignedWorld(forked);
    const ran: AdmittedAssignment[] = [];
    const held = Promise.withResolvers<void>();

    const sweep: DrainAssignmentsOptions = {
      now: NOW, budget: 4, staleMs: 600_000,
      run: async (task) => { ran.push(task); await held.promise; },
      onFailure: (cause) => { throw cause; },
    };

    // Both sweeps select before either resolves; binding is synchronous, so the second's `pending()` is empty.
    const first = drainAssignments(log, sweep);
    const second = drainAssignments(log, sweep);
    held.resolve();
    const [a, b] = await Promise.all([first, second]);

    expect(ran.map((task) => task.body)).toEqual(['Audit the auth flow.']);
    expect(a.consumed + b.consumed).toBe(1);

    expect(subordinateTurnContext(log, ran[0]?.turnId ?? '')).toEqual(forked);

    expect(log.hasOpenDrainLease()).toBe(false);
    expect(log.pending({ variant: 'subordinate_task' })).toEqual([]);
  });

  test('a failed run leaves its lease open for a later sweep to re-pend', async () => {
    const log = assignedWorld();
    const failures: unknown[] = [];

    const swept = await drainAssignments(log, {
      now: NOW, budget: 4, staleMs: 600_000,
      run: () => Promise.reject(new KinuError('unavailable', 'the model refused')),
      onFailure: (cause) => { failures.push(cause); },
    });

    expect(swept).toEqual({ consumed: 1, truncated: false });
    expect(failures).toHaveLength(1);

    // The open lease is the retry: closing it drops the assignment; re-pending spins on the failure.
    expect(log.hasOpenDrainLease()).toBe(true);
    expect(log.pending({ variant: 'subordinate_task' })).toEqual([]);
  });
});
