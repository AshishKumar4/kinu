import { DurableObject, WorkerEntrypoint, exports } from 'cloudflare:workers';
import { MemoryContentStore } from '@agent-core/core/content';
import { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { CRED_KERNEL, CRED_SESSION_USER, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { parseSlateProject, resolveSlateChain, routeSlateBindingCall, type SlateProcess, type JsonValue, type SlateCallResult, type SlateInvocation } from '@kinu.run/core';
import { KinuError, renderThrownChain } from '@kinu.run/core/obs';
import { ResidentSlateProcesses } from '../../src/slates/resident';
import { codemodeEgress } from '../../src/codemode-egress';

/**
 * Stands in for the host's binding entrypoint, using the host's OWN resolution
 * so this probe cannot pass while `ResidentSlateHost` would refuse: it holds
 * the same `invocation -> { id, chain }` record and calls `resolveSlateChain`.
 */
export class SlateChainProbe extends WorkerEntrypoint {
  async call(member: string, args: JsonValue[], invocation: string | null): Promise<SlateCallResult> {
    const project = parseSlateProject({ main: 'server.ts', slate: { bindings: { PEER: { kind: 'app', id: 'peer' } } } });

    try {
      const chain = resolveSlateChain({ invocations: SlateProcessProbeDO.invocations, id: 'probe', invocation });
      const route = routeSlateBindingCall({ id: 'probe', project, name: 'PEER', request: { member, args, invocation }, chain });

      if (route.kind !== 'app') throw new Error('Expected app route');

      return { ok: true, value: { chain: [...route.chain], args: [...route.args] } };
    } catch (cause) {
      if (!(cause instanceof KinuError)) throw cause;

      return { ok: false, reason: cause.code, error: cause.message };
    }
  }
}

export class SlateProcessProbeDO extends DurableObject<Cloudflare.Env> {
  /** The live app invocations, exactly as `ResidentSlateHost` keeps them.
   *  Static because the entrypoint above answers outside this object. */
  static readonly invocations = new Map<string, SlateInvocation>();
  private readonly vfs = new SqliteVFS(this.ctx.storage.sql, this.ctx);
  private readonly processes = new SessionProcessSupervisor();
  private readonly ports = new PortRegistry();
  private readonly resident = new ResidentSlateProcesses({
    ctx: this.ctx, env: this.env, workspace: this.ctx.id.toString(), content: new MemoryContentStore(),
    session: async () => ({ vfs: this.vfs, processes: this.processes }),
    registerPort: async (pid, port, target) => {
      this.ports.bindFacetStub(pid, target);
      this.ports.register(port, pid);
    },
    unregisterPorts: (pid) => { this.ports.unregisterByPid(pid); },
  });
  private process: SlateProcess | undefined;

  async start(source = [
    'let calls: number = 0;',
    'export default { fetch(request: Request): Response {',
    '  calls += 1;',
    '  return Response.json({ calls, path: new URL(request.url).pathname });',
    '} };',
  ].join('\n'), bindChain = false, cred: VfsCred = CRED_SESSION_USER): Promise<void> {
    const root = '/home/user/slates/notes';
    const files = this.vfs.as(CRED_KERNEL);
    files.mkdir(root, { recursive: true });
    files.writeFile(`${root}/server.ts`, source);
    this.process = await this.resident.start({
      key: crypto.randomUUID(), owner: JSON.stringify([this.ctx.id.toString(), root, cred]), root, port: 8789, cred,
      bindings: bindChain ? { PEER: exports.SlateChainProbe({}) } : {},
      globalOutbound: codemodeEgress(),
      project: parseSlateProject({ main: 'server.ts' }),
    });
  }

  async seedPrivateSource(): Promise<void> {
    const kernel = this.vfs.as(CRED_KERNEL);
    kernel.mkdir('/root', { mode: 0o700 });
    kernel.writeFile('/root/private.ts', 'export default "kernel-private-source";', { mode: 0o600 });
  }

  async seedGroupSource(): Promise<void> {
    const kernel = this.vfs.as(CRED_KERNEL);
    kernel.mkdir('/shared', { recursive: true });
    kernel.writeFile('/shared/group.ts', 'export default "group-protected-source";', { mode: 0o640 });
    kernel.chown('/shared/group.ts', 0, 3000);
  }

  async readPrivateSourceAsAgent() {
    try { return { content: this.vfs.as(CRED_SESSION_USER).readFileString('/root/private.ts') }; }
    catch (cause) { return { error: renderThrownChain({ cause }) }; }
  }

  async compileProbe(source: string, cred: VfsCred = CRED_SESSION_USER) {
    try { await this.start(source, false, cred); }
    catch (cause) {
      if (!(cause instanceof KinuError)) throw cause;

      return { code: cause.code, detail: renderThrownChain({ cause }) };
    }

    const response = await this.request('/private');
    await this.stop();

    return response;
  }

  /**
   * One request, driven the way the host drives one: mint an invocation for
   * `chain`, send its id, retire it when the request settles. `chain`
   * undefined is the PREVIEW shape — a root lineage, and still a named one,
   * exactly as `ResidentSlateHost.previewInvocation` makes it.
   */
  async request(path: string, chain?: string[]): Promise<{ status: number; body: string }> {
    // EVERY entry is named, preview included: an unnamed request is one a slate
    // can keep and replay as a root lineage.
    const invocation = crypto.randomUUID();
    SlateProcessProbeDO.invocations.set(invocation, { id: 'probe', chain: chain ?? [] });

    try {
      const response = await this.ports.routeRequest(8789, new Request(
        'https://slate.invalid' + path, { headers: { 'x-slate-call': invocation } },
      ), path);

      if (response === null) return { status: 404, body: 'No listener' };

      return { status: response.status, body: await response.text() };
    } finally {
      SlateProcessProbeDO.invocations.delete(invocation);
    }
  }

  async stop(): Promise<void> {
    if (this.process === undefined) throw new Error('Slate was not started');
    await this.process.stop();
  }
}
