/**
 * The gadget server boundary, executed under the runtime that enforces it.
 *
 * WHY THE WORKERD POOL. A gadget server runs as a facet of the owning object,
 * loaded through the dynamic-Worker loader with `globalOutbound: null`, and
 * every binding in its `env` is a loopback entrypoint that calls back into
 * the owner over a stub. The loader, the facet lifetime and storage, the
 * outbound refusal and the entrypoint hop are all platform: `bun test` has
 * none of them, so nothing there can say whether a server is actually
 * contained. The pool is the only tier that can.
 *
 * WHAT THE PROBE DRIVES. A real `GadgetHost` over the real file plane on the
 * probe's own SQLite, minting each binding from this test worker's own
 * `exports` exactly as production mints from the Worker's, a strict approval
 * policy with nobody to ask, and a fixed `listBackgroundJobs` answer. The
 * assertions below are the pairs that discriminate: egress blocked beside a
 * files read that answers, a read inside the root beside a read above it, a
 * listed source beside an unlisted one, the declared `env` beside everything
 * else.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { GadgetCallResult, JsonValue } from '@kinu.run/core';
import {
  PROBE_JOBS, PROBE_MCP_READ_TOOL, PROBE_MCP_WRITE_TOOL, type GadgetFacetProbeRpc,
} from './gadget-facet-probe';

const SERVER_JS = `import { DurableObject } from 'cloudflare:workers';
export class Gadget extends DurableObject {
  async echo(x) { return 'echo:' + x; }
  async egress() { try { await fetch('https://example.com'); return 'reached'; } catch (e) { return 'blocked: ' + e.message; } }
  async ownStorage() { this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS t(x)'); return 'own'; }
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
  const open = (name: string): GadgetFacetProbeRpc => {
    const stub = env.GADGET_FACET_PROBE.get(env.GADGET_FACET_PROBE.idFromName(name));
    // SAFETY: the binding the test worker guarantees serves GadgetFacetProbeDO
    // (vitest.config.ts names its class), whose six methods match this view exactly.
    // The stub parks in `unknown` because calling through its mapped stub type makes
    // type instantiation excessively deep (TS2589); the methods it answers are
    // verified against the probe class, not parsed here.
    const untyped = stub as unknown;
    // SAFETY: the same stub the binding guarantees, re-read here as the narrow view.
    return untyped as GadgetFacetProbeRpc;
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

  it('answers a method through the facet', async () => {
    const subject = await seed('gadget-facet-echo');
    expect(valueOf(await subject.gadgetCall('probe', 'echo', ['ping']))).toBe('echo:ping');
  });

  it('blocks egress while the files binding reads inside its root', async () => {
    const subject = await seed('gadget-facet-egress');
    // The discriminating pair agent-core SPEC C13-CLOUDFLARE-DYNAMIC-NO-EGRESS
    // asks for: no network, and the declared bindings still answering.
    expect(String(valueOf(await subject.gadgetCall('probe', 'egress', [])))).toMatch(/^blocked: /);
    expect(valueOf(await subject.gadgetCall('probe', 'readFile', ['note.txt']))).toBe('probe data\n');
    expect(valueOf(await subject.gadgetCall('probe', 'writeFile', ['from-gadget.txt', 'written by gadget']))).toEqual({
      path: 'gadgets/probe/data/from-gadget.txt',
      chars: 17,
    });
    expect(valueOf(await subject.gadgetCall('probe', 'readFile', ['from-gadget.txt']))).toBe('written by gadget');
  });
  it('denies a files read above the binding root', async () => {
    const subject = await seed('gadget-facet-files-deny');
    // The denial crosses one more hop on the way out: the binding answers
    // `denied`, the isolate throws it, and the outer call classifies a thrown
    // call as `io` — so the class is asserted on the message here and exactly
    // on the hop below.
    const refusal = refusalOf(await subject.gadgetCall('probe', 'readFile', ['../../../SOUL.md']));
    expect(refusal.error).toContain('denied');
  });
  it('answers a listed read model and denies an unlisted one', async () => {
    const subject = await seed('gadget-facet-data');
    expect(valueOf(await subject.gadgetCall('probe', 'data', ['listBackgroundJobs']))).toEqual(PROBE_JOBS);
    const refusal = refusalOf(await subject.gadgetCall('probe', 'data', ['listPendingActions']));
    expect(refusal.error).toContain('denied');
  });

  it('hands the isolate only its declared bindings', async () => {
    const subject = await seed('gadget-facet-ambient');
    expect(valueOf(await subject.gadgetCall('probe', 'ambient', []))).toEqual(['FILES', 'GITHUB', 'WORKSPACE']);
  });

  it('runs a read-only MCP tool and refuses a side effect nobody can approve', async () => {
    const subject = await seed('gadget-facet-mcp');
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
    const subject = await seed('gadget-facet-hop');
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
  it('keeps facet storage of its own', async () => {
    const subject = await seed('gadget-facet-storage');
    expect(valueOf(await subject.gadgetCall('probe', 'ownStorage', []))).toBe('own');
  });

  it('refuses reserved method names before any facet is touched', async () => {
    const subject = await seed('gadget-facet-names');
    expect(refusalOf(await subject.gadgetCall('probe', 'fetch', [])).reason).toBe('bad_input');
    expect(refusalOf(await subject.gadgetCall('probe', '_private', [])).reason).toBe('bad_input');
  });

  it('restarts the facet on the rewritten server', async () => {
    const subject = await seed('gadget-facet-rewrite');
    expect(valueOf(await subject.gadgetCall('probe', 'echo', ['ping']))).toBe('echo:ping');
    await subject.writeGadget('probe', { 'server.js': SERVER_V2 });
    expect(valueOf(await subject.gadgetCall('probe', 'echo', ['ping']))).toBe('v2:ping');
  });

  it('broadcasts the slug when files under gadgets/ change', async () => {
    const subject = await seed('gadget-facet-changed');
    expect(valueOf(await subject.gadgetCall('probe', 'echo', ['ping']))).toBe('echo:ping');
    await subject.filesChanged(['home/user/gadgets/probe/server.js']);
    expect(await subject.readBroadcasts()).toEqual([{ type: 'gadgets_changed', slugs: ['probe'] }]);
  });
});
