// The `team` (subordinates), `peers` (cross-workspace), and `report`
// (subordinate → parent) builtins — the contract between the LLM surface and
// their deps. The transports themselves (facet substrate, peer outbox,
// waiters, reply channels) are exercised in cf-backend tests against the real
// hubs; this file pins the tool-side behavior: action dispatch, validation,
// defaults, timeout clamping, the reserved reply topic, and structural
// absence when deps aren't wired.
import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from '@proteus/test-utils';
import {
  buildBuiltinTools, PEER_REPLY_TOPIC,
  type TeamToolDeps, type PeersToolDeps, type ReportToolDeps,
  type SubordinateRosterEntry,
} from '../src/index.ts';

interface Call { action: string; input: unknown }

type ExecutableTool = { execute: (args: Record<string, unknown>) => Promise<unknown> };

function buildTool(name: string, deps: Record<string, unknown>): ExecutableTool {
  const { rt } = createTestRuntime();
  const tools = buildBuiltinTools({ rt, ...deps });
  const tool = tools[name] as ExecutableTool | undefined;
  expect(tool).toBeTruthy();
  return tool!;
}

// ── team (subordinate management) ───────────────────────────────────────────

const rosterEntry: SubordinateRosterEntry = {
  name: 'researcher', displayName: 'Researcher', role: 'competitive research',
  createdBy: 'orchestrator', status: 'idle', currentTask: null,
  createdAt: 1000, dismissedAt: null,
};

function makeTeam(overrides: Partial<TeamToolDeps> = {}): { deps: TeamToolDeps; calls: Call[] } {
  const calls: Call[] = [];
  const deps: TeamToolDeps = {
    list: async () => { calls.push({ action: 'list', input: null }); return [rosterEntry]; },
    spawn: async (input) => {
      calls.push({ action: 'spawn', input });
      return { name: input.name ?? 'researcher', displayName: 'Researcher' };
    },
    assign: async (input) => { calls.push({ action: 'assign', input }); return { ok: true, name: input.name }; },
    status: async (input) => { calls.push({ action: 'status', input }); return { roster: [rosterEntry] }; },
    message: async (input) => { calls.push({ action: 'message', input }); return { ok: true, name: input.name }; },
    dismiss: async (input) => {
      calls.push({ action: 'dismiss', input });
      return { ok: true, name: input.name, historyKept: input.keepHistory ?? false };
    },
    ...overrides,
  };
  return { deps, calls };
}

describe('team tool — registration (structural gating)', () => {
  test('absent deps → no team tool (subordinates + CLI have no subordinate management)', () => {
    const { rt } = createTestRuntime();
    const tools = buildBuiltinTools({ rt });
    expect(Object.keys(tools)).not.toContain('team');
    expect(Object.keys(tools)).not.toContain('peers');
    expect(Object.keys(tools)).not.toContain('report');
  });
});

describe('team tool — subordinate actions', () => {
  test('list returns the roster', async () => {
    const { deps } = makeTeam();
    const result = await buildTool('team', { team: deps }).execute({ action: 'list' }) as {
      subordinates: SubordinateRosterEntry[];
    };
    expect(result.subordinates).toEqual([rosterEntry]);
  });

  test('empty roster carries the spawn hint', async () => {
    const { deps } = makeTeam({ list: async () => [] });
    const result = await buildTool('team', { team: deps }).execute({ action: 'list' }) as {
      subordinates: unknown[]; note?: string;
    };
    expect(result.subordinates).toEqual([]);
    expect(result.note).toContain('spawn');
  });

  test('spawn forwards role/mission (+ optional name/model)', async () => {
    const { deps, calls } = makeTeam();
    const result = await buildTool('team', { team: deps }).execute({
      action: 'spawn', role: 'researcher', mission: 'Map the landscape', model: 'openai/gpt-5',
    });
    expect(result).toEqual({ name: 'researcher', displayName: 'Researcher' });
    expect(calls[0].input).toEqual({ role: 'researcher', mission: 'Map the landscape', model: 'openai/gpt-5' });
  });

  test('assign forwards name/task and the optional deliverable/deadline hint', async () => {
    const { deps, calls } = makeTeam();
    const result = await buildTool('team', { team: deps }).execute({
      action: 'assign', name: 'researcher', task: 'Survey auth', deliverable: 'a note', deadline_hint: 'today',
    });
    expect(result).toEqual({ ok: true, name: 'researcher' });
    expect(calls[0].input).toEqual({
      name: 'researcher', task: 'Survey auth', deliverable: 'a note', deadlineHint: 'today',
    });
  });

  test('status works with and without a name', async () => {
    const { deps, calls } = makeTeam();
    const t = buildTool('team', { team: deps });
    await t.execute({ action: 'status' });
    await t.execute({ action: 'status', name: 'researcher' });
    expect(calls.map((c) => c.input)).toEqual([{}, { name: 'researcher' }]);
  });

  test('message injects a conversational note', async () => {
    const { deps, calls } = makeTeam();
    const result = await buildTool('team', { team: deps }).execute({
      action: 'message', name: 'researcher', content: 'also check the CLI',
    });
    expect(result).toEqual({ ok: true, name: 'researcher' });
    expect(calls[0].input).toEqual({ name: 'researcher', content: 'also check the CLI' });
  });

  test('dismiss forwards keep_history', async () => {
    const { deps, calls } = makeTeam();
    const t = buildTool('team', { team: deps });
    expect(await t.execute({ action: 'dismiss', name: 'researcher' }))
      .toEqual({ ok: true, name: 'researcher', historyKept: false });
    expect(await t.execute({ action: 'dismiss', name: 'researcher', keep_history: true }))
      .toEqual({ ok: true, name: 'researcher', historyKept: true });
    expect(calls[1].input).toEqual({ name: 'researcher', keepHistory: true });
  });

  test('missing required args are sharp errors, not deps calls', async () => {
    const { deps, calls } = makeTeam();
    const t = buildTool('team', { team: deps });
    expect(await t.execute({ action: 'spawn', role: 'r' })).toEqual({ error: 'spawn requires role and mission' });
    expect(await t.execute({ action: 'assign', name: 'x' })).toEqual({ error: 'assign requires name and task' });
    expect(await t.execute({ action: 'message', name: 'x' })).toEqual({ error: 'message requires name and content' });
    expect(await t.execute({ action: 'dismiss' })).toEqual({ error: 'dismiss requires name' });
    expect(calls).toEqual([]);
  });

  test('deps exceptions surface as tool error objects (never throw into the turn)', async () => {
    const { deps } = makeTeam({
      assign: async () => { throw new Error('unknown subordinate "ghost" — list your team with action:"list"'); },
    });
    const result = await buildTool('team', { team: deps }).execute({
      action: 'assign', name: 'ghost', task: 'x',
    }) as { error: string };
    expect(result.error).toContain('unknown subordinate "ghost"');
  });
});

// ── peers (cross-workspace messaging) ───────────────────────────────────────

function makePeers(overrides: Partial<PeersToolDeps> = {}): { deps: PeersToolDeps; calls: Call[] } {
  const calls: Call[] = [];
  const deps: PeersToolDeps = {
    listPeers: async () => {
      calls.push({ action: 'list', input: null });
      return [{ name: 'scout', displayName: 'Scout' }];
    },
    ask: async (input) => {
      calls.push({ action: 'ask', input });
      return { status: 'replied', from: input.agent, reply: 'answer' };
    },
    send: async (input) => {
      calls.push({ action: 'send', input });
      return { status: 'delivered', message_id: 'ox1' };
    },
    reply: async (input) => {
      calls.push({ action: 'reply', input });
      return { ok: true };
    },
    spawnWorkspace: async (input) => {
      calls.push({ action: 'spawn_workspace', input });
      return { agent: input.name ?? 'specialist', created: true, status: 'replied', from: 'specialist', reply: 'done' };
    },
    ...overrides,
  };
  return { deps, calls };
}

describe('peers tool — actions (the moved cross-workspace capability)', () => {
  test('list returns the roster; empty roster hints spawn_workspace', async () => {
    const { deps } = makePeers();
    const result = await buildTool('peers', { peers: deps }).execute({ action: 'list' }) as { peers: unknown[] };
    expect(result.peers).toEqual([{ name: 'scout', displayName: 'Scout' }]);

    const empty = makePeers({ listPeers: async () => [] });
    const emptyResult = await buildTool('peers', { peers: empty.deps }).execute({ action: 'list' }) as {
      peers: unknown[]; note?: string;
    };
    expect(emptyResult.note).toContain('spawn_workspace');
  });

  test('ask forwards agent/topic/message and returns the reply', async () => {
    const { deps, calls } = makePeers();
    const result = await buildTool('peers', { peers: deps }).execute({
      action: 'ask', agent: 'scout', message: 'What changed?', topic: 'research',
    });
    expect(result).toEqual({ status: 'replied', from: 'scout', reply: 'answer' });
    expect(calls[0].input).toMatchObject({ agent: 'scout', topic: 'research', message: 'What changed?' });
  });

  test('ask defaults: topic "message", timeout 120s; clamp to [5s, 600s]', async () => {
    const { deps, calls } = makePeers();
    const t = buildTool('peers', { peers: deps });
    await t.execute({ action: 'ask', agent: 'scout', message: 'x' });
    await t.execute({ action: 'ask', agent: 'scout', message: 'x', timeout_seconds: 1 });
    await t.execute({ action: 'ask', agent: 'scout', message: 'x', timeout_seconds: 9999 });
    expect(calls.map((c) => (c.input as { timeoutMs: number }).timeoutMs)).toEqual([120_000, 5_000, 600_000]);
    expect((calls[0].input as { topic: string }).topic).toBe('message');
  });

  test('send is fire-and-forget; reply forwards the event id', async () => {
    const { deps, calls } = makePeers();
    const t = buildTool('peers', { peers: deps });
    expect(await t.execute({ action: 'send', agent: 'scout', message: 'FYI' }))
      .toEqual({ status: 'delivered', message_id: 'ox1' });
    expect(await t.execute({ action: 'reply', event_id: 'pe1', message: 'here you go' })).toEqual({ ok: true });
    expect(calls[1].input).toEqual({ eventId: 'pe1', message: 'here you go' });
  });

  test('spawn_workspace forwards purpose + message (the old team.spawn semantics, verbatim transport)', async () => {
    const { deps, calls } = makePeers();
    const result = await buildTool('peers', { peers: deps }).execute({
      action: 'spawn_workspace', purpose: 'summarize research papers', message: 'Summarize X',
    });
    expect(result).toMatchObject({ agent: 'specialist', created: true, status: 'replied' });
    expect(calls[0].input).toMatchObject({ purpose: 'summarize research papers', message: 'Summarize X' });
  });

  test('missing required args are sharp errors, not deps calls', async () => {
    const { deps, calls } = makePeers();
    const t = buildTool('peers', { peers: deps });
    expect(await t.execute({ action: 'ask', agent: 'scout' })).toEqual({ error: 'ask requires agent and message' });
    expect(await t.execute({ action: 'send', message: 'x' })).toEqual({ error: 'send requires agent and message' });
    expect(await t.execute({ action: 'reply', message: 'x' })).toEqual({ error: 'reply requires event_id and message' });
    expect(await t.execute({ action: 'spawn_workspace', message: 'x' }))
      .toEqual({ error: 'spawn_workspace requires purpose and message' });
    expect(calls).toEqual([]);
  });

  test(`the reserved "${PEER_REPLY_TOPIC}" topic is rejected`, async () => {
    const { deps, calls } = makePeers();
    const result = await buildTool('peers', { peers: deps }).execute({
      action: 'send', agent: 'scout', message: 'x', topic: PEER_REPLY_TOPIC,
    }) as { error?: string };
    expect(result.error).toContain('reserved');
    expect(calls).toEqual([]);
  });
});

// ── report (subordinate → parent) ───────────────────────────────────────────

describe('report tool — the subordinate progress spine', () => {
  test('forwards status + content to the parent seam', async () => {
    const calls: Call[] = [];
    const deps: ReportToolDeps = {
      report: async (input) => { calls.push({ action: 'report', input }); return { delivered: true }; },
    };
    const result = await buildTool('report', { report: deps }).execute({
      status: 'completed', content: 'Survey done — note written.',
    });
    expect(result).toEqual({ delivered: true });
    expect(calls[0].input).toEqual({ status: 'completed', content: 'Survey done — note written.' });
  });

  test('empty content is a sharp error; deps failures surface as error objects', async () => {
    const deps: ReportToolDeps = {
      report: async () => { throw new Error('parent unreachable'); },
    };
    const t = buildTool('report', { report: deps });
    expect(await t.execute({ status: 'progress', content: '  ' })).toEqual({ error: 'report requires non-empty content' });
    expect(await t.execute({ status: 'blocked', content: 'need creds' })).toEqual({ error: 'parent unreachable' });
  });
});
