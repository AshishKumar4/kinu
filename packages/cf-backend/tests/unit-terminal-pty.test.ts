/**
 * Terminal lifecycle at the route seam: which environments get a terminal, no shell before /workspace attaches,
 * bounded geometry, and an attached terminal moving the durable lease (the SDK's activity clock does not decide stop).
 */

import { describe, expect, test } from 'bun:test';
import { serveFamily } from './helpers/api';
import {
  createRecordingLogger, setDiagnosticsSink, type RecordedLog,
} from '@kinu.run/core/obs';
import * as v from 'valibot';
import { LINE_MODE_LABEL, LineTerminalState, terminalLane } from '@kinu.run/core';
import { WORKSPACE_TERMINAL_PATH } from '@kinu.run/core';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { jsrpcStub } from './helpers/jsrpc-stub';
import { installSandboxSdkMock } from './helpers/sandbox-sdk';

// The route's module graph reaches the Sandbox SDK at import; the stand-in is for the import alone.
await installSandboxSdkMock();

// `agents` reaches `cloudflare:email`: mock first, then the dynamic import.
mockAgentsSdk();

const { terminalRoutes } = await import('../src/terminal-route');

import type { TerminalRouteDeps, TerminalWorkspace } from '../src/terminal-route';

/** Vocabulary a person is never shown: our primitives, transports, missing methods. */
const FORBIDDEN_IN_COPY = /pty|pseudo-terminal|JSON-RPC|daemon|Nimbus|startProcess|stdin|resize|socket/i;

interface PtySize { cols?: number; rows?: number; shell?: string }

interface TerminalDouble {
  noteTerminalActivity(): Promise<void>;
  deleteSession(sessionId: string): Promise<{ success: boolean }>;
  getSession(sessionId: string): Promise<{ terminal(request: Request, options?: PtySize): Promise<Response> }>;
}

/** Order is the contract: a PTY before the workspace attached is a shell onto the wrong disk, before egress one with no network. */
interface Trace {
  readonly calls: string[];
  options: PtySize | undefined;
  request: Request | undefined;
  forwarded: Request | undefined;
  /** Must not be the agent's exec session, where one long agent command would swallow keystrokes. */
  session: string | undefined;
}

interface Harness {
  readonly deps: TerminalRouteDeps;
  readonly trace: Trace;
}

/** The container double is a `jsrpcStub`: real binding methods are not own enumerable properties. */
function harness(opts: {
  prepare?: () => Promise<{ ok: true } | { error: string }>;
  lease?: () => Promise<void>;
  attach?: () => Promise<Response>;
  sandboxBound?: boolean;
} = {}): Harness {
  const trace: Trace = { calls: [], options: undefined, request: undefined, forwarded: undefined, session: undefined };

  const container = jsrpcStub<TerminalDouble>({
    noteTerminalActivity: async () => {
      trace.calls.push('noteTerminalActivity');

      if (opts.lease) await opts.lease();
    },
    deleteSession: () => { throw new Error('deleteSession: no case here restarts the container shell'); },
    getSession: async (sessionId) => {
      trace.calls.push('getSession');
      trace.session = sessionId;

      return {
        terminal: async (request, options) => {
          trace.calls.push('terminal');
          trace.options = options;
          trace.request = request;

          return opts.attach
            ? await opts.attach()
            // A 101 needs a real WebSocketPair; this body proves the SDK response is returned unchanged.
            : new Response('pty-socket', { status: 200 });
        },
      };
    },
  });

  const agent = jsrpcStub<TerminalWorkspace>({
    prepareTerminal: async (executorId: string) => {
      trace.calls.push(`prepareTerminal:${executorId}`);

      return opts.prepare ? await opts.prepare() : { ok: true as const };
    },
    fetch: async (request: Request) => {
      trace.calls.push('fetch');
      trace.forwarded = request;

      return new Response('workspace-socket', { status: 200 });
    },
    openDeviceTerminal: () => { throw new Error('openDeviceTerminal: the device lane is not driven by this suite'); },
  });

  // Fakes cannot satisfy `DurableObjectId`/`DurableObjectStub`, so the route takes the two resolutions instead.
  return {
    deps: {
      resolveWorkspace: async () => agent,
      resolveSandbox: () => opts.sandboxBound === false ? null : container,
      UserDO: {
        idFromName: () => { throw new Error('UserDO.idFromName: the device lane is not driven by this suite'); },
        get: () => { throw new Error('UserDO.get: the device lane is not driven by this suite'); },
      },
    },
    trace,
  };
}

const WORKSPACE = 'kinu-main';

/** The abandonment case supplies its own recorder to prove cleanup survives the response. */
function executionContext(): Pick<ExecutionContext, 'waitUntil'> {
  return { waitUntil: () => {} };
}

function terminalRequest(
  request: Request,
  deps: TerminalRouteDeps,
  ctx: Pick<ExecutionContext, 'waitUntil'> = executionContext(),
): Promise<Response | null> {
  return serveFamily(terminalRoutes(() => deps), { workspace: { name: WORKSPACE }, ctx: ctx })(request, {});
}

function attachRequest(query: string, init: RequestInit = {}): Request {
  return new Request(`https://app.example/api/workspaces/${WORKSPACE}/terminal?${query}`, {
    headers: { upgrade: 'websocket' },
    ...init,
  });
}

const payloadSchema = v.record(v.string(), v.unknown());

async function body(response: Response | null | undefined) {
  if (response == null) throw new Error('the route returned no response');

  return v.parse(payloadSchema, await response.json());
}

async function recorded<T>(run: () => Promise<T>): Promise<{
  readonly value: T;
  readonly logs: readonly RecordedLog[];
}> {
  const logger = createRecordingLogger();
  const restore = setDiagnosticsSink(logger);

  try {
    return { value: await run(), logs: logger.emitted };
  } finally {
    restore();
  }
}

describe('which environments can have a terminal', () => {
  test('the container and the owner machine are the PTY lanes', () => {
    expect(terminalLane('sandbox')).toEqual({ mode: 'pty' });
    expect(terminalLane('device')).toEqual({ mode: 'pty' });
  });

  test('the workspace is the runtime\'s own shell', () => {
    expect(terminalLane('workspace')).toEqual({ mode: 'shell' });
  });

  // Product rule: a lane label states what a person is in, never our missing methods, so a lane carries a mode only.
  // The lane table states what an environment can give; reachability is the route's preflight.
  test.each(['parent', 'something-invented'])(
    '%s is line mode, and its lane carries no sentence to render',
    (executor) => {
      expect(terminalLane(executor)).toEqual({ mode: 'line' });
    },
  );

  test('the line-mode label states the mode and no implementation detail', () => {
    expect(LINE_MODE_LABEL).toContain('line mode');
    expect(LINE_MODE_LABEL).not.toMatch(FORBIDDEN_IN_COPY);
  });
});

describe('attaching a terminal', () => {
  test('another path under the same workspace is left to the next handler', async () => {
    const { deps } = harness();

    const response = await terminalRequest(
      new Request(`https://app.example/api/workspaces/${WORKSPACE}/files?path=/x`), deps,
    );

    expect(response).toBeNull();
  });

  test('the container is prepared before the shell opens onto it', async () => {
    const { deps, trace } = harness();
    const response = await terminalRequest(attachRequest('executor=sandbox&cols=120&rows=40'), deps);
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe('pty-socket');
    // Preflight (egress, /workspace) settles before the PTY exists, and the lease is stamped before the socket
    // is handed over, or the first heartbeat can stop the container under it.
    expect(trace.calls).toEqual(['prepareTerminal:sandbox', 'noteTerminalActivity', 'getSession', 'terminal']);
  });

  test('the shell is the user\'s own session, not the one the agent execs in', async () => {
    const { deps, trace } = harness();
    await terminalRequest(attachRequest('executor=sandbox'), deps);
    // A stable named session so a reload lands on the running shell; the SDK default session is the agent's
    // exec lane, and one session holds one PTY and one foreground process.
    expect(trace.session).toBe('kinu-terminal');
    expect(trace.session).not.toContain('sandbox-');
  });

  test('two attaches land in the same session, so a reload reattaches', async () => {
    const { deps, trace } = harness();
    await terminalRequest(attachRequest('executor=sandbox'), deps);
    const first = trace.session;
    await terminalRequest(attachRequest('executor=sandbox'), deps);
    expect(trace.session).toBe(first);
  });

  test('the geometry the client asks for reaches the terminal', async () => {
    const { deps, trace } = harness();
    await terminalRequest(attachRequest('executor=sandbox&cols=120&rows=40'), deps);
    expect(trace.options).toEqual({ cols: 120, rows: 40 });
  });

  test('a shell is never named: the container picks it, and TERM with it', async () => {
    const { deps, trace } = harness();
    await terminalRequest(attachRequest('executor=sandbox'), deps);
    // No `shell` key: `PtyOptions.shell` is spawned as one argv token, so `bash -l` would ENOENT.
    expect(trace.options).toEqual({});
    expect(trace.options).not.toHaveProperty('shell');
  });

  test.each([
    ['cols=abc&rows=40', { rows: 40 }],
    ['cols=0&rows=0', {}],
    ['cols=99999&rows=40', { rows: 40 }],
    ['cols=80.5&rows=24', { rows: 24 }],
    ['cols=-80&rows=24', { rows: 24 }],
  ])('geometry from a query string is bounded (%s)', async (query, expected) => {
    const { deps, trace } = harness();
    await terminalRequest(attachRequest(`executor=sandbox&${query}`), deps);
    expect(trace.options).toEqual(expected);
  });

  test('the upgrade the SDK proxies is the same request, minus the caller\'s credentials', async () => {
    const { deps, trace } = harness();

    const request = attachRequest('executor=sandbox', {
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-version': '13',
        'sec-websocket-protocol': 'pty',
        // A container runs agent-chosen code, so neither the session cookie nor the identity header may reach it.
        cookie: '__Host-kinu_session=s3cr3t; other=v',
        authorization: 'Bearer pta_notyours',
        'x-kinu-user-id': 'u_1',
        'x-kinu-auth-time': '1700000000000',
      },
    });

    await terminalRequest(request, deps);
    const forwarded = trace.request;

    if (!forwarded) throw new Error('the SDK was never handed an upgrade');
    expect(forwarded.url).toBe(request.url);
    expect([...forwarded.headers.keys()].sort()).toEqual([
      'connection', 'sec-websocket-protocol', 'sec-websocket-version', 'upgrade',
    ]);
  });

  // A wrong-verb GET is refused before anything is touched; it must not start a container on its way to saying so.
  test.each([
    { path: 'terminal?executor=sandbox', status: 400 },
    { path: 'terminal?executor=workspace', status: 400 },
    { path: 'terminal/keepalive?executor=sandbox', status: 405 },
  ])('GET /$path is refused and touches nothing', async ({ path, status }) => {
    const { deps, trace } = harness();

    const response = await terminalRequest(
      new Request(`https://app.example/api/workspaces/${WORKSPACE}/${path}`), deps,
    );

    expect(response?.status).toBe(status);
    expect(trace.calls).toEqual([]);
  });

  test('an executor with no terminal is refused as line mode, carrying no implementation detail', async () => {
    const { deps, trace } = harness();
    const response = await terminalRequest(attachRequest('executor=parent'), deps);
    expect(response?.status).toBe(409);
    const payload = await body(response);
    expect(payload.lane).toBe('line');
    expect(payload.missing).toBeUndefined();
    expect(JSON.stringify(payload)).not.toMatch(FORBIDDEN_IN_COPY);
    expect(trace.calls).toEqual([]);
  });

  test('no executor is named', async () => {
    const { deps } = harness();
    const response = await terminalRequest(attachRequest(''), deps);
    expect(response?.status).toBe(400);
    expect(String((await body(response)).error)).toContain('executor');
  });

  test('a deployment with no container binding says so', async () => {
    const { deps } = harness({ sandboxBound: false });
    const response = await terminalRequest(attachRequest('executor=sandbox'), deps);
    expect(response?.status).toBe(503);
    expect(String((await body(response)).error)).toContain('Sandbox binding');
  });

  test('a workspace that cannot attach its disk gets the reason, not a shell', async () => {
    const { deps, trace } = harness({
      prepare: async () => ({ error: 'attach overran its budget; a retry is scheduled' }),
    });

    const response = await terminalRequest(attachRequest('executor=sandbox'), deps);
    expect(response?.status).toBe(503);
    expect(String((await body(response)).error)).toContain('attach overran');
    expect(trace.calls).toEqual(['prepareTerminal:sandbox']);
  });

  test('a container that fails the attach reports it rather than hanging', async () => {
    const { deps } = harness({ attach: async () => { throw new Error('container is not listening on 3000'); } });
    const response = await terminalRequest(attachRequest('executor=sandbox'), deps);
    expect(response?.status).toBe(503);
    expect(String((await body(response)).error)).toContain('not listening');
  });
});

/** Terminal failures, preflight included, must carry the workspace and executor tags; control flow is unchanged. */
describe('a terminal failure names the workspace and the executor', () => {
  function terminalRows(
    logs: readonly RecordedLog[], event: string,
  ): readonly RecordedLog[] {
    return logs.filter((log) => log.event === event);
  }

  const scope = { workspace: WORKSPACE, executor: 'sandbox' };

  test('a readiness refusal is a fleet row, and still the same answer to the client', async () => {
    const { deps, trace } = harness({
      prepare: async () => ({ error: 'attach overran its budget; a retry is scheduled' }),
    });

    const { value: response, logs } = await recorded(
      async () => await terminalRequest(attachRequest('executor=sandbox'), deps),
    );

    expect(response?.status).toBe(503);
    expect(String((await body(response)).error)).toContain('attach overran');
    expect(trace.calls).toEqual(['prepareTerminal:sandbox']);

    const notReady = terminalRows(logs, 'terminal.not_ready');
    expect(notReady).toHaveLength(1);
    expect(notReady[0]?.fields).toMatchObject(scope);
    // The refusal is already a rendered chain from across the RPC, so it rides as the cause.
    expect(notReady[0]?.cause).toContain('attach overran');
  });

  test('a workspace that cannot be reached is reported, not escaped', async () => {
    const { deps, trace } = harness({
      prepare: async () => { throw new Error('the workspace object is not answering'); },
    });

    const { value: response, logs } = await recorded(
      async () => await terminalRequest(attachRequest('executor=sandbox'), deps),
    );

    expect(response?.status).toBe(503);
    expect(String((await body(response)).error)).toContain('not answering');
    expect(trace.calls).toEqual(['prepareTerminal:sandbox']);

    const preflight = terminalRows(logs, 'terminal.preflight_failed');
    expect(preflight).toHaveLength(1);
    expect(preflight[0]?.fields).toMatchObject(scope);
    expect(preflight[0]?.code).toBe('unavailable');
  });

  test('the attach carries the SAME two tags, which is what makes it one scope', async () => {
    const { deps } = harness({
      attach: async () => { throw new Error('container is not listening on 3000'); },
    });

    const { logs } = await recorded(
      async () => await terminalRequest(attachRequest('executor=sandbox'), deps),
    );

    const attach = terminalRows(logs, 'terminal.attach_failed');
    expect(attach).toHaveLength(1);
    expect(attach[0]?.fields).toMatchObject(scope);
  });

  test('a line-mode executor is a labelled mode, not a failure row', async () => {
    const { deps } = harness();

    const { logs } = await recorded(
      async () => await terminalRequest(attachRequest('executor=parent'), deps),
    );

    // Line mode is a correct refusal, not a failure: pooling it with defects would make the rate meaningless.
    expect(logs.filter((log) => log.event.startsWith('terminal.'))).toEqual([]);
  });
});

describe('line terminal executor switches', () => {
  test('a new generation clears the prior executor and rejects its completion', () => {
    const state = new LineTerminalState();
    const oldGeneration = state.reset();
    expect(state.recordOutput('old-output')).toBe(true);
    state.append('echo old');
    state.beginCommand();

    const generation = state.reset();

    expect(generation).not.toBe(oldGeneration);
    expect(state.recordOutput('old-output')).toBe(true);
    expect(state.takeCommand()).toBe('');
    expect(state.running).toBe(false);
    expect(state.clearBusy()).toBe(false);
    expect(state.finishCommand(oldGeneration)).toBe(false);
  });
});

describe('an attached terminal and a container that wants to sleep', () => {
  // The SDK renews its activity clock per proxied frame, but `quiesceStep` reads the durable lease, which only an
  // object operation moves: the pane's beat keeps a reading (not typing) user's container awake.
  test('each beat renews the lease', async () => {
    const { deps, trace } = harness();

    const beat = new Request(
      `https://app.example/api/workspaces/${WORKSPACE}/terminal/keepalive?executor=sandbox`,
      { method: 'POST' },
    );

    for (let i = 0; i < 3; i++) {
      const response = await terminalRequest(beat, deps);
      expect(response?.status).toBe(200);
      expect((await body(response)).ok).toBe(true);
    }

    expect(trace.calls).toEqual(['noteTerminalActivity', 'noteTerminalActivity', 'noteTerminalActivity']);
  });

  test('a beat never starts a shell', async () => {
    const { deps, trace } = harness();
    await terminalRequest(
      new Request(`https://app.example/api/workspaces/${WORKSPACE}/terminal/keepalive?executor=sandbox`,
        { method: 'POST' }), deps,
    );
    expect(trace.calls).not.toContain('terminal');
  });

  test('a container that has gone away answers the beat with why', async () => {
    const { deps } = harness({ lease: async () => { throw new Error('attach failed: snapshot not found'); } });

    const response = await terminalRequest(
      new Request(`https://app.example/api/workspaces/${WORKSPACE}/terminal/keepalive?executor=sandbox`,
        { method: 'POST' }), deps,
    );

    expect(response?.status).toBe(503);
    expect(String((await body(response)).error)).toContain('snapshot not found');
  });

  test('a beat for a lane that has no terminal is refused like an attach', async () => {
    const { deps, trace } = harness();

    const response = await terminalRequest(
      new Request(`https://app.example/api/workspaces/${WORKSPACE}/terminal/keepalive?executor=parent`,
        { method: 'POST' }), deps,
    );

    expect(response?.status).toBe(409);
    expect(trace.calls).toEqual([]);
  });
});

describe('the workspace shell', () => {
  test('the upgrade is forwarded into the workspace object once its runtime is composed', async () => {
    const { deps, trace } = harness();

    const response = await terminalRequest(attachRequest('executor=workspace&cols=100&rows=30', {
      headers: { upgrade: 'websocket', 'x-kinu-probe': 'rides-along' },
    }), deps);

    expect(await response?.text()).toBe('workspace-socket');
    expect(trace.calls).toEqual(['prepareTerminal:workspace', 'fetch']);
    const forwarded = new URL(trace.forwarded?.url ?? '');
    expect(forwarded.pathname).toBe(WORKSPACE_TERMINAL_PATH);
    expect(forwarded.searchParams.get('executor')).toBe('workspace');
    expect(trace.forwarded?.headers.get('upgrade')).toBe('websocket');
    expect(trace.forwarded?.headers.get('x-kinu-probe')).toBe('rides-along');
  });

  test('a runtime that cannot compose is the reason the pane sees, and a fleet row', async () => {
    const { deps, trace } = harness({ prepare: async () => ({ error: 'the workspace database is read-only' }) });

    const { value: response, logs } = await recorded(
      async () => await terminalRequest(attachRequest('executor=workspace'), deps),
    );

    expect(response?.status).toBe(503);
    expect(String((await body(response)).error)).toContain('read-only');
    expect(trace.calls).toEqual(['prepareTerminal:workspace']);
    expect(logs.map((log) => log.event)).toEqual(['terminal.workspace_not_ready']);
  });

  test('the beat and the reset are guards: a POST is acknowledged, nothing else is reached', async () => {
    const { deps, trace } = harness();

    for (const verb of ['keepalive', 'reset']) {
      const acknowledged = await terminalRequest(
        new Request(`https://app.example/api/workspaces/${WORKSPACE}/terminal/${verb}?executor=workspace`, { method: 'POST' }), deps,
      );

      const refused = await terminalRequest(
        new Request(`https://app.example/api/workspaces/${WORKSPACE}/terminal/${verb}?executor=workspace`), deps,
      );

      expect(await body(acknowledged)).toEqual({ ok: true });
      expect(refused?.status).toBe(405);
    }

    expect(trace.calls).toEqual([]);
  });
});

// KINU-036: the request that starts an attach owns it, and `request.signal` says the owner is gone. No outer
// deadline: it would have to exceed a cold container start yet undercut an idle tab.
describe('who owns a terminal attach', () => {
  test('a client already gone opens no session and beats no lease', async () => {
    const { deps, trace } = harness();
    const controller = new AbortController();
    controller.abort();

    const response = await terminalRequest(
      attachRequest('executor=sandbox', { signal: controller.signal }), deps,
    );

    expect(response?.status).toBe(503);
    expect(String((await body(response)).error)).toContain('client disconnected');
    // The preflight is not fenced: the container belongs to the DO and another attach may be waiting on it.
    expect(trace.calls).toEqual(['prepareTerminal:sandbox']);
  });

  test('a client that leaves mid-upgrade gets no shell, and its socket is released', async () => {
    // Every step awaits a signal the code produces, never a clock.
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<Response>();
    const closed = Promise.withResolvers<void>();
    const events: string[] = [];

    const { deps, trace } = harness({
      attach: () => {
        entered.resolve();

        return held.promise;
      },
    });

    const controller = new AbortController();
    const retained: Promise<unknown>[] = [];

    const context: Pick<ExecutionContext, 'waitUntil'> = {
      waitUntil: (promise) => { retained.push(promise); },
    };

    const pending = terminalRequest(
      attachRequest('executor=sandbox', { signal: controller.signal }), deps, context,
    );

    await entered.promise;
    expect(trace.calls).toContain('terminal');
    controller.abort();

    const response = await pending;
    expect(response?.status).toBe(503);
    expect(String((await body(response)).error)).toContain('client disconnected');
    expect(retained).toHaveLength(1);

    // Nobody reads the late socket, so it is taken and closed rather than left for the edge to reap.
    const late = new Response('pty-socket', { status: 200 });
    Object.defineProperty(late, 'webSocket', {
      value: {
        accept: () => { events.push('accept'); },
        close: (code: number, reason: string) => {
          events.push(`close:${code}:${reason}`);
          closed.resolve();
        },
      },
    });
    held.resolve(late);

    // After the response returns, this request-retained promise is what keeps the late socket release alive.
    await retained[0];
    await closed.promise;
    expect(events).toEqual(['accept', 'close:1001:terminal client went away']);
  });

  test('a client that stays gets the SDK response unchanged', async () => {
    const { deps } = harness();
    const controller = new AbortController();

    const response = await terminalRequest(
      attachRequest('executor=sandbox', { signal: controller.signal }), deps,
    );

    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe('pty-socket');
  });
});
