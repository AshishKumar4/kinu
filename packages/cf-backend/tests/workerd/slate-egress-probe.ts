import { Agent } from 'agents';
import * as v from 'valibot';
import { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { SlateHost } from '../../src/slates/host';
import { ROOT_SLATE_CALLER, slateCallerKey } from '../../src/slates/bindings';
import { initWorkspaceSchema, type SqlValue, type WorkMode } from '@kinu.run/core';
import { ContentRef } from '@agent-core/core';
import { processes } from '@nimbus-sh/fabric/workerd-facet-host.js';
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

  private prepare(): void {
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
  }

  async request(mode: WorkMode, target: string, redirect: RequestRedirect = 'follow'): Promise<string> {
    this.prepare();
    const process = await this.host.ensure({ ...ROOT_SLATE_CALLER, workMode: mode }, 'network');
    return (await process.request(new Request('https://slate.invalid/?target=' + encodeURIComponent(target) + '&redirect=' + redirect))).text();
  }

  async publicPlanCall() {
    const result = await this.host.operation({ ...ROOT_SLATE_CALLER, workMode: 'plan' }, { op: 'call', id: 'network', method: 'example' });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }

  async legacyThenCurrent(): Promise<{ legacy: string; current: string; reused: string }> {
    this.prepare();
    const committed = v.parse(v.object({ ok: v.literal(true), value: v.object({ source: v.string() }) }),
      await this.host.operation(ROOT_SLATE_CALLER, { op: 'commit', id: 'network' }));
    const digest = new ContentRef(committed.value.source).digest.value;
    // Historical loader identity, deliberately fixed here to seed the pre-policy
    // image. This is a rollout fixture, not a production compatibility reader.
    const key = 'slate:' + this.ctx.id.toString() + ':' + slateCallerKey(ROOT_SLATE_CALLER) + '#network:' + digest;
    const writerId = crypto.randomUUID();
    const legacy = processes(this.ctx, this.env).spawn(
      () => ({ readFile: async () => { throw new Error('Legacy fixture has inline modules only'); } }),
      { doId: this.ctx.id.toString(), pid: 900000, writerId },
      { pid: 900000, writerId, workerKey: key, startArgs: {}, boot: { kind: 'code', code: {
        compatibilityDate: '2025-12-01', compatibilityFlags: ['nodejs_compat'], mainModule: 'legacy.js', env: {},
        modules: { 'legacy.js': `import { DurableObject } from 'cloudflare:workers';
          export class NimbusProcess extends DurableObject {
            calls = 0;
            async startProcess() { return { ok: true }; }
            async handleHttpRequest(request) {
              const target = new URL(request.url).searchParams.get('target') || 'https://example.com/control';
              const response = await fetch(target);
              return Response.json({ legacy: true, calls: ++this.calls, status: response.status, body: await response.text() });
            }
          }` },
      } } },
    );
    try {
      await legacy.started;
      const warm = await (await legacy.handleHttpRequest(new Request('https://slate.invalid/'))).text();
      v.parse(v.object({ legacy: v.literal(true), status: v.literal(200), body: v.literal('public control') }), JSON.parse(warm));
      const current = await this.request('build', 'http://169.254.169.254/forbidden');
      const reused = await this.request('build', 'https://example.com/control');
      return { legacy: warm, current, reused };
    } finally { await legacy.release(); }
  }
}
