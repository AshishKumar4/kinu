/**
 * The per-activation MCP tool cache is keyed by a hash of the descriptor content, never a mutation
 * watermark: a watermark resets on cold start while durable server rows survive.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { McpToolSurfaceCache } from '../src/user/mcp';
import { McpToolSurfaceSchema } from '@kinu.run/core';

function surface(descriptors: Array<{ toolKey: string; name: string }>, unavailable: string[] = []): string {
  return JSON.stringify(v.parse(McpToolSurfaceSchema, {
    descriptors: descriptors.map((d) => ({
      serverId: 'srv1', serverName: 'srv', name: d.name, toolKey: d.toolKey,
      description: `${d.name} does things`, inputSchema: { type: 'object' },
    })),
    unavailable: unavailable.map((server) => ({ server, reason: 'warmup budget missed' })),
  }));
}

type Built = { keys: string[] };

function harness() {
  const builds: string[][] = [];

  const cache = new McpToolSurfaceCache<Built>(async (descriptors) => {
    const keys = descriptors.map((d) => d.toolKey);
    builds.push(keys);

    return { keys };
  });

  let next = surface([]);
  const failNext = () => { next = '\fNOT JSON'; };

  const serve = (raw: string) => { next = raw; };

  return {
    cache, builds, serve, failNext,
    // A window big enough that admission is never under test; the budget is proven in unit-user-mcp.test.ts.
    refresh: (contextWindow = 200_000, nativeToolTokens = 0) =>
      cache.refresh(async () => next, { contextWindow, modelOutputLimit: 4_000, nativeToolTokens }),
    unavailable: () => cache.unavailable,
  };
}

describe('McpToolSurfaceCache — keyed by descriptor content', () => {
  test('a cold activation builds from whatever the durable rows say', async () => {
    const h = harness();
    h.serve(surface([{ toolKey: 'mcp_srv_weather', name: 'weather' }]));
    expect(await h.refresh()).toEqual({ keys: ['mcp_srv_weather'] });
    expect(h.builds).toHaveLength(1);
  });

  test('an EMPTY surface is a valid build, cached like any other', async () => {
    const h = harness();
    h.serve(surface([]));

    expect(await h.refresh()).toEqual({ keys: [] });
    expect(h.builds).toEqual([[]]);
    // Empty is a state the durable rows reported, not a read that failed to happen.
    expect(await h.refresh()).toEqual({ keys: [] });
    expect(h.builds).toHaveLength(1);
    expect(h.unavailable()).toHaveLength(0);
  });

  test('an empty surface never reads as "never configured"', async () => {
    // Empty is just empty after a cold start; the next non-empty read installs.
    const h = harness();
    h.serve(surface([]));
    await h.refresh();

    h.serve(surface([{ toolKey: 'mcp_srv_weather', name: 'weather' }]));
    expect(await h.refresh()).toEqual({ keys: ['mcp_srv_weather'] });
    expect(h.builds).toHaveLength(2);
  });

  test('a surface that goes empty again is honoured, not ignored', async () => {
    // A cache that only grew would keep dispatching to a deleted row.
    const h = harness();
    h.serve(surface([{ toolKey: 'a', name: 'a' }]));
    await h.refresh();

    h.serve(surface([]));
    expect(await h.refresh()).toEqual({ keys: [] });
    expect(h.builds).toEqual([['a'], []]);
  });

  test('an unchanged surface is served from the cache without a rebuild', async () => {
    const h = harness();
    h.serve(surface([{ toolKey: 'a', name: 'a' }]));
    await h.refresh();
    await h.refresh();
    expect(h.builds).toHaveLength(1);
  });

  test('an update rebuilds exactly once', async () => {
    const h = harness();
    h.serve(surface([{ toolKey: 'a', name: 'a' }]));
    await h.refresh();
    h.serve(surface([{ toolKey: 'a', name: 'a' }, { toolKey: 'b', name: 'b' }]));
    expect(await h.refresh()).toEqual({ keys: ['a', 'b'] });
    expect(h.builds).toHaveLength(2);
  });

  test('a deleted server invalidates without any mutation event', async () => {
    const h = harness();
    h.serve(surface([{ toolKey: 'a', name: 'a' }, { toolKey: 'b', name: 'b' }]));
    await h.refresh();
    h.serve(surface([{ toolKey: 'a', name: 'a' }]));
    expect(await h.refresh()).toEqual({ keys: ['a'] });
  });

  test('an OAuth completion that adds tools to the same server invalidates', async () => {
    const h = harness();
    h.serve(surface([], ['srv']));
    await h.refresh();
    h.serve(surface([{ toolKey: 'authed', name: 'authed' }]));
    expect(await h.refresh()).toEqual({ keys: ['authed'] });
  });

  test('the unavailable list follows the surface actually served', async () => {
    const h = harness();
    h.serve(surface([{ toolKey: 'a', name: 'a' }], ['slow-server']));
    await h.refresh();
    expect(h.unavailable().map((u) => u.server)).toEqual(['slow-server']);
    h.serve(surface([{ toolKey: 'a', name: 'a' }]));
    await h.refresh();
    expect(h.unavailable()).toHaveLength(0);
  });

  test('a failed fetch propagates without mutating the last good build', async () => {
    const h = harness();
    const good = surface([{ toolKey: 'a', name: 'a' }]);
    h.serve(good);
    await h.refresh();
    h.failNext();
    await expect(h.refresh()).rejects.toThrow();
    h.serve(good);
    expect(await h.refresh()).toEqual({ keys: ['a'] });
    expect(h.builds).toHaveLength(1);
  });

  test('a failed fetch before any good read rejects', async () => {
    const h = harness();
    h.failNext();
    await expect(h.refresh()).rejects.toThrow();
    expect(h.builds).toHaveLength(0);
  });

  test('identical content under different key order still hashes differently only when content differs', async () => {
    const h = harness();
    h.serve(surface([{ toolKey: 'a', name: 'a' }, { toolKey: 'b', name: 'b' }]));
    await h.refresh();
    h.serve(surface([{ toolKey: 'a', name: 'a' }, { toolKey: 'b', name: 'b' }]));
    await h.refresh();
    expect(h.builds).toHaveLength(1);
  });

  test('a smaller model window rebuilds — the window decides the admission', async () => {
    const h = harness();
    h.serve(surface([{ toolKey: 'mcp_srv_weather', name: 'weather' }]));
    await h.refresh(200_000);
    await h.refresh(200_000);
    expect(h.builds).toHaveLength(1);
    // Same rows, a smaller model: an unkeyed cache would serve the larger model's surface.
    await h.refresh(20_000);
    expect(h.builds).toHaveLength(2);
  });

  test("a grown native tool surface rebuilds — it is the other half of the division", async () => {
    const h = harness();
    h.serve(surface([{ toolKey: 'mcp_srv_weather', name: 'weather' }]));
    await h.refresh(200_000, 4_000);
    await h.refresh(200_000, 4_000);
    expect(h.builds).toHaveLength(1);
    // The actor's own tools grew, so the remainder MCP is admitted against moved.
    await h.refresh(200_000, 60_000);
    expect(h.builds).toHaveLength(2);
  });
});
