import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildDrainBatch,
  EventLog,
  eventContentPath,
  initEventsHubTables,
  renderForLLM,
  spillEventContent,
  type SerializedMessage,
  type SubordinateReportPayload,
  type SubordinateRosterEntry,
} from '@proteus/core';
import { createMemoryVfs } from '@proteus/test-utils';
import {
  SubordinateIdentityStore,
  SubordinateRosterStore,
  admitSubordinateReport,
  admitSubordinateTask,
  createTeamToolDeps,
  normalizeReportContent,
  readSubordinateLiveStatus,
  type SubordinateRuntime,
} from '../src/subordinate-support.js';

interface SqlExec {
  exec(query: string, ...bindings: unknown[]): { toArray(): Array<Record<string, unknown>> };
}

type SqlBinding = string | number | bigint | boolean | null | Uint8Array;

function sqlBinding(value: unknown): SqlBinding {
  if (value === null || typeof value === 'string' || typeof value === 'number'
    || typeof value === 'bigint' || typeof value === 'boolean' || value instanceof Uint8Array) {
    return value;
  }
  throw new TypeError(`unsupported sqlite binding: ${typeof value}`);
}

function recordRow(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('sqlite returned a non-record row');
  }
  return Object.fromEntries(Object.entries(value));
}

function makeSql(): SqlExec {
  const db = new Database(':memory:');
  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.prepare(query);
      const values = bindings.map(sqlBinding);
      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) {
        return { toArray: () => stmt.all(...values).map(recordRow) };
      }
      stmt.run(...values);
      return { toArray: () => [] };
    },
  };
}

const source = (path: string) => readFileSync(join(import.meta.dir, '..', 'src', path), 'utf8');

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

  test('all user-level gates present the parent workspace name, never the facet name', () => {
    const actor = source('actor-agent.ts');
    const runtime = source('runtime.ts');
    const orchestrator = source('orchestrator.ts');
    const subordinate = source('subordinate-agent.ts');
    // MCP now identifies its caller by the workspace capability token rather
    // than by a name argument, so a facet dispatches as its parent workspace
    // and there is no name left to spoof.
    expect(actor).toContain('userDOStub.userMcp_callTool(caller, serverId, mcpName, args)');
    expect(actor).not.toContain('callerAgentName');
    expect(runtime).toContain('agentName: actor.workspaceName');
    expect(subordinate).toContain('const bootstrap = await parent.getSubordinateBootstrapIdentity();');
    expect(subordinate).toContain('parentWorkspace: bootstrap.parentWorkspace');
    expect(subordinate).toContain('ownerUserId: bootstrap.ownerUserId');
    expect(orchestrator).toContain('inheritedContext: () => orchestrator.readInheritedContext()');
  });

  test('a subordinate holds the parent workspace capability token, pushed never pulled', () => {
    const actor = source('actor-agent.ts');
    const orchestrator = source('orchestrator.ts');
    const subordinate = source('subordinate-agent.ts');

    // One store, inherited by both actor classes: a facet's token IS the
    // parent's, so §B6 taint inheritance needs no per-facet bookkeeping.
    expect(actor).toContain('protected async workspaceCapabilityToken(): Promise<string | null>');
    expect(actor).toContain('async installWorkspaceCapability(token: string)');

    // Push, both at spawn and whenever the parent's token is (re)issued.
    expect(orchestrator).toContain('const capabilityToken = await orchestrator.workspaceCapabilityToken();');
    expect(orchestrator).toContain('await stub.installWorkspaceCapability(token);');
    expect(subordinate).toContain('if (input.capabilityToken) await this.installWorkspaceCapability(input.capabilityToken);');

    // Never pull: the bootstrap RPC any stub-holder can reach must not carry a
    // secret, and nothing reads the token back out of a workspace DO.
    const bootstrap = orchestrator.slice(
      orchestrator.indexOf('async getSubordinateBootstrapIdentity()'),
      orchestrator.indexOf('async receiveSubordinateEvent('),
    );
    expect(bootstrap).not.toContain('capabilityToken');
    expect(actor).not.toMatch(/@callable\(\)\s*\n\s*async (installWorkspaceCapability|workspaceCapabilityToken)/);
    for (const file of ['actor-agent.ts', 'orchestrator.ts', 'subordinate-agent.ts']) {
      expect(source(file)).not.toMatch(/async get\w*CapabilityToken\w*\(\)/);
    }
  });

  test('subordinate tools are structurally confined to report, without team, peers, or product changes', () => {
    const subordinate = source('subordinate-agent.ts');
    const profile = subordinate.slice(
      subordinate.indexOf('protected actorToolDeps()'),
      subordinate.indexOf('protected notifyOwner'),
    );
    expect(profile).toContain('report:');
    expect(profile).not.toContain('team:');
    expect(profile).not.toContain('peers:');
    expect(profile).not.toContain('productChanges:');
    // Cross-workspace experience transfer is reach beyond the workspace, so it
    // rides the orchestrator's profile for the same reason peers does.
    expect(profile).not.toContain('experience:');
    expect(source('orchestrator.ts')).toContain('experience: this.getExperienceToolDeps(),');
    // …and absence is structural: a deps-gated name is dropped from the
    // advertised surface too, not just from the ToolSet.
    expect(source('actor-agent.ts'))
      .toContain("const DEPS_GATED_TOOLS = ['report', 'experience', 'product_change'] as const;");
  });

  test('browser subordinate callables reuse the team policy and are not exposed by the facet', () => {
    const orchestrator = source('orchestrator.ts');
    const subordinate = source('subordinate-agent.ts');
    expect(orchestrator).toContain('return this.getTeamToolDeps().list();');
    expect(orchestrator).toContain("return this.getTeamToolDeps().spawn({ role, mission, createdBy: 'user' });");
    expect(orchestrator).toContain('return this.getTeamToolDeps().dismiss({ name });');
    expect(subordinate).not.toContain('spawnSubordinate(');
    expect(subordinate).not.toContain('dismissSubordinate(');
    expect(subordinate).not.toContain('listSubordinates(');
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
    },
    async status(name) {
      fail('status');
      return {
        lastActivity: name.length,
        recentSteps: [{ event: 'beforeturn', summary: 'streamText() called next', elapsedMs: 12, createdAt: 34 }],
      };
    },
    async message(name, content) { calls.push(`message:${name}:${content}`); fail('message'); },
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
  test('spawn gives the subordinate a filtered inherited-context digest before its first mission', async () => {
    const inheritedContext: SerializedMessage[] = [
      { id: 's1', role: 'system', content: 'Internal system policy', createdAt: 1 },
      { id: 'u1', role: 'user', content: 'Fix auth and billing in parallel.', createdAt: 2 },
      { id: 't1', role: 'tool', content: 'Very noisy tool output', createdAt: 3 },
      { id: 'a1', role: 'assistant', content: 'I will split the independent workstreams.', createdAt: 4 },
    ];
    const h = makeTeamHarness(inheritedContext);

    await h.team.spawn({ role: 'auth engineer', mission: 'Repair the auth flow.' });

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
      now: 10,
    });
    const turn = buildDrainBatch(log.pending({ variant: 'subordinate_task' }));
    expect(turn?.text.indexOf('<inherited_context>')).toBeLessThan(
      turn?.text.indexOf('task: Repair the auth flow.') ?? -1,
    );
  });

  test('successful actions expose one canonical roster and nested live status', async () => {
    const h = makeTeamHarness();

    expect(await h.team.spawn({ role: 'market researcher', mission: 'Map the market.' })).toEqual({
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

    await h.team.assign({ name: 'researcher-a1b2c3', task: 'Compare vendors' });
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
    await h.team.message({ name: 'researcher-a1b2c3', content: 'Include pricing.' });
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
      if (operation !== 'spawn') await h.team.spawn({ role: 'researcher', mission: 'Initial mission' });
      if (operation === 'message') h.roster.applyReport('researcher-a1b2c3', 'blocked');
      const before = h.roster.get('researcher-a1b2c3');
      const broadcastsBefore = h.broadcasts.length;
      h.failures.add(operation);

      const action = operation === 'spawn'
        ? h.team.spawn({ role: 'researcher', mission: 'Mission' })
        : operation === 'assign'
          ? h.team.assign({ name: 'researcher-a1b2c3', task: 'Replacement' })
          : operation === 'message'
            ? h.team.message({ name: 'researcher-a1b2c3', content: 'Continue' })
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

    await expect(h.team.spawn({ role: 'researcher', mission: 'Mission' }))
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

    await expect(h.team.spawn({ role: 'researcher', mission: 'Mission' }))
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
      async assign(name) { observed.push({ operation: 'assign', roster: roster.get(name) }); },
      async status() { return null; },
      async message(name) { observed.push({ operation: 'message', roster: roster.get(name) }); },
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

    await team.spawn({ role: 'researcher', mission: 'Initial mission' });
    await team.assign({ name: 'researcher-a1b2c3', task: 'Replacement' });
    roster.applyReport('researcher-a1b2c3', 'blocked');
    await team.message({ name: 'researcher-a1b2c3', content: 'Continue' });
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
    await h.team.spawn({ role: 'researcher', mission: 'Mission' });
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
    await h.team.spawn({ role: 'researcher', mission: 'Map the market.' });

    h.roster.applyReport('researcher-a1b2c3', 'completed');
    const afterCompletion = await h.team.list();
    expect(afterCompletion).toHaveLength(1);
    expect(afterCompletion[0]).toMatchObject({ name: 'researcher-a1b2c3', status: 'idle', currentTask: null });

    await h.team.assign({ name: 'researcher-a1b2c3', task: 'One more comparison' });
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
    await h.team.spawn({ role: 'researcher', mission: 'Mission' });

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
      deliverable: 'Report', deadlineHint: 'today', now: 10,
    });
    const report = admitSubordinateReport(log, {
      fromSubordinate: 'researcher', status: 'completed', content: 'Done', task: 'Investigate', now: 11,
    });

    expect(task.admitted).toBe(true);
    expect(report.admitted).toBe(true);
    expect(log.pending({ variant: 'subordinate_task' })[0]).toMatchObject({
      trust: 'authenticated', priority: 'normal',
      payload: {
        from_workspace: 'proteus-main', kind: 'task', body: 'Investigate',
        deliverable: 'Report', deadline_hint: 'today',
      },
    });
    expect(log.pending({ variant: 'subordinate_report' })[0]).toMatchObject({
      trust: 'authenticated', priority: 'background',
      payload: {
        from_subordinate: 'researcher', status: 'completed', content: 'Done', task: 'Investigate',
      },
    });
  });

  test('empty actor identities and bodies are rejected before EventLog admission', () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);

    expect(() => admitSubordinateTask(log, {
      fromWorkspace: ' ', kind: 'task', body: 'work', now: 1,
    })).toThrow('fromWorkspace');
    expect(() => admitSubordinateTask(log, {
      fromWorkspace: 'main', kind: 'task', body: ' ', now: 1,
    })).toThrow('body');
    expect(() => admitSubordinateReport(log, {
      fromSubordinate: 'researcher', status: 'progress', content: ' ', now: 1,
    })).toThrow('content');
    expect(log.pending()).toEqual([]);
  });
});

describe('oversize subordinate reports stay reachable', () => {
  /** The parent's ingress, in the order orchestrator.receiveSubordinateEvent
   *  runs it: normalize → spill (async, outside the storage transaction) →
   *  admit with the citation. */
  async function admitFromSubordinate(log: EventLog, vfs: Parameters<typeof spillEventContent>[0], raw: string) {
    const content = normalizeReportContent(raw);
    const contentPath = await spillEventContent(vfs, content);
    return admitSubordinateReport(log, {
      fromSubordinate: 'researcher', status: 'completed', content,
      task: 'Survey auth', ...(contentPath ? { contentPath } : {}), now: 11,
    });
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
    const path = (event.payload as SubordinateReportPayload).content_path;
    // Normalized before spilling: the cited file is byte-for-byte the content
    // the brief truncates, never the untrimmed wire text.
    expect(path).toBe(eventContentPath(content));
    expect(await vfs.readFile(path!)).toBe(content);

    expect(renderForLLM(event).brief).toEndWith(` — full report: ${path}`);
    expect(buildDrainBatch([event])!.text).toContain(path!);
  });

  test('a report within the brief budget writes nothing and renders exactly as before', async () => {
    const log = freshLog();
    const { vfs, files } = createMemoryVfs();

    await admitFromSubordinate(log, vfs, 'Survey done — three seams found; note written.');

    const event = log.pending({ variant: 'subordinate_report' })[0];
    expect((event.payload as SubordinateReportPayload).content_path).toBeUndefined();
    expect(files.size).toBe(0);
    expect(renderForLLM(event).brief)
      .toBe('completed [re: Survey auth]: Survey done — three seams found; note written.');
  });

  test('the parent ingress spills before opening its storage transaction', () => {
    const orchestrator = source('orchestrator.ts');
    const ingress = orchestrator.slice(
      orchestrator.indexOf('async receiveSubordinateEvent('),
      orchestrator.indexOf('// ── Mission Inbox'),
    );
    expect(ingress.indexOf('await spillEventContent(this.rt.storage.vfs, content)'))
      .toBeLessThan(ingress.indexOf('transactionSync'));
    expect(ingress).toContain('const content = normalizeReportContent(input.content);');
    expect(ingress).toContain('...(contentPath ? { contentPath } : {}),');
  });
});
