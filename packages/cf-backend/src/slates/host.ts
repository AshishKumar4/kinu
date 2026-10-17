import { exports } from 'cloudflare:workers';
import * as v from 'valibot';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import {
  SlateController, type SlateControllerPorts, heldSlateKey, initEphemeralSlateTable, initSlateLiveShareTables, initSlateUsageTable, slateStorageCall,
  ROOT_SLATE_CALLER, serverAuthority, shareCaller, slateAnswer, slateRevision,
  type LiveShareAuthority, type ServerAuthority, type SlateAppCall, type SlateApps, type SlateBuilds, type SlateCaller, type SlateLaunch,
} from '@kinu.run/core/slates';
import {
  ingressAdmitted, slateTitle, SLATE_STORAGE_BINDING, SLATE_HOST_BINDING,
  SlateCallRequestSchema, requireWorkModePermission, routeSlateCall, issuedSlateInvocation, grantAdmits, admitNestedViewerCall,
  isJsonAnswer, JsonValueSchema, isSlateMethodName, answeredRefusal, reoriginateRequest,
  escapeHtml, publicPage, VIEWER_EXCHANGE_PATH,
  type JsonValue, type SlateRoute, type SlateCallRequest, type SlateCallResult, type SlateSurfaceResult, type SlateSurfaceValue, type SlateInvocation,
  type SlateSurfaceCatalog, type LiveShareRecord, type SlateViewer, type ShareViewerClaim, type MissionGovernor, type EphemeralSlateAddress,
  type SlateFileChange, type SlateOperation,
} from '@kinu.run/core';
import type { KvStore } from '@kinu.run/agent-utils';
import { attempt, ERROR_CODES, KinuError, refusalOf, settle, toKinuError, type Refusal } from '@kinu.run/core/obs';
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
  /** A share's viewer: what runs for it reaches no browser of the owner's, as a viewer's slate process does not. */
  readonly viewer?: true;
  /**
   * Each member a call reaches inside itself, as a crafted tool's program does, before it runs: recorded for its
   * owner's slate, held to the grant and the share's life for a viewer. It throws to refuse.
   */
  readonly nested: (namespace: string, member: string) => void;
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
  shareUrl(handle: string): Promise<string | null>;
  /** The app's page a `users` share is entered through, or null where this deployment names no app origin. */
  shareEntry(share: string): string | null;
  /** Absent means no per-viewer rate bound, as at the edge. */
  kv?: KvStore;
  /** Debits the per-share per-day spend label; absent means no spend bound. */
  budget?(): MissionGovernor;
  ownerTitle?(): Promise<string>;
  /** Each viewer's own account, where their personal parts' calls run (`part-runs.ts`); absent, no part runs. */
  readonly partConnections?: PartConnections;
  ownerUserId?(): string | null;
  /** The workspace's one queue of actions parked on its owner, where `owner` shares' effects wait (deferred-approval.ts). */
  readonly ownerEffects?: NonNullable<SlateControllerPorts<SlateSource, ResidentSlateProcess>['ownerEffects']>;
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
  /** How many times each slate's sharing changed: a launch started under an older count starts again. */
  private readonly shareGenerations = new Map<string, number>();

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
      ended: (held) => {
        for (const [invocationId, issued] of this.invocations) {
          if (issued.held === held) this.invocations.delete(invocationId);
        }
      },
      call: (request) => this.call(request),
      catalog: () => deps.catalog(),
      shareUrl: (handle) => deps.shareUrl(handle),
      shareEntry: (share) => deps.shareEntry(share),
      ...(kv !== undefined && { admitted: async (key: string, perMinute: number) => ingressAdmitted(kv, 'slate-share', key, perMinute) }),
      ...(deps.budget !== undefined && { budget: deps.budget.bind(deps) }),
      ...(deps.ownerUserId !== undefined && { ownerUserId: deps.ownerUserId.bind(deps) }),
      ...(deps.forgetPicture !== undefined && { forgetPicture: deps.forgetPicture.bind(deps) }),
      ...(deps.sharesChanged !== undefined && { sharesChanged: deps.sharesChanged.bind(deps) }),
      ...(deps.ownerEffects !== undefined && { ownerEffects: deps.ownerEffects }),
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
  }): Promise<ViewerAdmitted | Response> {
    const admission = await this.controller.viewers.admit(input);
    const headers = { 'cache-control': 'no-store' };

    switch (admission.kind) {
      case 'missing': return new Response('Not found', { status: 404, headers });
      case 'sign-in': return new Response(null, { status: 303, headers: { location: admission.entry, ...headers } });
      case 'too-many': return new Response('Too many requests', { status: 429, headers });
      case 'consent': return await this.consentPage(admission.share, admission.namespaces);
      case 'admitted': {
        const { caller, share, viewer } = admission;
        const invocation = crypto.randomUUID();

        this.invocations.set(invocation, { id: share.slate, chain: [], viewer });

        return { caller, invocation, share, viewer, settle: (outcome) => { this.controller.live.settleRequest(viewer.request, outcome); } };
      }
    }
  }

  /** What the grant reaches of the owner's, disclosed before anything of theirs runs. */
  private async consentPage(share: LiveShareRecord, namespaces: readonly string[]): Promise<Response> {
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
<a class="btn solid" href="${VIEWER_EXCHANGE_PATH}?consent=1">Continue</a>
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
    const admission = await this.admitViewerRequest({ handle, claim, pathname });

    if (admission instanceof Response) return admission;

    try {
      // A share's viewers use the slate itself: its durable app and its storage are the state everyone shares. What its
      // calls may reach is the shares' to say (`sharedAuthority`), for every caller alike.
      const process = await this.ensure(ROOT_SLATE_CALLER, admission.share.slate);
      const headers = new Headers(request.headers);
      headers.set('x-slate-call', admission.invocation);
      const target = new URL(request.url);
      target.pathname = pathname;
      const forwarded = reoriginateRequest(request, target.toString(), { headers, redirect: request.redirect });
      const response = headers.get('upgrade')?.toLowerCase() === 'websocket' ? await process.connect(forwarded) : await process.request(forwarded);

      if (response.status === 101) {
        this.invocations.set(admission.invocation, {
          id: admission.share.slate, chain: [], viewer: admission.viewer,
          held: heldSlateKey(ROOT_SLATE_CALLER, admission.share.slate),
        });
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

  /**
   * A named root invocation for a request this host did not originate; unnamed, a slate could replay a preview's calls
   * from inside a hop. A socket's invocation is released by its close listener via `__host`.
   */
  slateInvocation(port: number, socket: boolean): { readonly value: string; release: () => void } | null {
    const running = this.controller.processes.onPort(port);

    if (running === null) return null;
    const value = crypto.randomUUID();
    this.invocations.set(value, socket ? { id: running.id, chain: [], held: running.held } : { id: running.id, chain: [] });

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

  /** Every call a slate makes, routed and held to its caller's reach as of now: a held stub proves its slate, nothing more. */
  async surfaceCall(caller: SlateCaller, id: string, name: string, request: JsonValue): Promise<SlateSurfaceResult> {
    try {
      const parsed = v.safeParse(SlateCallRequestSchema, request);

      if (!parsed.success) throw new KinuError('bad_input', 'A slate call is { path: string[], args: JSON[], invocation: string | null }', { cause: new v.ValiError(parsed.issues) });

      if (name === SLATE_HOST_BINDING) return this.releaseInvocation(caller, id, parsed.output);

      // Answered here, not dispatched: it carries no actor capability.
      if (name === SLATE_STORAGE_BINDING) return slateStorageCall(this.controller.state, caller, id, { member: parsed.output.path.join('.'), args: parsed.output.args });
      const issued = issuedSlateInvocation({ invocations: this.invocations, id, invocation: parsed.output.invocation });
      const chain = issued?.chain ?? [];
      const ownServer = caller.path.length === 0 && caller.share === undefined;

      // Shared, its server acts as its shares allow now, whoever called it, the owner too.
      const shared = ownServer ? this.sharedAuthority(id) : ({ kind: 'owner' } satisfies ServerAuthority);

      // A shared slate's server acts only under a record this host issued: a viewer's request, or the owner's own (their
      // preview, their agent's call). A call naming none is no one's, and is refused, never taken for the owner's.
      if (ownServer && issued === null && shared.kind !== 'owner') {
        return await settle(slateAnswer(`slate ${id} ${name}`, Effect.fail(new KinuError('denied', `Slate ${id} is shared, and called out under no request of this host's`))));
      }

      const viewer = ownServer ? issued?.viewer : undefined;

      // A viewer's request is held to its own share as it stands now, whatever the slate's other shares say: revoked,
      // it is refused there, never taken for the owner's own.
      if (viewer !== undefined) {
        if (shared.kind === 'none') return await settle(slateAnswer(`slate ${id} ${name}`, Effect.fail(await this.ownAccessRefusal(id))));

        return await this.controller.viewers.call({
          share: viewer.share, id, request: parsed.output, chain, issued,
          bound: (address) => this.boundedBy(this.sharedAuthority(id), id, address),
          run: (route, nested) => this.run(shareCaller(viewer.share), route, {
            // What it reaches inside itself meets every share's bound as it stands then, as well as its own share's grant.
            nested: (namespace, member) => { this.nestedBound(id, { namespace, member }); nested(namespace, member); },
            ...(parsed.output.authorize && { authorizeOnly: true }),
          }, viewer),
        });
      }

      if (shared.kind === 'none') return await settle(slateAnswer(`slate ${id} ${name}`, Effect.fail(await this.ownAccessRefusal(id))));

      const beyond = this.boundedBy(shared, id, routeSlateCall({ id, request: parsed.output, chain, hosted: false }).address);

      if (beyond !== null) return await settle(slateAnswer(`slate ${id} ${name}`, Effect.fail(beyond)));

      // The share row is re-read now, so a revoked share refuses mid-flight.
      if (caller.share !== undefined) {
        return await this.controller.viewers.call({
          share: caller.share, id, request: parsed.output, chain, issued,
          run: (route, nested) => this.run(caller, route, { nested, ...(parsed.output.authorize && { authorizeOnly: true }) }, issued?.viewer),
        });
      }

      const source = await this.slateSources.resolve(caller.cred, id);

      if (source.kind === 'message' && !source.bound) {
        throw new KinuError('denied', `Slate ${id} is a hired agent's page, drawn with no authority lent to it: its calls would not run where that agent's stores are`);
      }

      // An answer's page calls as its author as of now, in the mode the author's next turn runs in.
      const callsAs = source.kind === 'message' ? source.author : caller;
      // Only the owner's own slate, calling as the owner, hires or messages helpers; a hosted actor's slate never does.
      const call = routeSlateCall({ id, request: parsed.output, chain, hosted: callsAs.path.length > 0 });

      // An answer's page is never shared or published, so what it calls is no slate's graph.
      const record = (namespace: string, member: string) => { if (source.kind !== 'message') this.controller.usage.record(id, { namespace, member }); };

      record(call.address.namespace, call.address.member);

      return await this.run(callsAs, call.route, { nested: record, ...(parsed.output.authorize && { authorizeOnly: true }) });
    } catch (cause) {
      return { ok: false, ...refusalOf(toKinuError({ doing: `slate ${id} ${name}`, cause, otherwise: 'io' })) };
    }
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
      case 'app': return this.call({ caller, id: route.id, method: route.method, args: [...route.args], chain: route.chain, viewer });
    }
  }

  /** One Cap'n Web HTTP-batch RPC; the invocation id lives exactly as long as the call. */
  async call(request: SlateAppCall): Promise<SlateCallResult> {
    const { caller, id, method, args, chain = [], viewer } = request;
    const invocation = crypto.randomUUID();
    this.invocations.set(invocation, viewer === undefined ? { id, chain } : { id, chain, viewer });

    try {
      requireWorkModePermission(caller.workMode, false, 'Calling authored slate code');

      if (!isSlateMethodName(method)) throw new KinuError('bad_input', `"${method}" is not an app method name`);
      const parsed = v.safeParse(v.array(JsonValueSchema), args);

      if (!parsed.success) throw new KinuError('bad_input', 'Slate arguments must be JSON values', { cause: new v.ValiError(parsed.issues) });
      const process = await this.ensure(caller, id);

      if (!process.methods.includes(method)) {
        throw new KinuError('bad_input', `Slate ${id} has no method ${method}; its class exports ${process.methods.join(', ')}`);
      }

      const stub = slateBatchStub<Record<string, (...args: JsonValue[]) => Promise<JsonValue>>>(process, invocation);

      try {
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

  /** Why `address` is beyond what the slate's server may reach under `shared` now; null when it is within. */
  private boundedBy(shared: ServerAuthority, id: string, address: { readonly namespace: string; readonly member: string }): KinuError | null {
    if (shared.kind !== 'grant' || grantAdmits(shared.grant, id, address.namespace, address.member) !== null) return null;

    return new KinuError('denied', `Slate ${id} is shared with the owner's access, which does not reach ${address.namespace}.${address.member}`);
  }

  /** What a viewer's call reaches inside itself, held to every share's bound as it stands now: it throws to refuse. */
  private nestedBound(id: string, address: { readonly namespace: string; readonly member: string }): void {
    const now = this.sharedAuthority(id);

    if (now.kind === 'none') admitNestedViewerCall({ slates: [], members: [] }, id, address);

    if (now.kind === 'grant') admitNestedViewerCall(now.grant, id, address);
  }

  /** What the slate's server acts with now (`serverAuthority`): its live shares, at its current revision. */
  private sharedAuthority(id: string): ServerAuthority {
    return serverAuthority(this.liveAuthorities(id), slateRevision(this.controller.builds, id) ?? '');
  }

  /** The slate's live shares as its server's authority reads them: each one's mode, grant and approved revision. */
  private liveAuthorities(id: string): LiveShareAuthority[] {
    return this.controller.live.authoritiesOf(id);
  }

  /** Why a call of a slate shared for each person's own access is refused, and what its owner can do about it. */
  private async ownAccessRefusal(id: string): Promise<KinuError> {
    const owner = (await this.deps.ownerTitle?.()) ?? 'Its owner';

    return new KinuError('denied', `Slate ${id} is shared for each person's own access, so its server uses no one's connections. `
      + `${owner} can turn on My access in its share sheet; each person's own data shows in their own parts.`);
  }

  /**
   * A share of `id` started, stopped or changed mode: its durable app ends, and boots again on its next call with the
   * network its shares now allow.
   */
  async shareChanged(id: string): Promise<void> {
    this.shareGenerations.set(id, (this.shareGenerations.get(id) ?? 0) + 1);
    await this.controller.processes.stopWhere((running) => running.id === id && running.caller.share === undefined && running.caller.path.length === 0);
  }

  /**
   * An editor's change to one of this workspace's slates (docs/SLATE-SHARING-NIMBUS.md §2): refused unless a live share
   * adds `editor` to edit it now. Its files are written, every `owner` share of it suspended until its owner approves
   * the reach again, and it is built from its own tree; a change that does not build is taken back whole, the shares'
   * approvals with it, and says why.
   */
  editAs(id: string, editor: { readonly userId: string; readonly email: string }, files: SlateFileChange): Promise<SlateCallResult> {
    return settle(slateAnswer(`${editor.email}'s edit of slate ${id}`, Effect.gen({ self: this }, function* () {
      if (!this.controller.live.editsSlate(id, editor.userId)) return yield* new KinuError('denied', `Slate ${id} is not shared with ${editor.email} to edit`);
      const written = yield* Effect.promise(async () => this.controller.writeShared(id, files));

      if (!written.ok) return yield* new KinuError(written.reason, written.error);
      const suspended = this.controller.suspendForEdit(id, editor.email);

      const built = yield* Effect.result(Effect.flatMap(
        attempt({ doing: `building slate ${id}`, otherwise: 'io' }, async () => this.controller.processes.booted(ROOT_SLATE_CALLER, id)),
        (running) => (running.broken === null ? Effect.void : Effect.fail(new KinuError('bad_input', running.broken))),
      ));

      if (built._tag === 'Failure') {
        const undone = yield* Effect.promise(async () => this.controller.writeShared(id, written.value.before));

        if (!undone.ok) return yield* new KinuError(undone.reason, `${built.failure.message}; taking the change back failed too: ${undone.error}`);
        this.controller.restoreAuthorities(suspended, editor.email);

        return yield* Effect.fail(built.failure);
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
      : Effect.fail(new KinuError('bad_input', `Slate ${id} is shared, so it runs only as its own files build; they do not build alone yet`)))));
  }

  async ensure(caller: SlateCaller, id: string): Promise<ResidentSlateProcess> {
    return (await this.controller.processes.booted(caller, id)).process;
  }

  /** A process for `launch`: the slate's bindings as its caller, and its outbound mediated as that caller's eval is. */
  private async launch(launch: SlateLaunch<SlateSource>): Promise<ResidentSlateProcess> {
    const { id, caller, source, image, app } = launch;

    await this.servable(id, source.kind === 'message' || image.scope === 'tree');

    // Shared, the slate's server drives no browser of the owner's: only one its own call opened (Kitesurf).
    const unshared = caller.share === undefined && this.sharedAuthority(id).kind === 'owner';
    // What the slate's sharing was when this launch chose its network: changed before it is running, it starts again.
    const generation = this.shareGenerations.get(id) ?? 0;
    const actor = unshared ? await this.deps.browserActor(caller) : null;
    // Shared, it reaches the network as no one: its own preview hosts too.
    const globalOutbound = caller.workMode === 'plan' ? null : codemodeEgress({ workspace: this.deps.workspace, actor, asOwner: unshared });

    if (caller.workMode === 'build' && globalOutbound === null) {
      throw new KinuError('unsupported', 'Resident slate egress requires the shared outbound policy binding');
    }

    const bindings: Record<string, Fetcher<SlateBinding>> = {};

    for (const name of [SLATE_SURFACE, SLATE_STORAGE_BINDING, SLATE_HOST_BINDING]) {
      const props: SlateBindingProps = { workspace: this.deps.workspace, id, name, caller };
      bindings[name] = exports.SlateBinding({ props });
    }

    const started = await this.resident.launch({ owner: id, root: source.root, bindings, globalOutbound, app: app === null ? null : { port: app.port } }, image);

    // Shared or unshared while it started: its network was chosen for what no longer holds, so it never runs as it is.
    if ((this.shareGenerations.get(id) ?? 0) !== generation) {
      await started.stop();

      return await this.launch(launch);
    }

    return started;
  }
}
