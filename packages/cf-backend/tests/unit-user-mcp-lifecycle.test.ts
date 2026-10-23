// Per-user MCP lifecycle in a real UserDO: atomic name uniqueness, derived SDK rows,
// credentials never reach the SDK as data, and only a transport 401 forces reconnect.
import { describe, expect, test } from 'bun:test';
import {
  createTestUserDO, provisionTestWorkspace, sqlExec, testOwner, TEST_CREDENTIAL_ENCRYPTION_KEY,
  type TestUserDO, type TestUserDOOptions,
} from './helpers/user-do';
import {
  closeMcpTransport, seedMcpAnswer, failNextMcpToolCall, failNextMcpDiscovery, hangMcpEstablish, hangNextMcpConnect, holdNextMcpToolCall, inheritedMcpManager,
  liveMcpFetch, liveMcpTransport, recordedMcpFetch, recordedMcpLifecycle, recordedMcpServers, recordedMcpToolAborts,
  recordedMcpToolCalls, requireMcpSignIn, resetRecordedMcp, seedMcpSession, seedMcpTools, seedMcpAuthContinuation, seedConfiguredMcpServer, seedSdkMcpServer, seedUndiscoveredMcpTools,
} from './helpers/agents-sdk';
import { classifyMcpFailure } from '../src/user/mcp';
import { createCredentialCipher, McpToolSurfaceSchema } from '@kinu.run/core';
import { KinuError, setDiagnosticsSink, type LogFields } from '@kinu.run/core/obs';
import { ProtocolError, SdkError, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client';
import type { McpToolSurface } from '../src/user/mcp-servers';
import type { UserCaller } from '@kinu.run/core';
import { refusedSseConnect, refusedToolCall } from './helpers/mcp-transport';
import { nextTurn } from './helpers/actor-harness';
import * as v from 'valibot';

/** The descriptor surface, held to `McpToolSurfaceSchema`, the contract the orchestrator's cache reads. */
async function readSurface(h: TestUserDO, owner: UserCaller): Promise<McpToolSurface> {
  return v.parse(McpToolSurfaceSchema, await h.userDO.userMcp_toolDescriptors(owner));
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

/** A configured server, written as `userMcp_add` would; the real call needs a live endpoint. A credentialed row is
 *  registered by the next object's activation, as after a deploy, so a test of its transport wakes one. */
async function seedServer(
  h: TestUserDO,
  id: string,
  fields: { name?: string; url?: string; headers?: Record<string, string> } = {},
): Promise<void> {
  await h.userDO.userMcp_list(await testOwner());
  const cipher = await createCredentialCipher({ CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });
  // Sealed as the add seals them, for this object and this server.
  const headers = fields.headers === undefined ? null : await cipher.seal(`test-user-do:mcp:${id}`, JSON.stringify(fields.headers));
  seedConfiguredMcpServer(sqlExec(h.db), id, { name: fields.name ?? id, url: fields.url ?? `https://${id}.example/sse`, transport: 'auto', headers });

  // A read over a non-empty table hydrates the manager.
  await h.userDO.userMcp_list(await testOwner());
}

function storedName(id: string): string | undefined {
  return recordedMcpServers().find((server) => server.id === id)?.name;
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

describe('a server name is one identity, claimed one add at a time', () => {
  test('a second server under the same name, in any case, is refused and adds no row', async () => {
    const h = harness();
    await seedServer(h, 'srv1', { name: 'GitHub' });
    // Refused at the name claim, before the add dials anything.
    await expect(h.userDO.userMcp_add(await testOwner(), { name: 'github', serverUrl: 'https://other.example/sse' }, 'https://kinu.example'))
      .rejects.toThrow('github');
    expect(sqlExec(h.db).exec('SELECT id FROM user_mcp_servers').toArray()).toEqual([{ id: 'srv1' }]);
    h.close();
  });

  test('a blank name is refused, and nothing is stored', async () => {
    const h = harness();
    await seedServer(h, 'srv1', { name: 'github' });
    const owner = await testOwner();

    await expect(h.userDO.userMcp_add(owner, { name: '   ', serverUrl: 'https://mcp.example/sse' }, 'https://kinu.example')).rejects.toThrow();
    expect(sqlExec(h.db).exec('SELECT id FROM user_mcp_servers').toArray()).toEqual([{ id: 'srv1' }]);
    h.close();
  });

  test('two adds of one name at once: one stands, the other is refused, whichever claims second', async () => {
    const h = harness();
    const owner = await testOwner();
    await h.userDO.userMcp_list(owner);

    const adds = await Promise.allSettled([
      h.userDO.userMcp_add(owner, { name: 'github', serverUrl: 'https://a.example/sse' }, 'https://kinu.example'),
      h.userDO.userMcp_add(owner, { name: 'GitHub', serverUrl: 'https://b.example/sse' }, 'https://kinu.example'),
    ]);

    expect(adds.map((add) => add.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(recordedMcpServers().filter((server) => server.name.toLowerCase() === 'github')).toHaveLength(1);
    expect(sqlExec(h.db).exec('SELECT id FROM user_mcp_servers').toArray()).toHaveLength(1);
    h.close();
  });

  test('two servers may share one endpoint under different names', async () => {
    // Identity is the name; uniqueness must not be pinned to the URL.
    const h = harness();
    await seedServer(h, 'srv1', { name: 'work', url: 'https://mcp.example/sse' });
    await seedServer(h, 'srv2', { name: 'personal', url: 'https://mcp.example/sse' });
    expect(storedName('srv2')).toBe('personal');
    h.close();
  });
});

describe('the management surface completes a round trip', () => {
  test('create, list and remove', async () => {
    const h = harness();
    const owner = await testOwner();
    await seedServer(h, 'srv1', { name: 'github' });
    await seedServer(h, 'srv2', { name: 'linear' });

    const listed = await h.userDO.userMcp_list(owner);
    expect(listed.map((s) => s.id)).toEqual(['srv1', 'srv2']);
    expect(listed.every((s) => s.error === null)).toBe(true);

    await h.userDO.userMcp_remove(owner, 'srv2');
    expect((await h.userDO.userMcp_list(owner)).map((s) => s.id)).toEqual(['srv1']);
    expect(storedName('srv2')).toBeUndefined();
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
    expect(surface.unavailable.map((u) => u.server)).toEqual(['broken', 'github', 'github']);
    expect(surface.unavailable[0]?.reason).toContain('server went away');
    expect(surface.unavailable[1]?.reason).toContain('any_input');
    expect(surface.unavailable[2]?.reason).toContain('scalar_root');
    expect(listed.map((server) => [server.name, server.toolsCount, server.error?.includes('scalar_root') ?? false]))
      .toEqual([['broken', 0, false], ['github', 1, true]]);

    // The offered tool runs, shaped by the schema the lenient read found: the untouched optional '' is dropped.
    await h.userDO.userMcp_callTool(owner, { serverId: 'srv1', name: 'do_thing', args: { q: '', note: '' }, id: crypto.randomUUID() });
    expect(recordedMcpToolCalls()).toEqual([{ serverId: 'srv1', name: 'do_thing', arguments: { q: '' } }]);
    h.close();
  });
});

// The owner, onboarding on kinu.run 90fd4539f, 2026-10-23: Gmail read "Connected · 0 tools" beside its tool list's
// failure, which quoted Google's whole tool list. Google answered `tools/list` 403 for the token, with no reason, and that
// list as the body; its handshake had answered 200.
describe('a server that refuses its tool list', () => {
  /** The SDK's error for that answer (`@modelcontextprotocol/client` 2.3.1, `_send`). */
  const refusedList = () => new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented,
    'Error POSTing to endpoint: {"id":0,"jsonrpc":"2.0","result":{"cacheScope":"public","resultType":"complete","tools":[]}}', { status: 403, statusText: '' });

  test('reads failed, not connected, and names the status and what its own tools/list was told, not the body', async () => {
    const first = harness();
    const owner = await testOwner();
    await seedServer(first, 'gm1', { name: 'Gmail' });
    await seedServer(first, 'gm2', { name: 'Calendar' });

    // The next object's activation runs each server on the transport the plane builds.
    const h = createTestUserDO({ storage: first.db });
    await h.userDO.userMcp_list(owner);
    const [gmail, calendar] = [liveMcpFetch('gm1'), liveMcpFetch('gm2')];

    if (gmail === null || calendar === null) throw new Error('a server runs on no transport of the plane\'s');
    const rpc = (method: string) => ({ method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 0, method }) });

    // Each listing goes out on its server's transport and is refused 403: Gmail's with no reason; Calendar's says why,
    // while a tool call beside it is refused with another challenge, which is not the listing's.
    seedUndiscoveredMcpTools('gm1', async () => {
      await gmail('https://gm1.example/sse', rpc('tools/list'));
      throw refusedList();
    });
    seedUndiscoveredMcpTools('gm2', async () => {
      await calendar('https://gm2.example/sse', rpc('tools/list'));
      await calendar('https://gm2.example/sse', rpc('tools/call'));
      throw refusedList();
    });

    const real = globalThis.fetch;

    globalThis.fetch = Object.assign(async (url: Request | URL | RequestInfo, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      const challenge = body.includes('tools/call') ? 'Bearer error="invalid_token"' : 'Bearer error="insufficient_scope", scope="calendar.readonly"';

      const at = url instanceof Request ? url.url : url.toString();

      return new Response('{}', { status: 403, headers: at.includes('gm2') ? { 'www-authenticate': challenge } : {} });
    }, { preconnect: real.preconnect });

    // More refusals than a server keeps, all of tool calls, before any listing: the listing still finds its own.
    let rows: Awaited<ReturnType<typeof h.userDO.userMcp_list>>;

    try {
      for (let call = 0; call < 20; call += 1) await calendar('https://gm2.example/sse', rpc('tools/call'));
      await h.userDO.userMcp_warmConnections(owner);
      rows = await h.userDO.userMcp_list(owner);
    } finally {
      globalThis.fetch = real;
    }

    expect(rows.map((server) => ({ name: server.name, status: server.status, tools: server.toolsCount, error: server.error, signIn: server.signIn }))).toEqual([
      { name: 'Calendar', status: 'failed', tools: 0, error: 'Calendar refused its tool list: HTTP 403, saying Bearer error="insufficient_scope", scope="calendar.readonly"', signIn: false },
      { name: 'Gmail', status: 'failed', tools: 0, error: 'Gmail refused its tool list: HTTP 403, with no reason given', signIn: false },
    ]);
    h.close();
    first.close();
  });
});

describe('the descriptor read is off the connection critical path', () => {
  test('it starts no connection work of its own', async () => {
    const h = harness();
    const owner = await testOwner();
    await h.userDO.userMcp_list(owner);
    seedConfiguredMcpServer(sqlExec(h.db), 'srv1', { name: 'slow', url: 'https://srv1.example/sse', transport: 'auto' });
    const before = recordedMcpLifecycle();
    const establishedBefore = before.established.length;
    const restoredBefore = before.restored;

    const surface = await readSurface(h, owner);

    // A dial's `_connectWithRetry` has no bound, so the read starts none: it waits only for those a wake started.
    const after = recordedMcpLifecycle();
    expect(after.established.length).toBe(establishedBefore);
    expect(after.restored).toBe(restoredBefore);
    expect(surface.descriptors).toEqual([]);
    expect(surface.unavailable[0]?.server).toBe('slow');
    h.close();
  });

  // The owner, production, 2026-10-23: the account's object woke 22 times in 20 minutes and dialled every server again
  // each time; a turn whose call woke it read its tools at once, and opened without GitHub.
  test('a read made while its object\'s wake is still dialling waits for that dial, and offers the server\'s tools', async () => {
    const first = harness();
    const owner = await testOwner();
    await seedServer(first, 'srv1', { name: 'fast' });
    seedConfiguredMcpServer(sqlExec(first.db), 'srv2', { name: 'waking', url: 'https://srv2.example/sse', transport: 'auto', headers: 'sealed' });
    const gate = hangMcpEstablish();
    // The activation registers the credentialed server and starts its dial, as a wake does.
    const h = createTestUserDO({ storage: first.db });
    const warming = h.userDO.userMcp_warmConnections(owner);

    // The gate must be engaged, or this cannot tell "the read waits" from "nothing to wait for".
    await gate.entered;
    expect(recordedMcpLifecycle().established).toContain('srv2');
    seedMcpTools('srv1', [{ name: 'ready_tool', inputSchema: { type: 'object' } }]);
    // The tools it will offer, on a connection still dialling (seeding marks it ready).
    seedMcpTools('srv2', [{ name: 'woken_tool', inputSchema: { type: 'object' } }]);
    liveConnection(h, 'srv2').connectionState = 'connecting';

    // Read before the dial ends, released well after a read that did not wait would have answered without it.
    const reading = readSurface(h, owner);

    await new Promise((resolve) => { setTimeout(resolve, 200); });
    gate.release();
    const surface = await reading;

    expect(surface.descriptors.map((d) => d.toolKey)).toEqual(['mcp_fast_ready_tool', 'mcp_waking_woken_tool']);
    expect(surface.unavailable).toEqual([]);
    await warming;
    h.close();
    first.close();
  });

  test('a later read sees what the warmup established', async () => {
    const h = harness();
    const owner = await testOwner();
    await h.userDO.userMcp_list(owner);
    seedConfiguredMcpServer(sqlExec(h.db), 'srv1', { name: 'later', url: 'https://srv1.example/sse', transport: 'auto' });

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

  // A dial that failed when the object woke left the server failed, and a failed server offers no descriptor, so no
  // turn or slate ever reached the call that redials it: its tools stayed gone until the object woke again.
  test('a warmup dials a failed server again, and the next read offers its tools', async () => {
    const h = harness();
    const owner = await testOwner();
    await seedServer(h, 'srv1', { name: 'flaky' });
    seedMcpTools('srv1', [{ name: 'go', inputSchema: { type: 'object' } }]);
    liveConnection(h, 'srv1').connectionState = 'failed';

    expect((await readSurface(h, owner)).unavailable.map((u) => u.server)).toEqual(['flaky']);
    await h.userDO.userMcp_warmConnections(owner);

    const surface = await readSurface(h, owner);
    expect(surface.descriptors.map((d) => d.toolKey)).toEqual(['mcp_flaky_go']);
    expect(surface.unavailable).toEqual([]);
    h.close();
  });

  test('a warmup dials a failed server once a wake, so a dead server costs one dial each time the object wakes', async () => {
    const h = harness();
    const owner = await testOwner();
    await seedServer(h, 'srv1', { name: 'dead' });
    seedMcpTools('srv1', [{ name: 'go', inputSchema: { type: 'object' } }]);
    liveConnection(h, 'srv1').connectionState = 'failed';

    await h.userDO.userMcp_warmConnections(owner);
    const dialled = recordedMcpLifecycle().discovered.filter((id) => id === 'srv1').length;
    liveConnection(h, 'srv1').connectionState = 'failed';
    await h.userDO.userMcp_warmConnections(owner);

    expect(dialled).toBe(1);
    expect(recordedMcpLifecycle().discovered.filter((id) => id === 'srv1')).toHaveLength(1);
    expect(liveConnection(h, 'srv1').connectionState).toBe('failed');
    h.close();
  });

  // The SDK restores a server awaiting sign-in as authenticating with a new provider, which holds no link, and the
  // settings page drew Authorize only from that link: the account's one way back was to remove the server and add it.
  // A sign-in is begun for its own address now; the row offers it.
  test('a server awaiting sign-in when the object wakes still offers its sign-in', async () => {
    const first = harness();
    const owner = await testOwner();
    await first.userDO.userMcp_list(owner);
    seedConfiguredMcpServer(sqlExec(first.db), 'srv1', { name: 'linear', url: 'https://mcp.linear.example/mcp', transport: 'streamable-http' });
    seedSdkMcpServer('srv1', { type: 'streamable-http' }, {
      name: 'linear', url: 'https://mcp.linear.example/mcp', callbackUrl: 'https://kinu.example/api/user/mcp/callback', authUrl: 'https://auth.example/authorize?state=before',
    });

    const woken = createTestUserDO({ storage: first.db });
    requireMcpSignIn('srv1', 'https://auth.example/authorize?state=fresh');
    const [listed] = await woken.userDO.userMcp_list(owner);

    expect(listed).toMatchObject({ status: 'authenticating', signIn: true });
    woken.close();
    first.close();
  });

  test('a deferred server contributes no descriptor, so it cannot reach the prompt', async () => {
    // Disjoint channels keep the cached system prompt independent of connection timing: absence
    // travels on `unavailable`, rendered into the dynamic ledger, not the byte-stable prefix.
    const h = harness();
    const owner = await testOwner();
    await seedServer(h, 'srv1', { name: 'ready' });
    seedMcpTools('srv1', [{ name: 'go', inputSchema: { type: 'object' } }]);
    seedConfiguredMcpServer(sqlExec(h.db), 'srv2', { name: 'pending', url: 'https://srv2.example/sse', transport: 'auto' });

    const surface = await readSurface(h, owner);

    const named = new Set(surface.descriptors.map((d) => d.serverName));
    const deferred = new Set(surface.unavailable.map((u) => u.server));
    expect([...named]).toEqual(['ready']);
    expect([...deferred]).toEqual(['pending']);

    for (const server of deferred) expect(named.has(server)).toBe(false);
    h.close();
  });
});

describe('a server is its config row and its catalog row, under one id', () => {
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

  test('a config row whose catalog row is gone has no endpoint to dial: it is removed at activation, and says so', async () => {
    const h = harness();
    await seedServer(h, 'srv1');
    // As an add that died between its catalog write and its config write never leaves, but a lost catalog row would.
    sqlExec(h.db).exec(`INSERT INTO user_mcp_servers (id) VALUES ('lost')`);

    // Built first: the harness installs its own sink as it is made.
    const woken = createTestUserDO({ storage: h.db });

    const lines = await diagnosticsDuring(async () => {
      expect((await woken.userDO.userMcp_list(await testOwner())).map((server) => server.id)).toEqual(['srv1']);
    });

    woken.close();

    expect(sqlExec(h.db).exec('SELECT id FROM user_mcp_servers').toArray()).toEqual([{ id: 'srv1' }]);
    expect(lines.filter((line) => line.name === 'mcp.uncatalogued_server_removed').map((line) => line.fields)).toEqual([{ serverId: 'lost' }]);
    h.close();
  });

  test('a configured row is not removed by that pass', async () => {
    const h = harness();
    await seedServer(h, 'srv1', { headers: { Authorization: 'Bearer keep' } });
    const woken = createTestUserDO({ storage: h.db });
    await woken.userDO.userMcp_list(await testOwner());
    expect(recordedMcpServers().map((s) => s.id)).toContain('srv1');
    woken.close();
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
    const woken = createTestUserDO({ storage: h.db });
    await woken.userDO.userMcp_list(await testOwner());

    const persisted = persistedServerOptions('srv1');
    expect(persisted).not.toContain('mcp-secret');
    expect(persisted).not.toContain('Authorization');
    expect(persisted).not.toContain('requestInit');
    expect(persisted).not.toContain('eventSourceInit');
    expect(persisted).toBe(JSON.stringify({ transport: { type: 'auto' } }));
    woken.close();
    h.close();
  });

  test('a cold activation serves a sealed credential through the seam, never as SDK data', async () => {
    const first = harness();
    await seedServer(first, 'srv1', { headers: { Authorization: 'Bearer sealed' } });

    // A new DO over the same storage; not `harness()`, which would clear the SDK rows under test.
    const woken = createTestUserDO({ storage: first.db });
    await woken.userDO.userMcp_list(await testOwner());

    expect(persistedServerOptions('srv1')).toBe(JSON.stringify({ transport: { type: 'auto' } }));
    // The live connection carries the seam: cold-start ordering invariant.
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

  test('a row that never held a credential resumes the session the SDK kept, on the transport the plane builds', async () => {
    // The plane builds every transport, for its fetch; one that dropped `sessionId` would open a new session on every
    // activation.
    const first = harness();
    await seedServer(first, 'plain');
    seedSdkMcpServer('plain', { type: 'auto', sessionId: 'sess-1', protocolVersion: '2026-07-28' });
    const untouched = persistedServerOptions('plain');

    const h = createTestUserDO({ storage: first.db });
    await h.userDO.userMcp_warmConnections(await testOwner());

    expect(persistedServerOptions('plain')).toBe(untouched);
    expect(liveMcpTransport('plain')).toMatchObject({ sessionId: 'sess-1', protocolVersion: '2026-07-28', fetch: expect.any(Function) });
    h.close();
    first.close();
  });

  test('stored headers that no longer open fail the request instead of sending it bare', async () => {
    const h = harness();
    await seedServer(h, 'srv1', { headers: { Authorization: 'Bearer sealed' } });
    const cipher = await createCredentialCipher({ CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });
    sqlExec(h.db).exec(
      'UPDATE user_mcp_servers SET headers = ? WHERE id = ?',
      await cipher.seal('test-user-do:mcp:other', JSON.stringify({ Authorization: 'Bearer other' })), 'srv1',
    );
    const woken = createTestUserDO({ storage: h.db });
    await woken.userDO.userMcp_list(await testOwner());

    const send = recordedMcpFetch('srv1');
    expect(send).not.toBeNull();

    const seen = await authorizationsSeenDuring(async () => {
      await expect(send?.('https://srv1.example/sse')).rejects.toMatchObject({ code: 'bad_input' });
    });

    expect(seen).toEqual([]);
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
});

describe('a caller stops the MCP call it made', () => {
  test('a cancel naming the call aborts its request, and the call settles with the cancel', async () => {
    const h = harness();
    await seedServer(h, 'srv1');
    seedMcpTools('srv1', [{ name: 'do_thing', inputSchema: { type: 'object' } }]);
    holdNextMcpToolCall();
    const owner = await testOwner();
    const call = h.userDO.userMcp_callTool(owner, { serverId: 'srv1', name: 'do_thing', args: {}, id: 'call-7' });

    await h.userDO.userMcp_cancelCall(owner, 'call-7');
    await expect(call).rejects.toMatchObject({ code: 'cancelled' });
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
    await expect(renewing).rejects.toMatchObject({ code: 'cancelled' });
    expect(recordedMcpToolAborts()).toEqual([]);

    await h.userDO.userMcp_cancelCall(owner, 'call-running');
    await expect(running).rejects.toMatchObject({ code: 'cancelled' });
    h.close();
  });

  // Staging 39a0b3fd5 (2026-10-21), `mcp-reconnect` 1 of 4: a warmup redialled the server whose ended session a call was
  // renewing, as the connection read closed between the vendor's new client and its connect. Two connects shared that
  // client, and the renewal's handshake went out on the other's transport with no session, which the server refused.
  test("a warmup while a call renews its server's session starts no second connect of it, and the call answers", async () => {
    const h = harness();
    await seedServer(h, 'srv1');
    seedMcpTools('srv1', [{ name: 'do_thing', inputSchema: { type: 'object' } }]);
    seedMcpSession('srv1', 's1');
    const owner = await testOwner();

    failNextMcpToolCall(await refusedToolCall({ status: 404, body: 'session ended' }));
    const renewal = hangNextMcpConnect();
    const call = h.userDO.userMcp_callTool(owner, { serverId: 'srv1', name: 'do_thing', args: {}, id: 'call-renewed' });

    await renewal.entered;
    const warming = h.userDO.userMcp_warmConnections(owner);

    // The warmup reads the connection while the renewal's connect is out.
    await nextTurn();
    renewal.release();
    await Promise.all([call, warming]);

    expect(recordedMcpLifecycle().overlapped).toEqual([]);
    h.close();
  });

  // Main, 2026-10-21: every connect of a server is one of its dials, so none shares the vendor's client with another; a
  // sign-in's end used to establish its server beside a warmup's redial of it.
  test("a sign-in's end while a warmup redials its server waits for the redial, and connects once it is done", async () => {
    const h = harness();
    await seedServer(h, 'srv1');
    seedMcpTools('srv1', [{ name: 'do_thing', inputSchema: { type: 'object' } }]);
    const owner = await testOwner();

    // Failed, so the warmup redials it and the sign-in's end establishes it in earnest: the vendor's establish passes
    // over a ready connection (`client-BnYbNT3z.js:2192`).
    liveConnection(h, 'srv1').connectionState = 'failed';
    const redial = hangNextMcpConnect();
    const warming = h.userDO.userMcp_warmConnections(owner);

    await redial.entered;
    const ended = h.userDO.userMcp_handleOAuthCallback(owner, 'https://kinu.example.com/api/user/mcp/callback?state=signed.srv1&code=c');

    // The sign-in's end reads the server while the redial's connect is out.
    await nextTurn();
    redial.release();
    await Promise.all([warming, ended]);

    expect({ overlapped: recordedMcpLifecycle().overlapped, established: recordedMcpLifecycle().established.includes('srv1') }).toEqual({ overlapped: [], established: true });
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
    await expect(call).rejects.toMatchObject({ code: 'cancelled' });
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
    await seedMcpAuthContinuation('srv1', 'https://auth.example/authorize?srv1');
    // A POST 401 with no auth provider to retry through.
    failNextMcpToolCall(await refusedToolCall({ status: 401, body: 'nope' }));
    // In production the dispatch and the `discoverIfConnected` probe are two failing requests.
    failNextMcpDiscovery(await refusedToolCall({ status: 401, body: 'nope' }));

    await expect(h.userDO.userMcp_callTool(await testOwner(), { serverId: 'srv1', name: 'do_thing', args: {}, id: crypto.randomUUID() }))
      .rejects.toThrow('Error POSTing to endpoint: nope');

    // Observe the persisted `authenticating` status and the sign-in it offers, not merely that a re-probe was attempted.
    expect(recordedMcpLifecycle().discovered).toContain('srv1');
    const [listed] = await h.userDO.userMcp_list(await testOwner());
    expect(listed?.status).toBe('authenticating');
    expect(listed?.signIn).toBe(true);
    h.close();
  });

  test('an UnauthorizedError from the auth path converges too', async () => {
    const h = harness();
    await seedServer(h, 'srv1');
    seedMcpTools('srv1', [{ name: 'do_thing', inputSchema: { type: 'object' } }]);
    await seedMcpAuthContinuation('srv1', 'https://auth.example/authorize?srv1');
    // An auth provider that cannot recover the token.
    failNextMcpToolCall(await refusedToolCall({ status: 401, body: 'nope', authProvider: { token: () => Promise.resolve('stale') } }));
    failNextMcpDiscovery(await refusedToolCall({ status: 401, body: 'nope' }));

    await expect(h.userDO.userMcp_callTool(await testOwner(), { serverId: 'srv1', name: 'do_thing', args: {}, id: crypto.randomUUID() }))
      .rejects.toThrow();

    expect(recordedMcpLifecycle().discovered).toContain('srv1');
    const [listed] = await h.userDO.userMcp_list(await testOwner());
    expect(listed?.status).toBe('authenticating');
    expect(listed?.signIn).toBe(true);
    h.close();
  });

  test('a typed 401 wrapped by another error still converges', async () => {
    const h = harness();
    await seedServer(h, 'srv1');
    seedMcpTools('srv1', [{ name: 'do_thing', inputSchema: { type: 'object' } }]);
    await seedMcpAuthContinuation('srv1', 'https://auth.example/authorize?srv1');
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
    expect(listed?.signIn).toBe(true);
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
    await seedMcpAuthContinuation('srv1', 'https://auth.example/authorize?srv1');
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
    // still out, and the call reached a client with no transport 128 ms later. The activation dials every server on
    // the transport it builds.
    const first = harness();
    const owner = await testOwner();
    await seedServer(first, 'srv1', { name: 'Cloudflare' });
    seedSdkMcpServer('srv1', {}, { name: 'Cloudflare' });
    const dial = hangMcpEstablish();
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

    await expect(h.userDO.userMcp_callTool(await testOwner(), { serverId: 'srv1', name: 'do_thing', args: {}, id: crypto.randomUUID() }))
      .rejects.toMatchObject({ code: 'unavailable' });
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
    const dial = hangMcpEstablish();
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
      new Error('401 Unauthorized: Not connected, timed out'),
    ].map((cause) => classifyMcpFailure({ cause }))).toEqual([
      'not_connected', 'connection_closed', 'timeout', 'send_failed', 'protocol', 'server_error',
      'auth', 'http', 'not_connected', 'cancelled', 'refused', 'unknown',
    ]);

    // A call refused before dispatch carries no transport error: the connection's state says what it met.
    const refused = new KinuError('unavailable', 'the call was not sent');

    expect((['authenticating', 'connecting', 'absent', 'ready'] as const).map((state) => classifyMcpFailure({ cause: refused, state })))
      .toEqual(['auth', 'not_connected', 'not_connected', 'unknown']);
  });
});
