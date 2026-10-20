import { exports } from 'cloudflare:workers';
import * as v from 'valibot';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import {
  SlateController, type SlateControllerPorts, heldSlateKey, initEphemeralSlateTable, initSlateLiveShareTables, initSlateUsageTable, slateStorageCall,
  ROOT_SLATE_CALLER, shareCaller, slateAnswer,
  type ServerSend, type SlateAppCall, type SlateApps, type SlateBuilds, type SlateCaller, type SlateCallFrom, type SlateLaunch, type SlateLineage, type ToolContract,
} from '@kinu.run/core/slates';
import {
  ingressAdmitted, slateTitle, SLATE_STORAGE_BINDING, SLATE_HOST_BINDING,
  SlateCallRequestSchema, requireWorkModePermission, routeSlateCall, issuedSlateInvocation, slateAddressImpact, SLATE_DRIVEN_MEMBERS,
  isJsonAnswer, JsonValueSchema, isSlateMethodName, answeredRefusal, reoriginateRequest,
  escapeHtml, keptSlateContext, publicPage, sharedBuildRefusal, VIEWER_EXCHANGE_PATH,
  type JsonValue, type SlateRoute, type SlateCallRequest, type SlateCallResult, type SlateSurfaceResult, type SlateSurfaceValue, type SlateInvocation,
  type SlateSurfaceCatalog, type LiveShareRecord, type SlateViewer, type ShareViewerClaim, type MissionGovernor, type EphemeralSlateAddress,
  type SlateFileChange, type SlateOperation, type EgressPrincipal,
} from '@kinu.run/core';
import type { KvStore } from '@kinu.run/agent-utils';
import { attempt, ERROR_CODES, KinuError, refusalOf, settle, toKinuError, type Refusal } from '@kinu.run/core/obs';
import type { ApprovalSpend } from '@kinu.run/core';
import { Effect } from 'effect';
import { ResidentSlateProcesses, type ResidentSlateDeps, type ResidentSlateProcess } from './resident';
import { slateBatchStub } from './rpc-transport';
import { type SlateBinding, type SlateBindingProps } from './bindings';
import { codemodeEgress } from '../codemode-egress';
import { SlateSources, type MessageBlock, type SlateSource } from './sources';
import { PersonalParts, type PartConnections } from './part-runs';

type SlateCapabilityRoute = Exclude<SlateRoute, { kind: 'app' }>;

/** What the host decided about a call, carried into the actor that runs it. */
export interface SlateDispatchContext {
  /** Check that the call may run, and run nothing: the class runs it, where its browser socket lives. */
  readonly authorizeOnly?: true;
  /**
   * The shared server's environment: a call any shared slate bounds, whoever's request it is (a viewer's or the
   * owner's own), runs crafted tools, egress and browsers as the share's, never as the owner's own. One principal,
   * one policy (shared-server.ts).
   */
  readonly viewer?: true;
  /**
   * Each member a call reaches inside itself, as a crafted tool's program does, before it runs: recorded for its
   * owner's slate, held to the grant and the share's life for a viewer. It throws to refuse.
   */
  readonly nested: (namespace: string, member: string) => void;
  /**
   * A viewer's call: the share's word on it read again where it acts (share-viewers.ts `ViewerRun`). The dispatch calls
   * it synchronously immediately before the call acts, with nothing awaited between; it throws to refuse.
   */
  readonly admit?: () => void;
}

export interface SlateHostDeps extends Omit<ResidentSlateDeps, 'retained'> {
  readonly ctx: DurableObjectState;
  readonly workspace: string;
  /** The object's slate build records, which its owner reads and moves on a file change before any host is loaded. */
  readonly builds: SlateBuilds;
  /** Runs as the caller: its own providers, role reach, read models and gates. */
  dispatch(caller: SlateCaller, route: SlateCapabilityRoute, context: SlateDispatchContext): Promise<SlateSurfaceValue>;
  /** The actor whose browser sessions the caller's slate drives, as that actor's eval programs do; null for a share's
   *  viewer, whose grant no CDP socket passes through. */
  browserActor(caller: SlateCaller): Promise<string | null>;
  readonly apps: SlateApps;
  catalog(): Promise<SlateSurfaceCatalog>;
  /** The app's page a share is entered through, its one link, or null where this deployment names no app origin. */
  shareEntry(share: string): string | null;
  /** Absent means no per-viewer rate bound, as at the edge. */
  kv?: KvStore;
  /** Debits the per-share per-day spend label; absent means no spend bound. */
  budget?(): MissionGovernor;
  ownerTitle?(): Promise<string>;
  /** Each viewer's own account, where their personal parts' calls run (`part-runs.ts`); absent, no part runs. */
  readonly partConnections?: PartConnections;
  ownerUserId?(): string | null;
  /** The owner's secrets granted to the workspace, as an owner's slate server holds them: placeholders, since a slate's
   *  server is started again without asking (`CommandEnvironment` `keep`). */
  secrets?(): Promise<Readonly<Record<string, string>>>;
  /** The workspace's one queue of actions parked on its owner, where `owner` shares' effects wait (deferred-approval.ts). */
  readonly ownerEffects?: NonNullable<SlateControllerPorts<SlateSource, ResidentSlateProcess>['ownerEffects']>;
  /** What the owner's MCP catalog knows of a connection's tool (share-policy.ts `ToolContract`). */
  toolContract?(namespace: string, member: string): Promise<ToolContract | null>;
  /** A live share's Gallery listing changed where its owner waits: the Gallery is told now, a failure logged. */
  listingChanged?(share: LiveShareRecord): Promise<void>;
  /** The Gallery told again of these listed shares, in the background. */
  relisted?(shares: readonly LiveShareRecord[]): void;
  forgetPicture?(slate: string): Promise<void>;
  sharesChanged?(): Promise<'current' | 'pending'>;
  previewed?(slate: string): void;
  /** This workspace's owner reading or changing a slate another workspace shared with them to edit (orchestrator). */
  shared?(operation: Extract<SlateOperation, { op: 'sharedFiles' | 'sharedEdit' }>): Promise<SlateCallResult>;
  /** The block an ephemeral slate's id names, and the author whose authority its page runs with; refused when no stored
   *  answer holds it. */
  messageBlock?(address: EphemeralSlateAddress): Promise<MessageBlock>;
}


/** The one surface every slate is given, as its process sees it. */
const SLATE_SURFACE = 'workspace';

/** A viewer let in: the caller its calls run as, and the invocation its request carries. */
interface ViewerAdmitted {
  readonly caller: SlateCaller;
  readonly invocation: string;
  readonly share: LiveShareRecord;
  readonly viewer: SlateViewer;
  readonly settle: (outcome: string) => void;
}

/** A guest refusal crosses Cap'n Web as a plain Error with message `reason: error`. */
const SLATE_REFUSAL_MESSAGE = new RegExp(`^(${ERROR_CODES.join('|')}): ([\\s\\S]*)$`);

function shareOutcome(response: Response): 'ok' | 'refused' | 'error' {
  if (response.ok) return 'ok';

  return response.status < 500 ? 'refused' : 'error';
}

function refusalFromThrown(input: { cause: unknown }): Refusal | null {
  const match = input.cause instanceof Error ? SLATE_REFUSAL_MESSAGE.exec(input.cause.message) : null;
  const reason = match === null ? undefined : v.safeParse(v.picklist(ERROR_CODES), match[1]);

  return reason?.success === true && match !== null ? refusalOf(new KinuError(reason.output, match[2])) : null;
}

/**
 * One process per authored tree per caller, and one durable application per slate. The application's port and capability
 * persist in this object's storage, run as the workspace root and keep one facet SQLite until `remove`; other callers' processes are private and portless.
 */
export class SlateHost {
  readonly controller: SlateController<SlateSource, ResidentSlateProcess>;
  private readonly resident: ResidentSlateProcesses;
  private readonly slateSources: SlateSources;
  /** Each viewer's own parts of the slates this workspace shares (docs/SLATE-SHARING-NIMBUS.md §3). */
  readonly parts: PersonalParts;

  constructor(private readonly deps: SlateHostDeps) {
    const sql = deps.ctx.storage.sql;
    const { kv } = deps;

    initSlateLiveShareTables((ddl) => { sql.exec(ddl); });
    initEphemeralSlateTable((ddl) => { sql.exec(ddl); });
    initSlateUsageTable((ddl) => { sql.exec(ddl); });
    this.controller = new SlateController({
      workspace: deps.workspace, sql, builds: deps.builds, transaction: (body) => deps.ctx.storage.transactionSync(body),
      session: deps.session, apps: deps.apps,
      resolve: (cred, id) => this.slateSources.resolve(cred, id),
      // A shared slate builds from its own tree alone (`SlateBuildInput.scope`), so its build is told apart from the same
      // source built unshared: sharing it builds it anew, and no image built before reaches anyone it is shared with.
      digest: async (cred, id, source) => `${await this.slateSources.digest(cred, id, source)}${this.controller.live.isShared(id) ? ':tree' : ''}`,
      build: async (caller, id, source) => this.resident.build({
        owner: id, root: source.root, project: source.project, read: await this.slateSources.reader(caller.cred, source), cred: caller.cred,
        ...(this.controller.live.isShared(id) && { scope: 'tree' as const }),
      }),
      launch: (launch) => this.launch(launch),
      // A socket-held invocation dies with the process that held it.
      // A socket-held request, and every request issued to the process, dies with it.
      ended: (held) => {
        const lineage = this.heldLineage.get(held);

        this.heldLineage.delete(held);

        for (const [invocationId, issued] of this.invocations) {
          if (issued.held === held || issued.incarnation === lineage?.incarnation) this.invocations.delete(invocationId);
        }
      },
      call: (request) => this.call(request),
      catalog: () => deps.catalog(),
      shareEntry: (share) => deps.shareEntry(share),
      ...(kv !== undefined && { admitted: async (key: string, perMinute: number) => ingressAdmitted(kv, 'slate-share', key, perMinute) }),
      ...(deps.budget !== undefined && { budget: deps.budget.bind(deps) }),
      ...(deps.ownerUserId !== undefined && { ownerUserId: deps.ownerUserId.bind(deps) }),
      ...(deps.forgetPicture !== undefined && { forgetPicture: deps.forgetPicture.bind(deps) }),
      ...(deps.sharesChanged !== undefined && { sharesChanged: deps.sharesChanged.bind(deps) }),
      ...(deps.ownerTitle !== undefined && { ownerTitle: deps.ownerTitle.bind(deps) }),
      ...(deps.ownerEffects !== undefined && { ownerEffects: deps.ownerEffects }),
      ...(deps.toolContract !== undefined && { toolContract: deps.toolContract.bind(deps) }),
      ...(deps.listingChanged !== undefined && { listingChanged: deps.listingChanged.bind(deps) }),
      ...(deps.relisted !== undefined && { relisted: deps.relisted.bind(deps) }),
      shareChanged: async (slate) => { await this.shareChanged(slate); },
      ...(deps.previewed !== undefined && { previewed: deps.previewed.bind(deps) }),
      ...(deps.shared !== undefined && { shared: async (_caller: SlateCaller, operation: Parameters<NonNullable<SlateHostDeps['shared']>>[0]) => this.shared(operation) }),
    });
    this.resident = new ResidentSlateProcesses({
      session: deps.session, facetManager: deps.facetManager, bundler: deps.bundler, retained: () => this.controller.builds.retained(),
    });
    this.slateSources = new SlateSources({
      project: (cred, id) => this.controller.project(cred, id), trees: (cred) => this.controller.slates(cred), host: deps,
    });
    this.parts = new PersonalParts({
      workspace: deps.workspace, controller: this.controller, resident: this.resident, call: (request) => this.call(request),
      ...(deps.ownerUserId !== undefined && { ownerUserId: deps.ownerUserId.bind(deps) }),
      ...(deps.ownerTitle !== undefined && { ownerTitle: deps.ownerTitle.bind(deps) }),
      ...(deps.partConnections !== undefined && { connections: deps.partConnections }),
    });
  }

  /** The core's admission, answered over HTTP: refusals as their statuses, the consent page, or the viewer let in. */
  async admitViewerRequest(input: {
    readonly handle: string;
    readonly claim: ShareViewerClaim;
    readonly pathname: string;
    /** The host context its page was framed with, kept across the consent it may be asked first (`keptSlateContext`). */
    readonly context: string;
  }): Promise<ViewerAdmitted | Response> {
    const admission = await this.controller.viewers.admit(input);
    const headers = { 'cache-control': 'no-store' };

    switch (admission.kind) {
      case 'missing': return new Response('Not found', { status: 404, headers });
      case 'sign-in': return new Response(null, { status: 303, headers: { location: admission.entry, ...headers } });
      case 'too-many': return new Response('Too many requests', { status: 429, headers });
      case 'consent': return await this.consentPage(admission.share, admission.namespaces, input.context);
      case 'admitted': {
        const { caller, share, viewer } = admission;
        const invocation = crypto.randomUUID();

        // Bound to no process yet (`routeShare` binds it to the one it reaches): a call naming it now is refused.
        this.invocations.set(invocation, { id: share.slate, chain: [], viewer, incarnation: '', generations: this.generationsOf([share.slate]) });

        return { caller, invocation, share, viewer, settle: (outcome) => { this.controller.live.settleRequest(viewer.request, outcome); } };
      }
    }
  }

  /** What the grant reaches of the owner's, disclosed before anything of theirs runs. */
  private async consentPage(share: LiveShareRecord, namespaces: readonly string[], context: string): Promise<Response> {
    const project = await this.controller.project(CRED_SESSION_USER, share.slate);
    const owner = (await this.deps.ownerTitle?.()) ?? this.deps.workspace;
    const title = slateTitle(project, share.slate);
    const reached = namespaces.map((namespace) => `<li>${escapeHtml(namespace)}</li>`).join('');

    const html = publicPage({
      title: `${owner} shared ${title}`,
      body: `<main><section class="section">
<h1>${escapeHtml(owner)} shared ${escapeHtml(title)}</h1>
<p class="dim">This slate runs in ${escapeHtml(owner)}'s workspace and calls these connections with their credentials:</p>
<ul>${reached}</ul>
<p class="dim">What you do here runs as ${escapeHtml(owner)} and is logged for them.</p>
<a class="btn solid" href="${escapeHtml(`${VIEWER_EXCHANGE_PATH}?consent=1${context === '' ? '' : `&${context}`}`)}">Continue</a>
</section></main>`,
    });

    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  }

  async routeShare(
    handle: string,
    claim: ShareViewerClaim,
    request: Request,
    pathname: string,
  ): Promise<Response> {
    const admission = await this.admitViewerRequest({ handle, claim, pathname, context: keptSlateContext(new URL(request.url)) });

    if (admission instanceof Response) return admission;

    try {
      // A share's viewers use the slate itself: its durable app and its storage are the state everyone shares. What its
      // calls may reach is the shared server's to say (shared-server.ts), for every request alike.
      const process = await this.ensure(ROOT_SLATE_CALLER, admission.share.slate);
      const issued = this.invocations.get(admission.invocation);

      if (issued !== undefined) this.invocations.set(admission.invocation, { ...issued, incarnation: this.lineageOfProcess(process).incarnation });
      const headers = new Headers(request.headers);
      headers.set('x-slate-call', admission.invocation);
      const target = new URL(request.url);
      target.pathname = pathname;
      const forwarded = reoriginateRequest(request, target.toString(), { headers, redirect: request.redirect });
      const response = headers.get('upgrade')?.toLowerCase() === 'websocket' ? await process.connect(forwarded) : await process.request(forwarded);

      const held = this.invocations.get(admission.invocation);

      if (response.status === 101 && held !== undefined) {
        this.invocations.set(admission.invocation, { ...held, held: heldSlateKey(ROOT_SLATE_CALLER, admission.share.slate) });
      } else {
        this.invocations.delete(admission.invocation);
        admission.settle(shareOutcome(response));
      }

      return response;
    } catch (cause) {
      this.invocations.delete(admission.invocation);
      const error = toKinuError({ doing: `slate share ${handle}`, cause, otherwise: 'io' });
      admission.settle('error');

      return new Response(error.message, {
        status: error.code === 'denied' || error.code === 'missing' ? 404 : 500,
        headers: { 'cache-control': 'no-store' },
      });
    }
  }

  private readonly invocations = new Map<string, SlateInvocation & { readonly held?: string }>();
  /** Each running process's lineage, as minted into its bindings at launch: by the process, and by its held key. */
  private readonly lineages = new WeakMap<ResidentSlateProcess, SlateLineage>();
  private readonly heldLineage = new Map<string, SlateLineage>();

  private lineageOfProcess(process: ResidentSlateProcess): SlateLineage {
    return this.lineages.get(process) ?? { incarnation: '', generation: -1, ancestors: {} };
  }

  /** Each slate's sharing generation now: what a request issued now is bound to. */
  private generationsOf(slates: readonly string[]): Record<string, number> {
    return Object.fromEntries(slates.map((slate) => [slate, this.controller.generation(slate)]));
  }

  /**
   * A named root invocation for a request this host did not originate; unnamed, a slate could replay a preview's calls
   * from inside a hop. A socket's invocation is released by its close listener via `__host`.
   */
  slateInvocation(port: number, socket: boolean): { readonly value: string; release: () => void } | null {
    const running = this.controller.processes.onPort(port);

    if (running === null) return null;
    const value = crypto.randomUUID();
    const record = { id: running.id, chain: [], incarnation: this.lineageOfProcess(running.process).incarnation, generations: this.generationsOf([running.id]) };

    this.invocations.set(value, socket ? { ...record, held: running.held } : record);

    return { value, release: () => { this.invocations.delete(value); } };
  }

  private releaseInvocation(caller: SlateCaller, id: string, request: SlateCallRequest): SlateCallResult {
    const target = request.args[0];

    if (request.path.join('.') !== 'release' || !v.is(v.string(), target)) {
      return { ok: false, ...refusalOf(toKinuError({ doing: `slate ${id} host call`, cause: new KinuError('bad_input', 'The host binding answers only release(invocation)'), otherwise: 'io' })) };
    }

    const issued = this.invocations.get(target);
    // Only the invocation this process holds, so it cannot retire another's lineage.

    if (issued === undefined || issued.id !== id || issued.held !== heldSlateKey(caller, id)) {
      return { ok: false, ...refusalOf(toKinuError({ doing: `slate ${id} host call`, cause: new KinuError('denied', `Slate ${id} named app invocation ${target}, which this host is not running`), otherwise: 'io' })) };
    }

    this.invocations.delete(target);

    if (issued.viewer !== undefined) this.controller.live.settleRequest(issued.viewer.request, 'closed');

    return { ok: true, value: null };
  }

  /**
   * Every call a slate makes, routed and held to its caller's reach as of now: a held stub proves its slate, nothing more.
   * `lineage` is what the host minted into the process's bindings; the request it names says only whom the call is for.
   * Where any slate on the call's way is shared, its server is the one principal it is (shared-server.ts), read again at
   * the very send.
   */
  async surfaceCall({ caller, id, name, lineage }: SlateCallFrom, request: JsonValue): Promise<SlateSurfaceResult> {
    try {
      const parsed = v.safeParse(SlateCallRequestSchema, request);

      if (!parsed.success) throw new KinuError('bad_input', 'A slate call is { path: string[], args: JSON[], invocation: string | null }', { cause: new v.ValiError(parsed.issues) });

      if (name === SLATE_HOST_BINDING) return this.releaseInvocation(caller, id, parsed.output);
      const servers = this.controller.servers;
      const issued = issuedSlateInvocation({ invocations: this.invocations, id, invocation: parsed.output.invocation });
      const stale = servers.lineage(id, lineage, issued);

      if (stale !== null) return { ok: false, ...refusalOf(stale) };

      // Answered here, not dispatched: it carries no actor capability.
      if (name === SLATE_STORAGE_BINDING) return slateStorageCall(this.controller.state, caller, id, { member: parsed.output.path.join('.'), args: parsed.output.args });
      // The shared slates this process runs under (`SlateCaller.via`, minted into its bindings) bound it whatever request it
      // names, or none: a callee cannot drop the authority it inherited by dropping the record that names it.
      const chain = [...new Set([...Object.keys(caller.via ?? {}), ...issued?.chain ?? []])];
      const shared = [...chain, id].some((slate) => servers.authorityOf(slate).kind !== 'owner');

      // A shared server acts only under a request this host issued; a call naming none is no one's, and refused.
      if (shared && issued === null) return { ok: false, ...refusalOf(new KinuError('denied', `Slate ${id} is shared, and called out under no request of this host's`)) };
      const viewer = issued?.viewer;
      const reportOnly = parsed.output.authorize !== true;

      const gate = (call: { readonly address: { readonly namespace: string; readonly member: string }; readonly effect: boolean }, on: string) => servers.gate({
        slate: id, chain, address: call.address, effect: call.effect, args: parsed.output.args, on, fence: { lineage, record: issued },
      });

      // What a call reaches inside itself meets every shared server's bound as it stands then, its process and request
      // held first to the sharing they began under.
      const within = (namespace: string, member: string) => { servers.within({ slate: id, chain, address: { namespace, member }, fence: { lineage, record: issued } }); };

      // A viewer's request is held to its own share as it stands now, and the server's word on it with it.
      if (viewer !== undefined) {
        return await this.controller.viewers.call({
          share: viewer.share, id, request: parsed.output, chain, issued, gate: (call) => gate(call, viewer.subject),
          bound: (address) => servers.bounded({ slate: id, chain, address }),
          run: (route, nested, admit) => this.run(shareCaller(viewer.share), route, {
            nested: (namespace, member) => { within(namespace, member); nested(namespace, member); },
            admit,
            viewer: true,
            ...(parsed.output.authorize && { authorizeOnly: true }),
          }, viewer),
        });
      }

      if (caller.share !== undefined) return { ok: false, ...refusalOf(new KinuError('denied', `Slate ${id} runs for a share, and called out under no viewer's request`)) };
      const source = await this.slateSources.resolve(caller.cred, id);

      if (source.kind === 'message' && !source.bound) {
        throw new KinuError('denied', `Slate ${id} is a hired agent's page, drawn with no authority lent to it: its calls would not run where that agent's stores are`);
      }

      // An answer's page calls as its author as of now, in the mode the author's next turn runs in.
      const callsAs = source.kind === 'message' ? source.author : caller;
      // Only the owner's own slate, calling as the owner, hires or messages helpers; a hosted actor's slate never does.
      const call = routeSlateCall({ id, request: parsed.output, chain, hosted: callsAs.path.length > 0 });
      const impact = slateAddressImpact(call.address) ?? 'administer';
      const driven = reportOnly && call.address.namespace === 'web' && SLATE_DRIVEN_MEMBERS.includes(call.address.member);
      // An answer's page is never shared or published, so what it calls is no slate's graph.
      const record = (namespace: string, member: string) => { if (source.kind !== 'message') this.controller.usage.record(id, { namespace, member }); };

      record(call.address.namespace, call.address.member);

      // Shared, the owner's own request is the server's like any other: bounded, and every effect asks them.
      // Unbounded or not, its send reads again where it acts, as does each member it reaches inside itself.
      return await this.gatedRun({
        gate: gate({ address: call.address, effect: impact !== 'observe' && !driven }, 'the owner'),
        run: (bounded, admit) => this.run(callsAs, call.route, {
          nested: (namespace, member) => { within(namespace, member); record(namespace, member); },
          admit,
          ...(bounded && { viewer: true }),
          ...(parsed.output.authorize && { authorizeOnly: true }),
        }),
      });
    } catch (cause) {
      return { ok: false, ...refusalOf(toKinuError({ doing: `slate ${id} ${name}`, cause, otherwise: 'io' })) };
    }
  }

  /**
   * A call the shared servers on its way weighed (`gate`), run with their word taken again where it acts, and the
   * owner's approval it took settled once it was handed on: a failure after that may have acted, so one approval never
   * runs a call twice. Unbounded (no shared server on its way), it runs as its owner's own app always did, its send read
   * again all the same: unbounded when it began is no permission once it is shared.
   */
  gatedRun(input: {
    readonly gate: Effect.Effect<ServerSend, KinuError>;
    readonly run: (bounded: boolean, admit: () => void) => Promise<SlateSurfaceResult>;
  }): Promise<SlateSurfaceResult> {
    return settle(Effect.gen({ self: this }, function* () {
      const send = yield* input.gate;
      const taken: ApprovalSpend[] = [];

      const admit = (): void => {
        const spend = send.admit();

        if (spend !== null) taken.push(spend);
      };

      const settled = Effect.promise(async () => {
        const [spend] = taken;

        if (spend !== undefined) await this.deps.ownerEffects?.settle(spend, 'spent');
      });

      return yield* Effect.ensuring(attempt({ doing: 'a slate\'s call', otherwise: 'io' }, async () => input.run(send.bounded, admit)), settled);
    }));
  }

  private async run(caller: SlateCaller, route: SlateRoute, context: SlateDispatchContext, viewer?: SlateViewer): Promise<SlateSurfaceResult> {
    switch (route.kind) {
      case 'namespace': {
        const value = await this.deps.dispatch(caller, route, context);
        const refused = isJsonAnswer(value) ? answeredRefusal(value) : null;

        return refused === null ? { ok: true, value } : { ok: false, ...refused };
      }

      // MCP owns CallToolResult.isError; read models are application data.
      // Neither producer declares the internal namespace refusal vocabulary.
      case 'mcp':
      case 'rpc':
      case 'tool':
      case 'agent':
      case 'ai': return { ok: true, value: await this.deps.dispatch(caller, route, context) };
      // The hop keeps the caller's authority, never the author's; the viewer follows the chain.
      case 'app': return this.call({
        caller: this.inheriting(caller, route.chain), id: route.id, method: route.method, args: [...route.args], chain: route.chain, viewer,
        ...(context.admit !== undefined && { admit: context.admit }),
      });
    }
  }

  /**
   * The caller a hop's callee runs as: an owner's request that came through a shared slate runs the callee in a process
   * of its own, bounded by those slates whatever it names (`SlateCaller.via`). A viewer's runs as its share already.
   */
  private inheriting(caller: SlateCaller, chain: readonly string[]): SlateCaller {
    if (caller.share !== undefined) return caller;

    // Each shared slate on the way, sealed at its sharing now; what the caller inherited keeps the seal it already has.
    const sealed = chain.filter((slate) => caller.via?.[slate] === undefined && this.controller.servers.authorityOf(slate).kind !== 'owner')
      .map((slate) => [slate, this.controller.generation(slate)] as const);

    const via = { ...caller.via, ...Object.fromEntries(sealed) };

    return Object.keys(via).length === 0 ? caller : { ...caller, via };
  }

  /** One Cap'n Web HTTP-batch RPC; the invocation id lives exactly as long as the call. */
  async call(request: SlateAppCall): Promise<SlateCallResult> {
    const { caller, id, method, args, chain = [], viewer, admit } = request;
    const invocation = crypto.randomUUID();

    try {
      requireWorkModePermission(caller.workMode, false, 'Calling authored slate code');

      if (!isSlateMethodName(method)) throw new KinuError('bad_input', `"${method}" is not an app method name`);
      const parsed = v.safeParse(v.array(JsonValueSchema), args);

      if (!parsed.success) throw new KinuError('bad_input', 'Slate arguments must be JSON values', { cause: new v.ValiError(parsed.issues) });
      const process = await this.ensure(caller, id);

      if (!process.methods.includes(method)) {
        throw new KinuError('bad_input', `Slate ${id} has no method ${method}; its class exports ${process.methods.join(', ')}`);
      }

      // Issued to the process it reaches, under each slate's sharing on its way now.
      const record = { id, chain, incarnation: this.lineageOfProcess(process).incarnation, generations: this.generationsOf([...chain, id]) };

      this.invocations.set(invocation, viewer === undefined ? record : { ...record, viewer });
      const stub = slateBatchStub<Record<string, (...args: JsonValue[]) => Promise<JsonValue>>>(process, invocation);

      try {
        // The caller's word read again where the call is sent, with nothing awaited between: it throws to refuse.
        admit?.();
        const raw: unknown = await stub[method](...parsed.output);
        const value = v.safeParse(JsonValueSchema, raw === undefined ? null : raw);

        if (!value.success) throw new KinuError('bad_input', 'Slate method must return a JSON value', { cause: new v.ValiError(value.issues) });

        return { ok: true, value: value.output };
      } finally {
        // Dispose here, not at transport end, or workerd reports the read-loop rejection as unhandled.
        stub[Symbol.dispose]();
      }
    } catch (cause) {
      const refusal = refusalFromThrown({ cause });

      if (refusal !== null) return { ok: false, ...refusal };

      return { ok: false, ...refusalOf(toKinuError({ doing: `slate ${id}.${method}`, cause, otherwise: 'io' })) };
    } finally {
      this.invocations.delete(invocation);
    }
  }

  /**
   * A share of `id` started, stopped or changed mode: its durable app ends, and boots again on its next call with the
   * network its shares now allow.
   */
  async shareChanged(id: string): Promise<void> {
    // Its own app, and every process that inherited its bound through it (`SlateCaller.via`): their lineage refuses
    // them already, so this only ends what can no longer act.
    await this.controller.processes.stopWhere((running) => (running.id === id && running.caller.share === undefined && running.caller.path.length === 0)
      || running.caller.via?.[id] !== undefined);
  }

  /**
   * An editor's change to one of this workspace's slates (docs/SLATE-SHARING-NIMBUS.md §2): refused unless a live share
   * adds `editor` to edit it now. One version-checked batch commits its files and edit mark, then builds from its own
   * tree. A failed build takes back only bytes this batch still owns; newer saves survive and are named as conflicts.
   */
  editAs(id: string, editor: { readonly userId: string; readonly email: string }, files: SlateFileChange): Promise<SlateCallResult> {
    return settle(slateAnswer(`${editor.email}'s edit of slate ${id}`, Effect.gen({ self: this }, function* () {
      if (!this.controller.live.editsSlate(id, editor.userId)) return yield* new KinuError('denied', `Slate ${id} is not shared with ${editor.email} to edit`);
      const written = yield* Effect.promise(async () => this.controller.writeShared(id, files, editor.email));

      if (!written.ok) return yield* new KinuError(written.reason, written.error);

      const built = yield* Effect.result(Effect.flatMap(
        attempt({ doing: `building slate ${id}`, otherwise: 'io' }, async () => this.controller.processes.booted(ROOT_SLATE_CALLER, id)),
        (running) => (running.broken === null ? Effect.void : Effect.fail(new KinuError('bad_input', running.broken))),
      ));

      if (built._tag === 'Failure') {
        const undone = yield* Effect.promise(async () => this.controller.rollbackShared(id, written.value));

        if (!undone.ok) return yield* new KinuError(undone.reason, `${built.failure.message}; taking the change back failed too: ${undone.error}`, { cause: built.failure });
        const conflicts = undone.value.conflicts;

        return yield* new KinuError(built.failure.code, `${built.failure.message}${conflicts.length === 0 ? '' : `; rollback conflict: kept newer changes to ${conflicts.join(', ')}`}`, { cause: built.failure });
      }

      return [...written.value.paths];
    })));
  }

  /** One of this workspace's slates' files, for someone a live share adds to edit it now. */
  filesFor(id: string, editor: { readonly userId: string; readonly email: string }): Promise<SlateCallResult> {
    return settle(slateAnswer(`reading slate ${id} for ${editor.email}`, Effect.gen({ self: this }, function* () {
      if (!this.controller.live.editsSlate(id, editor.userId)) return yield* new KinuError('denied', `Slate ${id} is not shared with ${editor.email} to edit`);
      const read = yield* Effect.promise(async () => this.controller.sharedFiles(id));

      return read.ok ? read.value : yield* new KinuError(read.reason, read.error);
    })));
  }

  /** This workspace's owner reading or changing a slate another workspace shared with them to edit. */
  shared(operation: Parameters<NonNullable<SlateHostDeps['shared']>>[0]): Promise<SlateCallResult> {
    return settle(slateAnswer(`slate ${operation.workspace}/${operation.slate}`, Effect.gen({ self: this }, function* () {
      const answered = yield* attempt({ doing: 'asking its workspace', otherwise: 'unavailable' }, async () => this.deps.shared?.(operation) ?? null);

      if (answered === null) return yield* new KinuError('unsupported', 'This workspace edits no shared slate');

      return answered.ok ? answered.value : yield* new KinuError(answered.reason, answered.error);
    })));
  }

  /**
   * Refused when `id` is shared and its image was not built from its own tree alone: a shared slate never runs one built
   * before it was shared, which its last build that worked may be when its own tree alone does not build.
   */
  servable(id: string, ownTree: boolean): Promise<void> {
    return settle(Effect.suspend(() => (ownTree || !this.controller.live.isShared(id)
      ? Effect.void
      : Effect.fail(new KinuError('bad_input', sharedBuildRefusal(id))))));
  }

  async ensure(caller: SlateCaller, id: string): Promise<ResidentSlateProcess> {
    return (await this.controller.processes.booted(caller, id)).process;
  }

  /** A process for `launch`: the slate's bindings as its caller, and its outbound mediated as that caller's eval is. */
  private async launch(launch: SlateLaunch<SlateSource>): Promise<ResidentSlateProcess> {
    const { id, caller, source, image, app } = launch;

    await this.servable(id, source.kind === 'message' || image.scope === 'tree');

    // Shared, the slate's server drives no browser of the owner's: only one its own call opened (Kitesurf).
    const unshared = caller.share === undefined && caller.via === undefined && this.controller.servers.authorityOf(id).kind === 'owner';
    // What the slate's sharing was when this launch chose its network: changed before it is running, it starts again.
    // The shared slates it inherited its bound from are sealed into it as the hop sealed them (`SlateCaller.via`).
    const lineage: SlateLineage = { incarnation: crypto.randomUUID(), generation: this.controller.generation(id), ancestors: { ...caller.via } };
    const actor = unshared ? await this.deps.browserActor(caller) : null;
    // Shared, it reaches the network as no one: its own preview hosts too, and it holds and spends none of the owner's secrets.
    const ownerUserId = unshared ? this.deps.ownerUserId?.() ?? null : null;
    const principal: EgressPrincipal = unshared ? { as: 'owner', workspace: this.deps.workspace, actorId: actor, ownerUserId } : { as: 'viewer', workspace: this.deps.workspace, actorId: null };
    const globalOutbound = caller.workMode === 'plan' ? null : codemodeEgress({ principal });
    const secrets = unshared ? await this.deps.secrets?.() ?? {} : {};

    if (caller.workMode === 'build' && globalOutbound === null) {
      throw new KinuError('unsupported', 'Resident slate egress requires the shared outbound policy binding');
    }

    const bindings: Record<string, Fetcher<SlateBinding>> = {};

    for (const name of [SLATE_SURFACE, SLATE_STORAGE_BINDING, SLATE_HOST_BINDING]) {
      const props: SlateBindingProps = { workspace: this.deps.workspace, id, name, caller, lineage };
      bindings[name] = exports.SlateBinding({ props });
    }

    const started = await this.resident.launch({ owner: id, root: source.root, bindings, secrets, globalOutbound, app: app === null ? null : { port: app.port } }, image);

    // Shared or unshared while it started: its network was chosen for what no longer holds, so it never runs as it is.
    if (this.controller.generation(id) !== lineage.generation) {
      await started.stop();

      return await this.launch(launch);
    }

    const running = await this.sealed(id, lineage, started);

    this.lineages.set(running, lineage);
    this.heldLineage.set(heldSlateKey(caller, id), lineage);

    return running;
  }

  /**
   * `started` while the sharing sealed in its lineage still holds; else stopped, and refused. A shared slate it inherited
   * its bound from shares otherwise since the hop sealed it: the bound it was started under has ended, and started again
   * under the same seals it would end the same way, so it never runs.
   */
  sealed(id: string, lineage: SlateLineage, started: ResidentSlateProcess): Promise<ResidentSlateProcess> {
    return settle(Effect.gen({ self: this }, function* () {
      const ended = this.controller.servers.lineage(id, lineage, null);

      if (ended === null) return started;
      yield* Effect.promise(async () => started.stop());

      return yield* ended;
    }));
  }
}
