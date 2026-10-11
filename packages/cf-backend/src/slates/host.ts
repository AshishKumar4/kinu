import { markStoreChanged } from '@kinu.run/core';
import { exports } from 'cloudflare:workers';
import * as v from 'valibot';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import {
  SlateController, heldSlateKey, initEphemeralSlateTable, initSlateLiveShareTables, initSlateUsageTable, slateCallerKey, slateStorageCall,
  type SlateAppCall, type SlateApps, type SlateCaller, type SlateLaunch,
} from '@kinu.run/core/slates';
import {
  ingressAdmitted, slateTitle, SLATE_STORAGE_BINDING, SLATE_HOST_BINDING,
  SlateCallRequestSchema, requireWorkModePermission, routeSlateCall, issuedSlateInvocation,
  isJsonAnswer, JsonValueSchema, isSlateMethodName, answeredRefusal, reoriginateRequest,
  escapeHtml, publicPage, VIEWER_EXCHANGE_PATH,
  type JsonValue, type SlateRoute, type SlateCallRequest, type SlateCallResult, type SlateSurfaceResult, type SlateSurfaceValue, type SlateInvocation,
  type SlateSurfaceCatalog, type LiveShareRecord, type SlateViewer, type ShareViewerClaim, type MissionGovernor, type EphemeralSlateAddress,
} from '@kinu.run/core';
import type { KvStore } from '@kinu.run/agent-utils';
import { ERROR_CODES, KinuError, refusalOf, toKinuError, type Refusal } from '@kinu.run/core/obs';
import { ResidentSlateProcesses, type ResidentSlateDeps, type ResidentSlateProcess } from './resident';
import { slateBatchStub } from './rpc-transport';
import { type SlateBinding, type SlateBindingProps } from './bindings';
import { codemodeEgress } from '../codemode-egress';
import { SlateSources, type MessageBlock, type SlateSource } from './sources';

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
  ownerUserId?(): string | null;
  forgetPicture?(slate: string): Promise<void>;
  sharesChanged?(): Promise<'current' | 'pending'>;
  previewed?(slate: string): void;
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

export type { SlateAppCall };

/**
 * One process per authored tree per caller, and one durable application per slate. The application's port and capability
 * persist in this object's storage, run as the workspace root and keep one facet SQLite until `remove`; other callers' processes are private and portless.
 */
export class SlateHost {
  readonly controller: SlateController<SlateSource, ResidentSlateProcess>;
  private readonly resident: ResidentSlateProcesses;
  private readonly slateSources: SlateSources;

  constructor(private readonly deps: SlateHostDeps) {
    const sql = deps.ctx.storage.sql;
    const kv = deps.kv;

    initSlateLiveShareTables((ddl) => { sql.exec(ddl); });
    initEphemeralSlateTable((ddl) => { sql.exec(ddl); });
    initSlateUsageTable((ddl) => { sql.exec(ddl); });
    this.controller = new SlateController({
      workspace: deps.workspace, sql, transaction: (body) => deps.ctx.storage.transactionSync(body),
      session: deps.session, apps: deps.apps,
      resolve: (cred, id) => this.slateSources.resolve(cred, id),
      digest: (cred, id, source) => this.slateSources.digest(cred, id, source),
      build: async (caller, id, source) => this.resident.build({
        owner: id, root: source.root, project: source.project, read: await this.slateSources.reader(caller.cred, source), cred: caller.cred,
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
      ...(deps.previewed !== undefined && { previewed: deps.previewed.bind(deps) }),
    });
    this.resident = new ResidentSlateProcesses({
      session: deps.session, facetManager: deps.facetManager, bundler: deps.bundler, retained: () => this.controller.builds.retained(),
    });
    this.slateSources = new SlateSources({
      project: (cred, id) => this.controller.project(cred, id), trees: (cred) => this.controller.slates(cred), host: deps,
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
      const process = await this.ensure(admission.caller, admission.share.slate);
      const headers = new Headers(request.headers);
      headers.set('x-slate-call', admission.invocation);
      // A share's process is private and portless, so the request goes to its handle.
      const target = new URL(request.url);
      target.pathname = pathname;
      const forwarded = reoriginateRequest(request, target.toString(), { headers, redirect: request.redirect });
      const response = headers.get('upgrade')?.toLowerCase() === 'websocket' ? await process.connect(forwarded) : await process.request(forwarded);

      if (response.status === 101) {
        this.invocations.set(admission.invocation, {
          id: admission.share.slate, chain: [], viewer: admission.viewer,
          held: `${slateCallerKey(admission.caller)}#${admission.share.slate}`,
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

  async ensure(caller: SlateCaller, id: string): Promise<ResidentSlateProcess> {
    return (await this.controller.processes.booted(caller, id)).process;
  }

  /** A process for `launch`: the slate's bindings as its caller, and its outbound mediated as that caller's eval is. */
  private async launch(launch: SlateLaunch<SlateSource>): Promise<ResidentSlateProcess> {
    const { key, id, caller, source, image, app } = launch;
    const globalOutbound = caller.workMode === 'plan' ? null : codemodeEgress({ workspace: this.deps.workspace, actor: await this.deps.browserActor(caller) });

    if (caller.workMode === 'build' && globalOutbound === null) {
      throw new KinuError('unsupported', 'Resident slate egress requires the shared outbound policy binding');
    }

    const bindings: Record<string, Fetcher<SlateBinding>> = {};

    for (const name of [SLATE_SURFACE, SLATE_STORAGE_BINDING, SLATE_HOST_BINDING]) {
      const props: SlateBindingProps = { workspace: this.deps.workspace, id, name, caller };
      bindings[name] = exports.SlateBinding({ props });
    }

    const read = await this.slateSources.reader(caller.cred, source);

    return await this.resident.launch({
      key, owner: id, root: source.root, project: source.project, read, cred: caller.cred, bindings, globalOutbound,
      app: app === null ? null : { port: app.port },
    }, image);
  }

  filesChanged(paths: readonly string[]): string[] {
    const ids = this.controller.filesChanged(paths);

    if (ids.length > 0) markStoreChanged(this.deps.ctx.storage.sql);

    return ids;
  }
}
