/**
 * A real SlateHost in workerd, reached through `routeShare` over Cap'n Web (batch and socket arms).
 * Also bound as `OrchestratorAgent` because the slate's FILES binding resolves `workspaceOwner(...).slateBindingCallAsWire` by `ctx.id.name`.
 */
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import * as v from 'valibot';
import { newWebSocketRpcSession } from 'capnweb';
import { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import { seedBaseFilesystem } from '@nimbus-sh/core/workspace';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import { PID_GEN_STRIDE } from '@nimbus-sh/core/runtime/process-table.js';
import { workspaceGenerationStorage } from '@kinu.run/core/workspace';
import { adoptGeneration, generation } from '@nimbus-sh/fabric/generation.js';
import { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { probeFacetManager } from './facet-manager';
import {
  bindActorHandle, initWorkspaceSchema, MissionGovernor,
  type JsonValue, type ShareViewerClaim, type SlateCallResult, type SqlExec, type SqlExecutor, type SqlValue,
} from '@kinu.run/core';
import { initSlateLiveShareTables } from '@kinu.run/core/slates';
import { SlateHost } from '../../src/slates/host';
import { ROOT_SLATE_CALLER, type SlateCaller } from '../../src/slates/bindings';
import { slateBatchStub } from '../../src/slates/rpc-transport';
import { renderThrownChain } from '@kinu.run/core/obs';

// `env.FILES` and `codemodeEgress()` resolve exports of this worker; without them a `build` boot throws before the route.
export { SlateBinding } from '../../src/slates/bindings';

export { CodemodeEgress } from '../../src/codemode-egress';

/** Every other binding kind the probe slate declares surfaces as a `problem` row. */
const CATALOG = {
  executors: [{ namespace: 'workspace', members: ['readFile', 'writeFile'] }],
  mcp: [],
  tools: [],
  tiers: [],
};

const refusedText = async (call: Promise<JsonValue>): Promise<string> => {
  try {
    await call;

    return 'mutate answered';
  } catch (cause) {
    return renderThrownChain({ cause });
  }
};

const SLATE_ID = 'board';

export class SlateShareProbeDO extends DurableObject<Cloudflare.Env> {
  private readonly vfs = new SqliteVFS(this.ctx.storage.sql, this.ctx);
  private readonly processes = new SessionProcessSupervisor();
  private readonly ports = new PortRegistry();
  private readonly host: SlateHost;
  private _budget: MissionGovernor | undefined;
  private readonly gen: Parameters<typeof adoptGeneration>[0];
  private lastCall: string | null = null;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // The tagged-template bridge mirrors `bindAgentSql` (src/runtime.ts), hosted where the Agents SDK is not.

    const sql: SqlExecutor = <Row,>(
      query: TemplateStringsArray, ...values: SqlValue[]
    ): Row[] => ctx.storage.sql.exec<Row & Record<string, SqlStorageValue>>(query.join('?'), ...values).toArray();

    const exec: SqlExec = {
      exec: (query, ...bindings) => ctx.storage.sql.exec(query, ...bindings),
    };

    initWorkspaceSchema({ execRaw: (ddl: string) => ctx.storage.sql.exec(ddl), sql, exec });
    initSlateLiveShareTables((ddl: string) => ctx.storage.sql.exec(ddl));
    seedBaseFilesystem(this.vfs, ['home', 'etc']);
    // Pids are generation-scoped per boot so a re-spawned process never gets a pid with a live append writer.
    this.gen = workspaceGenerationStorage(ctx.storage.sql);
    const facets = probeFacetManager({ ctx, env, processes: this.processes, portRegistry: this.ports, vfs: this.vfs });

    this.host = new SlateHost({
      ctx, workspace: ctx.id.name ?? ctx.id.toString(),
      session: async () => ({ vfs: this.vfs, processes: this.processes }),
      facetManager: async () => facets,
      dispatch: async (_caller, route) => {
        if (route.kind !== 'namespace') throw new Error(`probe dispatch answers namespace only, got ${route.kind}`);

        if (route.member === 'readFile') {
          const path = v.is(v.string(), route.args[0]) ? route.args[0] : '/x';

          return this.vfs.as(CRED_KERNEL).readFileString(path);
        }

        return null;
      },
      apps: {
        ensure: async () => { throw new Error('a share probe reserves no durable app'); },
        reserved: async () => null,
        remove: async () => ({ removed: false, port: null }),
        url: async () => { throw new Error('a share probe publishes no preview URL'); },
      },
      catalog: async () => ({ ...CATALOG, slates: await this.host.projects(ROOT_SLATE_CALLER) }),
      shareUrl: async (handle) => `https://${handle}.share.test/`,
      // No AUTH_KV binding, as on a deployment without it; the spend bound is real.
      budget: () => this._budget ??= new MissionGovernor({
        storage: { sql, execRaw: (ddl: string) => ctx.storage.sql.exec(ddl) },
        actor: bindActorHandle(sql, {
          actorId: 'main', workspaceId: ctx.id.name ?? ctx.id.toString(),
          parentActorId: null, name: 'main', storageKey: 'main',
        }, () => {}),
      }),
      ownerTitle: async () => ctx.id.name ?? ctx.id.toString(),
    });
  }

  async start(): Promise<void> {
    await adoptGeneration(this.gen);
    this.processes.setPidBase(generation(this.gen) * PID_GEN_STRIDE);
    const root = '/home/main/slates/board';
    const files = this.vfs.as(CRED_KERNEL);
    files.mkdir(root, { recursive: true });
    files.writeFile(`${root}/package.json`, JSON.stringify({
      name: SLATE_ID, main: 'server.ts',
      slate: {
        title: 'Board', runtime: 'worker',
        bindings: { FILES: { kind: 'namespace', namespace: 'workspace', members: ['readFile', 'writeFile'] } },
      },
    }));
    files.writeFile(`${root}/server.ts`, [
      'import { SlateObject } from "kinu:slate";',
      'export class Slate extends SlateObject {',
      '  async probe() { return await this.env.FILES.readFile("/x"); }',
      '  async mutate() { return await this.env.FILES.writeFile("/x", "y"); }',
      '  async fetch() { return new Response("share-ok"); }',
      '}',
    ].join('\n'));
    files.writeFile('/x', 'fixture-bytes');
  }

  async share(): Promise<SlateCallResult> {
    return this.host.operation(ROOT_SLATE_CALLER, { op: 'share', id: SLATE_ID, visibility: 'public', approved: [] });
  }

  async viewerFetch(handle: string, claim: ShareViewerClaim): Promise<{ status: number; body: string }> {
    try {
      const response = await this.host.routeShare(handle, claim, new Request('https://share.invalid/'), '/');

      return { status: response.status, body: await response.text() };
    } catch (cause) {
      return { status: 500, body: 'THROWN: ' + renderThrownChain({ cause }) };
    }
  }

  /** The transport ships one batch, so both calls issue in the same tick. */
  async viewerBatch(handle: string, claim: ShareViewerClaim): Promise<{ probe: string | null; mutateError: string }> {
    const stub = slateBatchStub<Record<string, (...args: JsonValue[]) => Promise<JsonValue>>>(
      { request: (request) => this.host.routeShare(handle, claim, request, '/__rpc') }, 'ignored',
    );

    const [raw, mutateError] = await Promise.all([
      stub.probe(),
      refusedText(stub.mutate()),
    ]);

    const probe = v.is(v.string(), raw) ? raw : JSON.stringify(raw ?? null);

    stub[Symbol.dispose]();

    return { probe, mutateError };
  }

  async viewerSocket(handle: string, claim: ShareViewerClaim): Promise<{ probe: string | null; mutateError: string }> {
    const response = await this.host.routeShare(
      handle, claim, new Request('https://share.invalid/__rpc', { headers: { Upgrade: 'websocket' } }), '/__rpc',
    );

    const socket = response.webSocket;

    if (socket === null) throw new Error(`upgrade refused: ${response.status}`);
    socket.accept();
    const stub = newWebSocketRpcSession<Record<string, (...args: JsonValue[]) => Promise<JsonValue>>>(socket);

    try {
      const raw = await stub.probe();
      const probe = v.is(v.string(), raw) ? raw : JSON.stringify(raw ?? null);
      const mutateError = await refusedText(stub.mutate());

      return { probe, mutateError };
    } finally {
      socket.close();
      // `release` reaches this DO over RPC: a tick so the audit row is settled before the test reads it.
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 0);
      await promise;
    }
  }

  async replay(share: string): Promise<SlateCallResult> {
    return this.host.bindingCall(
      { ...ROOT_SLATE_CALLER, share }, SLATE_ID, 'FILES', { member: 'readFile', args: ['/x'], invocation: this.lastCall },
    );
  }

  async requests(share: string): Promise<SlateCallResult> {
    return this.host.operation(ROOT_SLATE_CALLER, { op: 'viewerRequests', share });
  }

  async revoke(share: string): Promise<SlateCallResult> {
    return this.host.operation(ROOT_SLATE_CALLER, { op: 'unshare', share });
  }

  async stopped(): Promise<boolean> {
    return this.processes.getRunning().length === 0;
  }

  async slateBindingCallAs(caller: SlateCaller, id: string, name: string, request: JsonValue): Promise<SlateCallResult> {
    const parsed = v.safeParse(v.object({ invocation: v.nullable(v.string()) }), request);

    // The close listener releases with a null invocation; a replay must present the id the slate's call carried.
    if (parsed.success && parsed.output.invocation !== null) this.lastCall = parsed.output.invocation;

    return this.host.bindingCall(caller, id, name, request);
  }

  async slateBindingCallAsWire(caller: SlateCaller, id: string, name: string, request: JsonValue): Promise<string> {
    return JSON.stringify(await this.slateBindingCallAs(caller, id, name, request));
  }
}

export default class SlateShareProbeWorker extends WorkerEntrypoint<Cloudflare.Env> {}
