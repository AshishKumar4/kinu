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
import { McpToolSurfaceCache, McpToolSurfaceSchema } from '../src/user/mcp';

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
    refresh: () => cache.refresh(async () => next),
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
});
