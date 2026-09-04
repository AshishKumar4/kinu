/**
 * The orchestrator's per-activation MCP tool cache is keyed by the HASH OF THE
 * DESCRIPTOR CONTENT, never by a mutation watermark. A watermark reset to zero
 * on every cold start while durable server rows survived, and its "zero means
 * never configured" reader silently stripped every MCP tool after an eviction.
 * Content hashing has neither failure mode: cold reconstruction, update,
 * deletion and OAuth completion each invalidate exactly when the durable
 * surface differs from the cached one.
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
    // A window big enough that admission is never the thing under test here;
    // the budget has its own tests in unit-user-mcp.test.ts.
    // The output allowance is fixed here: the cache's contract is about the
    // KEY moving, and the budget's own arithmetic is proven in unit-user-mcp.
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
    // Served from the cache the second time: empty is a STATE the durable rows
    // reported, not a read that failed to happen.
    expect(await h.refresh()).toEqual({ keys: [] });
    expect(h.builds).toHaveLength(1);
    expect(h.unavailable()).toHaveLength(0);
  });

  test('an empty surface never reads as "never configured"', async () => {
    // The watermark bug this cache replaced: `_userMcpUpdatedAt` reset to zero
    // on every cold start while the durable server rows survived, and a reader
    // that treated zero as "no MCP configured" stripped every tool after an
    // eviction. Empty is just empty here, and the next non-empty read installs.
    const h = harness();
    h.serve(surface([]));
    await h.refresh();

    h.serve(surface([{ toolKey: 'mcp_srv_weather', name: 'weather' }]));
    expect(await h.refresh()).toEqual({ keys: ['mcp_srv_weather'] });
    expect(h.builds).toHaveLength(2);
  });

  test('a surface that goes empty again is honoured, not ignored', async () => {
    // The other direction of the same rule: the user deleted their last server,
    // and the tool must go. A cache that only ever grew would keep dispatching
    // to a row that no longer exists.
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
    // Same surface bytes again — no rebuild.
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
    // Same rows, a model with a tenth of the room. Serving the larger model's
    // surface here is what an unkeyed cache would do.
    await h.refresh(20_000);
    expect(h.builds).toHaveLength(2);
  });

  test("a grown native tool surface rebuilds — it is the other half of the division", async () => {
    const h = harness();
    h.serve(surface([{ toolKey: 'mcp_srv_weather', name: 'weather' }]));
    await h.refresh(200_000, 4_000);
    await h.refresh(200_000, 4_000);
    expect(h.builds).toHaveLength(1);
    // Same rows, same model, but the actor took on more of its own tools — a
    // narrowed role or a new skill set. The remainder MCP is admitted against
    // moved, so the cached division no longer holds.
    await h.refresh(200_000, 60_000);
    expect(h.builds).toHaveLength(2);
  });
});
