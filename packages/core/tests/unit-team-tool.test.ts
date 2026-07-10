// The `team` builtin — contract between the LLM surface and TeamToolDeps.
// The transport itself (outbox, waiters, reply channels) is exercised in
// cf-backend/tests/unit-peer-team.test.ts against the real hub; this file
// pins the tool-side behavior: action dispatch, validation, defaults,
// timeout clamping, and the reserved reply topic.
import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from '@proteus/test-utils';
import { buildBuiltinTools, PEER_REPLY_TOPIC, type TeamToolDeps } from '../src/index.ts';

interface Call { action: string; input: unknown }

function makeTeam(overrides: Partial<TeamToolDeps> = {}): { deps: TeamToolDeps; calls: Call[] } {
  const calls: Call[] = [];
  const deps: TeamToolDeps = {
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
    spawn: async (input) => {
      calls.push({ action: 'spawn', input });
      return { agent: input.name ?? 'specialist', created: true, status: 'replied', from: 'specialist', reply: 'done' };
    },
    ...overrides,
  };
  return { deps, calls };
}

function teamTool(deps: TeamToolDeps) {
  const { rt } = createTestRuntime();
  const tools = buildBuiltinTools({ rt, team: deps });
  const tool = tools.team as { execute: (args: Record<string, unknown>) => Promise<unknown> };
  expect(tool).toBeTruthy();
  return tool;
}

describe('team tool — registration', () => {
  test('absent deps → tool not registered (the CLI honest gate)', () => {
    const { rt } = createTestRuntime();
    const tools = buildBuiltinTools({ rt });
    expect(Object.keys(tools)).not.toContain('team');
  });
});

describe('team tool — actions', () => {
  test('list returns the roster', async () => {
    const { deps } = makeTeam();
    const result = await teamTool(deps).execute({ action: 'list' }) as { peers: Array<{ name: string }> };
    expect(result.peers).toEqual([{ name: 'scout', displayName: 'Scout' }]);
  });

  test('empty roster carries the spawn hint', async () => {
    const { deps } = makeTeam({ listPeers: async () => [] });
    const result = await teamTool(deps).execute({ action: 'list' }) as { peers: unknown[]; note?: string };
    expect(result.peers).toEqual([]);
    expect(result.note).toContain('spawn');
  });

  test('ask forwards agent/topic/message and returns the reply', async () => {
    const { deps, calls } = makeTeam();
    const result = await teamTool(deps).execute({
      action: 'ask', agent: 'scout', message: 'What changed?', topic: 'research',
    });
    expect(result).toEqual({ status: 'replied', from: 'scout', reply: 'answer' });
    expect(calls[0].input).toMatchObject({ agent: 'scout', topic: 'research', message: 'What changed?' });
  });

  test('ask defaults: topic "message", timeout 120s; clamp to [5s, 600s]', async () => {
    const { deps, calls } = makeTeam();
    const t = teamTool(deps);
    await t.execute({ action: 'ask', agent: 'scout', message: 'x' });
    await t.execute({ action: 'ask', agent: 'scout', message: 'x', timeout_seconds: 1 });
    await t.execute({ action: 'ask', agent: 'scout', message: 'x', timeout_seconds: 9999 });
    expect(calls.map((c) => (c.input as { timeoutMs: number }).timeoutMs)).toEqual([120_000, 5_000, 600_000]);
    expect((calls[0].input as { topic: string }).topic).toBe('message');
  });

  test('send is fire-and-forget with delivery status', async () => {
    const { deps } = makeTeam();
    const result = await teamTool(deps).execute({ action: 'send', agent: 'scout', message: 'FYI' });
    expect(result).toEqual({ status: 'delivered', message_id: 'ox1' });
  });

  test('reply forwards the event id and answer', async () => {
    const { deps, calls } = makeTeam();
    const result = await teamTool(deps).execute({ action: 'reply', event_id: 'pe1', message: 'here you go' });
    expect(result).toEqual({ ok: true });
    expect(calls[0].input).toEqual({ eventId: 'pe1', message: 'here you go' });
  });

  test('spawn forwards purpose + message and returns the specialist round-trip', async () => {
    const { deps, calls } = makeTeam();
    const result = await teamTool(deps).execute({
      action: 'spawn', purpose: 'summarize research papers', message: 'Summarize X',
    });
    expect(result).toMatchObject({ agent: 'specialist', created: true, status: 'replied' });
    expect(calls[0].input).toMatchObject({ purpose: 'summarize research papers', message: 'Summarize X' });
  });
});

describe('team tool — validation + failure surfaces', () => {
  test('missing required args are sharp errors, not deps calls', async () => {
    const { deps, calls } = makeTeam();
    const t = teamTool(deps);
    expect(await t.execute({ action: 'ask', agent: 'scout' })).toEqual({ error: 'ask requires agent and message' });
    expect(await t.execute({ action: 'send', message: 'x' })).toEqual({ error: 'send requires agent and message' });
    expect(await t.execute({ action: 'reply', message: 'x' })).toEqual({ error: 'reply requires event_id and message' });
    expect(await t.execute({ action: 'spawn', message: 'x' })).toEqual({ error: 'spawn requires purpose and message' });
    expect(calls).toEqual([]);
  });

  test(`the reserved "${PEER_REPLY_TOPIC}" topic is rejected`, async () => {
    const { deps, calls } = makeTeam();
    const result = await teamTool(deps).execute({
      action: 'send', agent: 'scout', message: 'x', topic: PEER_REPLY_TOPIC,
    }) as { error?: string };
    expect(result.error).toContain('reserved');
    expect(calls).toEqual([]);
  });

  test('deps exceptions surface as tool error objects (never throw into the turn)', async () => {
    const { deps } = makeTeam({
      ask: async () => { throw new Error('unknown peer "ghost" — list your team with action:"list"'); },
    });
    const result = await teamTool(deps).execute({ action: 'ask', agent: 'ghost', message: 'x' }) as { error: string };
    expect(result.error).toContain('unknown peer "ghost"');
  });
});
