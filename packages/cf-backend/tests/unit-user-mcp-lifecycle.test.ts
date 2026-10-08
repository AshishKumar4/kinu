// Per-user MCP lifecycle in a real UserDO: atomic name uniqueness, derived SDK rows,
// credentials never reach the SDK as data, and only a transport 401 forces reconnect.
import { describe, expect, test } from 'bun:test';
import {
  createTestUserDO, provisionTestWorkspace, sqlExec, testOwner, TEST_CREDENTIAL_ENCRYPTION_KEY,
  type TestUserDO, type TestUserDOOptions,
} from './helpers/user-do';
import {
  closeMcpTransport, dropLiveMcpFetch, failNextMcpRemove, holdMcpRestore, seedMcpAnswer, failNextMcpToolCall, failNextMcpDiscovery, hangMcpEstablish, holdNextMcpToolCall, inheritedMcpManager,
  liveMcpFetch, liveMcpTransport, recordedMcpFetch, recordedMcpLifecycle, recordedMcpServers, recordedMcpToolAborts,
  recordedMcpToolCalls, resetRecordedMcp, seedMcpSession, seedMcpTools, seedMcpAuthContinuation, seedSdkMcpServer, seedUndiscoveredMcpTools,
  type RecordedMcpTransport,
} from './helpers/agents-sdk';
import { classifyMcpFailure, McpServerUnreachable, storedMcpOptionsCarryCredential } from '../src/user/mcp';
import { createCredentialCipher, McpToolSurfaceSchema } from '@kinu.run/core';
import { KinuError, renderThrownChain, setDiagnosticsSink, type LogFields } from '@kinu.run/core/obs';
import { ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import type { McpToolSurface } from '../src/user/mcp-servers';
import type { UserCaller } from '@kinu.run/core';
import { refusedSseConnect, refusedToolCall } from './helpers/mcp-transport';
import * as v from 'valibot';

/** The descriptor surface, parsed by `McpToolSurfaceSchema`, the contract the orchestrator's cache validates. */
async function readSurface(h: TestUserDO, owner: UserCaller): Promise<McpToolSurface> {
  return v.parse(McpToolSurfaceSchema, JSON.parse(await h.userDO.userMcp_toolDescriptors(owner)));
}

/**
 * The SDK's `cf_agents_mcp_servers.server_options` bytes: `restoreConnectionsFromStorage` rebuilds a
 * transport from exactly these (`agents/dist/client-zqKcsyFa.js:1557-1571`).
 */
function persistedServerOptions(id: string): string {
  const row = recordedMcpServers().find((server) => server.id === id);

  if (!row) throw new Error(`No SDK row for ${id}`);

  if (row.server_options === null) throw new Error(`SDK row ${id} persisted no options`);

  return row.server_options;
}

const OWNER_ID = '0123456789abcdef0123456789abcdef';

async function stopMessage(call: Promise<string>): Promise<string> {
  try {
    return `answered ${await call}`;
  } catch (error) {
    return renderThrownChain({ cause: error });
  }
}

/** The message a refused call rejected with. */
async function failureOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error('the call was not refused');
}

function harness(options?: TestUserDOOptions): TestUserDO {
  resetRecordedMcp();

  return createTestUserDO(options);
}

/** A configured server, written as `userMcp_add` would; the real call needs a live endpoint. */
async function seedServer(
  h: TestUserDO,
  id: string,
  fields: { name?: string; url?: string; headers?: Record<string, string> } = {},
): Promise<void> {
  await h.userDO.userMcp_list(await testOwner());
  sqlExec(h.db).exec(
    `INSERT INTO user_mcp_servers (id, name, server_url, transport, headers, allowed_tools)
     VALUES (?, ?, ?, 'auto', NULL, NULL)`,
    id, fields.name ?? id, fields.url ?? `https://${id}.example/sse`,
  );

  if (fields.headers) {
    await h.userDO.userMcp_update(await testOwner(), id, { headers: fields.headers });

    return;
  }

  // A read over a non-empty table hydrates the manager.
  await h.userDO.userMcp_list(await testOwner());
}

function storedName(h: TestUserDO, id: string): string | undefined {
  const row = sqlExec(h.db).exec('SELECT name FROM user_mcp_servers WHERE id = ?', id).toArray()[0];
  const parsed = v.safeParse(v.string(), row?.name);

  return parsed.success ? parsed.output : undefined;
}

/** The `authorization` header of every request made while `body` runs, in order; restores the global. */
async function authorizationsSeenDuring(body: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const real = globalThis.fetch;

  const record = async (
    _url: Request | URL | RequestInfo,
    init?: RequestInit,
  ): Promise<Response> => {
    seen.push(new Headers(init?.headers).get('authorization') ?? 'none');

    return new Response('{}');
  };

  globalThis.fetch = Object.assign(record, { preconnect: real.preconnect });

  try {
    await body();
  } finally { globalThis.fetch = real; }

  return seen;
}

describe('a server name is one identity, enforced by the database', () => {
  test('a second server under the same name, in any case, is refused and adds no row', async () => {
    const h = harness();
    await seedServer(h, 'srv1', { name: 'GitHub' });
    // Refused at the name claim, before the add dials anything.
    await expect(h.userDO.userMcp_add(await testOwner(), { name: 'github', serverUrl: 'https://other.example/sse' }, 'https://kinu.example'))
      .rejects.toThrow('github');
    expect(sqlExec(h.db).exec('SELECT id FROM user_mcp_servers').toArray()).toEqual([{ id: 'srv1' }]);
    h.close();
  });

  test('a rename onto a taken name answers with the name, not a SQL error', async () => {
    const h = harness();
    await seedServer(h, 'srv1', { name: 'github' });
    await seedServer(h, 'srv2', { name: 'linear' });
    const refused = await failureOf(h.userDO.userMcp_update(await testOwner(), 'srv2', { name: 'GitHub' }));
    expect(refused).toContain('GitHub');
    expect(refused).not.toMatch(/UNIQUE|constraint/iu);
    expect(storedName(h, 'srv2')).toBe('linear');
    h.close();
  });

  test('a rename to a free name still works', async () => {
    const h = harness();
    await seedServer(h, 'srv1', { name: 'github' });
    await h.userDO.userMcp_update(await testOwner(), 'srv1', { name: 'gh' });
    expect(storedName(h, 'srv1')).toBe('gh');
    h.close();
  });

  test('a rename obeys the SAME name rule an add does', async () => {
    // Rename and add share bounds so both writes onto one UNIQUE index agree on what a name is.
    const h = harness();
    await seedServer(h, 'srv1', { name: 'github' });
    const owner = await testOwner();

    // A blank name and one past 64 characters are refused, as an add refuses them, and the stored name stays.
    await expect(h.userDO.userMcp_update(owner, 'srv1', { name: '   ' })).rejects.toThrow();
    await expect(h.userDO.userMcp_update(owner, 'srv1', { name: 'x'.repeat(65) })).rejects.toThrow();
    await expect(h.userDO.userMcp_add(owner, { name: '   ', serverUrl: 'https://mcp.example/sse' }, 'https://kinu.example')).rejects.toThrow();
    expect(storedName(h, 'srv1')).toBe('github');

    await h.userDO.userMcp_update(owner, 'srv1', { name: '  spaced  ' });
    expect(storedName(h, 'srv1')).toBe('spaced');
    h.close();
  });

  test('two servers may share one endpoint under different names', async () => {
    // Identity is the name; uniqueness must not be pinned to the URL.
    const h = harness();
    await seedServer(h, 'srv1', { name: 'work', url: 'https://mcp.example/sse' });
    await seedServer(h, 'srv2', { name: 'personal', url: 'https://mcp.example/sse' });
    expect(storedName(h, 'srv2')).toBe('personal');
    h.close();
  });

  test('two renames racing for one free name: exactly one lands', async () => {
    // The claim reads and writes in one storage transaction, so the loser gets the named-taken
    // sentence rather than a raw constraint violation.
    const h = harness();
    const owner = await testOwner();
    await seedServer(h, 'srv1', { name: 'linear' });
    await seedServer(h, 'srv2', { name: 'notion' });

    const settled = await Promise.allSettled([
      h.userDO.userMcp_update(owner, 'srv1', { name: 'shared' }),
      h.userDO.userMcp_update(owner, 'srv2', { name: 'Shared' }),
    ]);

    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect([storedName(h, 'srv1'), storedName(h, 'srv2')].filter((n) => n?.toLowerCase() === 'shared'))
      .toHaveLength(1);
    h.close();
  });
});

describe('the management surface completes a round trip', () => {
  test('create, list, rename and remove', async () => {
    const h = harness();
    const owner = await testOwner();
    await seedServer(h, 'srv1', { name: 'github' });
    await seedServer(h, 'srv2', { name: 'linear' });

    const listed = await h.userDO.userMcp_list(owner);
    expect(listed.map((s) => s.id)).toEqual(['srv1', 'srv2']);
    expect(listed.every((s) => s.error === null)).toBe(true);

    await h.userDO.userMcp_update(owner, 'srv2', { name: 'linear-work' });
    expect(storedName(h, 'srv2')).toBe('linear-work');

    await h.userDO.userMcp_remove(owner, 'srv2');
    expect((await h.userDO.userMcp_list(owner)).map((s) => s.id)).toEqual(['srv1']);
    expect(storedName(h, 'srv2')).toBeUndefined();
    h.close();
  });

  test('a removed server takes its tools off the descriptor surface', async () => {
    const h = harness();
    const owner = await testOwner();
    await seedServer(h, 'srv1', { name: 'github' });
    seedMcpTools('srv1', [{ name: 'do_thing', inputSchema: { type: 'object' } }]);
    expect((await readSurface(h, owner)).descriptors.map((d) => d.toolKey))
      .toEqual(['mcp_github_do_thing']);

    await h.userDO.userMcp_remove(owner, 'srv1');

    const surface = await readSurface(h, owner);
    expect(surface.descriptors).toEqual([]);
    expect(surface.unavailable).toEqual([]);
    h.close();
  });

  test('a server whose tool list breaks the spec keeps its good tools; the bad one is refused and named', async () => {
    const h = harness();
    const owner = await testOwner();
    await seedServer(h, 'srv1', { name: 'github' });
    await seedServer(h, 'srv2', { name: 'broken' });
    // What a failed discovery leaves: the SDK's strict check refused each list as a whole.
    seedUndiscoveredMcpTools('srv1', async () => ({
      tools: [
        { name: 'do_thing', inputSchema: { type: 'object', properties: { q: { type: 'string' }, note: { type: 'string' } }, required: ['q'] } },
        { name: 'any_input', inputSchema: true },
        { name: 'scalar_root', inputSchema: { type: 'string' } },
      ],
    }));
    seedUndiscoveredMcpTools('srv2', async () => { throw new Error('server went away'); });

    await h.userDO.userMcp_warmConnections(owner);
    const surface = await readSurface(h, owner);
    const listed = await h.userDO.userMcp_list(owner);

    expect(surface.descriptors.map((d) => d.toolKey)).toEqual(['mcp_github_do_thing']);
    expect(surface.unavailable.map((u) => [u.server, /"(\w+)" is not offered/.exec(u.reason)?.[1] ?? null])).toEqual([
      ['broken', null],
      ['github', 'any_input'],
      ['github', 'scalar_root'],
    ]);
    expect(surface.unavailable[0]?.reason).toContain('server went away');
    expect(surface.unavailable.some((u) => u.reason.includes('installed by the next turn'))).toBe(false);
    expect(listed.map((server) => [server.name, server.toolsCount, server.error?.includes('"scalar_root"') ?? false]))
      .toEqual([['broken', 0, false], ['github', 1, true]]);

    // The offered tool runs, shaped by the schema the lenient read found: the untouched optional '' is dropped.
    await h.userDO.userMcp_callTool(owner, { serverId: 'srv1', name: 'do_thing', args: { q: '', note: '' }, id: crypto.randomUUID() });
    expect(recordedMcpToolCalls()).toEqual([{ serverId: 'srv1', name: 'do_thing', arguments: { q: '' } }]);
    h.close();
  });
});

describe('the descriptor read is off the connection critical path', () => {
  test('it starts no connection work and waits for none', async () => {
    const h = harness();
    const owner = await testOwner();
    await h.userDO.userMcp_list(owner);
    sqlExec(h.db).exec(
      `INSERT INTO user_mcp_servers (id, name, server_url, transport, headers, allowed_tools)
       VALUES ('srv1', 'slow', 'https://srv1.example/sse', 'auto', NULL, NULL)`,
    );
    const before = recordedMcpLifecycle();
    const establishedBefore = before.established.length;
    const restoredBefore = before.restored;

    const surface = await readSurface(h, owner);

    // A dial's `_connectWithRetry` has no bound, so the read starts none and waits for none.
    const after = recordedMcpLifecycle();
    expect(after.established.length).toBe(establishedBefore);
    expect(after.restored).toBe(restoredBefore);
    expect(after.waited).toBe(0);
    expect(surface.descriptors).toEqual([]);
    expect(surface.unavailable[0]?.server).toBe('slow');
    expect(surface.unavailable[0]?.reason).toMatch(/not connected when this turn opened/);
    expect(surface.unavailable[0]?.reason).toMatch(/installed by the next turn/);
    expect(surface.unavailable[0]?.reason).not.toMatch(/\b5s\b|within \d/);
    h.close();
  });

  test('it returns promptly while a server is still connecting, and never blocks on it', async () => {
    const first = harness();
    const owner = await testOwner();
    await seedServer(first, 'srv1', { name: 'fast' });
    sqlExec(first.db).exec(
      `INSERT INTO user_mcp_servers (id, name, server_url, transport, headers, allowed_tools)
       VALUES ('srv2', 'stuck', 'https://srv2.example/sse', 'auto', 'sealed', NULL)`,
    );
    const gate = hangMcpEstablish();
    // The activation registers the credentialed server and starts its dial; the warmup waits on it.
    const h = createTestUserDO({ storage: first.db });
    const warming = h.userDO.userMcp_warmConnections(owner);

    // The gate must be engaged, or this cannot tell "the read does not wait" from "nothing to wait for".
    await gate.entered;
    expect(recordedMcpLifecycle().established).toContain('srv2');
    seedMcpTools('srv1', [{ name: 'ready_tool', inputSchema: { type: 'object' } }]);

    const surface = await readSurface(h, owner);

    expect(surface.descriptors.map((d) => d.toolKey)).toEqual(['mcp_fast_ready_tool']);
    expect(surface.unavailable.map((u) => u.server)).toEqual(['stuck']);
    gate.release();
    await warming;
    h.close();
    first.close();
  });

  test('a later read sees what the warmup established', async () => {
    const h = harness();
    const owner = await testOwner();
    await h.userDO.userMcp_list(owner);
    sqlExec(h.db).exec(
      `INSERT INTO user_mcp_servers (id, name, server_url, transport, headers, allowed_tools)
       VALUES ('srv1', 'later', 'https://srv1.example/sse', 'auto', NULL, NULL)`,
    );

    const first = await readSurface(h, owner);
    expect(first.descriptors).toEqual([]);
    expect(first.unavailable.map((u) => u.server)).toEqual(['later']);

    await h.userDO.userMcp_warmConnections(owner);
    seedMcpTools('srv1', [{ name: 'warm_tool', inputSchema: { type: 'object' } }]);

    const second = await readSurface(h, owner);
    expect(second.descriptors.map((d) => d.toolKey)).toEqual(['mcp_later_warm_tool']);
    expect(second.unavailable).toEqual([]);
    h.close();
  });

  test('a deferred server contributes no descriptor, so it cannot reach the prompt', async () => {
    // Disjoint channels keep the cached system prompt independent of connection timing: absence
    // travels on `unavailable`, rendered into the dynamic ledger, not the byte-stable prefix.
    const h = harness();
    const owner = await testOwner();
    await seedServer(h, 'srv1', { name: 'ready' });
    seedMcpTools('srv1', [{ name: 'go', inputSchema: { type: 'object' } }]);
    sqlExec(h.db).exec(
      `INSERT INTO user_mcp_servers (id, name, server_url, transport, headers, allowed_tools)
       VALUES ('srv2', 'pending', 'https://srv2.example/sse', 'auto', NULL, NULL)`,
    );

    const surface = await readSurface(h, owner);

    const named = new Set(surface.descriptors.map((d) => d.serverName));
    const deferred = new Set(surface.unavailable.map((u) => u.server));
    expect([...named]).toEqual(['ready']);
    expect([...deferred]).toEqual(['pending']);

    for (const server of deferred) expect(named.has(server)).toBe(false);
    h.close();
  });
});

describe('the SDK server rows are derived from the config table', () => {
  test('an SDK row no config row owns is removed at activation', async () => {
    const h = harness();
    await seedServer(h, 'srv1');
    seedSdkMcpServer('ghost');
    expect(recordedMcpServers().map((s) => s.id)).toContain('ghost');

    const woken = createTestUserDO({ storage: h.db });
    await woken.userDO.userMcp_list(await testOwner());

    expect(recordedMcpServers().map((s) => s.id)).not.toContain('ghost');
    woken.close();
    h.close();
  });

  test('a configured row is not removed by that pass', async () => {
    const h = harness();
    await seedServer(h, 'srv1', { headers: { Authorization: 'Bearer keep' } });
    await h.userDO.userMcp_list(await testOwner());
    expect(recordedMcpServers().map((s) => s.id)).toContain('srv1');
    h.close();
  });

  test('the row left behind by the LAST server is still collected', async () => {
    const h = harness();
    await h.userDO.userMcp_list(await testOwner());
    seedSdkMcpServer('ghost');
    const woken = createTestUserDO({ storage: h.db });
    await woken.userDO.userMcp_warmConnections(await testOwner());
    expect(recordedMcpServers()).toEqual([]);
    woken.close();
    h.close();
  });

  test('an activation dials nothing through the SDK’s own start path', async () => {
    // The SDK calls `restoreConnectionsFromStorage` at every activation, before any credential closure is
    // registered; the start-path call is retired so waking a UserDO opens no anonymous connections.
    const first = harness();
    await seedServer(first, 'srv1', { headers: { Authorization: 'Bearer mcp-secret' } });
    const h = createTestUserDO({ storage: first.db });
    const before = recordedMcpLifecycle().restored;

    await inheritedMcpManager(h.userDO).restoreConnectionsFromStorage('UserDO');

    expect(recordedMcpLifecycle().restored).toBe(before);
    expect(Object.keys(inheritedMcpManager(h.userDO).mcpConnections)).toEqual([]);

    // Restore runs at this object's own start, after the credentialed transport is registered.
    await h.userDO.userMcp_list(await testOwner());
    expect(recordedMcpLifecycle().restored).toBe(before + 1);
    expect(Object.keys(inheritedMcpManager(h.userDO).mcpConnections)).toEqual(['srv1']);
    expect(liveMcpFetch('srv1')).not.toBeNull();
    h.close();
    first.close();
  });
});

describe('a stored MCP credential never reaches the SDK as data', () => {
  test('what the SDK would persist for a credentialed server holds no credential', async () => {
    const h = harness();
    await seedServer(h, 'srv1', { headers: { Authorization: 'Bearer mcp-secret' } });

    const persisted = persistedServerOptions('srv1');
    expect(persisted).not.toContain('mcp-secret');
    expect(persisted).not.toContain('Authorization');
    expect(persisted).not.toContain('requestInit');
    expect(persisted).not.toContain('eventSourceInit');
    expect(persisted).toBe(JSON.stringify({ transport: { type: 'auto' } }));
    h.close();
  });

  test('the credential travels as a fetch closure instead', async () => {
    const h = harness();
    await seedServer(h, 'srv1', { headers: { Authorization: 'Bearer mcp-secret' } });
    expect(recordedMcpFetch('srv1')).not.toBeNull();
    h.close();
  });

  test('a cold activation over storage a pre-change build wrote scrubs it', async () => {
    const first = harness();
    await seedServer(first, 'srv1', { headers: { Authorization: 'Bearer mcp-secret' } });
    // A plaintext credential row in the SDK's storage, replayed on every reconnect.
    seedSdkMcpServer('srv1', { type: 'auto', requestInit: { headers: { Authorization: 'Bearer mcp-secret' } } });
    expect(persistedServerOptions('srv1')).toContain('mcp-secret');

    // A new DO over the same storage; not `harness()`, which would clear the SDK rows under test.
    const woken = createTestUserDO({ storage: first.db });
    await woken.userDO.userMcp_list(await testOwner());

    expect(persistedServerOptions('srv1')).toBe(JSON.stringify({ transport: { type: 'auto' } }));
    // The live connection carries the seam: cold-start ordering invariant.
    expect(liveMcpFetch('srv1')).not.toBeNull();
    expect(liveMcpTransport('srv1')?.requestInit).toBeUndefined();
    woken.close();
    first.close();
  });

  test('a row whose credential column is NULL is scrubbed too, not replayed', async () => {
    // The scrub must not be keyed on our credential column: once it goes NULL the SDK row keeps the
    // plaintext and nothing would reach it again.
    const first = harness();
    await seedServer(first, 'srv1');
    // Shape of a stored plaintext row (`buildMcpHeaderTransportOpts`, `a080f8d2a^:src/user/mcp.ts:270-287`).
    seedSdkMcpServer('srv1', {
      type: 'auto',
      eventSourceInit: {},
      requestInit: { headers: { Authorization: 'Bearer stale' } },
    });
    expect(persistedServerOptions('srv1')).toContain('stale');

    const woken = createTestUserDO({ storage: first.db });
    const listed = await woken.userDO.userMcp_list(await testOwner());

    // The plaintext is gone from the SDK's own state, the only place it ever was.
    expect(persistedServerOptions('srv1')).toBe(JSON.stringify({ transport: { type: 'auto' } }));
    expect(liveMcpTransport('srv1')?.requestInit).toBeUndefined();
    expect(liveMcpTransport('srv1')?.eventSourceInit).toBeUndefined();
    expect(liveMcpFetch('srv1')).toBeNull();
    // `restoreConnectionsFromStorage` skips a connection this pass registered (`client-zqKcsyFa.js:1541-1549`).
    expect(recordedMcpLifecycle().established).toContain('srv1');
    expect(listed[0]?.status).toBe('ready');
    woken.close();
    first.close();
  });

  test('a scrubbed row that DOES hold a credential still serves from the sealed copy', async () => {
    // The scrub removes the plaintext copy, not the capability: requests stay authorized from the sealed column.
    const first = harness();
    await seedServer(first, 'srv1', { headers: { Authorization: 'Bearer sealed' } });
    seedSdkMcpServer('srv1', {
      type: 'auto',
      requestInit: { headers: { Authorization: 'Bearer stale' } },
    });

    const woken = createTestUserDO({ storage: first.db });
    await woken.userDO.userMcp_list(await testOwner());

    expect(persistedServerOptions('srv1')).toBe(JSON.stringify({ transport: { type: 'auto' } }));
    expect(liveMcpTransport('srv1')?.requestInit).toBeUndefined();

    const seen = await authorizationsSeenDuring(async () => {
      const send = liveMcpFetch('srv1');
      expect(send).not.toBeNull();
      await send?.('https://srv1.example/sse');
    });

    expect(seen).toEqual(['Bearer sealed']);
    woken.close();
    first.close();
  });

  test('a headers-clearing patch as an activation’s FIRST MCP call leaves no plaintext', async () => {
    // Hydration runs after the NULL write, so the scrub cannot depend on the column.
    const first = harness();
    const owner = await testOwner();
    await seedServer(first, 'srv1', { headers: { Authorization: 'Bearer mcp-secret' } });
    seedSdkMcpServer('srv1', {
      type: 'auto',
      requestInit: { headers: { Authorization: 'Bearer mcp-secret' } },
    });

    const woken = createTestUserDO({ storage: first.db });
    await woken.userDO.userMcp_update(owner, 'srv1', { headers: null });

    expect(persistedServerOptions('srv1')).toBe(JSON.stringify({ transport: { type: 'auto' } }));
    expect(liveMcpTransport('srv1')?.requestInit).toBeUndefined();
    expect(sqlExec(first.db).exec(
      'SELECT headers FROM user_mcp_servers WHERE id = ?', 'srv1',
    ).toArray()[0]?.headers).toBeNull();

    // The seam the activation installed reads the cleared column: the next request goes out bare.
    const seen = await authorizationsSeenDuring(async () => {
      await liveMcpFetch('srv1')?.('https://srv1.example/sse');
    });

    expect(seen).toEqual(['none']);
    woken.close();
    first.close();
  });

  test('a row that never held a credential keeps the SDK session state it had', async () => {
    // Keyed on credential fields, not "the SDK persisted something": rewriting for `sessionId` would drop a
    // resumable session on every activation.
    const first = harness();
    await seedServer(first, 'plain');
    seedSdkMcpServer('plain', { type: 'auto', sessionId: 'sess-1', protocolVersion: '2026-07-28' });
    const untouched = persistedServerOptions('plain');

    const h = createTestUserDO({ storage: first.db });
    await h.userDO.userMcp_warmConnections(await testOwner());

    expect(persistedServerOptions('plain')).toBe(untouched);
    expect(recordedMcpLifecycle().established).toEqual([]);
    h.close();
    first.close();
  });

  test('a rotation is spent by the next request, with no reconnect', async () => {
    const h = harness();
    await seedServer(h, 'srv1', { headers: { Authorization: 'Bearer first' } });
    const established = recordedMcpLifecycle().established.length;
    const resolve = recordedMcpServers().find((server) => server.id === 'srv1')?.transport.fetch;

    await h.userDO.userMcp_update(await testOwner(), 'srv1', { headers: { Authorization: 'Bearer rotated' } });

    // The seam reads the sealed column per request, so rotation needs no re-register.
    expect(recordedMcpServers().find((server) => server.id === 'srv1')?.transport.fetch).toBe(resolve);
    expect(recordedMcpLifecycle().established.length).toBe(established);

    const seen = await authorizationsSeenDuring(async () => {
      const send = recordedMcpFetch('srv1');
      expect(send).not.toBeNull();
      await send?.('https://srv1.example/sse');
    });

    expect(seen).toEqual(['Bearer rotated']);
    h.close();
  });

  test('stored headers that no longer open fail the request instead of sending it bare', async () => {
    const h = harness();
    await seedServer(h, 'srv1', { headers: { Authorization: 'Bearer sealed' } });
    const cipher = await createCredentialCipher({ CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });
    sqlExec(h.db).exec(
      'UPDATE user_mcp_servers SET headers = ? WHERE id = ?',
      await cipher.seal('test-user-do:mcp:other', JSON.stringify({ Authorization: 'Bearer other' })), 'srv1',
    );

    const send = recordedMcpFetch('srv1');
    expect(send).not.toBeNull();

    const seen = await authorizationsSeenDuring(async () => {
      await expect(send?.('https://srv1.example/sse')).rejects.toThrow('opening the stored headers of MCP server srv1');
    });

    expect(seen).toEqual([]);
    h.close();
  });


  test('a failed credential-seam teardown cannot claim it installed the seam; the next activation does', async () => {
    const h = harness();
    const owner = await testOwner();
    await seedServer(h, 'srv1', { headers: { Authorization: 'Bearer first' } });
    dropLiveMcpFetch('srv1');
    failNextMcpRemove(new Error('close refused'));
    // The re-registration must stop at the failed teardown rather than register over the stale wire.
    await h.userDO.userMcp_update(owner, 'srv1', { headers: { Authorization: 'Bearer rotated' } });
    expect(liveMcpFetch('srv1')).toBeNull();

    const woken = createTestUserDO({ storage: h.db });
    await woken.userDO.userMcp_warmConnections(owner);
    expect(liveMcpFetch('srv1')).not.toBeNull();
    woken.close();
    h.close();
  });

  test('requests during an activation join its one reconciliation', async () => {
    const first = harness();
    const owner = await testOwner();
    await seedServer(first, 'srv1', { headers: { Authorization: 'Bearer first' } });
    const before = recordedMcpLifecycle().established.length;
    const gate = hangMcpEstablish();
    const h = createTestUserDO({ storage: first.db });

    const warming = h.userDO.userMcp_warmConnections(owner);
    const listing = h.userDO.userMcp_list(owner);
    await gate.entered;
    expect(recordedMcpLifecycle().established).toHaveLength(before + 1);

    gate.release();
    await Promise.all([warming, listing]);
    expect(recordedMcpLifecycle().established).toHaveLength(before + 1);
    expect(liveMcpFetch('srv1')).not.toBeNull();
    h.close();
    first.close();
  });
  test('a server with no credential is left to the SDK restore', async () => {
    const h = harness();
    await seedServer(h, 'plain');
    await h.userDO.userMcp_list(await testOwner());
    expect(recordedMcpLifecycle().established).toEqual([]);
    h.close();
  });
});

describe('what counts as a credential in the SDK’s stored options', () => {
  test('the three data fields count, and the SDK’s own connection state does not', () => {
    const stored = (transport: RecordedMcpTransport): string => JSON.stringify({ transport });

    expect(storedMcpOptionsCarryCredential(
      stored({ type: 'auto', requestInit: { headers: { Authorization: 'Bearer x' } } }),
    )).toBe(true);
    expect(storedMcpOptionsCarryCredential(
      stored({ type: 'auto', eventSourceInit: {} }),
    )).toBe(true);
    expect(storedMcpOptionsCarryCredential(
      stored({ type: 'auto', headers: { Authorization: 'Bearer x' } }),
    )).toBe(true);

    // Session resumption and retry policy are the SDK's own state; rewriting for them would drop a
    // resumable session on every activation.
    expect(storedMcpOptionsCarryCredential(
      stored({ type: 'auto', sessionId: 'sess-1', protocolVersion: '2026-07-28' }),
    )).toBe(false);
    expect(storedMcpOptionsCarryCredential(stored({ type: 'auto' }))).toBe(false);

    expect(storedMcpOptionsCarryCredential('{"client":{}}')).toBe(false);
    expect(storedMcpOptionsCarryCredential('{"transport":null}')).toBe(false);
    expect(storedMcpOptionsCarryCredential('not json at all')).toBe(false);
    expect(storedMcpOptionsCarryCredential(null)).toBe(false);
  });
});

// 2026-10-05: a stopped eval's MCP call ran on: the call is an RPC to this hub, and no signal crosses an RPC.
describe('a caller stops the MCP call it made', () => {
  test('a cancel naming the call aborts its request, and the call settles with the cancel', async () => {
    const h = harness();
    await seedServer(h, 'srv1');
    seedMcpTools('srv1', [{ name: 'do_thing', inputSchema: { type: 'object' } }]);
    holdNextMcpToolCall();
    const owner = await testOwner();
    const call = h.userDO.userMcp_callTool(owner, { serverId: 'srv1', name: 'do_thing', args: {}, id: 'call-7' });

    await h.userDO.userMcp_cancelCall(owner, 'call-7');
    expect(await stopMessage(call)).toBe('The MCP tool call stopped before its server answered.: Its caller stopped the MCP tool call.');
    expect(recordedMcpToolAborts()).toEqual([expect.objectContaining({ code: 'cancelled' })]);
    h.close();
  });

  // Release review, 2026-10-05: a stopped call waiting for its session's renewal kept its place among the calls in
  // flight until an unrelated call finished, since a renewal waits for every call still on the old session.
  test('a stopped call waiting for its server\'s session to be renewed settles at once, while the call the renewal waits for runs on', async () => {
    const h = harness();
    await seedServer(h, 'srv1');
    seedMcpTools('srv1', [{ name: 'do_thing', inputSchema: { type: 'object' } }]);
    seedMcpSession('srv1', 's1');
    const owner = await testOwner();
    const ended = await refusedToolCall({ status: 404, body: 'session ended' });
    const call = (id: string) => h.userDO.userMcp_callTool(owner, { serverId: 'srv1', name: 'do_thing', args: {}, id });

    holdNextMcpToolCall();
    const running = call('call-running');
    failNextMcpToolCall(ended);
    const renewing = call('call-renewing');

    await h.userDO.userMcp_cancelCall(owner, 'call-renewing');
    expect(await stopMessage(renewing)).toContain('Its caller stopped the MCP tool call.');
    expect(recordedMcpToolAborts()).toEqual([]);

    await h.userDO.userMcp_cancelCall(owner, 'call-running');
    expect(await stopMessage(running)).toContain('Its caller stopped the MCP tool call.');
    h.close();
  });

  // Release review, 2026-10-05: deleting a workspace revoked its token first, so its MCP calls ran on and it could not cancel them.
  test('deleting a workspace stops the MCP calls it is making', async () => {
    const h = harness({ durableObjectId: OWNER_ID });
    await seedServer(h, 'srv1');
    seedMcpTools('srv1', [{ name: 'do_thing', inputSchema: { type: 'object' } }]);
    const token = await provisionTestWorkspace(h, 'leaving');
    holdNextMcpToolCall();
    const call = h.userDO.userMcp_callTool({ workspaceToken: token }, { serverId: 'srv1', name: 'do_thing', args: {}, id: 'call-leaving' });

    await h.userDO.removeWorkspace(await testOwner(), 'leaving', OWNER_ID);
    expect(await stopMessage(call)).toContain('Workspace "leaving" was deleted, so its MCP tool calls stop.');
    expect(recordedMcpToolAborts()).toEqual([expect.objectContaining({ code: 'cancelled' })]);
    h.close();
  });

  test('a cancel for a call this hub is not making changes nothing', async () => {
    const h = harness();
    await seedServer(h, 'srv1');
    seedMcpTools('srv1', [{ name: 'do_thing', inputSchema: { type: 'object' } }]);
    const owner = await testOwner();

    await h.userDO.userMcp_cancelCall(owner, 'call-gone');
    await expect(h.userDO.userMcp_callTool(owner, { serverId: 'srv1', name: 'do_thing', args: {}, id: 'call-8' })).resolves.toBe(JSON.stringify({ content: [] }));
    expect(recordedMcpToolAborts()).toEqual([]);
    h.close();
  });
});

describe('an authorization failure converges to the reconnect state', () => {
  test('a transport 401 on dispatch re-probes the connection, and the failure still travels', async () => {
    const h = harness();
    await seedServer(h, 'srv1');
    seedMcpTools('srv1', [{ name: 'do_thing', inputSchema: { type: 'object' } }]);
    // The `authUrl` the SDK reads back while AUTHENTICATING (`client-zqKcsyFa.js:1704-1706`).
    seedMcpAuthContinuation('srv1', 'https://auth.example/authorize?srv1');
    // A POST 401 with no auth provider to retry through.
    failNextMcpToolCall(await refusedToolCall({ status: 401, body: 'nope' }));
    // In production the dispatch and the `discoverIfConnected` probe are two failing requests.
    failNextMcpDiscovery(await refusedToolCall({ status: 401, body: 'nope' }));

    await expect(h.userDO.userMcp_callTool(await testOwner(), { serverId: 'srv1', name: 'do_thing', args: {}, id: crypto.randomUUID() }))
      .rejects.toThrow('Error POSTing to endpoint: nope');

    // Observe the persisted `authenticating` status and `authUrl`, not merely that a re-probe was attempted.
    expect(recordedMcpLifecycle().discovered).toContain('srv1');
    const [listed] = await h.userDO.userMcp_list(await testOwner());
    expect(listed?.status).toBe('authenticating');
    expect(listed?.authUrl).toBe('https://auth.example/authorize?srv1');
    h.close();
  });

  test('an UnauthorizedError from the auth path converges too', async () => {
    const h = harness();
    await seedServer(h, 'srv1');
    seedMcpTools('srv1', [{ name: 'do_thing', inputSchema: { type: 'object' } }]);
    seedMcpAuthContinuation('srv1', 'https://auth.example/authorize?srv1');
    // An auth provider that cannot recover the token.
    failNextMcpToolCall(await refusedToolCall({ status: 401, body: 'nope', authProvider: { token: () => Promise.resolve('stale') } }));
    failNextMcpDiscovery(await refusedToolCall({ status: 401, body: 'nope' }));

    await expect(h.userDO.userMcp_callTool(await testOwner(), { serverId: 'srv1', name: 'do_thing', args: {}, id: crypto.randomUUID() }))
      .rejects.toThrow();

    expect(recordedMcpLifecycle().discovered).toContain('srv1');
    const [listed] = await h.userDO.userMcp_list(await testOwner());
    expect(listed?.status).toBe('authenticating');
    expect(listed?.authUrl).toBe('https://auth.example/authorize?srv1');
    h.close();
  });

  test('a typed 401 wrapped by another error still converges', async () => {
    const h = harness();
    await seedServer(h, 'srv1');
    seedMcpTools('srv1', [{ name: 'do_thing', inputSchema: { type: 'object' } }]);
    seedMcpAuthContinuation('srv1', 'https://auth.example/authorize?srv1');
    // An auth provider that re-authenticated, and the retry answered 401 again.
    const reauthenticated = { token: () => Promise.resolve('stale'), onUnauthorized: () => Promise.resolve() };
    failNextMcpToolCall(new Error('MCP request failed', {
      cause: await refusedToolCall({ status: 401, body: 'nope', authProvider: reauthenticated }),
    }));
    failNextMcpDiscovery(await refusedToolCall({ status: 401, body: 'nope', authProvider: reauthenticated }));

    await expect(h.userDO.userMcp_callTool(await testOwner(), { serverId: 'srv1', name: 'do_thing', args: {}, id: crypto.randomUUID() }))
      .rejects.toThrow();

    expect(recordedMcpLifecycle().discovered).toContain('srv1');
    const [listed] = await h.userDO.userMcp_list(await testOwner());
    expect(listed?.status).toBe('authenticating');
    expect(listed?.authUrl).toBe('https://auth.example/authorize?srv1');
    h.close();
  });

  test('a converged connection leaves the descriptor surface: offered nowhere, disclaimed once', async () => {
    // A failed probe does not clear cached tools, so the server must appear in exactly one channel:
    // absent from descriptors, named once in `unavailable`.
    const h = harness();
    await seedServer(h, 'srv1');
    seedMcpTools('srv1', [{ name: 'do_thing', inputSchema: { type: 'object' } }]);
    failNextMcpToolCall(await refusedToolCall({ status: 401, body: 'nope' }));
    failNextMcpDiscovery(await refusedToolCall({ status: 401, body: 'nope' }));

    await expect(h.userDO.userMcp_callTool(await testOwner(), { serverId: 'srv1', name: 'do_thing', args: {}, id: crypto.randomUUID() }))
      .rejects.toThrow('Error POSTing to endpoint: nope');

    const surface = await readSurface(h, await testOwner());
    expect(surface.descriptors).toEqual([]);
    expect(surface.unavailable).toHaveLength(1);
    expect(surface.unavailable[0]?.server).toBe('srv1');
    h.close();
  });

  test('an SSE stream refused with 401 converges too', async () => {
    const h = harness();
    await seedServer(h, 'srv1');
    seedMcpTools('srv1', [{ name: 'do_thing', inputSchema: { type: 'object' } }]);
    seedMcpAuthContinuation('srv1', 'https://auth.example/authorize?srv1');
    failNextMcpToolCall(await refusedSseConnect({ status: 401 }));
    failNextMcpDiscovery(await refusedSseConnect({ status: 401 }));

    await expect(h.userDO.userMcp_callTool(await testOwner(), { serverId: 'srv1', name: 'do_thing', args: {}, id: crypto.randomUUID() }))
      .rejects.toThrow();

    expect(recordedMcpLifecycle().discovered).toContain('srv1');
    const [listed] = await h.userDO.userMcp_list(await testOwner());
    expect(listed?.status).toBe('authenticating');
    h.close();
  });

  test('a transport refusal other than 401 reconnects nothing', async () => {
    for (const status of [403, 500]) {
      const h = harness();
      await seedServer(h, 'srv1');
      seedMcpTools('srv1', [{ name: 'do_thing', inputSchema: { type: 'object' } }]);
      failNextMcpToolCall(await refusedToolCall({ status, body: 'nope' }));

      await expect(h.userDO.userMcp_callTool(await testOwner(), { serverId: 'srv1', name: 'do_thing', args: {}, id: crypto.randomUUID() }))
        .rejects.toThrow('Error POSTing to endpoint: nope');

      expect({ status, discovered: recordedMcpLifecycle().discovered.includes('srv1') }).toEqual({ status, discovered: false });
      h.close();
    }
  });

  test("a tool's own error is not treated as an auth failure", async () => {
    const h = harness();
    await seedServer(h, 'srv1');
    seedMcpTools('srv1', [{ name: 'do_thing', inputSchema: { type: 'object' } }]);
    failNextMcpToolCall(new Error('the repository does not exist'));

    await expect(h.userDO.userMcp_callTool(await testOwner(), { serverId: 'srv1', name: 'do_thing', args: {}, id: crypto.randomUUID() }))
      .rejects.toThrow(/repository/);

    expect(recordedMcpLifecycle().discovered).not.toContain('srv1');
    h.close();
  });

  test("a tool error whose PROSE says 401 unauthorized reconnects NOTHING", async () => {
    // A proxied third-party 401 in a tool's error text is not a transport auth failure.
    const h = harness();
    await seedServer(h, 'srv1');
    seedMcpTools('srv1', [{ name: 'do_thing', inputSchema: { type: 'object' } }]);
    failNextMcpToolCall(new Error(
      'MCP error -32603: GitHub API replied 401 Unauthorized: bad credentials for the PAT you configured',
    ));

    await expect(h.userDO.userMcp_callTool(await testOwner(), { serverId: 'srv1', name: 'do_thing', args: {}, id: crypto.randomUUID() }))
      .rejects.toThrow(/401/);

    expect(recordedMcpLifecycle().discovered).not.toContain('srv1');
    h.close();
  });

  test('a plain error carrying a 401-shaped code is not a transport 401', async () => {
    const h = harness();
    await seedServer(h, 'srv1');
    seedMcpTools('srv1', [{ name: 'do_thing', inputSchema: { type: 'object' } }]);
    failNextMcpToolCall(Object.assign(new Error('upstream said no'), { code: 401 }));

    await expect(h.userDO.userMcp_callTool(await testOwner(), { serverId: 'srv1', name: 'do_thing', args: {}, id: crypto.randomUUID() }))
      .rejects.toThrow(/upstream/);

    expect(recordedMcpLifecycle().discovered).not.toContain('srv1');
    h.close();
  });
});

describe('the descriptor surface', () => {
  test('is ordered by tool key, so its content hash does not move on its own', async () => {
    const h = harness();
    await seedServer(h, 'srv1', { name: 'zulu' });
    seedMcpTools('srv1', [
      { name: 'b_tool', inputSchema: { type: 'object' } },
      { name: 'a_tool', inputSchema: { type: 'object' } },
    ]);
    const surface = await readSurface(h, await testOwner());
    expect(surface.descriptors.map((d) => d.toolKey))
      .toEqual(['mcp_zulu_a_tool', 'mcp_zulu_b_tool']);
    h.close();
  });

  test('omits a blank remote description instead of forwarding an empty string', async () => {
    const h = harness();
    await seedServer(h, 'srv1', { name: 'zulu' });
    seedMcpTools('srv1', [{ name: 'quiet', description: '', inputSchema: { type: 'object' } }]);
    const surface = await readSurface(h, await testOwner());
    expect(surface.descriptors).toHaveLength(1);
    expect('description' in surface.descriptors[0]).toBe(false);
    h.close();
  });

  test('a connected server with no tools is not reported as still connecting', async () => {
    const h = harness();
    await seedServer(h, 'srv1', { name: 'quiet' });
    seedMcpTools('srv1', []);
    const surface = await readSurface(h, await testOwner());
    expect(surface.descriptors).toEqual([]);
    expect(surface.unavailable).toEqual([]);

    const listed = await h.userDO.userMcp_list(await testOwner());
    expect(listed[0]?.status).toBe('ready');
    expect(listed[0]?.toolsCount).toBe(0);
    h.close();
  });

  test('a connected server whose allowlist filters every tool is not unavailable', async () => {
    const h = harness();
    await seedServer(h, 'srv1', { name: 'filtered' });
    sqlExec(h.db).exec(`UPDATE user_mcp_servers SET allowed_tools = '[]' WHERE id = 'srv1'`);
    seedMcpTools('srv1', [{ name: 'hidden', inputSchema: { type: 'object' } }]);

    const surface = await readSurface(h, await testOwner());
    expect(surface.descriptors).toEqual([]);
    expect(surface.unavailable).toEqual([]);

    const listed = await h.userDO.userMcp_list(await testOwner());
    expect(listed[0]?.status).toBe('ready');
    expect(listed[0]?.toolsCount).toBe(0);
    h.close();
  });
});

/** The live connection a test drives into a state the fake reaches no other way. */
function liveConnection(h: TestUserDO, id: string): { connectionState: string } {
  const connection = inheritedMcpManager(h.userDO).mcpConnections[id];

  if (!connection) throw new Error(`No live MCP connection for ${id}.`);

  return connection;
}

interface LoggedLine {
  readonly name: string;
  readonly fields: LogFields;
}

/** Every diagnostics line `body` logs. Set up after construction: each UserDO installs its own sink. */
async function diagnosticsDuring(body: () => Promise<void>): Promise<LoggedLine[]> {
  const lines: LoggedLine[] = [];

  const record = (name: string, fields: LogFields | undefined): void => {
    lines.push({ name, fields: fields ?? {} });
  };

  const restore = setDiagnosticsSink({ event: record, failure: (name, _error, fields) => { record(name, fields); } });

  try {
    await body();
  } finally { restore(); }

  return lines;
}

describe('a call finds its server usable, or says why not before sending', () => {
  test('a call that wakes the object waits for the dial its activation started, never failing "Not connected"', async () => {
    // Production, steady-valley-7d95009f at 14:44:54: the user object woke for the call, the restore dial was
    // still out, and the call reached a client with no transport 128 ms later.
    const first = harness();
    const owner = await testOwner();
    await seedServer(first, 'srv1', { name: 'Cloudflare' });
    seedSdkMcpServer('srv1');
    const dial = holdMcpRestore();
    const h = createTestUserDO({ storage: first.db });

    const call = h.userDO.userMcp_callTool(owner, { serverId: 'srv1', name: 'execute', args: {}, id: 'woke-for-it' });
    await dial.entered;
    expect(liveConnection(h, 'srv1').connectionState).toBe('connecting');
    expect(recordedMcpToolCalls()).toEqual([]);

    dial.release();
    expect(await call).toBe(JSON.stringify({ content: [] }));
    expect(recordedMcpToolCalls()).toEqual([{ serverId: 'srv1', name: 'execute', arguments: {} }]);
    h.close();
    first.close();
  });

  test('a ready connection whose transport closed is dialled again, and the call goes out once', async () => {
    const h = harness();
    const owner = await testOwner();
    await seedServer(h, 'srv1');
    seedMcpTools('srv1', [{ name: 'do_thing', inputSchema: { type: 'object' } }]);
    closeMcpTransport('srv1');

    const answer = await h.userDO.userMcp_callTool(owner, { serverId: 'srv1', name: 'do_thing', args: {}, id: crypto.randomUUID() });

    expect(answer).toBe(JSON.stringify({ content: [] }));
    expect(recordedMcpToolCalls()).toHaveLength(1);
    expect(recordedMcpLifecycle().discovered).toContain('srv1');
    h.close();
  });

  test('a server waiting for sign-in refuses the call before sending it, and says so', async () => {
    const h = harness();
    await seedServer(h, 'srv1', { name: 'linear' });
    seedMcpTools('srv1', [{ name: 'do_thing', inputSchema: { type: 'object' } }]);
    liveConnection(h, 'srv1').connectionState = 'authenticating';

    const refused = await failureOf(h.userDO.userMcp_callTool(await testOwner(), { serverId: 'srv1', name: 'do_thing', args: {}, id: crypto.randomUUID() }));

    expect(refused).toBe('MCP server linear is authenticating, so the call was not sent. Sign in to it again in Settings.');
    expect(recordedMcpToolCalls()).toEqual([]);
    h.close();
  });
});

describe('MCP connections and calls are logged, classified', () => {
  test('each failed call is logged once as mcp.call_failed, with its kind', async () => {
    const h = harness();
    const owner = await testOwner();
    await seedServer(h, 'srv1');
    seedMcpTools('srv1', [{ name: 'do_thing', inputSchema: { type: 'object' } }]);
    const call = (serverId: string): Promise<string> => h.userDO.userMcp_callTool(owner, { serverId, name: 'do_thing', args: {}, id: crypto.randomUUID() });
    const serverError = await refusedToolCall({ status: 500, body: 'boom' });

    const lines = await diagnosticsDuring(async () => {
      failNextMcpToolCall(serverError);
      await failureOf(call('srv1'));
      seedMcpAnswer({ content: [{ type: 'text', text: 'Invalid list options provided.' }], isError: true });
      await call('srv1');
      await failureOf(call('gone'));
      await call('srv1');
    });

    expect(lines.filter((line) => line.name === 'mcp.call_failed').map((line) => [line.fields.serverId, line.fields.kind, line.fields.state]))
      .toEqual([['srv1', 'http', 'ready'], ['srv1', 'tool_error', 'ready'], ['gone', 'refused', 'absent']]);
    h.close();
  });

  test('each connection change is logged once, with the state it left', async () => {
    const first = harness();
    const owner = await testOwner();
    await seedServer(first, 'srv1');
    seedSdkMcpServer('srv1');
    const dial = holdMcpRestore();
    const h = createTestUserDO({ storage: first.db });

    const lines = await diagnosticsDuring(async () => {
      const listing = h.userDO.userMcp_list(owner);
      await dial.entered;
      dial.release();
      await listing;
      await h.userDO.userMcp_warmConnections(owner);
    });

    expect(lines.filter((line) => line.name === 'mcp.connection_changed').map((line) => [line.fields.serverId, line.fields.from, line.fields.to]))
      .toEqual([['srv1', 'absent', 'connecting'], ['srv1', 'connecting', 'ready']]);
    h.close();
    first.close();
  });

  test('a failure is classified by its class and code, never its text', async () => {
    const wrapped = new KinuError('unavailable', 'calling a tool', { cause: new SdkError(SdkErrorCode.NotConnected, 'Not connected') });

    expect([
      new SdkError(SdkErrorCode.NotConnected, 'Not connected'),
      new SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed'),
      new SdkError(SdkErrorCode.RequestTimeout, 'Request timed out'),
      new SdkError(SdkErrorCode.SendFailed, 'send failed'),
      new SdkError(SdkErrorCode.InvalidResult, 'bad result'),
      new ProtocolError(-32602, 'bad params'),
      await refusedToolCall({ status: 401, body: 'no' }),
      await refusedToolCall({ status: 500, body: 'boom' }),
      wrapped,
      new KinuError('cancelled', 'stopped'),
      new KinuError('denied', 'not allowed'),
      new McpServerUnreachable('auth', 'signing in'),
      new Error('401 Unauthorized: Not connected, timed out'),
    ].map((cause) => classifyMcpFailure({ cause }))).toEqual([
      'not_connected', 'connection_closed', 'timeout', 'send_failed', 'protocol', 'server_error',
      'auth', 'http', 'not_connected', 'cancelled', 'refused', 'auth', 'unknown',
    ]);
  });
});
