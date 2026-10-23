/**
 * A row's Reconnect says what went wrong however the request failed: a refusal reaches the client as a defect
 * (`lib/http.ts`), which a typed-failure handler passes by, so the row showed nothing (review, 2026-10-23).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { asFetchFunction } from '@kinu.run/core';
import { reconnectSaying } from '../src/lib/user-api';

const realFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = realFetch; });

describe("a row's Reconnect", () => {
  test('back again says nothing; a refusal, a dropped connection or a server still failing each say why', async () => {
    const answers = [
      () => Response.json({ status: 'ready', error: null }),
      () => Response.json({ error: 'This account has no such MCP server.' }, { status: 404 }),
      () => { throw new TypeError('Failed to fetch'); },
      () => Response.json({ status: 'failed', error: 'Gmail refused its tool list: HTTP 403' }),
    ];

    let asked = 0;

    globalThis.fetch = asFetchFunction(async () => {
      const answer = answers[asked];

      asked += 1;

      if (answer === undefined) throw new Error('asked more than this test answers');

      return answer();
    });

    const said: (string | null)[] = [];

    for (let attempt = 0; attempt < answers.length; attempt += 1) said.push(await reconnectSaying('srv1', 'Gmail'));

    expect(said[0]).toBeNull();
    expect(said[1]).toContain('Gmail did not reconnect: ');
    expect(said[1]).toContain('no such MCP server');
    expect(said[2]).toContain('Failed to fetch');
    expect(said[3]).toBe('Gmail did not reconnect: Gmail refused its tool list: HTTP 403');
  });
});
