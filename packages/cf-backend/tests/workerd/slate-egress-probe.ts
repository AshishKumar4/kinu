import { Agent } from 'agents';
import * as v from 'valibot';
import { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { SlateHost } from '../../src/slates/host';
import { ROOT_SLATE_CALLER } from '../../src/slates/bindings';
import { initWorkspaceSchema, type SqlValue, type WorkMode } from '@kinu.run/core';
export { CodemodeEgress } from '../../src/codemode-egress';

export { SlateBinding } from '../../src/slates/bindings';
const source = `
const fetchFromModule = fetch;
let calls = 0;
export default { async fetch(request) {
  calls += 1;
  try {
    const url = new URL(request.url);
    const response = await fetchFromModule(url.searchParams.get('target'), { redirect: url.searchParams.get('redirect') ?? 'follow' });
    return Response.json({ calls, status: response.status, location: response.headers.get('location'), body: await response.text() });
  } catch (cause) { return Response.json({ calls, error: String(cause) }); }
} };`;

export class SlateEgressProbe extends Agent<Cloudflare.Env> {
  private readonly vfs = new SqliteVFS(this.ctx.storage.sql, this.ctx);
  private readonly processes = new SessionProcessSupervisor();
  private readonly ports = new PortRegistry();
  private readonly host = new SlateHost({
    ctx: this.ctx, env: this.env, workspace: this.ctx.id.toString(),
    session: async () => ({ vfs: this.vfs, processes: this.processes }),
    registerPort: async (pid, port, target) => { this.ports.bindFacetStub(pid, target); this.ports.register(port, pid); },
    unregisterPorts: pid => { this.ports.unregisterByPid(pid); },
    dispatch: async () => { throw new Error('The fixture declares no capability bindings'); },
    expose: async () => { throw new Error('The fixture does not publish preview URLs'); },
  });

  async request(mode: WorkMode, target: string, redirect: RequestRedirect = 'follow'): Promise<string> {
    initWorkspaceSchema({
      execRaw: statement => { this.ctx.storage.sql.exec(statement); }, exec: this.ctx.storage.sql,
      // Schema initialization uses scalar bindings; the SDK's tagged handle
      // omits blob parameters from its type. No row result is cast here.
      sql: <Row>(query: TemplateStringsArray, ...values: SqlValue[]): Row[] => this.sql<Row>(query,
        ...v.parse(v.array(v.union([v.string(), v.number(), v.boolean(), v.null()])), values)),
    });
    const files = this.vfs.as(CRED_KERNEL);
    const root = '/home/user/slates/network';
    if (!files.exists(root)) {
      files.mkdir(root, { recursive: true });
      files.writeFile(root + '/package.json', JSON.stringify({ main: 'server.js' }));
      files.writeFile(root + '/server.js', source);
    }
    const process = await this.host.ensure({ ...ROOT_SLATE_CALLER, workMode: mode }, 'network');
    return (await process.request(new Request('https://slate.invalid/?target=' + encodeURIComponent(target) + '&redirect=' + redirect))).text();
  }

  async publicPlanCall() {
    const result = await this.host.operation({ ...ROOT_SLATE_CALLER, workMode: 'plan' }, { op: 'call', id: 'network', method: 'example' });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }
}
