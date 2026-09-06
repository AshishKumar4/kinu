import { DurableObject } from 'cloudflare:workers';
import { MemoryContentStore } from '@agent-core/core/content';
import { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { parseSlateProject, type SlateProcess } from '@kinu.run/core';
import { KinuError, renderThrownChain } from '@kinu.run/core/obs';
import { ResidentSlateProcesses } from '../../src/slates/resident';

export class SlateProcessProbeDO extends DurableObject<Cloudflare.Env> {
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
  ].join('\n')): Promise<void> {
    const root = '/home/user/slates/notes';
    const files = this.vfs.as(CRED_KERNEL);
    files.mkdir(root, { recursive: true });
    files.writeFile(`${root}/server.ts`, source);
    this.process = await this.resident.start({
      key: crypto.randomUUID(), root, port: 8789, bindings: {},
      project: parseSlateProject({ main: 'server.ts' }),
    });
  }

  async seedPrivateSource(): Promise<void> {
    const kernel = this.vfs.as(CRED_KERNEL);
    kernel.mkdir('/root', { mode: 0o700 });
    kernel.writeFile('/root/private.ts', 'export default "kernel-private-source";', { mode: 0o600 });
  }

  async readPrivateSourceAsAgent() {
    try { return { content: this.vfs.as(CRED_SESSION_USER).readFileString('/root/private.ts') }; }
    catch (cause) { return { error: renderThrownChain({ cause }) }; }
  }

  async compileProbe(source: string) {
    try { await this.start(source); }
    catch (cause) {
      if (!(cause instanceof KinuError)) throw cause;
      return { code: cause.code, detail: renderThrownChain({ cause }) };
    }
    const response = await this.request('/private');
    await this.stop();
    return response;
  }

  async request(path: string): Promise<{ status: number; body: string }> {
    const response = await this.ports.routeRequest(8789, new Request(`https://slate.invalid${path}`), path);
    if (response === null) return { status: 404, body: 'No listener' };
    return { status: response.status, body: await response.text() };
  }

  async stop(): Promise<void> {
    if (this.process === undefined) throw new Error('Slate was not started');
    await this.process.stop();
  }
}
