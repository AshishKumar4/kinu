// Per-user MCP lifecycle in a real UserDO: atomic name uniqueness, derived SDK rows,
// credentials never reach the SDK as data, and only a transport 401 forces reconnect.
import { describe, expect, test } from 'bun:test';
import {
  createTestUserDO, sqlExec, testOwner, TEST_CREDENTIAL_ENCRYPTION_KEY,
  type TestUserDO, type TestUserDOOptions,
} from './helpers/user-do';
import {
  dropLiveMcpFetch, failNextMcpRemove, failNextMcpToolCall, failNextMcpDiscovery, hangMcpEstablish, inheritedMcpManager,
  liveMcpFetch, liveMcpTransport, recordedMcpFetch, recordedMcpLifecycle, recordedMcpServers,
  resetRecordedMcp, seedMcpTools, seedMcpAuthContinuation, seedSdkMcpServer,
  type RecordedMcpTransport,
} from './helpers/agents-sdk';
import { storedMcpOptionsCarryCredential, validateMcpServerInput } from '../src/user/mcp';
import { createCredentialCipher, McpToolSurfaceSchema } from '@kinu.run/core';
import type { McpToolSurface } from '../src/user/user-do';
import type { UserCaller } from '@kinu.run/core';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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
    `INSERT INTO user_mcp_servers (id, name, server_url, transport, headers, allowed_tools, created_at, updated_at)
     VALUES (?, ?, ?, 'auto', NULL, NULL, 0, 0)`,
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
  test('a second row under the same name, in any case, is refused', async () => {
    const h = harness();
    await seedServer(h, 'srv1', { name: 'GitHub' });
    // The UNIQUE index on `lower(name)` refuses the write itself.
    expect(() => sqlExec(h.db).exec(
      `INSERT INTO user_mcp_servers (id, name, server_url, transport, headers, allowed_tools, created_at, updated_at)
       VALUES ('srv2', 'github', 'https://other.example/sse', 'auto', NULL, NULL, 0, 0)`,
    )).toThrow(/UNIQUE/i);
    h.close();
  });

  test('a rename onto a taken name answers with the name, not a SQL error', async () => {
    const h = harness();
    await seedServer(h, 'srv1', { name: 'github' });
    await seedServer(h, 'srv2', { name: 'linear' });
    await expect(h.userDO.userMcp_update(await testOwner(), 'srv2', { name: 'GitHub' }))
      .rejects.toThrow("An MCP server named 'GitHub' already exists.");
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

    const addRefusal = (name: string): string => {
      try {
        validateMcpServerInput({ name, serverUrl: 'https://mcp.example/sse' });

        return '';
      }
      catch (err) { return err instanceof Error ? err.message : String(err); }
    };

    await expect(h.userDO.userMcp_update(owner, 'srv1', { name: '   ' }))
      .rejects.toThrow(addRefusal('   '));
    await expect(h.userDO.userMcp_update(owner, 'srv1', { name: 'x'.repeat(65) }))
      .rejects.toThrow(addRefusal('x'.repeat(65)));
    expect(storedName(h, 'srv1')).toBe('github');

    await h.userDO.userMcp_update(owner, 'srv1', { name: '  spaced  ' });
    expect(storedName(h, 'srv1')).toBe('spaced');
    expect(validateMcpServerInput({ name: '  spaced  ', serverUrl: 'https://mcp.example/sse' }).name)
      .toBe('spaced');
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
});

describe('the descriptor read is off the connection critical path', () => {
  test('it starts no connection work and waits for none', async () => {
    const h = harness();
    const owner = await testOwner();
    await h.userDO.userMcp_list(owner);
    sqlExec(h.db).exec(
      `INSERT INTO user_mcp_servers (id, name, server_url, transport, headers, allowed_tools, created_at, updated_at)
       VALUES ('srv1', 'slow', 'https://srv1.example/sse', 'auto', NULL, NULL, 0, 0)`,
    );
    const before = recordedMcpLifecycle();
    const establishedBefore = before.established.length;
    const restoredBefore = before.restored;

    const surface = await readSurface(h, owner);

    // `hydrateUserMcp` awaits `_connectWithRetry` with no bound, so nothing hydrated.
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
    const h = harness();
    const owner = await testOwner();
    await seedServer(h, 'srv1', { name: 'fast' });
    seedMcpTools('srv1', [{ name: 'ready_tool', inputSchema: { type: 'object' } }]);
    sqlExec(h.db).exec(
      `INSERT INTO user_mcp_servers (id, name, server_url, transport, headers, allowed_tools, created_at, updated_at)
       VALUES ('srv2', 'stuck', 'https://srv2.example/sse', 'auto', 'sealed', NULL, 0, 0)`,
    );
    const gate = hangMcpEstablish();
    const warming = h.userDO.userMcp_warmConnections(owner);

    // The gate must be engaged, or this cannot tell "the read does not wait" from "nothing to wait for".
    await gate.entered;
    expect(recordedMcpLifecycle().established).toContain('srv2');

    const surface = await readSurface(h, owner);

    expect(surface.descriptors.map((d) => d.toolKey)).toEqual(['mcp_fast_ready_tool']);
    expect(surface.unavailable.map((u) => u.server)).toEqual(['stuck']);
    gate.release();
    await warming;
    h.close();
  });

  test('a later read sees what the warmup established', async () => {
    const h = harness();
    const owner = await testOwner();
    await h.userDO.userMcp_list(owner);
    sqlExec(h.db).exec(
      `INSERT INTO user_mcp_servers (id, name, server_url, transport, headers, allowed_tools, created_at, updated_at)
       VALUES ('srv1', 'later', 'https://srv1.example/sse', 'auto', NULL, NULL, 0, 0)`,
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
      `INSERT INTO user_mcp_servers (id, name, server_url, transport, headers, allowed_tools, created_at, updated_at)
       VALUES ('srv2', 'pending', 'https://srv2.example/sse', 'auto', NULL, NULL, 0, 0)`,
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
  test('an SDK row no config row owns is removed on hydration', async () => {
    const h = harness();
    await seedServer(h, 'srv1');
    seedSdkMcpServer('ghost');
    expect(recordedMcpServers().map((s) => s.id)).toContain('ghost');

    await h.userDO.userMcp_list(await testOwner());

    expect(recordedMcpServers().map((s) => s.id)).not.toContain('ghost');
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
    await h.userDO.userMcp_warmConnections(await testOwner());
    expect(recordedMcpServers()).toEqual([]);
    h.close();
  });

  test('an activation dials nothing through the SDK’s own start path', async () => {
    // The SDK calls `restoreConnectionsFromStorage` at every activation, before any credential closure is
    // registered; the start-path call is retired so waking a UserDO opens no anonymous connections.
    const h = harness();
    seedSdkMcpServer('srv1');
    const before = recordedMcpLifecycle().restored;

    await inheritedMcpManager(h.userDO).restoreConnectionsFromStorage('UserDO');

    expect(recordedMcpLifecycle().restored).toBe(before);
    expect(Object.keys(inheritedMcpManager(h.userDO).mcpConnections)).toEqual([]);

    // Restore still runs at hydration, after the credentialed transport is registered.
    await seedServer(h, 'srv1', { headers: { Authorization: 'Bearer mcp-secret' } });
    expect(recordedMcpLifecycle().restored).toBe(before + 1);
    expect(Object.keys(inheritedMcpManager(h.userDO).mcpConnections)).toEqual(['srv1']);
    h.close();
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
    // Shape of a stored plaintext row (`buildMcpHeaderTransportOpts`, `7ba56550e^:src/user/mcp.ts:270-287`).
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
    expect(liveMcpFetch('srv1')).toBeNull();
    expect(sqlExec(first.db).exec(
      'SELECT headers FROM user_mcp_servers WHERE id = ?', 'srv1',
    ).toArray()[0]?.headers).toBeNull();
    woken.close();
    first.close();
  });

  test('a row that never held a credential keeps the SDK session state it had', async () => {
    // Keyed on credential fields, not "the SDK persisted something": rewriting for `sessionId` would drop a
    // resumable session on every activation.
    const h = harness();
    await seedServer(h, 'plain');
    seedSdkMcpServer('plain', { type: 'auto', sessionId: 'sess-1', protocolVersion: '2026-07-28' });
    const untouched = persistedServerOptions('plain');

    await h.userDO.userMcp_warmConnections(await testOwner());

    expect(persistedServerOptions('plain')).toBe(untouched);
    expect(recordedMcpLifecycle().established).toEqual([]);
    h.close();
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


  test('a failed credential-seam teardown cannot claim hydration installed it', async () => {
    const h = harness();
    const owner = await testOwner();
    await seedServer(h, 'srv1', { headers: { Authorization: 'Bearer first' } });
    dropLiveMcpFetch('srv1');
    failNextMcpRemove(new Error('close refused'));
    // Best-effort hydration must stop at the failed teardown rather than register over the stale wire.
    await h.userDO.userMcp_update(owner, 'srv1', { headers: { Authorization: 'Bearer rotated' } });
    expect(liveMcpFetch('srv1')).toBeNull();

    await h.userDO.userMcp_warmConnections(owner);
    expect(liveMcpFetch('srv1')).not.toBeNull();
    h.close();
  });

  test('concurrent warm callers join one credential-plane reconciliation', async () => {
    const h = harness();
    const owner = await testOwner();
    await seedServer(h, 'srv1', { headers: { Authorization: 'Bearer first' } });
    dropLiveMcpFetch('srv1');
    const before = recordedMcpLifecycle().established.length;
    const gate = hangMcpEstablish();

    const first = h.userDO.userMcp_warmConnections(owner);
    const second = h.userDO.userMcp_warmConnections(owner);
    await gate.entered;
    expect(recordedMcpLifecycle().established).toHaveLength(before + 1);

    gate.release();
    await Promise.all([first, second]);
    expect(recordedMcpLifecycle().established).toHaveLength(before + 1);
    expect(liveMcpFetch('srv1')).not.toBeNull();
    h.close();
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

describe('an authorization failure converges to the reconnect state', () => {
  test('a transport 401 on dispatch re-probes the connection, and the failure still travels', async () => {
    const h = harness();
    await seedServer(h, 'srv1');
    seedMcpTools('srv1', [{ name: 'do_thing', inputSchema: { type: 'object' } }]);
    // The `authUrl` the SDK reads back while AUTHENTICATING (`client-zqKcsyFa.js:1704-1706`).
    seedMcpAuthContinuation('srv1', 'https://auth.example/authorize?srv1');
    // What the pinned SDK throws on an unresolvable POST 401 (`streamableHttp.js:364`); the status is a number.
    failNextMcpToolCall(new StreamableHTTPError(401, 'Error POSTing to endpoint: nope'));
    // In production the dispatch and the `discoverIfConnected` probe are two failing requests.
    failNextMcpDiscovery(new StreamableHTTPError(401, 'Error POSTing to endpoint: nope'));

    await expect(h.userDO.userMcp_callTool(await testOwner(), 'srv1', 'do_thing', {}))
      .rejects.toThrow(/Streamable HTTP error/);

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
    failNextMcpToolCall(new UnauthorizedError());
    failNextMcpDiscovery(new StreamableHTTPError(401, 'Error POSTing to endpoint: nope'));

    await expect(h.userDO.userMcp_callTool(await testOwner(), 'srv1', 'do_thing', {}))
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
    failNextMcpToolCall(new Error('MCP request failed', {
      cause: new StreamableHTTPError(401, 'Server returned 401 after successful authentication'),
    }));
    failNextMcpDiscovery(new StreamableHTTPError(401, 'Server returned 401 after successful authentication'));

    await expect(h.userDO.userMcp_callTool(await testOwner(), 'srv1', 'do_thing', {}))
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
    failNextMcpToolCall(new StreamableHTTPError(401, 'Error POSTing to endpoint: nope'));
    failNextMcpDiscovery(new StreamableHTTPError(401, 'Error POSTing to endpoint: nope'));

    await expect(h.userDO.userMcp_callTool(await testOwner(), 'srv1', 'do_thing', {}))
      .rejects.toThrow(/Streamable HTTP error/);

    const surface = await readSurface(h, await testOwner());
    expect(surface.descriptors).toEqual([]);
    expect(surface.unavailable).toHaveLength(1);
    expect(surface.unavailable[0]?.server).toBe('srv1');
    h.close();
  });

  test("a tool's own error is not treated as an auth failure", async () => {
    const h = harness();
    await seedServer(h, 'srv1');
    seedMcpTools('srv1', [{ name: 'do_thing', inputSchema: { type: 'object' } }]);
    failNextMcpToolCall(new Error('the repository does not exist'));

    await expect(h.userDO.userMcp_callTool(await testOwner(), 'srv1', 'do_thing', {}))
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

    await expect(h.userDO.userMcp_callTool(await testOwner(), 'srv1', 'do_thing', {}))
      .rejects.toThrow(/401/);

    expect(recordedMcpLifecycle().discovered).not.toContain('srv1');
    h.close();
  });

  test('a plain error carrying a 401-shaped code is not a transport 401', async () => {
    const h = harness();
    await seedServer(h, 'srv1');
    seedMcpTools('srv1', [{ name: 'do_thing', inputSchema: { type: 'object' } }]);
    failNextMcpToolCall(Object.assign(new Error('upstream said no'), { code: 401 }));

    await expect(h.userDO.userMcp_callTool(await testOwner(), 'srv1', 'do_thing', {}))
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
