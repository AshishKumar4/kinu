/**
 * A real SlateHost in workerd, reached through `routeShare` over Cap'n Web (batch and socket arms).
 * Also bound as `OrchestratorAgent` because the slate's FILES binding resolves `workspaceOwner(...).slateBindingCallAsWire` by `ctx.id.name`.
 */
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import * as v from 'valibot';
import { newWebSocketRpcSession } from 'capnweb';
import { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { seedBaseFilesystem } from '@nimbus-sh/core/workspace';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import { PID_GEN_STRIDE } from '@nimbus-sh/core/runtime/process-table.js';
import { workspaceGenerationStorage } from '@kinu.run/core/workspace';
import { adoptGeneration, generation } from '@nimbus-sh/fabric/generation.js';
import { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { probeDurableApps, probeFacetManager } from './facet-manager';
import {
  agentCred, bindActorHandle, initWorkspaceSchema, MissionGovernor, provisionAgentHome, settleWorkspaceSlates, SHARE_SPEND_CAP_USD_PER_DAY,
  shareSpendLabel, subordinateAgentName,
  type JsonValue, type ShareViewerClaim, type SlateCallResult, type SqlExec, type SqlExecutor, type SqlValue,
} from '@kinu.run/core';
import { SlateId } from '@agent-core/core/slates';
import { initSlateLiveShareTables, slateDirectory } from '@kinu.run/core/slates';
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
  private readonly sql: SqlExecutor;
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

    this.sql = sql;

    initWorkspaceSchema({
      execRaw: (ddl: string) => ctx.storage.sql.exec(ddl), sql, exec, transactionSync: (write) => ctx.storage.transactionSync(write),
    });
    initSlateLiveShareTables((ddl: string) => ctx.storage.sql.exec(ddl));
    seedBaseFilesystem(this.vfs, ['home', 'etc']);
    // As the Kinu boot leaves every workspace: slates are the workspace's, not its main agent's.
    settleWorkspaceSlates(this.vfs.as(CRED_KERNEL));
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
        ...probeDurableApps(facets),
        url: async (port) => ({ url: `https://${String(port)}.preview.test/` }),
      },
      catalog: async () => ({ ...CATALOG, slates: await this.host.projects(ROOT_SLATE_CALLER) }),
      shareUrl: async (handle) => `https://${handle}.share.test/`,
      // No AUTH_KV binding, as on a deployment without it; the spend bound is real.
      budget: () => this.governor(),
      ownerTitle: async () => ctx.id.name ?? ctx.id.toString(),
    });
  }

  private governor(): MissionGovernor {
    this._budget ??= new MissionGovernor({
      storage: { sql: this.sql, execRaw: (ddl: string) => this.ctx.storage.sql.exec(ddl) },
      actor: bindActorHandle(this.sql, {
        actorId: 'main', workspaceId: this.ctx.id.name ?? this.ctx.id.toString(),
        parentActorId: null, name: 'main', storageKey: 'main',
      }, () => {}),
    });

    return this._budget;
  }

  async start(): Promise<void> {
    await adoptGeneration(this.gen);
    this.processes.setPidBase(generation(this.gen) * PID_GEN_STRIDE);
    const root = '/slates/board';
    const files = this.vfs.as(CRED_KERNEL);
    files.mkdir(root, { recursive: true });
    files.writeFile(`${root}/package.json`, JSON.stringify({
      name: SLATE_ID, main: 'server.ts',
      slate: {
        title: 'Board', runtime: 'worker',
        bindings: {
          FILES: { kind: 'namespace', namespace: 'workspace', members: ['readFile', 'writeFile'] },
          PEER: { kind: 'app', id: 'digest' },
        },
      },
    }));
    files.writeFile(`${root}/server.ts`, [
      'import { SlateObject } from "kinu:slate";',
      'export class Slate extends SlateObject {',
      '  async probe() { return await this.env.FILES.readFile("/x"); }',
      '  async mutate() { return await this.env.FILES.writeFile("/x", "y"); }',
      '  async hop() { return await this.env.PEER.digest(); }',
      '  async fetch() { return new Response("share-ok"); }',
      '}',
    ].join('\n'));
    const digest = '/slates/digest';
    files.mkdir(digest, { recursive: true });
    files.writeFile(`${digest}/package.json`, JSON.stringify({
      name: 'digest', main: 'server.ts', slate: { title: 'Digest', runtime: 'worker', bindings: {} },
    }));
    files.writeFile(`${digest}/server.ts`, [
      'import { SlateObject } from "kinu:slate";',
      'export class Slate extends SlateObject {',
      '  async digest() { return "digest-ok"; }',
      '}',
    ].join('\n'));
    files.writeFile('/x', 'fixture-bytes');
  }

  /**
   * A hired agent's slate, made with its own credential where slates live: its manifest in place, its server built
   * in its home and moved in, as a hire promotes a draft. The main agent changes both, then the hire previews it
   * and, as the main agent would, removes it.
   */
  async previewAsHire(): Promise<{ preview: SlateCallResult; removed: SlateCallResult; left: boolean }> {
    await adoptGeneration(this.gen);
    this.processes.setPidBase(generation(this.gen) * PID_GEN_STRIDE);
    const identity = { uid: 2001, gid: 2001 };
    const home = provisionAgentHome(this.vfs.as(CRED_KERNEL), subordinateAgentName('builder'), identity);
    const hire: SlateCaller = { path: [{ name: 'builder' }], cred: agentCred(identity), workMode: 'build' };
    const dir = slateDirectory(new SlateId('widgets'));
    const files = this.vfs.as(hire.cred);
    const main = this.vfs.as(CRED_SESSION_USER);
    const manifest = (title: string) => JSON.stringify({ name: 'widgets', main: 'server.ts', slate: { title, runtime: 'worker', bindings: {} } });

    const server = (count: number) => [
      'import { SlateObject } from "kinu:slate";',
      'export class Slate extends SlateObject {',
      `  async count() { return ${String(count)}; }`,
      '}',
    ].join('\n');

    files.mkdir(dir, { recursive: true });
    files.writeFile(`${dir}/package.json`, manifest('Widgets'));
    files.writeFile(`${home}/server.ts`, server(3));
    files.rename(`${home}/server.ts`, `${dir}/server.ts`);
    main.writeFile(`${dir}/package.json`, manifest('Widgets, reviewed'));
    main.writeFile(`${dir}/server.ts`, server(4));
    const preview = await this.host.operation(hire, { op: 'preview', id: 'widgets' });
    const removed = await this.host.operation(hire, { op: 'remove', id: 'widgets' });

    return { preview, removed, left: this.vfs.as(CRED_KERNEL).exists(dir) };
  }

  /** `approved` names members granted beyond the graph's read members. */
  async share(approved: readonly { binding: string; member: string }[] = []): Promise<SlateCallResult> {
    return this.host.operation(ROOT_SLATE_CALLER, {
      op: 'share', id: SLATE_ID, visibility: 'public', approved: approved.map((granted) => ({ slate: SLATE_ID, ...granted })),
    });
  }

  /** Publishes the board as a blueprint and imports it back as a fork, as a forker's workspace admits one. */
  async importBlueprint(): Promise<{ fork: string; running: number }> {
    const committed = await this.host.operation(ROOT_SLATE_CALLER, { op: 'commit', id: SLATE_ID });

    if (!committed.ok) throw new Error(`${committed.reason}: ${committed.error}`);
    const version = v.parse(v.object({ id: v.string() }), committed.value).id;
    const published = await this.host.operation(ROOT_SLATE_CALLER, { op: 'publish', id: SLATE_ID, version, include: [] });

    if (!published.ok) throw new Error(`${published.reason}: ${published.error}`);
    const share = v.parse(v.object({ share: v.object({ id: v.string() }) }), published.value).share.id;
    const bundle = await this.host.blueprintBundle(share);

    if (!bundle.ok) throw new Error(`${bundle.reason}: ${bundle.error}`);
    const fork = await this.host.admitBlueprint(bundle.value);

    if (!fork.ok) throw new Error(`${fork.reason}: ${fork.error}`);

    return { fork: fork.value.slate, running: this.processes.getRunning().length };
  }

  async liveShares(): Promise<SlateCallResult> {
    return this.host.operation(ROOT_SLATE_CALLER, { op: 'liveShares' });
  }

  /** The app hop, over one batch. */
  async viewerHop(handle: string, claim: ShareViewerClaim): Promise<string> {
    const stub = slateBatchStub<Record<string, (...args: JsonValue[]) => Promise<JsonValue>>>(
      { request: (request) => this.host.routeShare(handle, claim, request, '/__rpc') }, 'ignored',
    );

    try {
      return JSON.stringify(await stub.hop());
    } catch (cause) {
      return renderThrownChain({ cause });
    } finally {
      stub[Symbol.dispose]();
    }
  }

  /**
   * One socket session whose share changes between its calls: revoked, or spent past its daily cap by other
   * viewers' calls. `late` is a call carrying the session's invocation that arrives after the change, as one
   * already in flight from the slate does; JSON, as `slateBindingCallAsWire` answers.
   */
  async viewerSocketAcross(
    handle: string, claim: ShareViewerClaim, share: string, change: 'revoke' | 'spend',
  ): Promise<{ before: string | null; after: string; late: string }> {
    const response = await this.host.routeShare(
      handle, claim, new Request('https://share.invalid/__rpc', { headers: { Upgrade: 'websocket' } }), '/__rpc',
    );

    const socket = response.webSocket;

    if (socket === null) throw new Error(`upgrade refused: ${response.status}`);
    socket.accept();
    const stub = newWebSocketRpcSession<Record<string, (...args: JsonValue[]) => Promise<JsonValue>>>(socket);

    try {
      const raw = await stub.probe();
      const before = v.is(v.string(), raw) ? raw : JSON.stringify(raw ?? null);

      if (change === 'revoke') {
        await this.host.operation(ROOT_SLATE_CALLER, { op: 'unshare', share });
      } else {
        const governor = this.governor();
        governor.declare(shareSpendLabel(share), { usd: SHARE_SPEND_CAP_USD_PER_DAY });
        governor.debit(Math.ceil(SHARE_SPEND_CAP_USD_PER_DAY / 0.003 * 1000) + 1000, { labels: [shareSpendLabel(share)] });
      }

      const late = JSON.stringify(await this.replay(share));

      return { before, after: await refusedText(stub.probe()), late };
    } finally {
      socket.close();
    }
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
