import { describe, expect, test } from 'bun:test';
import { JsonValueSchema, type JsonValue } from '@kinu.run/core';
import { callAgentRpc } from '../src/cloud-api';
import * as v from 'valibot';

describe('callAgentRpc', () => {
  test('posts {method, args} to the generic rpc endpoint and unwraps {result}', async () => {
    const seen: Array<{ path: string; method: string; auth: string | null; body: JsonValue }> = [];

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        seen.push({
          path: url.pathname,
          method: req.method,
          auth: req.headers.get('authorization'),
          body: v.parse(JsonValueSchema, await req.json()),
        });

        return Response.json({ result: [{ id: 'head-1' }] });
      },
    });

    try {
      const result = await callAgentRpc({
        origin: `http://localhost:${server.port}`,
        token: 'ptc_tok',
        name: 'my agent',
        method: 'getHeadRuns',
        schema: v.array(v.object({ id: v.string() })),
        args: [5],
      });

      expect(result).toEqual([{ id: 'head-1' }]);
      expect(seen[0]).toEqual({
        path: '/api/cli/workspaces/my%20agent/rpc',
        method: 'POST',
        auth: 'Bearer ptc_tok',
        body: { method: 'getHeadRuns', args: [5] },
      });
    } finally {
      await server.stop(true);
    }
  });

  test('omitted args default to an empty array', async () => {
    const bodies: JsonValue[] = [];

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        bodies.push(v.parse(JsonValueSchema, await req.json()));

        return Response.json({ result: null });
      },
    });

    try {
      await callAgentRpc({
        origin: `http://localhost:${server.port}`,
        token: 't',
        name: 'a',
        method: 'getAgentStatus',
        schema: v.null(),
      });
      expect(bodies[0]).toEqual({ method: 'getAgentStatus', args: [] });
    } finally {
      await server.stop(true);
    }
  });

  test('server rejections surface as thrown messages', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: 'This token lacks the workspace.read scope' }, { status: 403 }),
    });

    try {
      await expect(callAgentRpc({
        origin: `http://localhost:${server.port}`,
        token: 't',
        name: 'a',
        method: 'getAgentStatus',
        schema: v.null(),
      }))
        .rejects.toThrow('This token lacks the workspace.read scope');
    } finally {
      await server.stop(true);
    }
  });
});
