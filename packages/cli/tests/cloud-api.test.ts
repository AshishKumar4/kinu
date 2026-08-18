// callAgentRpc — the client half of the generic agent-RPC transport:
// POST /api/cli/workspaces/:name/rpc {method, args} → {result}, errors
// surfaced as thrown messages.
import { describe, expect, test } from 'bun:test';
import { JsonValueSchema, type JsonValue } from '@proteus/core';
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
      const result = await callAgentRpc(
        `http://localhost:${server.port}`, 'ptc_tok', 'my agent', 'getHeadRuns',
        v.array(v.object({ id: v.string() })), [5],
      );
      expect(result).toEqual([{ id: 'head-1' }]);
      expect(seen[0]).toEqual({
        path: '/api/cli/workspaces/my%20agent/rpc',
        method: 'POST',
        auth: 'Bearer ptc_tok',
        body: { method: 'getHeadRuns', args: [5] },
      });
    } finally {
      server.stop(true);
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
      await callAgentRpc(`http://localhost:${server.port}`, 't', 'a', 'getAgentStatus', v.null());
      expect(bodies[0]).toEqual({ method: 'getAgentStatus', args: [] });
    } finally {
      server.stop(true);
    }
  });

  test('server rejections surface as thrown messages', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: 'No such agent RPC method: nope' }, { status: 404 }),
    });
    try {
      await expect(callAgentRpc(`http://localhost:${server.port}`, 't', 'a', 'nope', v.null()))
        .rejects.toThrow('No such agent RPC method: nope');
    } finally {
      server.stop(true);
    }
  });
});
