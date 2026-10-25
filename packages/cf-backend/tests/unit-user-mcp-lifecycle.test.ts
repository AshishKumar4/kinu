// An account's MCP servers in a real UserDO against real MCP servers over loopback HTTP: an add connects and lists once,
// a wake dials nothing, a call builds its client from the server's row, and a call the server never saw goes out once
// more on a new session.
import { describe, expect, test } from 'bun:test';
import { createTestUserDO, provisionTestWorkspace, sqlExec, testOwner, type TestUserDO } from './helpers/user-do';
import { mcpTestServer, type McpTestServer } from './helpers/mcp-server';
import { mcpWire } from '../src/user/mcp';
import { McpToolSurfaceSchema, type JsonObject, type JsonValue, type UserCaller } from '@kinu.run/core';
import { KinuError, setDiagnosticsSink, type LogFields } from '@kinu.run/core/obs';
import { ProtocolError, SdkError, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client';
import type { McpToolSurface } from '../src/user/mcp-servers';
import * as v from 'valibot';

const OWNER_ID = '0123456789abcdef0123456789abcdef';

const TRACKER_TOOLS: JsonValue[] = [
  {
    name: 'find_issue', description: 'Finds an issue.', annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { q: { type: 'string' }, note: { type: 'string' } }, required: ['q'] },
  },
  { name: 'close_issue', inputSchema: { type: 'object' } },
];

/** The descriptor surface, held to `McpToolSurfaceSchema`, the contract the orchestrator's cache reads. */
async function readSurface(h: TestUserDO, owner: UserCaller): Promise<McpToolSurface> {
  return v.parse(McpToolSurfaceSchema, await h.userDO.userMcp_toolDescriptors(owner));
}

async function add(h: TestUserDO, input: JsonObject): Promise<{ id: string; signIn: boolean }> {
  return h.userDO.userMcp_add(await testOwner(), input, 'https://kinu.example');
}

async function call(h: TestUserDO, serverId: string, name: string, args: JsonObject = {}): Promise<string> {
  return h.userDO.userMcp_callTool(await testOwner(), { serverId, name, args, id: crypto.randomUUID() });
}

/** The object woken again over the storage `h` wrote, as after its eviction: nothing it held in memory survives. */
function wake(h: TestUserDO): TestUserDO {
  return createTestUserDO({ storage: h.db });
}

/** Runs `body` with a fresh account and a server, and lets both go whatever it does. */
async function withServer(body: (h: TestUserDO, server: McpTestServer, owner: UserCaller) => Promise<void>, server: McpTestServer = mcpTestServer({ tools: TRACKER_TOOLS })): Promise<void> {
  const h = createTestUserDO({ durableObjectId: OWNER_ID });

  try {
    await body(h, server, await testOwner());
  } finally {
    await server.stop();
    h.close();
  }
}

interface LoggedLine {
  readonly name: string;
  readonly fields: LogFields;
}

/** Every diagnostics line `body` logs. */
async function diagnosticsDuring(body: () => Promise<void>): Promise<LoggedLine[]> {
  const lines: LoggedLine[] = [];
  const record = (name: string, fields: LogFields | undefined): void => { lines.push({ name, fields: fields ?? {} }); };

  const restore = setDiagnosticsSink({ event: record, failure: (name, _error, fields) => { record(name, fields); } });

  try {
    await body();
  } finally { restore(); }

  return lines;
}

describe('an account MCP server, from its add to its removal', () => {
  test('an add connects and lists once; a turn offers its tools, a call reaches them, and its removal takes them away', async () => {
    await withServer(async (h, server, owner) => {
      const added = await add(h, { name: 'tracker', serverUrl: server.url });

      expect(added.signIn).toBe(false);
      expect((await h.userDO.userMcp_list(owner)).map((s) => [s.name, s.status, s.toolsCount, s.error, s.signIn])).toEqual([['tracker', 'connected', 2, null, false]]);
      expect((await readSurface(h, owner)).descriptors.map((d) => [d.toolKey, d.readOnly === true])).toEqual([['mcp_tracker_close_issue', false], ['mcp_tracker_find_issue', true]]);

      server.answer = (made) => ({ content: [{ type: 'text', text: `found ${JSON.stringify(made.args)}` }] });
      // An untouched optional field's '' is dropped; the required one is sent as it is (KINU-052).
      expect(JSON.parse(await call(h, added.id, 'find_issue', { q: '', note: '' }))).toMatchObject({ content: [{ type: 'text', text: 'found {"q":""}' }] });
      expect(server.calls.map((made) => [made.name, made.args])).toEqual([['find_issue', { q: '' }]]);

      await h.userDO.userMcp_remove(owner, added.id);
      expect(await readSurface(h, owner)).toEqual({ descriptors: [], unavailable: [] });
      expect(await h.userDO.userMcp_list(owner)).toEqual([]);
      // The client it held ended its session at the server, as MCP asks of a client done with one.
      expect(server.seen.at(-1)).toBe('DELETE s1');
    });
  });

  test('a wake dials nothing: the turn after it offers the kept tools, and the first call resumes the session with no request before it', async () => {
    await withServer(async (first, server, owner) => {
      const { id } = await add(first, { name: 'tracker', serverUrl: server.url });
      const h = wake(first);
      const before = server.seen.length;

      try {
        expect((await readSurface(h, owner)).descriptors.map((d) => d.toolKey)).toEqual(['mcp_tracker_close_issue', 'mcp_tracker_find_issue']);
        expect((await h.userDO.userMcp_list(owner))[0]?.status).toBe('connected');
        expect(server.seen.length).toBe(before);

        await call(h, id, 'close_issue');
        expect(server.seen.slice(before)).toEqual(['tools/call s1']);
      } finally {
        h.close();
      }
    });
  });

  test('a call whose session the server ended starts one new session and goes out once more; the next wake resumes it', async () => {
    await withServer(async (first, server) => {
      const { id } = await add(first, { name: 'tracker', serverUrl: server.url });
      const before = server.seen.length;

      server.end('s1');
      await call(first, id, 'close_issue');
      expect(server.seen.slice(before)).toEqual(['tools/call s1', 'initialize -', 'notifications/initialized s2', 'tools/call s2']);
      expect(server.calls.map((made) => made.session)).toEqual(['s2']);

      const h = wake(first);

      try {
        await call(h, id, 'close_issue');
        expect(server.calls.map((made) => made.session)).toEqual(['s2', 's2']);
      } finally {
        h.close();
      }
    });
  });

  test('calls made together on an ended session share one new session, and each is sent once more on it', async () => {
    await withServer(async (h, server) => {
      const { id } = await add(h, { name: 'tracker', serverUrl: server.url });

      server.end('s1');
      await Promise.all([1, 2, 3].map(async () => call(h, id, 'close_issue')));
      expect({ sessions: server.sessions, calls: server.calls.map((made) => made.session) }).toEqual({ sessions: ['s1', 's2'], calls: ['s2', 's2', 's2'] });
    });
  });

  test('a call is sent once more at most: a server that ends each session it is called on fails the call with its 404', async () => {
    await withServer(async (h, server, owner) => {
      const { id } = await add(h, { name: 'tracker', serverUrl: server.url });

      server.endsEachCall = true;
      await expect(call(h, id, 'close_issue')).rejects.toThrow();
      expect(server.sessions).toEqual(['s1', 's2']);
      // A call's failure is the call's: the server answered its handshake, and stays connected.
      expect((await h.userDO.userMcp_list(owner))[0]?.status).toBe('connected');
    });
  });

  test('a 404 from a server that issues no session is the call\'s own failure: nothing is sent again', async () => {
    await withServer(async (h, server) => {
      const { id } = await add(h, { name: 'tracker', serverUrl: server.url });
      const before = server.seen.length;

      server.endsEachCall = true;
      await expect(call(h, id, 'close_issue')).rejects.toThrow();
      expect(server.seen.slice(before).filter((line) => line.startsWith('tools/call'))).toEqual(['tools/call -']);
    }, mcpTestServer({ sessions: false, tools: TRACKER_TOOLS }));
  });
});

describe('a server name is one identity', () => {
  test('one name, in any case, is one server; two adds of it at once leave one; two names may share an endpoint', async () => {
    await withServer(async (h, server, owner) => {
      await add(h, { name: 'tracker', serverUrl: server.url });
      await expect(add(h, { name: 'TRACKER', serverUrl: server.url })).rejects.toThrow("An MCP server named 'TRACKER' already exists.");
      await expect(add(h, { name: '   ', serverUrl: server.url })).rejects.toThrow('`name` is required.');

      const together = await Promise.allSettled([add(h, { name: 'board', serverUrl: server.url }), add(h, { name: 'Board', serverUrl: server.url })]);

      expect(together.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect((await h.userDO.userMcp_list(owner)).map((s) => s.name.toLowerCase())).toEqual(['board', 'tracker']);
    });
  });
});

describe('what a listing finds', () => {
  test('a tool list that breaks the spec keeps its good tools, and names the ones it refused', async () => {
    const tools: JsonValue[] = [
      { name: 'do_thing', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
      { name: 'any_input', inputSchema: true },
      { name: 'scalar_root', inputSchema: { type: 'string' } },
      { description: 'a tool with no name' },
    ];

    await withServer(async (h, server, owner) => {
      const { id } = await add(h, { name: 'github', serverUrl: server.url });
      const surface = await readSurface(h, owner);
      const [listed] = await h.userDO.userMcp_list(owner);

      expect(surface.descriptors.map((d) => d.toolKey)).toEqual(['mcp_github_do_thing']);
      expect(surface.unavailable.map((u) => [u.server, u.reason.includes('any_input') || u.reason.includes('scalar_root')])).toEqual([['github', true], ['github', true]]);
      expect([listed?.status, listed?.toolsCount, listed?.error?.includes('scalar_root'), listed?.error?.includes('has no name')]).toEqual(['connected', 1, true, true]);
      expect(JSON.parse(await call(h, id, 'do_thing', { q: 'x' }))).toMatchObject({ content: [{ type: 'text', text: 'ok' }] });
    }, mcpTestServer({ tools }));
  });

  // The owner, onboarding on kinu.run 90fd4539f, 2026-10-23: Gmail read "Connected · 0 tools" beside its tool list's
  // failure, which quoted Google's whole tool list. Google answered `tools/list` 403 for the token, with that list as
  // the body; its handshake had answered 200.
  test('a server that refuses its tool list reads failed, names the status and not the body, and connects once it lists', async () => {
    await withServer(async (h, server, owner) => {
      server.refuseList = { status: 403, body: JSON.stringify({ result: { tools: [{ name: 'quoted_tool' }] } }) };
      const { id } = await add(h, { name: 'Gmail', serverUrl: server.url });

      const lines = await diagnosticsDuring(async () => {
        expect(await h.userDO.userMcp_reconnect(owner, id)).toEqual({ status: 'failed', error: 'Gmail refused its tool list: HTTP 403' });
        expect((await readSurface(h, owner)).unavailable).toEqual([{ server: 'Gmail', reason: 'it has listed no tools: Gmail refused its tool list: HTTP 403. Reconnect it in Settings > MCP servers.' }]);

        server.refuseList = null;
        expect(await h.userDO.userMcp_reconnect(owner, id)).toEqual({ status: 'connected', error: null });
      });

      expect((await h.userDO.userMcp_list(owner)).map((s) => [s.status, s.toolsCount, s.signIn])).toEqual([['connected', 2, false]]);
      expect(lines.filter((line) => line.name === 'mcp.status_changed').map((line) => [line.fields.from, line.fields.to])).toEqual([['failed', 'connected']]);
    });
  });
});

describe('how a server is reached', () => {
  test('a server that asks for a login waits for a sign-in, offers no tool, and is sent no call until it has one', async () => {
    await withServer(async (h, server, owner) => {
      server.bearer = 'a login it does not have';
      const { id, signIn } = await add(h, { name: 'tracker', serverUrl: server.url });

      expect({ signIn, listed: (await h.userDO.userMcp_list(owner)).map((s) => [s.status, s.signIn]) }).toEqual({ signIn: true, listed: [['needs_sign_in', true]] });
      expect((await readSurface(h, owner)).unavailable).toEqual([{ server: 'tracker', reason: 'waiting for a sign-in: sign in to it again in Settings > MCP servers.' }]);
      await expect(call(h, id, 'close_issue')).rejects.toThrow('waits for a sign-in, so the call was not sent');
      expect(server.calls).toEqual([]);
    });
  });

  test('a token is sent with each request and kept sealed; one the server refuses is not added', async () => {
    await withServer(async (h, server, owner) => {
      server.bearer = 'the-token';
      await expect(add(h, { name: 'tracker', serverUrl: server.url, headers: { Authorization: 'Bearer another' } })).rejects.toThrow('Could not connect to the MCP server');
      expect(await h.userDO.userMcp_list(owner)).toEqual([]);

      const { id, signIn } = await add(h, { name: 'tracker', serverUrl: server.url, headers: { Authorization: 'Bearer the-token' } });

      await call(h, id, 'close_issue');
      const [stored] = sqlExec(h.db).exec(`SELECT headers FROM user_mcp_servers WHERE id = ?`, id).toArray();
      const { headers } = v.parse(v.object({ headers: v.string() }), stored);

      expect({ signIn, offered: (await h.userDO.userMcp_list(owner))[0]?.signIn, sent: server.calls.map((made) => made.authorization), sealed: !headers.includes('the-token') })
        .toEqual({ signIn: false, offered: false, sent: ['Bearer the-token'], sealed: true });
    });
  });

  test('a token the server stops taking fails the call, and its server reads failed until a call is answered again', async () => {
    await withServer(async (h, server, owner) => {
      server.bearer = 'the-token';
      const { id } = await add(h, { name: 'tracker', serverUrl: server.url, headers: { Authorization: 'Bearer the-token' } });

      server.bearer = 'a rotated token';
      await expect(call(h, id, 'close_issue')).rejects.toThrow();
      expect((await h.userDO.userMcp_list(owner)).map((s) => [s.status, s.signIn])).toEqual([['failed', false]]);

      server.bearer = 'the-token';
      await call(h, id, 'close_issue');
      expect((await h.userDO.userMcp_list(owner)).map((s) => [s.status, s.error])).toEqual([['connected', null]]);
    });
  });

  test('stored headers that no longer open fail the request instead of sending it bare', async () => {
    await withServer(async (first, server) => {
      server.bearer = 'the-token';
      const { id } = await add(first, { name: 'tracker', serverUrl: server.url, headers: { Authorization: 'Bearer the-token' } });

      sqlExec(first.db).exec(`UPDATE user_mcp_servers SET headers = 'not a sealed envelope' WHERE id = ?`, id);
      const h = wake(first);
      const before = server.seen.length;

      try {
        await expect(call(h, id, 'close_issue')).rejects.toThrow();
        expect(server.seen.length).toBe(before);
      } finally {
        h.close();
      }
    });
  });
});

describe('a caller stops the MCP call it made', () => {
  /** Holds each call at the server until released, telling when one arrives. */
  function holding(server: McpTestServer) {
    const arrived = Promise.withResolvers<void>();
    const released = Promise.withResolvers<JsonObject>();

    server.answer = () => {
      arrived.resolve();

      return released.promise;
    };

    return { arrived: arrived.promise, release: () => { released.resolve({ content: [] }); } };
  }

  test('a cancel naming the call aborts its request, and the call settles with the cancel; one naming no call changes nothing', async () => {
    await withServer(async (h, server, owner) => {
      const { id } = await add(h, { name: 'tracker', serverUrl: server.url });
      const held = holding(server);
      const made = h.userDO.userMcp_callTool(owner, { serverId: id, name: 'close_issue', args: {}, id: 'call-7' });

      await held.arrived;
      await h.userDO.userMcp_cancelCall(owner, 'call-gone');
      await h.userDO.userMcp_cancelCall(owner, 'call-7');
      await expect(made).rejects.toMatchObject({ code: 'cancelled' });
      held.release();
    });
  });

  // Release review, 2026-10-05: deleting a workspace revoked its token first, so its MCP calls ran on and it could not cancel them.
  test('deleting a workspace stops the MCP calls it is making', async () => {
    await withServer(async (h, server, owner) => {
      const { id } = await add(h, { name: 'tracker', serverUrl: server.url });
      const token = await provisionTestWorkspace(h, 'leaving');
      const held = holding(server);
      const made = h.userDO.userMcp_callTool({ workspaceToken: token }, { serverId: id, name: 'close_issue', args: {}, id: 'call-leaving' });

      await held.arrived;
      await h.userDO.removeWorkspace(owner, 'leaving', OWNER_ID);
      await expect(made).rejects.toMatchObject({ code: 'cancelled' });
      held.release();
    });
  });
});

describe('the descriptor surface', () => {
  test('is ordered by tool key, omits a blank description, and offers what an allowlist leaves without calling a server unavailable', async () => {
    const tools: JsonValue[] = [
      { name: 'b_tool', description: 'Does b.', inputSchema: { type: 'object' } },
      { name: 'a_tool', description: '', inputSchema: { type: 'object' } },
    ];

    await withServer(async (h, server, owner) => {
      await add(h, { name: 'zulu', serverUrl: server.url });
      await add(h, { name: 'filtered', serverUrl: server.url, allowedTools: [] });
      const surface = await readSurface(h, owner);

      expect({ keys: surface.descriptors.map((d) => d.toolKey), described: surface.descriptors.map((d) => 'description' in d), unavailable: surface.unavailable })
        .toEqual({ keys: ['mcp_zulu_a_tool', 'mcp_zulu_b_tool'], described: [false, true], unavailable: [] });
      expect((await h.userDO.userMcp_list(owner)).map((s) => [s.name, s.status, s.toolsCount])).toEqual([['filtered', 'connected', 0], ['zulu', 'connected', 2]]);
    }, mcpTestServer({ tools }));
  });
});

describe('MCP calls are logged, classified', () => {
  test('each failed call is logged once as mcp.call_failed, with its kind and its server\'s status', async () => {
    await withServer(async (h, server) => {
      const { id } = await add(h, { name: 'tracker', serverUrl: server.url });

      const lines = await diagnosticsDuring(async () => {
        server.answer = () => new Response('the server broke', { status: 500 });
        await expect(call(h, id, 'close_issue')).rejects.toThrow();
        server.answer = () => ({ content: [{ type: 'text', text: 'Invalid list options provided.' }], isError: true });
        await call(h, id, 'close_issue');
        await expect(call(h, 'gone', 'close_issue')).rejects.toThrow('no such MCP server');
      });

      expect(lines.filter((line) => line.name === 'mcp.call_failed').map((line) => [line.fields.serverId, line.fields.kind, line.fields.status]))
        .toEqual([[id, 'http', 'connected'], [id, 'tool_error', 'connected'], ['gone', 'refused', 'missing']]);
    });
  });

  test('a failure is classified by its class and code, never its text', () => {
    const refused = (status: number) => new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'Error POSTing to endpoint: no', { status, statusText: '' });
    const wrapped = new KinuError('unavailable', 'calling a tool', { cause: new SdkError(SdkErrorCode.NotConnected, 'Not connected') });

    expect([
      new SdkError(SdkErrorCode.NotConnected, 'Not connected'),
      new SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed'),
      new SdkError(SdkErrorCode.RequestTimeout, 'Request timed out'),
      new SdkError(SdkErrorCode.SendFailed, 'send failed'),
      new SdkError(SdkErrorCode.InvalidResult, 'bad result'),
      new ProtocolError(-32602, 'bad params'),
      refused(401),
      refused(500),
      wrapped,
      new KinuError('cancelled', 'stopped'),
      new KinuError('denied', 'not allowed'),
      new Error('401 Unauthorized: Not connected, timed out'),
    ].map((cause) => mcpWire.classifyMcpFailure({ cause }))).toEqual([
      'not_connected', 'connection_closed', 'timeout', 'send_failed', 'protocol', 'server_error',
      'auth', 'http', 'not_connected', 'cancelled', 'refused', 'unknown',
    ]);

    // A call refused before it was sent carries no transport error: its server's status says what it met.
    expect(mcpWire.classifyMcpFailure({ cause: new KinuError('denied', 'the call was not sent'), status: 'needs_sign_in' })).toBe('auth');
  });
});
