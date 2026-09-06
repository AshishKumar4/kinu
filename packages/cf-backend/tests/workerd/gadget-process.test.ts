/**
 * The gadget server boundary, executed under the runtime that enforces it.
 *
 * WHY THE WORKERD POOL. A gadget server runs as a resident process of the
 * owning object, booted through the fabric, and every binding in its `env`
 * is a loopback entrypoint that calls back into the owner over a stub. The
 * loader, the process lifetime and the entrypoint hop are all platform:
 * `bun test` has none of them, so nothing there can say what a server can
 * reach. The pool is the only tier that can.
 *
 * WHAT THE PROBE DRIVES. A real `GadgetHost` over the real file plane on the
 * probe's own SQLite, minting each binding from this test worker's own
 * `exports` exactly as production mints from the Worker's, a router of two
 * executor providers gated the way the agent's own are, a fixed
 * `listBackgroundJobs` answer and a recording MCP port. The assertions below
 * are the pairs that discriminate: the workspace's own network reachable
 * beside a file read that answers, a shell command that runs beside one the
 * executor's own gate parks, a listed member beside an unlisted one, a
 * declared `env` beside everything else, and one app composing another
 * beside the cycle that closes on itself.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { GADGET_LIMITS, type GadgetCallResult, type JsonValue } from '@kinu.run/core';
import {
  PROBE_JOBS, PROBE_MCP_TOOL, PROBE_PARKED_ID, type GadgetProcessProbeRpc,
} from './gadget-process-probe';

const SERVER_JS = `import { RpcTarget } from './capnweb.js';
export class Gadget extends RpcTarget {
  constructor(env) { super(); this.env = env; }
  async echo(x) { return 'echo:' + x; }
  async boom() { throw new Error('plain boom'); }
  async tick() {
    globalThis.__tick = (globalThis.__tick ?? 0) + 1;
    return globalThis.__tick;
  }
  async egress() { try { const r = await fetch('https://example.com'); return 'reached: ' + r.status; } catch (e) { return 'blocked: ' + e.message; } }
  async storageAuthority() { return typeof this.ctx; }
  async shell(command) { return await this.env.WS.exec(command); }
  async readFile(p) { return await this.env.WS.readFile(p); }
  async writeFile(p, t) { return await this.env.WS.writeFile(p, t); }
  async sandbox(command) { return await this.env.SANDBOX.exec(command); }
  async sandboxRead(p) { return await this.env.SANDBOX.readFile(p); }
  async data(method) { return await this.env.DATA[method](); }
  async ambient() { return Object.keys(this.env).sort(); }
  async mcp(tool, args) { return await this.env.GITHUB[tool](args ?? {}); }
  async inner(method, ...args) { return await this.env.INNER[method](...args); }
  async loop(n) { return await this.env.INNER.loop(n + 1); }
}
`;

const SERVER_V2 = SERVER_JS.replace("return 'echo:' + x", "return 'v2:' + x");

/** The app `probe` composes: it answers, and it binds `probe` back so a
 *  `loop` between the two never ends on its own. */
const INNER_SERVER_JS = `import { RpcTarget } from './capnweb.js';
export class Gadget extends RpcTarget {
  constructor(env) { super(); this.env = env; }
  async echo(x) { return 'inner:' + x; }
  async loop(n) { return await this.env.OUTER.loop(n + 1); }
}
`;

const MANIFEST = {
  v: 1,
  title: 'Probe',
  bindings: {
    WS: { kind: 'namespace', namespace: 'workspace' },
    SANDBOX: { kind: 'namespace', namespace: 'sandbox', members: ['exec'] },
    DATA: { kind: 'rpc', methods: ['listBackgroundJobs'] },
    GITHUB: { kind: 'mcp', server: 'github' },
    INNER: { kind: 'app', id: 'inner' },
  },
};

const INNER_MANIFEST = {
  v: 1,
  title: 'Inner',
  bindings: { OUTER: { kind: 'app', id: 'probe' } },
};

/** The call's value, or a failure naming the refusal instead of the shape. */
function valueOf(result: GadgetCallResult): JsonValue {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.error}`);
  return result.value;
}

/** The call's refusal, or a failure naming the value it answered instead. */
function refusalOf(result: GadgetCallResult): Extract<GadgetCallResult, { ok: false }> {
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.value)}`);
  return result;
}

describe('the gadget server boundary under workerd', () => {
  // The binding is bare (`./env.d.ts`), so the stub is re-read as the probe's
  // narrow RPC view here rather than called through its mapped stub type.
  const open = (name: string): GadgetProcessProbeRpc => {
    const stub = env.GADGET_PROCESS_PROBE.get(env.GADGET_PROCESS_PROBE.idFromName(name));
    // SAFETY: the binding the test worker guarantees serves GadgetProcessProbeDO
    // (vitest.config.ts names its class), whose six methods match this view exactly.
    // The stub parks in `unknown` because calling through its mapped stub type makes
    // type instantiation excessively deep (TS2589); the methods it answers are
    // verified against the probe class, not parsed here.
    const untyped = stub as unknown;
    // SAFETY: the same stub the binding guarantees, re-read here as the narrow view.
    return untyped as GadgetProcessProbeRpc;
  };

  async function seed(name: string, serverJs: string = SERVER_JS) {
    const subject = open(name);
    await subject.writeGadget('probe', {
      'gadget.json': JSON.stringify(MANIFEST),
      'server.js': serverJs,
      'data/note.txt': 'probe data\n',
    });
    await subject.writeGadget('inner', {
      'gadget.json': JSON.stringify(INNER_MANIFEST),
      'server.js': INNER_SERVER_JS,
    });
    return subject;
  }

  it('answers a method through the resident process', async () => {
    const subject = await seed('gadget-process-echo');
    expect(valueOf(await subject.gadgetCall('probe', 'echo', ['ping']))).toBe('echo:ping');
  });

  it('answers a plain server throw as io', async () => {
    const subject = await seed('gadget-process-boom');
    const refusal = refusalOf(await subject.gadgetCall('probe', 'boom', []));
    expect(refusal.error).toContain('plain boom');
  });

  it('runs each call against the server exactly once', async () => {
    const subject = await seed('gadget-process-tick');
    expect(valueOf(await subject.gadgetCall('probe', 'tick', []))).toBe(1);
    expect(valueOf(await subject.gadgetCall('probe', 'tick', []))).toBe(2);
    expect(valueOf(await subject.gadgetCall('probe', 'tick', []))).toBe(3);
  });

  it('reaches the workspace network, and the file plane and the shell through the workspace namespace', async () => {
    const subject = await seed('gadget-process-egress');
    // The server inherits the owner's outbound like every other resident
    // process; what it may NOT do is reach a namespace it did not declare,
    // which the declared-env case below holds. Under miniflare the fetch reaches
    // the loopback and answers; on the platform it reaches the network.
    expect(String(valueOf(await subject.gadgetCall('probe', 'egress', [])))).toMatch(/^reached: /);
    expect(valueOf(await subject.gadgetCall('probe', 'readFile', ['gadgets/probe/data/note.txt']))).toBe('probe data\n');
    expect(valueOf(await subject.gadgetCall('probe', 'writeFile', ['gadgets/probe/data/from-gadget.txt', 'written by gadget'])))
      .toBe('written by gadget');
    expect(valueOf(await subject.gadgetCall('probe', 'readFile', ['gadgets/probe/data/from-gadget.txt']))).toBe('written by gadget');
    expect(valueOf(await subject.gadgetCall('probe', 'shell', ['echo hi']))).toBe('ran: echo hi');
    expect(await subject.readShellCommands()).toEqual(['echo hi']);
  });

  it('parks a sandbox command on the executor\'s own gate and tells the app it did not run', async () => {
    const subject = await seed('gadget-process-sandbox');
    expect(valueOf(await subject.gadgetCall('probe', 'sandbox', ['ls']))).toBe('sandbox ran: ls');
    // A force-push reaches past the machine, so the sandbox provider's own gate
    // (the one codemode's `sandbox.exec` answers to) parks it on the owner.
    // The app is told exactly that, never that it ran.
    const parked = String(valueOf(await subject.gadgetCall('probe', 'sandbox', ['git push --force origin main'])));
    expect(parked).toContain('NOT RUN');
    expect(parked).toContain(PROBE_PARKED_ID);
    expect(await subject.readParked()).toEqual([{ command: 'git push --force origin main', executor: 'sandbox' }]);
    expect(await subject.readShellCommands()).toEqual(['sandbox:ls']);
  });

  it('denies a namespace member the manifest did not list, and a namespace the workspace lacks', async () => {
    const subject = await seed('gadget-process-members');
    const withheld = refusalOf(await subject.gadgetCall('probe', 'sandboxRead', ['x']));
    expect(withheld.error).toContain('denied');
    expect(withheld.error).toContain('exec');
    await subject.writeGadget('probe', {
      'gadget.json': JSON.stringify({
        ...MANIFEST, bindings: { ...MANIFEST.bindings, WS: { kind: 'namespace', namespace: 'laptop' } },
      }),
    });
    const absent = refusalOf(await subject.gadgetCall('probe', 'shell', ['echo hi']));
    expect(absent.error).toContain('unavailable');
    expect(absent.error).toContain('laptop');
  });

  it('answers a declared read model and denies one the manifest did not list', async () => {
    const subject = await seed('gadget-process-data');
    expect(valueOf(await subject.gadgetCall('probe', 'data', ['listBackgroundJobs']))).toEqual(PROBE_JOBS);
    const refusal = refusalOf(await subject.gadgetCall('probe', 'data', ['getExecutors']));
    expect(refusal.error).toContain('denied');
  });

  it('hands the process only its declared bindings', async () => {
    const subject = await seed('gadget-process-ambient');
    expect(valueOf(await subject.gadgetCall('probe', 'ambient', []))).toEqual(['DATA', 'GITHUB', 'INNER', 'SANDBOX', 'WS']);
  });

  it('calls an MCP tool on the named connection exactly as the agent would', async () => {
    const subject = await seed('gadget-process-mcp');
    expect(valueOf(await subject.gadgetCall('probe', 'mcp', [PROBE_MCP_TOOL, { id: 7 }]))).toEqual({
      called: PROBE_MCP_TOOL, args: { id: 7 },
    });
    expect(await subject.readMcpCalls()).toEqual([`github/${PROBE_MCP_TOOL}`]);
  });

  it('composes another app over the same call path and refuses a cycle by depth', async () => {
    const subject = await seed('gadget-process-compose');
    expect(valueOf(await subject.gadgetCall('probe', 'inner', ['echo', 'x']))).toBe('inner:x');
    const cycle = refusalOf(await subject.gadgetCall('probe', 'loop', [0]));
    expect(cycle.error).toContain(`app hop ${GADGET_LIMITS.appDepth + 1}`);
    expect(cycle.error).toContain('cycle');
    // Both servers stayed up: a refused hop is the app's own error, not a dead process.
    expect(valueOf(await subject.gadgetCall('probe', 'inner', ['echo', 'again']))).toBe('inner:again');
  });

  it('answers denied on the binding hop itself, with the exact class', async () => {
    // The same refusals as the entrypoints reach them: no isolate in
    // between, so the deciding hop's own class is what the test reads.
    const subject = await seed('gadget-process-hop');
    const member = await subject.gadgetBindingCall('probe', 'SANDBOX', { member: 'readFile', args: ['x'], depth: 0 });
    expect(refusalOf(member).reason).toBe('denied');
    const data = await subject.gadgetBindingCall('probe', 'DATA', { member: 'getExecutors', args: [], depth: 0 });
    expect(refusalOf(data).reason).toBe('denied');
    const undeclared = await subject.gadgetBindingCall('probe', 'FILES', { member: 'read', args: ['x'], depth: 0 });
    expect(refusalOf(undeclared).reason).toBe('denied');
    const deep = await subject.gadgetBindingCall('probe', 'INNER', { member: 'echo', args: ['x'], depth: GADGET_LIMITS.appDepth });
    expect(refusalOf(deep).reason).toBe('denied');
    const malformed = await subject.gadgetBindingCall('probe', 'WS', { member: 'exec', args: 'ls', depth: 0 });
    expect(refusalOf(malformed).reason).toBe('bad_input');
  });

  it('runs with no ctx of its own', async () => {
    const subject = await seed('gadget-process-storage');
    expect(valueOf(await subject.gadgetCall('probe', 'storageAuthority', []))).toBe('undefined');
  });

  it('refuses the constructor and private names before any process boots', async () => {
    const subject = await seed('gadget-process-names');
    expect(refusalOf(await subject.gadgetCall('probe', 'constructor', [])).reason).toBe('bad_input');
    expect(refusalOf(await subject.gadgetCall('probe', '_private', [])).reason).toBe('bad_input');
  });

  it('forwards a formerly reserved name to the server', async () => {
    // The server is a Cap'n Web target, not a Durable Object: `fetch` is an
    // ordinary method name now. The probe server defines no such method, so
    // the call fails past the bridge as `io`.
    const subject = await seed('gadget-process-fetch');
    expect(refusalOf(await subject.gadgetCall('probe', 'fetch', [])).reason).toBe('io');
  });

  it('boots the new server after a rewrite', async () => {
    const subject = await seed('gadget-process-rewrite');
    expect(valueOf(await subject.gadgetCall('probe', 'echo', ['ping']))).toBe('echo:ping');
    await subject.writeGadget('probe', { 'server.js': SERVER_V2 });
    expect(valueOf(await subject.gadgetCall('probe', 'echo', ['ping']))).toBe('v2:ping');
  });

  it('refuses a server written against the bare specifier', async () => {
    // The docs name `./capnweb.js` because the boot map carries that key and
    // the loader resolves nothing else: a server written the old way never
    // boots, and the call answers `io` naming the missing module. If the
    // platform ever resolves bare specifiers, this test goes red to say the
    // docs may relax.
    const bare = SERVER_JS.replace("from './capnweb.js'", "from 'capnweb'");
    const subject = await seed('gadget-process-spelling', bare);
    const refusal = refusalOf(await subject.gadgetCall('probe', 'echo', ['ping']));
    expect(refusal.reason).toBe('io');
    expect(refusal.error).toContain('capnweb');
  });

  it('broadcasts the slug when files under gadgets/ change', async () => {
    const subject = await seed('gadget-process-changed');
    expect(valueOf(await subject.gadgetCall('probe', 'echo', ['ping']))).toBe('echo:ping');
    await subject.filesChanged(['home/user/gadgets/probe/server.js']);
    expect(await subject.readBroadcasts()).toEqual([{ type: 'gadgets_changed', slugs: ['probe'] }]);
  });
});
