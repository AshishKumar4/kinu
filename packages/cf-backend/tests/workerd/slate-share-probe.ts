/**
 * A real SlateHost driven inside workerd, reached the way the share rail
 * reaches it: one viewer request crossing `routeShare` into a resident
 * process over Cap'n Web — the batch arm and the socket arm both.
 *
 * The class binds under two names in its vitest project: `SLATE_SHARE_PROBE`,
 * the handle the tests hold, and `OrchestratorAgent`, because the slate's
 * FILES binding is a `SlateBinding` worker entrypoint whose `call` resolves
 * `workspaceOwner(env, workspace).slateBindingCallAs` — the probe's own DO,
 * named by `ctx.id.name`.
 */
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import * as v from 'valibot';
import { newWebSocketRpcSession } from 'capnweb';
import { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import { PID_GEN_STRIDE } from '@nimbus-sh/core/runtime/process-table.js';
import { workspaceGenerationStorage } from '@kinu.run/core/workspace';
import { adoptGeneration, generation } from '@nimbus-sh/fabric/generation.js';
import { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { probeFacetManager } from './facet-manager';
import {
  bindActorHandle, initWorkspaceSchema, MissionGovernor,
  type JsonValue, type ShareViewerClaim, type SlateCallResult, type SqlExec, type SqlExecutor,
} from '@kinu.run/core';
import { initSlateLiveShareTables } from '@kinu.run/core/slates';
import { SlateHost } from '../../src/slates/host';
import { ROOT_SLATE_CALLER, type SlateCaller } from '../../src/slates/bindings';
import { slateBatchStub } from '../../src/slates/rpc-transport';
import { renderThrownChain } from '@kinu.run/core/obs';

// The slate's `env.FILES` resolves `exports.SlateBinding` in THIS worker, and
// `codemodeEgress()` resolves `exports.CodemodeEgress`: both must be exports
// of the probe bundle or a `build` boot throws before the route is reached.
export { SlateBinding } from '../../src/slates/bindings';

export { CodemodeEgress } from '../../src/codemode-egress';

/** The fixture catalog the graph and grant are cut against: one executor and
 *  nothing else — every other binding kind the probe slate declares surfaces
 *  as a `problem` row the share dialog would show. */
const CATALOG = {
  executors: [{ namespace: 'workspace', members: ['readFile', 'writeFile'] }],
  mcp: [],
  tools: [],
  tiers: [],
};

/** The text an RPC refusal arrives as: 'mutate answered' when the member ran
 *  despite the grant, the thrown chain when it refused. */
const refusedText = async (call: Promise<JsonValue>): Promise<string> => {
  try {
    await call;

    return 'mutate answered';
  } catch (cause) {
    return renderThrownChain({ cause });
  }
};

const SLATE_ID = 'board';

/** One DO holding a real SlateHost over its own SQLite. The slate it shares
 *  is authored in `start()` below; the ROUTE boots the process, so a viewer
 *  call is the whole path — admission, boot, port hop, binding call, audit. */
export class SlateShareProbeDO extends DurableObject<Cloudflare.Env> {
  private readonly vfs = new SqliteVFS(this.ctx.storage.sql, this.ctx);
  private readonly processes = new SessionProcessSupervisor();
  private readonly ports = new PortRegistry();
  private readonly host: SlateHost;
  private _budget: MissionGovernor | undefined;
  private readonly gen: Parameters<typeof adoptGeneration>[0];
  /** The `x-slate-call` of the most recent forwarded request — the socket's
   *  invocation for the replay check, kept because nothing else surfaces it. */
  private lastCall: string | null = null;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // The workspace schema creates the slate store tables; the live-share
    // tables are the new ones this probe exists to drive. The tagged-template
    // bridge is the one `bindAgentSql` (src/runtime.ts) makes, hosted where the
    // Agents SDK is not.

    // SAFETY: the same assertion `bindAgentSql` (runtime.ts) makes, at the same
    // boundary and for the same reason. `SqlExecutor` and the platform's
    // `sql.exec` are one tagged-template protocol; `SqlExecutor` additionally
    // admits `boolean`, which the schema inits never bind, and `ArrayBuffer`,
    // which Durable Object SQLite binds at runtime and does not type. The
    // Agents SDK is not hosted in this worker, which is why the bridge is here.
    const sql = ((
      query: TemplateStringsArray, ...values: SqlStorageValue[]
    ) => ctx.storage.sql.exec(query.join('?'), ...values).toArray()) as SqlExecutor;

    const exec: SqlExec = {
      exec: (query, ...bindings) => ctx.storage.sql.exec(query, ...bindings),
    };

    initWorkspaceSchema({ execRaw: (ddl: string) => ctx.storage.sql.exec(ddl), sql, exec });
    initSlateLiveShareTables((ddl: string) => ctx.storage.sql.exec(ddl));
    // The supervisor's pids are generation-scoped, exactly as a hosted
    // workspace's are: each boot of this object adopts the persisted counter's
    // next generation, so a slate process re-spawned after an eviction is
    // never handed a pid the filesystem still holds an append writer for.
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
      // The probe has no AUTH_KV binding — no request bound, the same answer
      // the edge gives on a deployment without it. The spend bound is real:
      // a governor over this object's own SQLite, acting as the root actor.
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

  /** The authored slate: `probe` spends the granted read member, `mutate`
   *  spends the member the grant does not name, `fetch` answers plainly. */
  async start(): Promise<void> {
    await adoptGeneration(this.gen);
    this.processes.setPidBase(generation(this.gen) * PID_GEN_STRIDE);
    const root = '/home/user/slates/board';
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

  /** The owner's `share` op: cuts the grant (read members only here) and
   *  opens the share row. */
  async share(): Promise<SlateCallResult> {
    return this.host.operation(ROOT_SLATE_CALLER, { op: 'share', id: SLATE_ID, visibility: 'public', approved: [] });
  }

  /** GET / through the real route: admission, the boot, the port hop. */
  async viewerFetch(handle: string, claim: ShareViewerClaim): Promise<{ status: number; body: string }> {
    try {
      const response = await this.host.routeShare(handle, claim, new Request('https://share.invalid/'), '/');

      return { status: response.status, body: await response.text() };
    } catch (cause) {
      return { status: 500, body: 'THROWN: ' + renderThrownChain({ cause }) };
    }
  }

  /** A Cap'n Web batch through `routeShare` — the transport's POST path. The
   *  transport ships one batch, so both calls issue in the same tick. */
  async viewerBatch(handle: string, claim: ShareViewerClaim): Promise<{ probe: string | null; mutateError: string }> {
    const stub = slateBatchStub<Record<string, (...args: JsonValue[]) => Promise<JsonValue>>>(
      { request: (request) => this.host.routeShare(handle, claim, request, '/__rpc') }, 'ignored',
    );

    const [raw, mutateError] = await Promise.all([
      stub.probe(),
      refusedText(stub.mutate()),
    ]);

    const probe = v.is(v.string(), raw) ? raw : JSON.stringify(raw ?? null);

    // SAFETY: `RpcStub` always carries a `Symbol.dispose` hook for its session
    // (capnweb's constructor sets it) — the interface merely does not declare it.
    const disposable = stub as { [Symbol.dispose](): void };

    disposable[Symbol.dispose]();

    return { probe, mutateError };
  }

  /** A WebSocket session through `routeShare` — the socket arm, whose
   *  invocation lives until `close` fires `release` back at `__host`. */
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
      // `release` reaches this DO over RPC: a tick so the audit row is settled
      // before the test reads it.
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 0);
      await promise;
    }
  }

  /** The socket's invocation replayed after close: the retired id refuses. */
  async replay(share: string): Promise<SlateCallResult> {
    return this.host.bindingCall(
      { ...ROOT_SLATE_CALLER, share }, SLATE_ID, 'FILES', { member: 'readFile', args: ['/x'], invocation: this.lastCall },
    );
  }

  /** The audit rows the `viewerRequests` op answers. */
  async requests(share: string): Promise<SlateCallResult> {
    return this.host.operation(ROOT_SLATE_CALLER, { op: 'viewerRequests', share });
  }

  /** Revoke the share — `unshare` stops the process the share carried. */
  async revoke(share: string): Promise<SlateCallResult> {
    return this.host.operation(ROOT_SLATE_CALLER, { op: 'unshare', share });
  }

  /** Whether the share's process is gone: revoking stops it, and a stopped
   *  resident leaves no running process in the supervisor. */
  async stopped(): Promise<boolean> {
    return this.processes.getRunning().length === 0;
  }

  /** The `workspaceOwner` arm: the slate's FILES binding calls back into this
   *  object under the share caller it was booted with. */
  async slateBindingCallAs(caller: SlateCaller, id: string, name: string, request: JsonValue): Promise<SlateCallResult> {
    const parsed = v.safeParse(v.object({ invocation: v.nullable(v.string()) }), request);

    // The socket's close listener releases with a null invocation; the id
    // the slate's own call carried is the one a replay must present.
    if (parsed.success && parsed.output.invocation !== null) this.lastCall = parsed.output.invocation;

    return this.host.bindingCall(caller, id, name, request);
  }
}

/** The probe worker: no fetch surface — the tests drive the DO by binding. */
export default class SlateShareProbeWorker extends WorkerEntrypoint<Cloudflare.Env> {}
