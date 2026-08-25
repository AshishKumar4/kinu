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

import { describe, expect, mock, test } from 'bun:test';
import * as v from 'valibot';
import { terminalLane } from '../src/lib/terminal-lane';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { jsrpcStub } from './helpers/jsrpc-stub';

// `getSandbox` resolves through whatever `env.Sandbox` binding each test
// installs, exactly like the SDK's own resolution — and, as
// unit-nimbus-lifecycle.test.ts records, `mock.module` state is process-wide,
// so this file owns the module for its own run rather than inheriting a
// throwing stub from whichever file bun loaded first.
mock.module('@cloudflare/sandbox', () => ({
  getSandbox: (namespace: SandboxProbe, name: string) => namespace.get(namespace.idFromName(name)),
  Sandbox: class {},
  proxyToSandbox: () => { throw new Error('proxyToSandbox is not exercised by this suite.'); },
}));

// The route imports `getAgentByName` from `agents`, whose module graph reaches
// `cloudflare:email`. One shared mock, then the dynamic import — the ordering
// every cf-backend route test uses.
mockAgentsSdk();

const { handleTerminalRequest } = await import('../src/terminal-route');

interface SandboxProbe {
  idFromName(name: string): string;
  get(id: string): TerminalDouble;
}

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
  test('the sandbox container is the one PTY lane', () => {
    expect(terminalLane('sandbox')).toEqual({ mode: 'pty' });
  });

  // The point of the whole lane table: a lane with no pseudo-terminal says what
  // it is missing instead of emulating one. An empty or generic reason is the
  // fake-shell defect wearing a label.
  test.each(['workspace', 'laptop', 'parent', 'something-invented'])(
    '%s is line mode and names the primitive it lacks',
    (executor) => {
      const lane = terminalLane(executor);
      expect(lane.mode).toBe('line');
      if (lane.mode !== 'line') return;
      expect(lane.missing.length).toBeGreaterThan(20);
      expect(lane.missing).not.toBe('unsupported');
    },
  );

  test('the missing primitive is specific to the environment', () => {
    const workspace = terminalLane('workspace');
    const laptop = terminalLane('laptop');
    if (workspace.mode !== 'line' || laptop.mode !== 'line') throw new Error('both are line lanes');
    expect(workspace.missing).not.toBe(laptop.missing);
    expect(workspace.missing).toContain('pseudo-terminal');
    expect(laptop.missing).toContain('pty');
  });
});

describe('attaching a terminal', () => {
  test('another path under the same workspace is left to the next handler', async () => {
    const { env } = harness();
    const response = await handleTerminalRequest(
      new Request(`https://app.example/api/workspaces/${WORKSPACE}/files?path=/x`), env, WORKSPACE,
    );
    expect(response).toBeNull();
  });

  test('the container is prepared before the shell opens onto it', async () => {
    const { env, trace } = harness();
    const response = await handleTerminalRequest(attachRequest('executor=sandbox&cols=120&rows=40'), env, WORKSPACE);
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
    await handleTerminalRequest(attachRequest('executor=sandbox'), env, WORKSPACE);
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
    await handleTerminalRequest(attachRequest('executor=sandbox'), env, WORKSPACE);
    const first = trace.session;
    await handleTerminalRequest(attachRequest('executor=sandbox'), env, WORKSPACE);
    expect(trace.session).toBe(first);
  });

  test('the geometry the client asks for reaches the terminal', async () => {
    const { env, trace } = harness();
    await handleTerminalRequest(attachRequest('executor=sandbox&cols=120&rows=40'), env, WORKSPACE);
    expect(trace.options).toEqual({ cols: 120, rows: 40 });
  });

  test('a shell is never named: the container picks it, and TERM with it', async () => {
    const { env, trace } = harness();
    await handleTerminalRequest(attachRequest('executor=sandbox'), env, WORKSPACE);
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
    await handleTerminalRequest(attachRequest(`executor=sandbox&${query}`), env, WORKSPACE);
    expect(trace.options).toEqual(expected);
  });

  test('the upgrade request itself is what the SDK proxies', async () => {
    const { env, trace } = harness();
    const request = attachRequest('executor=sandbox');
    await handleTerminalRequest(request, env, WORKSPACE);
    expect(trace.request).toBe(request);
  });

  test('a request that is not an upgrade touches nothing', async () => {
    const { env, trace } = harness();
    const response = await handleTerminalRequest(
      new Request(`https://app.example/api/workspaces/${WORKSPACE}/terminal?executor=sandbox`), env, WORKSPACE,
    );
    expect(response?.status).toBe(400);
    // Not merely a refusal: a plain GET must not start a container.
    expect(trace.calls).toEqual([]);
  });

  test('an executor with no terminal is refused with what it is missing', async () => {
    const { env, trace } = harness();
    const response = await handleTerminalRequest(attachRequest('executor=laptop'), env, WORKSPACE);
    expect(response?.status).toBe(409);
    const payload = await body(response);
    expect(payload.lane).toBe('line');
    expect(String(payload.missing)).toContain('pty');
    expect(trace.calls).toEqual([]);
  });

  test('no executor is named', async () => {
    const { env } = harness();
    const response = await handleTerminalRequest(attachRequest(''), env, WORKSPACE);
    expect(response?.status).toBe(400);
    expect(String((await body(response)).error)).toContain('executor');
  });

  test('a deployment with no container binding says so', async () => {
    const { env } = harness({ sandboxBound: false });
    const response = await handleTerminalRequest(attachRequest('executor=sandbox'), env, WORKSPACE);
    expect(response?.status).toBe(503);
    expect(String((await body(response)).error)).toContain('Sandbox binding');
  });

  test('a workspace that cannot attach its disk gets the reason, not a shell', async () => {
    const { env, trace } = harness({
      prepare: async () => ({ error: 'attach overran its budget; a retry is scheduled' }),
    });
    const response = await handleTerminalRequest(attachRequest('executor=sandbox'), env, WORKSPACE);
    expect(response?.status).toBe(503);
    expect(String((await body(response)).error)).toContain('attach overran');
    // The whole point: no PTY onto a container whose /workspace is not there.
    expect(trace.calls).toEqual(['prepareTerminal:sandbox']);
  });

  test('a container that fails the attach reports it rather than hanging', async () => {
    const { env } = harness({ attach: async () => { throw new Error('container is not listening on 3000'); } });
    const response = await handleTerminalRequest(attachRequest('executor=sandbox'), env, WORKSPACE);
    expect(response?.status).toBe(503);
    expect(String((await body(response)).error)).toContain('not listening');
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
      const response = await handleTerminalRequest(beat, env, WORKSPACE);
      expect(response?.status).toBe(200);
      expect((await body(response)).ok).toBe(true);
    }
    expect(trace.calls).toEqual(['noteTerminalActivity', 'noteTerminalActivity', 'noteTerminalActivity']);
  });

  test('a beat never starts a shell', async () => {
    const { env, trace } = harness();
    await handleTerminalRequest(
      new Request(`https://app.example/api/workspaces/${WORKSPACE}/terminal/keepalive?executor=sandbox`,
        { method: 'POST' }), env, WORKSPACE,
    );
    expect(trace.calls).not.toContain('terminal');
  });

  test('a beat is a POST', async () => {
    const { env, trace } = harness();
    const response = await handleTerminalRequest(
      new Request(`https://app.example/api/workspaces/${WORKSPACE}/terminal/keepalive?executor=sandbox`), env, WORKSPACE,
    );
    expect(response?.status).toBe(405);
    expect(trace.calls).toEqual([]);
  });

  test('a container that has gone away answers the beat with why', async () => {
    const { env } = harness({ lease: async () => { throw new Error('attach failed: snapshot not found'); } });
    const response = await handleTerminalRequest(
      new Request(`https://app.example/api/workspaces/${WORKSPACE}/terminal/keepalive?executor=sandbox`,
        { method: 'POST' }), env, WORKSPACE,
    );
    expect(response?.status).toBe(503);
    expect(String((await body(response)).error)).toContain('snapshot not found');
  });

  test('a beat for a lane that has no terminal is refused like an attach', async () => {
    const { env, trace } = harness();
    const response = await handleTerminalRequest(
      new Request(`https://app.example/api/workspaces/${WORKSPACE}/terminal/keepalive?executor=workspace`,
        { method: 'POST' }), env, WORKSPACE,
    );
    expect(response?.status).toBe(409);
    expect(trace.calls).toEqual([]);
  });
});
