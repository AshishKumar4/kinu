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
 * `exports` exactly as production mints from the Worker's, a strict approval
 * policy with nobody to ask, and a fixed `listBackgroundJobs` answer. The
 * assertions below are the pairs that discriminate: the workspace's own
 * network reachable beside a files read that answers, a read inside the root
 * beside a read above it, a
 * listed source beside an unlisted one, the declared `env` beside everything
 * else.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { GadgetCallResult, JsonValue } from '@kinu.run/core';
import {
  PROBE_JOBS, PROBE_MCP_READ_TOOL, PROBE_MCP_WRITE_TOOL, type GadgetProcessProbeRpc,
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
  async ownStorage() { await this.env.FILES.write('state.txt', 'own'); return this.env.FILES.read('state.txt'); }
  async storageAuthority() { return typeof this.ctx; }
  async readFile(p) { return await this.env.FILES.read(p); }
  async writeFile(p, t) { return await this.env.FILES.write(p, t); }
  async data(s) { return await this.env.WORKSPACE.read(s); }
  async ambient() { return Object.keys(this.env).sort(); }
  async mcp(tool) { return await this.env.GITHUB.call(tool, {}); }
}
`;

const SERVER_V2 = SERVER_JS.replace("return 'echo:' + x", "return 'v2:' + x");

const MANIFEST = {
  v: 1,
  title: 'Probe',
  bindings: {
    FILES: { kind: 'files', root: 'gadgets/probe/data' },
    WORKSPACE: { kind: 'workspace' },
    GITHUB: { kind: 'mcp', server: 'github' },
  },
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

  it('reaches the workspace network while the files binding reads inside its root', async () => {
    const subject = await seed('gadget-process-egress');
    // The server inherits the owner's outbound like every other resident
    // process; what it may NOT do is reach a workspace plane it did not declare,
    // which the declared-env case below holds. Under miniflare the fetch reaches
    // the loopback and answers; on the platform it reaches the network.
    expect(String(valueOf(await subject.gadgetCall('probe', 'egress', [])))).toMatch(/^reached: /);
    expect(valueOf(await subject.gadgetCall('probe', 'readFile', ['note.txt']))).toBe('probe data\n');
    expect(valueOf(await subject.gadgetCall('probe', 'writeFile', ['from-gadget.txt', 'written by gadget']))).toEqual({
      path: 'gadgets/probe/data/from-gadget.txt',
      chars: 17,
    });
    expect(valueOf(await subject.gadgetCall('probe', 'readFile', ['from-gadget.txt']))).toBe('written by gadget');
  });
  it('denies a files read above the binding root', async () => {
    const subject = await seed('gadget-process-files-deny');
    // The denial crosses one more hop on the way out: the binding answers
    // `denied`, the process throws it, and the outer call classifies a thrown
    // call as `io` — so the class is asserted on the message here and exactly
    // on the hop below.
    const refusal = refusalOf(await subject.gadgetCall('probe', 'readFile', ['../../../SOUL.md']));
    expect(refusal.error).toContain('denied');
  });
  it('answers a listed read model and denies an unlisted one', async () => {
    const subject = await seed('gadget-process-data');
    expect(valueOf(await subject.gadgetCall('probe', 'data', ['listBackgroundJobs']))).toEqual(PROBE_JOBS);
    const refusal = refusalOf(await subject.gadgetCall('probe', 'data', ['listPendingActions']));
    expect(refusal.error).toContain('denied');
  });

  it('hands the process only its declared bindings', async () => {
    const subject = await seed('gadget-process-ambient');
    expect(valueOf(await subject.gadgetCall('probe', 'ambient', []))).toEqual(['FILES', 'GITHUB', 'WORKSPACE']);
  });

  it('runs a read-only MCP tool and refuses a side effect nobody can approve', async () => {
    const subject = await seed('gadget-process-mcp');
    expect(valueOf(await subject.gadgetCall('probe', 'mcp', [PROBE_MCP_READ_TOOL]))).toEqual({
      called: PROBE_MCP_READ_TOOL,
    });
    const refusal = refusalOf(await subject.gadgetCall('probe', 'mcp', [PROBE_MCP_WRITE_TOOL]));
    expect(refusal.error).toContain('denied');
    expect(refusal.error).toContain('NOT RUN');
    expect(await subject.readMcpCalls()).toEqual([PROBE_MCP_READ_TOOL]);
  });

  it('answers denied on the binding hop itself, with the exact class', async () => {
    // The same three refusals as the entrypoints reach them: no isolate in
    // between, so the deciding hop's own class is what the test reads.
    const subject = await seed('gadget-process-hop');
    const files = await subject.gadgetBindingCall('probe', 'FILES', {
      kind: 'files', op: 'read', path: '../../../SOUL.md',
    });
    expect(refusalOf(files).reason).toBe('denied');
    const data = await subject.gadgetBindingCall('probe', 'WORKSPACE', {
      kind: 'workspace', op: 'read', source: 'listPendingActions',
    });
    expect(refusalOf(data).reason).toBe('denied');
    const mcp = await subject.gadgetBindingCall('probe', 'GITHUB', {
      kind: 'mcp', op: 'call', tool: PROBE_MCP_WRITE_TOOL, args: {},
    });
    const mcpRefusal = refusalOf(mcp);
    expect(mcpRefusal.reason).toBe('denied');
    expect(mcpRefusal.error).toContain('NOT RUN');
  });
  it('keeps lasting state in the files binding, with no ctx of its own', async () => {
    const subject = await seed('gadget-process-storage');
    expect(valueOf(await subject.gadgetCall('probe', 'ownStorage', []))).toBe('own');
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
