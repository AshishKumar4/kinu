// Behavior tests for the per-user MCP lifecycle inside a real UserDO.
//
// Contracts under test:
//   - the config table is the ONE identity: a name is unique atomically, in the
//     database, not by a SELECT that an await can be interleaved through
//   - the management surface completes a round trip: create, list, rename,
//     remove, with no row reporting a repair
//   - the SDK's server rows are DERIVED: an orphan is removed, never left as a
//     second writable truth
//   - a stored credential never reaches the SDK as data, on any path, including
//     the one an activation takes after hibernation
//   - a rotated credential is spent without a reconnect
//   - a dispatch the TRANSPORT could not authorize converges to the reconnect
//     state the UI already renders; a tool's own prose about a 401 does not
import { describe, expect, test } from 'bun:test';
import {
  createTestUserDO, sqlExec, testOwner,
  type TestUserDO, type TestUserDOOptions,
} from './helpers/user-do';
import {
  dropLiveMcpFetch, failNextMcpRemove, failNextMcpToolCall, hangMcpEstablish, inheritedMcpManager,
  liveMcpFetch, liveMcpTransport, recordedMcpFetch, recordedMcpLifecycle, recordedMcpServers,
  resetRecordedMcp, seedMcpTools, seedSdkMcpServer, type RecordedMcpTransport,
} from './helpers/agents-sdk';
import {
  McpToolSurfaceSchema, storedMcpOptionsCarryCredential, validateMcpServerInput,
} from '../src/user/mcp';
import type { McpToolSurface } from '../src/user/user-do';
import type { UserCaller } from '../src/user/workspace-capability';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as v from 'valibot';

/**
 * The descriptor surface, PARSED by the schema that defines it.
 *
 * `userMcp_toolDescriptors` answers with JSON on the wire, and
 * `McpToolSurfaceSchema` is the contract the orchestrator's cache validates it
 * against. Asserting a shape here instead would pin this test's guess at the
 * surface rather than the surface, and would keep passing after the real one
 * changed underneath it.
 */
async function readSurface(h: TestUserDO, owner: UserCaller): Promise<McpToolSurface> {
  return v.parse(McpToolSurfaceSchema, JSON.parse(await h.userDO.userMcp_toolDescriptors(owner)));
}

/**
 * What the SDK's own `cf_agents_mcp_servers.server_options` column HOLDS for a
 * server — the bytes, not a reconstruction of them.
 *
 * This is the state a credential-custody question has to be asked of:
 * `restoreConnectionsFromStorage` rebuilds a live transport out of exactly
 * these bytes (`agents/dist/client-zqKcsyFa.js:1557-1571`), so a credential
 * that is absent from our own column and present here is still spent on every
 * reconnect. The stand-in persists them the way `encodeMcpServerOptions` does,
 * whitelist and all.
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

/** A configured server, written the way `userMcp_add` writes one. Going through
 *  `userMcp_add` itself needs a live third-party endpoint: it connects and rolls
 *  the row back when it cannot. */
async function seedServer(
  h: TestUserDO,
  id: string,
  fields: { name?: string; url?: string; headers?: Record<string, string> } = {},
): Promise<void> {
  // Any gated call brings the real schema up before a row is written.
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
  // A read over a non-empty table is what hydrates the manager, and every test
  // below asks a question about hydrated state.
  await h.userDO.userMcp_list(await testOwner());
}

function storedName(h: TestUserDO, id: string): string | undefined {
  const row = sqlExec(h.db).exec('SELECT name FROM user_mcp_servers WHERE id = ?', id).toArray()[0];
  const parsed = v.safeParse(v.string(), row?.name);
  return parsed.success ? parsed.output : undefined;
}

describe('a server name is one identity, enforced by the database', () => {
  test('a second row under the same name, in any case, is refused', async () => {
    const h = harness();
    await seedServer(h, 'srv1', { name: 'GitHub' });
    // The UNIQUE index is on `lower(name)`, which is the rule the old
    // SELECT-then-INSERT used — and the rule an await could be interleaved
    // through. Now the write itself refuses.
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
    // The rename path used to carry its own copy of the bounds under its own
    // sentence, so the two write paths onto one UNIQUE index could disagree
    // about what a name is.
    const h = harness();
    await seedServer(h, 'srv1', { name: 'github' });
    const owner = await testOwner();
    const addRefusal = (name: string): string => {
      try { validateMcpServerInput({ name, serverUrl: 'https://mcp.example/sse' }); return ''; }
      catch (err) { return err instanceof Error ? err.message : String(err); }
    };

    await expect(h.userDO.userMcp_update(owner, 'srv1', { name: '   ' }))
      .rejects.toThrow(addRefusal('   '));
    await expect(h.userDO.userMcp_update(owner, 'srv1', { name: 'x'.repeat(65) }))
      .rejects.toThrow(addRefusal('x'.repeat(65)));
    expect(storedName(h, 'srv1')).toBe('github');

    // And the accepted form is the stored form on both paths: trimmed.
    await h.userDO.userMcp_update(owner, 'srv1', { name: '  spaced  ' });
    expect(storedName(h, 'srv1')).toBe('spaced');
    expect(validateMcpServerInput({ name: '  spaced  ', serverUrl: 'https://mcp.example/sse' }).name)
      .toBe('spaced');
    h.close();
  });

  test('two servers may share one endpoint under different names', async () => {
    // Two credentials for one endpoint is a real configuration: identity is the
    // name, so uniqueness must not be pinned to the URL.
    const h = harness();
    await seedServer(h, 'srv1', { name: 'work', url: 'https://mcp.example/sse' });
    await seedServer(h, 'srv2', { name: 'personal', url: 'https://mcp.example/sse' });
    expect(storedName(h, 'srv2')).toBe('personal');
    h.close();
  });

  test('two renames racing for one free name: exactly one lands', async () => {
    // The claim reads `lower(name)` and writes inside ONE storage transaction,
    // so the loser sees the winner rather than a stale read. The UNIQUE index
    // refuses the second write too — but as a constraint violation, not as the
    // sentence naming the taken name that the owner is meant to read.
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
    // Nothing to repair: the `error` channel carries connection errors only.
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

    // It hydrated nothing: `hydrateUserMcp` awaits `establishConnection`, which
    // awaits `_connectWithRetry` with no bound, so the deleted
    // `waitForConnections({ timeout: 5_000 })` could never bound what it claimed.
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
    // A third party that accepts the socket and never finishes. The warmup owner
    // is left hanging on it, unawaited, exactly as a slow connect leaves it.
    const gate = hangMcpEstablish();
    const warming = h.userDO.userMcp_warmConnections(owner);

    // THE GATE MUST ACTUALLY BE ENGAGED, or this test cannot tell "the read does
    // not wait" from "there was nothing to wait for" — and it would stay green
    // if the gate ever stopped reaching `establishConnection`, measuring its own
    // fixture instead of the read. Awaiting the gate's own arrival signal, not a
    // delay: establishment is STARTED and suspended inside it from here on.
    await gate.entered;
    expect(recordedMcpLifecycle().established).toContain('srv2');

    const surface = await readSurface(h, owner);

    // The turn got what was already connected and a report for what was not,
    // while a connection was in flight the whole time.
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

    // The warmup owner establishes, off the turn.
    await h.userDO.userMcp_warmConnections(owner);
    seedMcpTools('srv1', [{ name: 'warm_tool', inputSchema: { type: 'object' } }]);

    const second = await readSurface(h, owner);
    expect(second.descriptors.map((d) => d.toolKey)).toEqual(['mcp_later_warm_tool']);
    expect(second.unavailable).toEqual([]);
    h.close();
  });

  test('a deferred server contributes no descriptor, so it cannot reach the prompt', async () => {
    // The two channels are disjoint, and that is what keeps the turn's cached
    // system prompt independent of connection timing: the prompt is fed the
    // admitted tool NAMES, and a server that was not connected when the turn
    // opened produces none of them. Its absence travels on `unavailable`, which
    // the actor renders into the per-step dynamic ledger rather than the
    // byte-stable prefix.
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
    // A count-first short-circuit made this the one case nothing looked at: the
    // user has no configured server, and an SDK row is still reconnecting to a
    // third party with their credential.
    const h = harness();
    await h.userDO.userMcp_list(await testOwner());
    seedSdkMcpServer('ghost');
    await h.userDO.userMcp_warmConnections(await testOwner());
    expect(recordedMcpServers()).toEqual([]);
    h.close();
  });

  test('an activation dials nothing through the SDK’s own manager', async () => {
    // The defect: `Agent`'s base constructor builds a SECOND MCPClientManager
    // over the same `cf_agents_mcp_servers` rows, and the SDK init chain calls
    // `restoreConnectionsFromStorage` on it unconditionally on every
    // activation. That manager holds none of this plane's credential closures,
    // so a UserDO waking up opened an anonymous connection to every MCP
    // endpoint the user had configured — whether or not anyone touched MCP.
    const h = harness();
    await seedServer(h, 'srv1', { headers: { Authorization: 'Bearer mcp-secret' } });
    const before = recordedMcpLifecycle().restored;

    await inheritedMcpManager(h.userDO).restoreConnectionsFromStorage('test-user-do');

    expect(recordedMcpLifecycle().restored).toBe(before);
    expect(Object.keys(inheritedMcpManager(h.userDO).mcpConnections)).toEqual([]);
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
    // The SDK's own storage as the previous implementation left it: the
    // credential as data, replayed from there on every reconnect.
    seedSdkMcpServer('srv1', { type: 'auto', requestInit: { headers: { Authorization: 'Bearer mcp-secret' } } });
    expect(persistedServerOptions('srv1')).toContain('mcp-secret');

    // An eviction and the next request: a new Durable Object over the same
    // storage. Not `harness()` — that would clear the SDK rows under test.
    const woken = createTestUserDO({ storage: first.db });
    await woken.userDO.userMcp_list(await testOwner());

    expect(persistedServerOptions('srv1')).toBe(JSON.stringify({ transport: { type: 'auto' } }));
    // And the LIVE connection is the one carrying the seam, not one the restore
    // built from the stale plaintext row — the cold-start ordering invariant.
    expect(liveMcpFetch('srv1')).not.toBeNull();
    expect(liveMcpTransport('srv1')?.requestInit).toBeUndefined();
    woken.close();
    first.close();
  });

  test('a row whose credential column is NULL is scrubbed too, not replayed', async () => {
    // The custody hole this closes: the scrub used to be a side effect of
    // registering a CREDENTIALED row, so it was keyed on a column that can be
    // null. Clear the credential — or let the old build's best-effort
    // re-register fail — and the column goes NULL while the SDK's own row keeps
    // the plaintext, which every reconnect then spends. Once NULL, nothing
    // reached the row again.
    const first = harness();
    await seedServer(first, 'srv1');
    // Exactly the shape a plaintext-era build left: `buildMcpHeaderTransportOpts`
    // returned `requestInit: { headers }` beside an `eventSourceInit` wrapper
    // (`7ba56550e^:src/user/mcp.ts:270-287`), and the closure half of that
    // wrapper does not survive JSON.
    seedSdkMcpServer('srv1', {
      type: 'auto',
      eventSourceInit: {},
      requestInit: { headers: { Authorization: 'Bearer stale' } },
    });
    expect(persistedServerOptions('srv1')).toContain('stale');

    const woken = createTestUserDO({ storage: first.db });
    const listed = await woken.userDO.userMcp_list(await testOwner());

    // The plaintext is gone from the SDK's OWN state, which is the only place
    // it ever was — asserting it is absent from our column would prove nothing.
    expect(persistedServerOptions('srv1')).toBe(JSON.stringify({ transport: { type: 'auto' } }));
    expect(liveMcpTransport('srv1')?.requestInit).toBeUndefined();
    expect(liveMcpTransport('srv1')?.eventSourceInit).toBeUndefined();
    // A row with no credential gets no seam: there is nothing to open per
    // request, so the transport is bare rather than a closure over a NULL read.
    expect(liveMcpFetch('srv1')).toBeNull();
    // And the server still works: the rewrite re-establishes what it tore down,
    // because `restoreConnectionsFromStorage` skips a connection this pass
    // registered (`client-zqKcsyFa.js:1541-1549`).
    expect(recordedMcpLifecycle().established).toContain('srv1');
    expect(listed[0]?.status).toBe('ready');
    woken.close();
    first.close();
  });

  test('a scrubbed row that DOES hold a credential still serves from the sealed copy', async () => {
    // The neighbour case, and the one that says the scrub is not a deletion of
    // the capability: the config row holds a credential, the SDK's row holds a
    // plaintext copy of it, and after the rewrite the request must still be
    // authorized — from the sealed column, opened per request.
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
      const send = liveMcpFetch('srv1');
      expect(send).not.toBeNull();
      await send?.('https://srv1.example/sse');
    } finally { globalThis.fetch = real; }
    expect(seen).toEqual(['Bearer sealed']);
    woken.close();
    first.close();
  });

  test('a headers-clearing patch as an activation’s FIRST MCP call leaves no plaintext', async () => {
    // Hydration runs after the NULL write, so a scrub that depended on the
    // column could not see the row it was meant to clean. Nothing has hydrated
    // yet on this activation either, so the scrub cannot ride along on
    // somebody else's registration.
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
    // The credential really was removed on our side, so nothing can re-derive
    // it: this is the state the owner asked for.
    expect(sqlExec(first.db).exec(
      'SELECT headers FROM user_mcp_servers WHERE id = ?', 'srv1',
    ).toArray()[0]?.headers).toBeNull();
    woken.close();
    first.close();
  });

  test('a row that never held a credential keeps the SDK session state it had', async () => {
    // The scrub is keyed on the fields a credential can arrive in, NOT on "the
    // SDK persisted something". Rewriting for `sessionId` would drop a
    // resumable session on every activation and re-register forever.
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

    // Same closure, no re-register, no reconnect: the seam reads the sealed
    // column per request, so there is nothing to reinstall.
    expect(recordedMcpServers().find((server) => server.id === 'srv1')?.transport.fetch).toBe(resolve);
    expect(recordedMcpLifecycle().established.length).toBe(established);

    const seen: string[] = [];
    const real = globalThis.fetch;
    // `typeof globalThis.fetch` carries `preconnect` beside the call signature.
    // The stub is COMPLETED with the real one's rather than asserted into shape,
    // and the two parameters take their platform types by inference.
    const record = async (
      _url: Request | URL | RequestInfo,
      init?: RequestInit,
    ): Promise<Response> => {
      seen.push(new Headers(init?.headers).get('authorization') ?? 'none');
      return new Response('{}');
    };
    globalThis.fetch = Object.assign(record, { preconnect: real.preconnect });
    try {
      // Spent through the helper's validated accessor, so the signature is
      // established rather than asserted here.
      const send = recordedMcpFetch('srv1');
      expect(send).not.toBeNull();
      await send?.('https://srv1.example/sse');
    } finally { globalThis.fetch = real; }
    expect(seen).toEqual(['Bearer rotated']);
    h.close();
  });


  test('a failed credential-seam teardown cannot claim hydration installed it', async () => {
    const h = harness();
    const owner = await testOwner();
    await seedServer(h, 'srv1', { headers: { Authorization: 'Bearer first' } });
    dropLiveMcpFetch('srv1');
    failNextMcpRemove(new Error('close refused'));
    // Header rotation tries to install the credential closure. The update itself
    // persists the sealed header, but its best-effort hydration must stop at the
    // failed teardown instead of registering over the stale wire and claiming
    // the closure is live.
    await h.userDO.userMcp_update(owner, 'srv1', { headers: { Authorization: 'Bearer rotated' } });
    expect(liveMcpFetch('srv1')).toBeNull();

    // The next owner-owned hydration retries the complete sequence and only then
    // exposes the closure.
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
    // Nothing to install a seam for, so nothing was registered by us.
    expect(recordedMcpLifecycle().established).toEqual([]);
    h.close();
  });
});

describe('what counts as a credential in the SDK’s stored options', () => {
  test('the three data fields count, and the SDK’s own connection state does not', () => {
    // The same vocabulary the seeds use, so a field named here is a field the
    // SDK's column can really hold.
    const stored = (transport: RecordedMcpTransport): string => JSON.stringify({ transport });

    // The two a plaintext-era build produced, plus the third the persistence
    // whitelist keeps.
    expect(storedMcpOptionsCarryCredential(
      stored({ type: 'auto', requestInit: { headers: { Authorization: 'Bearer x' } } }),
    )).toBe(true);
    expect(storedMcpOptionsCarryCredential(
      stored({ type: 'auto', eventSourceInit: {} }),
    )).toBe(true);
    expect(storedMcpOptionsCarryCredential(
      stored({ type: 'auto', headers: { Authorization: 'Bearer x' } }),
    )).toBe(true);

    // Session resumption and retry policy are the SDK's own state. Reading them
    // as a reason to rewrite would drop a resumable session on every activation
    // and re-register forever.
    expect(storedMcpOptionsCarryCredential(
      stored({ type: 'auto', sessionId: 'sess-1', protocolVersion: '2026-07-28' }),
    )).toBe(false);
    expect(storedMcpOptionsCarryCredential(stored({ type: 'auto' }))).toBe(false);

    // Nothing a credential could be restored from.
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
    // What the pinned SDK actually throws when a POST comes back 401 and the
    // transport cannot resolve it (`streamableHttp.js:364`). The status is a
    // NUMBER on the error, which is what the convergence reads.
    failNextMcpToolCall(new StreamableHTTPError(401, 'Error POSTing to endpoint: nope'));

    await expect(h.userDO.userMcp_callTool(await testOwner(), 'srv1', 'do_thing', {}))
      .rejects.toThrow(/Streamable HTTP error/);

    // `discoverIfConnected` is the SDK's own reauthorization path: an
    // unauthorized probe moves the connection to AUTHENTICATING and persists the
    // authorize URL, which is what the UI renders as "Open authorize".
    expect(recordedMcpLifecycle().discovered).toContain('srv1');
    h.close();
  });

  test('an UnauthorizedError from the auth path converges too', async () => {
    const h = harness();
    await seedServer(h, 'srv1');
    seedMcpTools('srv1', [{ name: 'do_thing', inputSchema: { type: 'object' } }]);
    failNextMcpToolCall(new UnauthorizedError());

    await expect(h.userDO.userMcp_callTool(await testOwner(), 'srv1', 'do_thing', {}))
      .rejects.toThrow();

    expect(recordedMcpLifecycle().discovered).toContain('srv1');
    h.close();
  });

  test('a typed 401 wrapped by another error still converges', async () => {
    const h = harness();
    await seedServer(h, 'srv1');
    seedMcpTools('srv1', [{ name: 'do_thing', inputSchema: { type: 'object' } }]);
    failNextMcpToolCall(new Error('MCP request failed', {
      cause: new StreamableHTTPError(401, 'Server returned 401 after successful authentication'),
    }));

    await expect(h.userDO.userMcp_callTool(await testOwner(), 'srv1', 'do_thing', {}))
      .rejects.toThrow();

    expect(recordedMcpLifecycle().discovered).toContain('srv1');
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
    // The regression this replaces. A remote tool that proxies some other API
    // hands back that API's 401 as its own error text; the old matcher read the
    // rendered cause chain, found `unauthorized`, and tore down a connection
    // that was authorized perfectly well. The words belong to a third party.
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
    expect('description' in surface.descriptors[0]!).toBe(false);
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
