// Behavior tests for the `memory` tool's `sessions` action — the LLM-facing
// surface over SessionSearchStore (one implementation, both backends).
import { describe, test, expect } from 'bun:test';
import type { ToolSet } from 'ai';
import { createTestRuntime } from '@proteus/test-utils';
import { buildBuiltinTools, initAllTables } from '../src/index.ts';

type Exec = (args: Record<string, unknown>) => Promise<unknown>;

function setup() {
  const { rt, testSql } = createTestRuntime();
  initAllTables(testSql.execRaw);
  const tools: ToolSet = buildBuiltinTools({ rt });
  const memoryExec = tools.memory!.execute as unknown as Exec;
  let row = 0;
  const insert = (sessionId: string, role: string, content: string): string => {
    const id = `m-${++row}`;
    testSql.sql`INSERT INTO messages (id, session_id, role, content, created_at)
                VALUES (${id}, ${sessionId}, ${role}, ${content}, ${1_000_000 + row * 1000})`;
    return id;
  };
  return { memoryExec, insert };
}

describe('memory tool — sessions action', () => {
  test('searches past transcripts and returns ranked hits with refs', async () => {
    const { memoryExec, insert } = setup();
    const id = insert('proj', 'assistant', 'we shipped the cloudflare tunnel fix yesterday');
    insert('proj', 'user', 'unrelated chatter');
    const res = await memoryExec({ action: 'sessions', query: 'cloudflare tunnel' }) as {
      mode: string; hits: Array<{ messageId: string; sessionId: string; snippet: string }>;
    };
    expect(res.mode).toBe('search');
    expect(res.hits.length).toBe(1);
    expect(res.hits[0]!.messageId).toBe(id);
    expect(res.hits[0]!.sessionId).toBe('proj');
  });

  test('scrolls a window around a hit when around_message_id is set', async () => {
    const { memoryExec, insert } = setup();
    insert('proj', 'user', 'before');
    const anchor = insert('proj', 'assistant', 'anchor message');
    insert('proj', 'user', 'after');
    const res = await memoryExec({ action: 'sessions', around_message_id: anchor, window: 1 }) as {
      mode: string; messages: Array<{ content: string; anchor?: true }>;
    };
    expect(res.mode).toBe('scroll');
    expect(res.messages.map((m) => m.content)).toEqual(['before', 'anchor message', 'after']);
    expect(res.messages[1]!.anchor).toBe(true);
  });

  test('browses recent sessions when neither query nor anchor is given', async () => {
    const { memoryExec, insert } = setup();
    insert('a', 'user', 'first session kickoff');
    insert('b', 'user', 'second session kickoff');
    const res = await memoryExec({ action: 'sessions' }) as {
      mode: string; sessions: Array<{ sessionId: string; preview: string }>;
    };
    expect(res.mode).toBe('browse');
    expect(res.sessions.map((s) => s.sessionId)).toEqual(['b', 'a']);
    expect(res.sessions[1]!.preview).toBe('first session kickoff');
  });

  test('returns a clean error for an unknown anchor id', async () => {
    const { memoryExec } = setup();
    const res = await memoryExec({ action: 'sessions', around_message_id: 'missing' }) as { error: string };
    expect(res.error).toContain('missing');
  });

  test('save and search actions are unchanged', async () => {
    const { memoryExec } = setup();
    expect(await memoryExec({ action: 'search' })).toBe('memory.search requires `query`.');
    expect(await memoryExec({ action: 'save' })).toBe('memory.save requires `content`.');
  });
});
