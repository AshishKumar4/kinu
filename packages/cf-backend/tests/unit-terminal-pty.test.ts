/**
 * The terminal's lifecycle at the seam a user actually reaches: attach, write,
 * resize, keepalive, close — and what a sleeping container does to each.
 *
 * The PTY itself belongs to the sandbox SDK (a `Bun.Terminal` in the container,
 * binary frames over one WebSocket, `{type:'resize'}` control frames). What is
 * OURS, and what these tests govern, is everything around it: which
 * environments may have a terminal at all and what each one that may not is
 * missing, that a shell is never opened onto a container whose /workspace has
 * not attached, that the geometry a query string carries is bounded before it
 * reaches the terminal, and that an attached terminal moves the DURABLE lease
 * the container's heartbeat reads — because the SDK's own activity clock is
 * renewed by proxied frames and that clock is not the one that decides whether
 * the container may stop.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import {
  createRecordingLogger, setDiagnosticsSink, type RecordedLog,
} from '@kinu.run/core/obs';
import * as v from 'valibot';
import { LINE_MODE_LABEL, LineTerminalState, terminalLane } from '../src/lib/terminal-lane';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { jsrpcStub } from './helpers/jsrpc-stub';
import { installSandboxSdkMock, setSandboxSdk } from './helpers/sandbox-sdk';

// `getSandbox` resolves through whatever `env.Sandbox` binding each test
// installs, exactly like the SDK's own resolution. The shared stand-in owns
// the module; this file only points it. Reset in `afterAll`, so a later file
// meets the real SDK.
await installSandboxSdkMock();
setSandboxSdk({
  getSandbox: (namespace: NonNullable<Env['Sandbox']>, name: string) =>
    namespace.get(namespace.idFromName(name)),
});
afterAll(() => { setSandboxSdk(null); });

// The route imports `getAgentByName` from `agents`, whose module graph reaches
// `cloudflare:email`. One shared mock, then the dynamic import — the ordering
// every cf-backend route test uses.
mockAgentsSdk();

const { handleTerminalRequest } = await import('../src/terminal-route');

/** The vocabulary a person is never shown: our primitives, our transports, our
 *  missing methods. Read by the label case and by the route's refusal body. */
const FORBIDDEN_IN_COPY = /pty|pseudo-terminal|JSON-RPC|daemon|Nimbus|startProcess|stdin|resize|socket/i;

interface PtySize { cols?: number; rows?: number; shell?: string }

interface TerminalDouble {
  noteTerminalActivity(): Promise<void>;
  getSession(sessionId: string): Promise<{ terminal(request: Request, options?: PtySize): Promise<Response> }>;
}

/** What the container and the workspace were asked to do, in order. The order
 *  is the contract: a PTY opened before the workspace attached is a shell onto
 *  the wrong disk, and one opened before egress is installed is a shell with no
 *  network. */
interface Trace {
  readonly calls: string[];
  /** The `PtyOptions` the SDK was handed on the last attach, if any. */
  options: PtySize | undefined;
  /** The upgrade request the SDK was handed, if any. */
  request: Request | undefined;
  /** The session the PTY was opened in. A user's terminal must not land in the
   *  agent's own exec session, where one long agent command would swallow the
   *  user's keystrokes. */
  session: string | undefined;
}

interface Harness {
  readonly env: Env;
  readonly trace: Trace;
}

/**
 * A workspace whose container answers, unless a failure is asked for.
 *
 * The container double is a `jsrpcStub`: a real binding hands back an object
 * whose methods are not own enumerable properties, and an object literal is the
 * shape that let four production TypeErrors pass their tests.
 */
function harness(opts: {
  prepare?: () => Promise<{ ok: true } | { error: string }>;
  lease?: () => Promise<void>;
  attach?: () => Promise<Response>;
  sandboxBound?: boolean;
} = {}): Harness {
  const trace: Trace = { calls: [], options: undefined, request: undefined, session: undefined };
  const container = jsrpcStub<TerminalDouble>({
    noteTerminalActivity: async () => {
      trace.calls.push('noteTerminalActivity');
      if (opts.lease) await opts.lease();
    },
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
            // A 101 cannot be constructed without a real WebSocketPair, so the
            // double answers with a body that proves the SDK's response is the
            // one the route returns unchanged.
            : new Response('pty-socket', { status: 200 });
        },
      };
    },
  });
  // `getAgentByName` resolves through the namespace binding, so the workspace
  // double is reached exactly the way production reaches it — through a stub
  // whose methods are not own enumerable properties.
  const agent = jsrpcStub({
    prepareTerminal: async (executorId: string) => {
      trace.calls.push(`prepareTerminal:${executorId}`);
      return opts.prepare ? await opts.prepare() : { ok: true as const };
    },
  });
  // The doubles are deliberately NOT typed as the bindings they stand in for:
  // a fake `idFromName` returning the name can never satisfy `DurableObjectId`,
  // and `jsrpcStub`'s prototype-bound methods can never satisfy
  // `DurableObjectStub` — that mismatch IS the double. `Object.assign` is what
  // lets the members land without the type system adjudicating the fakes.
  const view: Partial<Env> = {};
  Object.assign(view, {
    OrchestratorAgent: { idFromName: (name: string) => name, get: () => agent },
  });
  if (opts.sandboxBound !== false) {
    Object.assign(view, {
      Sandbox: { idFromName: (name: string) => name, get: () => container },
    });
  }
  // SAFETY: both members the route reads are constructed by the Object.assigns
  // above — `OrchestratorAgent.get` (returning the `prepareTerminal` double)
  // and `Sandbox.get` (returning the container double) are the complete set
  // `handleTerminalRequest` touches, verified against its body. The
  // `sandboxBound: false` arm omits `Sandbox` deliberately and pins the 503
  // that omission produces. Nothing unassigned is reachable through this cast.
  return { env: view as Env, trace };
}

const WORKSPACE = 'kinu-main';

/** Ordinary route calls do not leave background work; the abandonment case below
 * supplies its own recorder so it can prove cleanup survives the response. */
function executionContext(): Pick<ExecutionContext, 'waitUntil'> {
  return { waitUntil: () => {} };
}

function terminalRequest(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, 'waitUntil'> = executionContext(),
): Promise<Response | null> {
  return handleTerminalRequest(request, env, WORKSPACE, ctx);
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

describe('which environments can have a terminal', () => {
  test('the container and the owner machine are the PTY lanes', () => {
    expect(terminalLane('sandbox')).toEqual({ mode: 'pty' });
    expect(terminalLane('laptop')).toEqual({ mode: 'pty' });
  });

  // THE CONTRACT CHANGED HERE, and this case is what enforces the new one.
  // Until 2026-09-02 a line lane carried a `missing` sentence and the pane
  // printed it, so the bar read "the device daemon's JSON-RPC surface has no
  // pty method …" next to the mode. The owner's product rule forbids that: a
  // label states what a person is in, never our missing methods. So the lane
  // carries a mode and nothing else, and there is no field a sentence can
  // reach the screen through.
  //
  // `laptop` left this list on 2026-09-03, when the machine's own agent grew a
  // real terminal. The lane table states what an ENVIRONMENT can give; whether
  // one particular machine is attached right now is the route's preflight.
  test.each(['workspace', 'parent', 'something-invented'])(
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
    const { env } = harness();
    const response = await terminalRequest(
      new Request(`https://app.example/api/workspaces/${WORKSPACE}/files?path=/x`), env,
    );
    expect(response).toBeNull();
  });

  test('the container is prepared before the shell opens onto it', async () => {
    const { env, trace } = harness();
    const response = await terminalRequest(attachRequest('executor=sandbox&cols=120&rows=40'), env);
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe('pty-socket');
    // prepareTerminal is the sandbox lane's own preflight (egress installed
    // with this workspace's grants, /workspace attached). It has to be settled
    // before the PTY exists, and the lease has to be stamped before the socket
    // is handed over, or the first heartbeat can stop the container under it.
    expect(trace.calls).toEqual(['prepareTerminal:sandbox', 'noteTerminalActivity', 'getSession', 'terminal']);
  });

  test('the shell is the user\'s own session, not the one the agent execs in', async () => {
    const { env, trace } = harness();
    await terminalRequest(attachRequest('executor=sandbox'), env);
    // A named session, and a STABLE one: a reload has to land on the shell that
    // is already running so the container replays its buffer into it. The SDK's
    // default session (`sandbox-<id>`) is the agent's exec lane and must not be
    // it — one session holds one PTY and one foreground process, so sharing it
    // sends the user's keystrokes into whatever the agent is running.
    expect(trace.session).toBe('kinu-terminal');
    expect(trace.session).not.toContain('sandbox-');
  });

  test('two attaches land in the same session, so a reload reattaches', async () => {
    const { env, trace } = harness();
    await terminalRequest(attachRequest('executor=sandbox'), env);
    const first = trace.session;
    await terminalRequest(attachRequest('executor=sandbox'), env);
    expect(trace.session).toBe(first);
  });

  test('the geometry the client asks for reaches the terminal', async () => {
    const { env, trace } = harness();
    await terminalRequest(attachRequest('executor=sandbox&cols=120&rows=40'), env);
    expect(trace.options).toEqual({ cols: 120, rows: 40 });
  });

  test('a shell is never named: the container picks it, and TERM with it', async () => {
    const { env, trace } = harness();
    await terminalRequest(attachRequest('executor=sandbox'), env);
    // No `shell` key at all. `PtyOptions.shell` is spawned as one argv token,
    // so `bash -l` would be an ENOENT rather than a login shell; the container's
    // own default is bash and it sets TERM=xterm-256color regardless.
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
    const { env, trace } = harness();
    await terminalRequest(attachRequest(`executor=sandbox&${query}`), env);
    expect(trace.options).toEqual(expected);
  });

  test('the upgrade the SDK proxies is the same request, minus the caller\'s credentials', async () => {
    const { env, trace } = harness();
    const request = attachRequest('executor=sandbox', {
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-version': '13',
        'sec-websocket-protocol': 'pty',
        // What a browser and server.ts put on this request in production: the
        // session cookie the SPA authenticates with, and the identity header the
        // worker appends for the DO hop. A container runs agent-chosen code, so
        // neither may reach it.
        cookie: '__Host-kinu_session=s3cr3t; other=v',
        authorization: 'Bearer pta_notyours',
        'x-kinu-user-id': 'u_1',
        'x-kinu-auth-time': '1700000000000',
      },
    });
    await terminalRequest(request, env);
    const forwarded = trace.request;
    if (!forwarded) throw new Error('the SDK was never handed an upgrade');
    expect(forwarded.url).toBe(request.url);
    expect([...forwarded.headers.keys()].sort()).toEqual([
      'connection', 'sec-websocket-protocol', 'sec-websocket-version', 'upgrade',
    ]);
  });

  test('a request that is not an upgrade touches nothing', async () => {
    const { env, trace } = harness();
    const response = await terminalRequest(
      new Request(`https://app.example/api/workspaces/${WORKSPACE}/terminal?executor=sandbox`), env,
    );
    expect(response?.status).toBe(400);
    // Not merely a refusal: a plain GET must not start a container.
    expect(trace.calls).toEqual([]);
  });

  test('an executor with no terminal is refused as line mode, carrying no implementation detail', async () => {
    const { env, trace } = harness();
    const response = await terminalRequest(attachRequest('executor=workspace'), env);
    expect(response?.status).toBe(409);
    const payload = await body(response);
    expect(payload.lane).toBe('line');
    expect(payload.missing).toBeUndefined();
    expect(JSON.stringify(payload)).not.toMatch(FORBIDDEN_IN_COPY);
    expect(trace.calls).toEqual([]);
  });

  test('no executor is named', async () => {
    const { env } = harness();
    const response = await terminalRequest(attachRequest(''), env);
    expect(response?.status).toBe(400);
    expect(String((await body(response)).error)).toContain('executor');
  });

  test('a deployment with no container binding says so', async () => {
    const { env } = harness({ sandboxBound: false });
    const response = await terminalRequest(attachRequest('executor=sandbox'), env);
    expect(response?.status).toBe(503);
    expect(String((await body(response)).error)).toContain('Sandbox binding');
  });

  test('a workspace that cannot attach its disk gets the reason, not a shell', async () => {
    const { env, trace } = harness({
      prepare: async () => ({ error: 'attach overran its budget; a retry is scheduled' }),
    });
    const response = await terminalRequest(attachRequest('executor=sandbox'), env);
    expect(response?.status).toBe(503);
    expect(String((await body(response)).error)).toContain('attach overran');
    // The whole point: no PTY onto a container whose /workspace is not there.
    expect(trace.calls).toEqual(['prepareTerminal:sandbox']);
  });

  test('a container that fails the attach reports it rather than hanging', async () => {
    const { env } = harness({ attach: async () => { throw new Error('container is not listening on 3000'); } });
    const response = await terminalRequest(attachRequest('executor=sandbox'), env);
    expect(response?.status).toBe(503);
    expect(String((await body(response)).error)).toContain('not listening');
  });
});

/**
 * Which failures on this route can be traced back to a workspace.
 *
 * The attach's own failures carried the workspace and the executor; the
 * PREFLIGHT's did not, and the preflight is how a terminal most often fails to
 * open. A readiness refusal was rendered to the pane and recorded nowhere, and a
 * workspace object that could not be reached escaped the handler with no cause
 * chain either. Every case below asserts the pair of tags, because a fleet row
 * for "a terminal did not open" that cannot say WHOSE is a row nobody can act
 * on. The control flow is asserted alongside each one: the diagnostic is an
 * addition to this route, never a change to what it answers or to the order in
 * which the container is touched.
 */
describe('a terminal failure names the workspace and the executor', () => {
  /** What `body` answered AND what the diagnostic sink was told while it ran.
   *  Both from one seam: every case here asserts the client's answer as well as
   *  the fleet row, and returning the value is what keeps the response properly
   *  typed instead of assigned out through a widened binding. */
  async function recorded<T>(body: () => Promise<T>): Promise<{
    readonly value: T;
    readonly logs: readonly RecordedLog[];
  }> {
    const logger = createRecordingLogger();
    const restore = setDiagnosticsSink(logger);
    try {
      return { value: await body(), logs: logger.emitted };
    } finally {
      restore();
    }
  }

  /** The `terminal.*` rows one case produced, by event name. */
  function terminalRows(
    logs: readonly RecordedLog[], event: string,
  ): readonly RecordedLog[] {
    return logs.filter((log) => log.event === event);
  }

  const scope = { workspace: WORKSPACE, executor: 'sandbox' };

  test('a readiness refusal is a fleet row, and still the same answer to the client', async () => {
    const { env, trace } = harness({
      prepare: async () => ({ error: 'attach overran its budget; a retry is scheduled' }),
    });

    const { value: response, logs } = await recorded(
      async () => await terminalRequest(attachRequest('executor=sandbox'), env),
    );

    // Unchanged: the pane shows what it always showed.
    expect(response?.status).toBe(503);
    expect(String((await body(response)).error)).toContain('attach overran');
    // And the fence has not moved: no session, no lease beat, no PTY.
    expect(trace.calls).toEqual(['prepareTerminal:sandbox']);

    const notReady = terminalRows(logs, 'terminal.not_ready');
    expect(notReady).toHaveLength(1);
    expect(notReady[0]?.fields).toMatchObject(scope);
    // The refusal is already a rendered chain from the other side of the RPC, so
    // it rides as the cause rather than being restated.
    expect(notReady[0]?.cause).toContain('attach overran');
  });

  test('a workspace that cannot be reached is reported, not escaped', async () => {
    const { env, trace } = harness({
      prepare: async () => { throw new Error('the workspace object is not answering'); },
    });

    const { value: response, logs } = await recorded(
      async () => await terminalRequest(attachRequest('executor=sandbox'), env),
    );

    // An answer rather than a throw out of the handler, with the whole chain.
    expect(response?.status).toBe(503);
    expect(String((await body(response)).error)).toContain('not answering');
    expect(trace.calls).toEqual(['prepareTerminal:sandbox']);

    const preflight = terminalRows(logs, 'terminal.preflight_failed');
    expect(preflight).toHaveLength(1);
    expect(preflight[0]?.fields).toMatchObject(scope);
    expect(preflight[0]?.code).toBe('unavailable');
  });

  test('the attach carries the SAME two tags, which is what makes it one scope', async () => {
    const { env } = harness({
      attach: async () => { throw new Error('container is not listening on 3000'); },
    });

    const { logs } = await recorded(
      async () => await terminalRequest(attachRequest('executor=sandbox'), env),
    );

    // The parity assertion. Before this change the preflight and the attach
    // disagreed about what a terminal failure is correlated by, and the
    // preflight's answer was "nothing".
    const attach = terminalRows(logs, 'terminal.attach_failed');
    expect(attach).toHaveLength(1);
    expect(attach[0]?.fields).toMatchObject(scope);
  });

  test('a line-mode executor is a labelled mode, not a failure row', async () => {
    const { env } = harness();

    const { logs } = await recorded(
      async () => await terminalRequest(attachRequest('executor=workspace'), env),
    );

    // The negative control, and a deliberate boundary: routing to line mode is a
    // correct refusal the pane renders as a mode. Recording it as a failure would
    // pool it with the defects above, and a rate that pools a correct refusal
    // with a defect is worse than no rate.
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

    // Deleting any reset, or accepting a completion from another generation,
    // makes one of the assertions below red.
    expect(generation).not.toBe(oldGeneration);
    expect(state.recordOutput('old-output')).toBe(true);
    expect(state.takeCommand()).toBe('');
    expect(state.running).toBe(false);
    expect(state.clearBusy()).toBe(false);
    expect(state.finishCommand(oldGeneration)).toBe(false);
  });
});

describe('an attached terminal and a container that wants to sleep', () => {
  // The SDK renews its own activity clock on every frame the container proxy
  // forwards, but the durable lease that `quiesceStep` reads is only moved by an
  // operation on the object. So the pane's beat is the ONLY thing that keeps a
  // container awake for a user who is reading rather than typing.
  test('each beat renews the lease', async () => {
    const { env, trace } = harness();
    const beat = new Request(
      `https://app.example/api/workspaces/${WORKSPACE}/terminal/keepalive?executor=sandbox`,
      { method: 'POST' },
    );
    for (let i = 0; i < 3; i++) {
      const response = await terminalRequest(beat, env);
      expect(response?.status).toBe(200);
      expect((await body(response)).ok).toBe(true);
    }
    expect(trace.calls).toEqual(['noteTerminalActivity', 'noteTerminalActivity', 'noteTerminalActivity']);
  });

  test('a beat never starts a shell', async () => {
    const { env, trace } = harness();
    await terminalRequest(
      new Request(`https://app.example/api/workspaces/${WORKSPACE}/terminal/keepalive?executor=sandbox`,
        { method: 'POST' }), env,
    );
    expect(trace.calls).not.toContain('terminal');
  });

  test('a beat is a POST', async () => {
    const { env, trace } = harness();
    const response = await terminalRequest(
      new Request(`https://app.example/api/workspaces/${WORKSPACE}/terminal/keepalive?executor=sandbox`), env,
    );
    expect(response?.status).toBe(405);
    expect(trace.calls).toEqual([]);
  });

  test('a container that has gone away answers the beat with why', async () => {
    const { env } = harness({ lease: async () => { throw new Error('attach failed: snapshot not found'); } });
    const response = await terminalRequest(
      new Request(`https://app.example/api/workspaces/${WORKSPACE}/terminal/keepalive?executor=sandbox`,
        { method: 'POST' }), env,
    );
    expect(response?.status).toBe(503);
    expect(String((await body(response)).error)).toContain('snapshot not found');
  });

  test('a beat for a lane that has no terminal is refused like an attach', async () => {
    const { env, trace } = harness();
    const response = await terminalRequest(
      new Request(`https://app.example/api/workspaces/${WORKSPACE}/terminal/keepalive?executor=workspace`,
        { method: 'POST' }), env,
    );
    expect(response?.status).toBe(409);
    expect(trace.calls).toEqual([]);
  });
});

// KINU-036. Past the preflight the route had no fence at all: the session and
// the PTY upgrade were awaited unconditionally, so a client that closed its tab
// left a shell being opened for nobody, and a container that never answered
// `/ws/pty` held the request forever. The fix is OWNERSHIP, not a clock — the
// request that starts an attach owns it, and `request.signal` is the platform's
// own statement that the owner is gone. An outer deadline would have to be both
// longer than a cold container start and shorter than an idle tab, which is not
// one number.
describe('who owns a terminal attach', () => {
  test('a client already gone opens no session and beats no lease', async () => {
    const { env, trace } = harness();
    const controller = new AbortController();
    controller.abort();

    const response = await terminalRequest(
      attachRequest('executor=sandbox', { signal: controller.signal }), env,
    );

    expect(response?.status).toBe(503);
    expect(String((await body(response)).error)).toContain('client disconnected');
    // The preflight ran and is deliberately NOT fenced: the container belongs to
    // the Durable Object and another attach may already be waiting on that
    // start. Everything after it creates state for THIS client, so none of it
    // ran.
    expect(trace.calls).toEqual(['prepareTerminal:sandbox']);
  });

  test('a client that leaves mid-upgrade gets no shell, and its socket is released', async () => {
    // Every step is awaited on the signal the code itself produces — the double
    // entering `terminal()`, the late response, the socket being closed — so
    // nothing here waits on a clock.
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<Response>();
    const closed = Promise.withResolvers<void>();
    const events: string[] = [];
    const { env, trace } = harness({
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
      attachRequest('executor=sandbox', { signal: controller.signal }), env, context,
    );
    await entered.promise;
    expect(trace.calls).toContain('terminal');
    // The tab closes while the container is still opening the shell.
    controller.abort();

    const response = await pending;
    expect(response?.status).toBe(503);
    expect(String((await body(response)).error)).toContain('client disconnected');
    expect(retained).toHaveLength(1);

    // The container answers late. Nobody is reading that socket, so this end is
    // taken and closed rather than left for the edge to reap on idleness.
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

    // Await the request-retained cleanup rather than a local scheduling accident:
    // after the response has returned, this is the only promise keeping the
    // late socket release alive across an isolate turn.
    await retained[0];
    await closed.promise;
    expect(events).toEqual(['accept', 'close:1001:terminal client went away']);
  });

  test('a client that stays gets the SDK response unchanged', async () => {
    const { env } = harness();
    const controller = new AbortController();

    const response = await terminalRequest(
      attachRequest('executor=sandbox', { signal: controller.signal }), env,
    );

    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe('pty-socket');
  });
});
