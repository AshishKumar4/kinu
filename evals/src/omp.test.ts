import { describe, expect, test } from 'bun:test';
import type { JsonObject } from '@kinu.run/core';
import { OwnerTurns, parseLogLine, shakenRegions, splitAt, unshaken } from './omp';

interface At { readonly [field: string]: string | null; readonly id: string; readonly parentId: string | null; readonly timestamp: string }

/** A log line as the converter reads it, from its JSON. */
const line = (entry: JsonObject) => parseLogLine(JSON.stringify(entry));

const user = (at: At, text: string) => line({ type: 'message', ...at, message: { role: 'user', content: [{ type: 'text', text }] } });

const assistant = (at: At, text: string, calls: { id: string; name: string; arguments: JsonObject }[] = []) =>
  line({ type: 'message', ...at, message: { role: 'assistant', content: [...calls.map((call) => ({ type: 'toolCall', ...call })), { type: 'text', text }] } });

const result = (at: At, toolCallId: string, text: string) =>
  line({ type: 'message', ...at, message: { role: 'toolResult', toolCallId, toolName: 'bash', content: [{ type: 'text', text }], isError: false } });

/** One session: an owner asks, the agent runs a command and answers, the owner corrects it, and the agent answers again. */
function session(prefix: string): ReturnType<typeof parseLogLine>[] {
  return [
    line({ type: 'session', version: 3, id: prefix, timestamp: '2026-10-01T00:00:00.000Z', cwd: '/repo' }),
    user({ id: `${prefix}u1`, parentId: null, timestamp: '2026-10-01T00:00:01.000Z' }, 'list the files'),
    assistant({ id: `${prefix}a1`, parentId: `${prefix}u1`, timestamp: '2026-10-01T00:00:02.000Z' }, '', [{ id: 'c1', name: 'bash', arguments: { command: 'ls' } }]),
    line({ type: 'custom', customType: 'tool_execution_start', id: `${prefix}x1`, parentId: `${prefix}a1`, timestamp: '2026-10-01T00:00:02.500Z' }),
    result({ id: `${prefix}r1`, parentId: `${prefix}x1`, timestamp: '2026-10-01T00:00:03.000Z' }, 'c1', 'a.ts b.ts'),
    assistant({ id: `${prefix}a2`, parentId: `${prefix}r1`, timestamp: '2026-10-01T00:00:04.000Z' }, 'There are two files.'),
    user({ id: `${prefix}u2`, parentId: `${prefix}a2`, timestamp: '2026-10-01T00:00:05.000Z' }, 'no, include hidden ones'),
    assistant({ id: `${prefix}a3`, parentId: `${prefix}u2`, timestamp: '2026-10-11T00:00:06.000Z' }, 'Three, with .env.'),
  ];
}

describe('owner turns from session logs', () => {
  test('a turn is an owner message, the work under it, and the owner message that received it', () => {
    const turns = new OwnerTurns();

    for (const entry of session('s')) turns.add('s', entry);
    const [first, second] = turns.turns();

    expect(first?.turn).toMatchObject({ userMessage: 'list the files', assistantResponse: 'There are two files.', steps: 2, hadError: false, turnId: 'su1' });
    expect(first?.turn.toolCalls.map((call) => [call.name, call.target, call.resultWindow])).toEqual([['bash', 'ls', '"a.ts b.ts"']]);
    expect(first?.followup).toEqual({ text: 'no, include hidden ones', at: '2026-10-01T00:00:05.000Z' });
    expect(second?.followup).toBeNull();
  });

  test("a fork's copy of a session adds no turn, and a fork that runs on gives the last turn its answer", () => {
    const turns = new OwnerTurns();

    for (const entry of session('s')) turns.add('s', entry);

    // The fork copies every entry under fresh ids, then the owner goes on.
    for (const entry of session('f')) turns.add('f', entry);

    turns.add('f', user({ id: 'fu3', parentId: 'fa3', timestamp: '2026-10-11T00:00:07.000Z' }, 'good'));

    expect(turns.turns().map((turn) => [turn.turn.userMessage, turn.followup?.text ?? null])).toEqual([
      ['list the files', 'no, include hidden ones'], ['no, include hidden ones', 'good'], ['good', null],
    ]);
    expect(turns.read()).toMatchObject({ ownerRecords: 5, forkCopies: 2 });
  });

  test('a credential in a request, a command or a result is kept redacted', () => {
    const turns = new OwnerTurns();
    // Assembled at runtime: a contiguous real-shaped literal trips the secret scan and push protection.
    const key = 'ghp' + '_' + 'k'.repeat(36);
    turns.add('s', user({ id: 'u', parentId: null, timestamp: '2026-10-01T00:00:01.000Z' }, `use ${key}`));
    turns.add('s', assistant({ id: 'a', parentId: 'u', timestamp: '2026-10-01T00:00:02.000Z' }, 'done', [{ id: 'c', name: 'bash', arguments: { command: `gh auth login --with-token ${key}` } }]));
    turns.add('s', result({ id: 'r', parentId: 'a', timestamp: '2026-10-01T00:00:03.000Z' }, 'c', `token ${key} saved`));

    expect(JSON.stringify(turns.turns())).not.toContain(key);
  });

  test('turns asked before the cutoff train; from it on they are held out', () => {
    const turns = new OwnerTurns();

    for (const entry of session('s')) turns.add('s', entry);
    turns.add('s', user({ id: 'u3', parentId: 'sa3', timestamp: '2026-10-12T00:00:00.000Z' }, 'ship it'));
    const { train, heldOut } = splitAt(turns.turns(), '2026-10-10');

    expect([train.map((turn) => turn.turn.userMessage), heldOut.map((turn) => turn.turn.userMessage)])
      .toEqual([['list the files', 'no, include hidden ones'], ['ship it']]);
  });

  test('a text the harness shook out is put back from its artifact\'s region, and a call whose arguments it dropped keeps its note', () => {
    const log = '### region 1 (bash, ~3 tok)\n\nfirst output\n\n### region 2 (read, ~9 tok)\n\n1:# Agents\n2:\n';
    const regions = shakenRegions(log);
    const turns = new OwnerTurns((logged, id) => (logged === 's' && id === 7 ? regions : null));

    turns.add('s', user({ id: 'u', parentId: null, timestamp: '2026-10-01T00:00:01.000Z' }, 'read the agents file'));
    turns.add('s', line({
      type: 'message', id: 'a', parentId: 'u', timestamp: '2026-10-01T00:00:02.000Z',
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 'read', arguments: {} }, { type: 'text', text: '[tool:read] AGENTS.md' }, { type: 'text', text: 'It lists the agents.' }] },
    }));
    turns.add('s', result({ id: 'r', parentId: 'a', timestamp: '2026-10-01T00:00:03.000Z' }, 'c', '[shaken ~9 tokens — recover: artifact://7 (region 2)]'));

    expect([...regions.entries()]).toEqual([[1, 'first output'], [2, '1:# Agents\n2:']]);
    expect(unshaken('a [shaken ~1 tokens — recover: artifact://8 (region 1)] b', () => null)).toBe('a [shaken ~1 tokens — recover: artifact://8 (region 1)] b');
    const [turn] = turns.turns();
    expect(turn?.turn.assistantResponse).toBe('It lists the agents.');
    expect(turn?.turn.toolCalls[0]).toMatchObject({ name: 'read', argsWindow: expect.stringContaining('[tool:read] AGENTS.md'), resultWindow: expect.stringContaining('1:# Agents') });
  });
});
