/**
 * A real SlateHost in workerd, reached through `routeShare` over Cap'n Web (batch and socket arms).
 * Also bound as `OrchestratorAgent` because the slate's `workspace` resolves `workspaceOwner(...).slateCallAs` by `ctx.id.name`.
 */
import { Effect } from 'effect';
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import * as v from 'valibot';
import { newWebSocketRpcSession } from 'capnweb';
import { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { ProcessFiles } from '@nimbus-sh/core/runtime/process-files.js';
import { supervisorEsbuildService } from '@nimbus-sh/worker/facet-host';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { seedBaseFilesystem } from '@nimbus-sh/core/workspace';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import { PID_GEN_STRIDE } from '@nimbus-sh/core/runtime/process-table.js';
import { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { probeDurableApps, probeFacetManager } from './facet-manager';
import {
  agentCred, bindActorHandle, initWorkspaceSchema, MissionGovernor, provisionAgentHome, settleWorkspaceSlates, SHARE_SPEND_CAP_USD_PER_DAY, SlateOperationSchema,
  shareSpendLabel, type JsonValue, type ShareViewerClaim, type SlateCallResult, type SqlExec, type SqlExecutor, type SqlValue, actorHomeName } from '@kinu.run/core';
import { SlateId } from '@agent-core/core/slates';
import { initSlateLiveShareTables, slateDirectory } from '@kinu.run/core/slates';
import { SlateHost } from '../../src/slates/host';
import { ROOT_SLATE_CALLER, type SlateCaller } from '../../src/slates/bindings';
import { slateBatchStub } from '../../src/slates/rpc-transport';
import { renderThrownChain } from '@kinu.run/core/obs';
import { asFetchFunction, callCodemodeMember, createDefaultWebSearchProvider, createWebCodemodeProvider, requireCodemodeMember } from '@kinu.run/core';

// `env.FILES` and `codemodeEgress()` resolve exports of this worker; without them a `build` boot throws before the route.


export * from '../../src/server';

/** The owner's connections as a graph reads them: one MCP server with a read-only tool and one that writes. */
const MCP = [{ server: 'github', title: 'github', tools: [{ name: 'read_issue', readOnly: true }, { name: 'create_issue', readOnly: false }] }];

/** The triage slates, and what each calls as its owner runs it: `issues` hops into `triage-digest`, which hops back. */
const TRIAGE = {
  issues: [
    ['mcp', 'github', 'read_issue'], ['mcp', 'github', 'create_issue'], ['readFile'], ['writeFile'],
    ['memory', 'recall'], ['memory', 'remember'], ['agent', 'send'], ['slates', 'triage-digest', 'summary'],
  ],
  'triage-digest': [['readFile'], ['slates', 'issues', 'refresh']],
  // What a slate never reaches: control of its calling agent, delegation, or making tools.
  overreach: [['agents', 'hire'], ['agent', 'hire'], ['workspace', 'createTool']],
} as const;

const refusedText = async (call: Promise<JsonValue>): Promise<string> => {
  try {
    await call;

    return 'mutate answered';
  } catch (cause) {
    return renderThrownChain({ cause });
  }
};

const SLATE_ID = 'board';

/** The actor whose browser sessions the owner's slate drives, and the one session it opened. */
const PROBE_ACTOR = 'probe-actor';

const OWNED_SESSION = 'owned-session';

/** A slate whose class connects the browser session its request names, as an eval program would. */
const DRIVER = [
  'import { SlateObject } from "kinu:slate";',
  'export class Slate extends SlateObject {',
  '  async fetch(request) {',
  '    const session = new URL(request.url).searchParams.get("session");',
  '    try { await this.env.workspace.web.connectBrowser(session); return new Response("connected"); }',
  '    catch (cause) { return new Response(String(cause?.message ?? cause)); }',
  '  }',
  '}',
].join('\n');

/** Each time this isolate's Browser Run was dialed: a browser the class reached, whatever the dial then answered. */
let browserRunDials = 0;

/** Browser Run, as the egress gate reaches it: a session answers where a CDP socket would, naming the session. */
export class FakeBrowserRun extends WorkerEntrypoint {
  override async fetch(): Promise<Response> {
    browserRunDials += 1;

    return new Response('Browser Run started a Kitesurf browser');
  }

  async connectSession(sessionId: string) {
    browserRunDials += 1;

    return { webSocket: { fetch: async () => new Response(`Browser Run reached session ${sessionId}`) } };
  }
}

/** The web members a slate's host answers; with no Browser Run of its own, only the browser members' refusals. */
const PROBE_WEB = createWebCodemodeProvider({
  provider: createDefaultWebSearchProvider({ fetch: asFetchFunction(async () => new Response('', { status: 404 })), browser: { missing: 'the probe renders nothing' } }),
  files: null, prelude: { missing: 'a slate drives a browser from its class' },
});

export class SlateShareProbeDO extends DurableObject<Cloudflare.Env> {
  private readonly vfs = new SqliteVFS(this.ctx.storage.sql, this.ctx);
  private readonly filesystem = new ProcessFiles(this.vfs);
  private readonly processes = new SessionProcessSupervisor();

  /** How many processes the owner's own calls left running before the board was shared. */
  private ownersOwn = 0;
  private readonly ports = new PortRegistry();
  private readonly host: SlateHost;
  private _budget: MissionGovernor | undefined;
  private readonly sql: SqlExecutor;
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
    seedBaseFilesystem(this.vfs);
    // As the Kinu boot leaves every workspace: slates are the workspace's, not its main agent's.
    settleWorkspaceSlates(this.vfs.as(CRED_KERNEL), (path) => { this.vfs.registerSharedDirectory(path); });
    // Pids are generation-scoped per boot so a re-spawned process never gets a pid with a live append writer. The
    // probe hosts no Kinu workspace, so it keeps its own counter, one atomic statement per construction.
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS probe_generation (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)');

    const generation = ctx.storage.sql.exec<{ value: number }>(
      'INSERT INTO probe_generation (id, value) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET value = value + 1 RETURNING value',
    ).one().value;

    this.processes.setPidBase(generation * PID_GEN_STRIDE);
    const facets = probeFacetManager({ ctx, env, processes: this.processes, portRegistry: this.ports, vfs: this.vfs, filesystem: this.filesystem });

    this.host = new SlateHost({
      ctx, workspace: ctx.id.name ?? ctx.id.toString(),
      session: async () => ({ vfs: this.vfs, processes: this.processes, filesystem: this.filesystem }),
      facetManager: async () => facets,
      bundler: (vfs) => supervisorEsbuildService(ctx, env, vfs),
      dispatch: async (_caller, route, context) => {
        if (route.kind !== 'namespace') throw new Error(`probe dispatch answers namespace only, got ${route.kind}`);

        // The actor's half of authorizing a browser member: it is within reach, so the class may run it.
        if (route.namespace === 'web' && context.authorizeOnly) {
          requireCodemodeMember([PROBE_WEB], 'web', route.member);

          return null;
        }

        if (route.namespace === 'web') return await callCodemodeMember([PROBE_WEB], 'web', route.member, route.args) ?? null;

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
      browserActor: async (caller) => (caller.share === undefined ? PROBE_ACTOR : null),
      catalog: async () => ({ mcp: MCP, slates: Object.keys(await this.host.projects(ROOT_SLATE_CALLER)) }),
      shareUrl: async (handle) => `https://${handle}.share.test/`,
      shareEntry: () => null,
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
      }, () => Effect.void),
    });

    return this._budget;
  }

  async start(): Promise<void> {
    const root = '/slates/board';
    const files = this.vfs.as(CRED_KERNEL);
    files.mkdir(root, { recursive: true });
    files.writeFile(`${root}/package.json`, JSON.stringify({
      name: SLATE_ID, main: 'server.ts',
      slate: { title: 'Board', runtime: 'worker' },
    }));
    files.writeFile(`${root}/server.ts`, [
      'import { SlateObject } from "kinu:slate";',
      'export class Slate extends SlateObject {',
      '  async probe() { return await this.env.workspace.readFile("/x"); }',
      '  async mutate() { return await this.env.workspace.writeFile("/x", "y"); }',
      '  async hop() { return await this.env.workspace.slates.digest.digest(); }',
      '  async fetch() { return new Response("share-ok"); }',
      '}',
    ].join('\n'));
    const digest = '/slates/digest';
    files.mkdir(digest, { recursive: true });
    files.writeFile(`${digest}/package.json`, JSON.stringify({
      name: 'digest', main: 'server.ts', slate: { title: 'Digest', runtime: 'worker' },
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
    const identity = { uid: 2001, gid: 2001 };
    const home = provisionAgentHome(this.vfs.as(CRED_KERNEL), actorHomeName({ origin: 'agent', name: 'builder', storageKey: 'builder' }), identity);
    const hire: SlateCaller = { path: [{ name: 'builder' }], cred: agentCred(identity), workMode: 'build' };
    const dir = slateDirectory(new SlateId('widgets'));
    const files = this.vfs.as(hire.cred);
    const main = this.vfs.as(CRED_SESSION_USER);
    const manifest = (title: string) => JSON.stringify({ name: 'widgets', main: 'server.ts', slate: { title, runtime: 'worker' } });

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

  /** The egress gate's question of the workspace object: whether this actor opened this session. */
  async ownsBrowserSession(actorId: string, sessionId: string): Promise<boolean> {
    return actorId === PROBE_ACTOR && sessionId === OWNED_SESSION;
  }

  /** What the owner's driver slate answers when its class connects `session`. */
  async drive(session: string): Promise<string> {
    const files = this.vfs.as(CRED_KERNEL);
    files.mkdir('/slates/driver', { recursive: true });
    files.writeFile('/slates/driver/package.json', JSON.stringify({ name: 'driver', main: 'server.js' }));
    files.writeFile('/slates/driver/server.js', DRIVER);
    const process = await this.host.ensure(ROOT_SLATE_CALLER, 'driver');

    return await (await process.request(new Request(`https://slate.invalid/?session=${encodeURIComponent(session)}`))).text();
  }

  /**
   * What the driver answers a viewer of its public share when its class connects `session`, the owner having run it
   * once and shared it granting `approved` beyond what observes.
   */
  async driveShared(session: string, approved: readonly string[], claim: ShareViewerClaim): Promise<{ answer: string; dialed: number }> {
    await this.drive('kitesurf');
    const before = browserRunDials;

    const created = v.parse(v.object({ ok: v.literal(true), value: v.object({ share: v.object({ handle: v.string() }) }) }), await this.host.operation(ROOT_SLATE_CALLER, {
      op: 'share', id: 'driver', visibility: 'public', approved: approved.map((member) => ({ slate: 'driver', namespace: 'web', member })),
    }));

    const request = new Request(`https://share.invalid/?session=${encodeURIComponent(session)}`);
    const answer = await (await this.host.routeShare(created.value.share.handle, claim, request, '/')).text();

    return { answer, dialed: browserRunDials - before };
  }

  /** The triage slates (`TRIAGE`), as an owner authors them where slates live and runs each through what it calls. */
  async authorTriage(): Promise<void> {
    const files = this.vfs.as(CRED_KERNEL);

    for (const id of Object.keys(TRIAGE)) {
      files.mkdir(`/slates/${id}`, { recursive: true });
      files.writeFile(`/slates/${id}/package.json`, JSON.stringify({ name: id, main: 'server.ts', slate: { title: id, runtime: 'worker' } }));
      files.writeFile(`/slates/${id}/server.ts`, 'import { SlateObject } from "kinu:slate";\nexport class Slate extends SlateObject {}\n');
    }

    // Each call is recorded where the host routes it, whatever it then answers.
    for (const [id, paths] of Object.entries(TRIAGE)) {
      for (const path of paths) await this.host.surfaceCall(ROOT_SLATE_CALLER, id, 'workspace', { path: [...path], args: path[0] === 'mcp' || path[0] === 'agent' ? [{ text: 'x' }] : [], invocation: null });
    }
  }

  /** One operation as `as` asks it: the owner at the root, the owner in Plan mode, or a hired agent. */
  async operationAs(as: 'root' | 'plan' | 'hire', input: JsonValue): Promise<SlateCallResult> {
    const callers: Record<typeof as, SlateCaller> = {
      root: ROOT_SLATE_CALLER, plan: { ...ROOT_SLATE_CALLER, workMode: 'plan' }, hire: { ...ROOT_SLATE_CALLER, path: [{ name: 'helper' }] },
    };

    return this.host.operation(callers[as], v.parse(SlateOperationSchema, input));
  }

  /** A call a share's viewer makes with no invocation: the share must name the running call it rides. */
  async unnamedShareCall(share: string): Promise<SlateCallResult> {
    return this.host.surfaceCall({ ...ROOT_SLATE_CALLER, share }, SLATE_ID, 'workspace', { path: ['readFile'], args: ['/x'], invocation: null });
  }

  /** The board as its owner runs it, so its graph names what a share can grant. */
  private async exerciseBoard(): Promise<void> {
    for (const [path, args] of [[['readFile'], ['/x']], [['writeFile'], ['/x', 'fixture-bytes']], [['slates', 'digest', 'digest'], []]] as const) {
      await this.host.surfaceCall(ROOT_SLATE_CALLER, SLATE_ID, 'workspace', { path: [...path], args: [...args], invocation: null });
    }
  }

  /** `approved` names members granted beyond the graph's observing members. */
  async share(approved: readonly { namespace: string; member: string }[] = []): Promise<SlateCallResult> {
    await this.exerciseBoard();
    this.ownersOwn = this.processes.getRunning().length;

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
   * already in flight from the slate does.
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
    return this.host.surfaceCall(
      { ...ROOT_SLATE_CALLER, share }, SLATE_ID, 'workspace', { path: ['readFile'], args: ['/x'], invocation: this.lastCall },
    );
  }

  async requests(share: string): Promise<SlateCallResult> {
    return this.host.operation(ROOT_SLATE_CALLER, { op: 'viewerRequests', share });
  }

  async revoke(share: string): Promise<SlateCallResult> {
    return this.host.operation(ROOT_SLATE_CALLER, { op: 'unshare', share });
  }

  /** Whether every process a share started has stopped; the owner's own, from exercising the board, keep running. */
  async stopped(): Promise<boolean> {
    return this.processes.getRunning().length === this.ownersOwn;
  }

  async slateCallAs(caller: SlateCaller, id: string, name: string, request: JsonValue): Promise<SlateCallResult> {
    const parsed = v.safeParse(v.object({ invocation: v.nullable(v.string()) }), request);

    // The close listener releases with a null invocation; a replay must present the id the slate's call carried.
    if (parsed.success && parsed.output.invocation !== null) this.lastCall = parsed.output.invocation;

    return this.host.surfaceCall(caller, id, name, request);
  }
}

export default class SlateShareProbeWorker extends WorkerEntrypoint<Cloudflare.Env> {}


