import { markStoreChanged } from '@kinu.run/core';
import { exports } from 'cloudflare:workers';
import { WorkspaceId } from '@agent-core/core';
import { SlateId, SlateVersionId } from '@agent-core/core/slates';
import * as v from 'valibot';
import { CRED_KERNEL, CRED_SESSION_USER, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { ROOT_SLATE_CALLER, slateCallerKey, type SlateCaller } from '@kinu.run/core/slates';
import {
  forgetSlateFiles, SlateFiles, SlateShareStore, WorkspaceSlateContentStore, SqliteSlateStateStore, SqliteSlateStore, WorkspaceBlueprints, WorkspaceSlates, slateDirectory,
  type BlueprintReading, type DurableAppIdentity, type DurableApps, type ShareUser,
} from '@kinu.run/core/slates';
import { SlateLiveShareStore, initSlateLiveShareTables, shareLiveSlate } from '@kinu.run/core/slates';
import { EphemeralSlates, initEphemeralSlateTable, SlateUsageStore, initSlateUsageTable, SlateBuilds, SlateProcesses, SlateShareViewers, heldSlateKey, slateStorageCall, type FailingSlateBuild, type RunningSlate, type SlateLaunch } from '@kinu.run/core/slates';
import {
  ingressAdmitted,
  parseSlateProject, slateIdFor, slateTitle, SLATE_STORAGE_BINDING, SLATE_HOST_BINDING,
  SlateCallRequestSchema, SlateOperationSchema, requireSlateWorkMode, requireWorkModePermission, routeSlateCall, issuedSlateInvocation,
  isJsonAnswer, JsonValueSchema, projectJsonValue, isSlateMethodName, answeredRefusal, reoriginateRequest,
  escapeHtml, publicPage, VIEWER_EXCHANGE_PATH,
  type BlueprintBundle, type BlueprintFork, type JsonValue, type SlateAnswer, type SlateProject, type SlateShareRecord,
  type SlateRoute, type SlateCallRequest, type SlateCallResult, type SlateSurfaceResult, type SlateSurfaceValue, type SlateInvocation, type SlateOperation, type SlateSummary, type SlateProblem, type WorkspacePreviewUrl,
  type SlateSurfaceCatalog, type LiveShareRecord, type SlateViewer, type ShareViewerClaim,
  type MissionGovernor, type WorkspaceOverviewShare, slateCapabilityGraph, type SlateCapabilityGraph,
  ephemeralSlateAddress, type EphemeralSlateAddress,
} from '@kinu.run/core';
import { SLATES_ROOT, slateAuthority } from '@kinu.run/core';
import type { KvStore } from '@kinu.run/agent-utils';
import { ERROR_CODES, KinuError, classifyErrorCode, refusalOf, settle, toKinuError, type Refusal } from '@kinu.run/core/obs';
import { Effect } from 'effect';
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

type SharingOp = 'inspect' | 'publish' | 'unshare' | 'shares' | 'share' | 'liveShares' | 'viewerRequests';

interface SlateApps extends DurableApps {
  url(port: number, capability: string): Promise<WorkspacePreviewUrl>;
  /** Each held port's owner, the slate whose application serves on it. */
  owners(): Promise<ReadonlyMap<number, string>>;
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

  return reason?.success === true && match !== null ? { reason: reason.output, error: match[2] } : null;
}

export interface SlateAppCall {
  readonly caller: SlateCaller;
  readonly id: string;
  readonly method: string;
  readonly args: JsonValue[];
  readonly chain?: readonly string[];
  readonly viewer?: SlateViewer;
}

/**
 * One process per authored tree per caller, and one durable application per slate. The application's port and capability
 * persist in this object's storage, run as the workspace root and keep one facet SQLite until `remove`; other callers' processes are private and portless.
 */
export class SlateHost {
  private content: WorkspaceSlateContentStore | undefined;
  private readonly resident: ResidentSlateProcesses;
  private readonly store: SqliteSlateStore;
  private readonly state: SqliteSlateStateStore;
  private readonly sourceRuntimes = new Map<string, WorkspaceSlates>();
  private readonly processes: SlateProcesses<SlateSource, ResidentSlateProcess>;
  private readonly live: SlateLiveShareStore;
  private readonly pages: EphemeralSlates;
  private readonly slateSources: SlateSources;
  /** A published blueprint never changes. */
  private readonly blueprintHeadings = new Map<string, { title: string; description: string }>();
  private readonly usage: SlateUsageStore;
  private readonly builds: SlateBuilds;
  private readonly viewers: SlateShareViewers;

  constructor(private readonly deps: SlateHostDeps) {
    this.resident = new ResidentSlateProcesses({
      session: deps.session, facetManager: deps.facetManager, bundler: deps.bundler, retained: () => this.builds.retained(),
    });
    this.store = new SqliteSlateStore(deps.ctx.storage.sql, (body) => deps.ctx.storage.transactionSync(body));
    this.state = new SqliteSlateStateStore(deps.ctx.storage.sql);
    initSlateLiveShareTables((ddl) => { deps.ctx.storage.sql.exec(ddl); });
    this.live = new SlateLiveShareStore(deps.ctx.storage.sql);
    initEphemeralSlateTable((ddl) => { deps.ctx.storage.sql.exec(ddl); });
    this.pages = new EphemeralSlates(deps.ctx.storage.sql);
    initSlateUsageTable((ddl) => { deps.ctx.storage.sql.exec(ddl); });
    this.usage = new SlateUsageStore(deps.ctx.storage.sql);
    this.builds = new SlateBuilds(deps.ctx.storage.sql);
    this.slateSources = new SlateSources({
      project: (cred, id) => this.project(cred, id), trees: (cred) => this.sources(cred), host: deps,
    });
    const kv = deps.kv;

    this.viewers = new SlateShareViewers({
      live: this.live, shareEntry: (share) => deps.shareEntry(share),
      ...(deps.budget !== undefined && { budget: deps.budget.bind(deps) }),
      ...(deps.ownerUserId !== undefined && { ownerUserId: deps.ownerUserId.bind(deps) }),
      ...(kv !== undefined && { admitted: async (key, perMinute) => ingressAdmitted(kv, 'slate-share', key, perMinute) }),
    });
    this.processes = new SlateProcesses({
      workspace: deps.workspace, builds: this.builds, pages: this.pages, apps: deps.apps,
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
    });
  }

  private async project(cred: VfsCred, id: string): Promise<SlateProject> {
    const session = await this.deps.session();
    const path = `${slateDirectory(new SlateId(id))}/package.json`;

    return parseSlateProject(JSON.parse(session.vfs.as(cred).readFileString(path)));
  }

  /** As the owner's root: publishing reads committed versions, never the caller's live tree. */
  private async blueprints(): Promise<WorkspaceBlueprints> {
    const slates = await this.sources(CRED_SESSION_USER);

    if (this.content === undefined) throw new KinuError('io', 'Slate content was not initialized');

    return new WorkspaceBlueprints({ slates, content: this.content,
      shares: new SlateShareStore(this.deps.ctx.storage.sql),
      usage: (slate) => this.usage.list(slate),
    });
  }

  private async blueprintAnswer<Value>(doing: string, body: (blueprints: WorkspaceBlueprints) => Promise<Value> | Value): Promise<SlateAnswer<Value>> {
    try {
      await this.deps.session();

      return { ok: true, value: await body(await this.blueprints()) };
    } catch (cause) {
      return { ok: false, ...refusalOf(toKinuError({ doing, cause, otherwise: 'io' })) };
    }
  }

  private async graph(slate: string): Promise<SlateCapabilityGraph> {
    return slateCapabilityGraph({ slate, workspace: this.deps.workspace, catalog: await this.deps.catalog(), usage: (id) => this.usage.list(id) });
  }

  /** Uses `get`, not `live`: a revoked row still reads; refusing it is the caller's job. */
  async readLiveShare(share: string): Promise<{ share: LiveShareRecord; title: string; description: string } | null> {
    const record = this.live.get(share);

    if (record === undefined) return null;
    let project: SlateProject | undefined;

    try {
      project = await this.project(CRED_SESSION_USER, record.slate);
    } catch (cause) {
      if (cause instanceof KinuError && cause.code === 'denied') throw cause;
      project = undefined;
    }

    return {
      share: record,
      title: project === undefined ? record.slate : slateTitle(project, record.slate),
      description: '',
    };
  }

  /** `readLiveShare` through the S6 gate: missing is 'missing', revoked is 'denied'. */
  async readLiveShareRecord(share: string): Promise<SlateAnswer<{ record: LiveShareRecord; title: string; description: string }>> {
    try {
      const record = this.live.live(share);
      const read = await this.readLiveShare(share);

      return {
        ok: true,
        value: { record, title: read?.title ?? record.slate, description: read?.description ?? '' },
      };
    } catch (cause) {
      return { ok: false, ...refusalOf(toKinuError({ doing: `read live share ${share}`, cause, otherwise: 'io' })) };
    }
  }

  /** The core's admission, answered over HTTP: refusals as their statuses, the consent page, or the viewer let in. */
  async admitViewerRequest(input: {
    readonly handle: string;
    readonly claim: ShareViewerClaim;
    readonly pathname: string;
  }): Promise<ViewerAdmitted | Response> {
    const admission = await this.viewers.admit(input);
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

        return { caller, invocation, share, viewer, settle: (outcome) => { this.live.settleRequest(viewer.request, outcome); } };
      }
    }
  }

  /** What the grant reaches of the owner's, disclosed before anything of theirs runs. */
  private async consentPage(share: LiveShareRecord, namespaces: readonly string[]): Promise<Response> {
    const project = await this.project(CRED_SESSION_USER, share.slate);
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

  /** Unparseable slates are omitted; they surface as `problem` rows on the graph. */
  async projects(caller: SlateCaller): Promise<Record<string, SlateProject>> {
    const session = await this.deps.session();
    const vfs = session.vfs.as(caller.cred);
    const projects: Record<string, SlateProject> = {};

    if (!vfs.exists(SLATES_ROOT)) return projects;

    for (const entry of vfs.readdir(SLATES_ROOT)) {
      if (entry.type !== 'directory') continue;

      try {
        projects[entry.name] = await this.project(caller.cred, entry.name);
      } catch (cause) {
        if (classifyErrorCode({ cause }) !== 'bad_input') throw cause;
      }
    }

    return projects;
  }

  /** Re-reads the row now; refused when revoked. */
  readBlueprint(share: string): Promise<SlateAnswer<BlueprintReading>> {
    return this.blueprintAnswer('reading blueprint ' + share, (blueprints) => blueprints.read(share));
  }

  blueprintBundle(share: string): Promise<SlateAnswer<BlueprintBundle>> {
    return this.blueprintAnswer('exporting blueprint ' + share, (blueprints) => blueprints.bundle(share));
  }

  /** The projection each user reads is written by the caller. */
  async shareBlueprintWith(share: string, users: readonly ShareUser[]): Promise<SlateAnswer<SlateShareRecord>> {
    return this.changedShares(await this.blueprintAnswer('sharing blueprint ' + share, (blueprints) => blueprints.shareWith(share, users)));
  }

  /** Never starts its process. */
  admitBlueprint(bundle: BlueprintBundle): Promise<SlateAnswer<BlueprintFork>> {
    return this.blueprintAnswer('admitting a blueprint', (blueprints) => blueprints.admit(this.deps.workspace, bundle));
  }

  async shareLiveWith(share: string, users: readonly ShareUser[]): Promise<SlateAnswer<LiveShareRecord>> {
    return this.changedShares(await this.blueprintAnswer('sharing slate ' + share, () => this.live.addUsers(share, users)));
  }

  private async changedShares<Answer extends { readonly ok: boolean }>(answer: Answer): Promise<Answer> {
    return answer.ok && await this.deps.sharesChanged?.() === 'pending' ? { ...answer, listing: 'pending' } : answer;
  }

  /** A live share goes by its slate's title. */
  async shareCards(titles: ReadonlyMap<string, string>): Promise<WorkspaceOverviewShare[]> {
    const blueprints = await this.blueprints();
    const cards: WorkspaceOverviewShare[] = [];

    for (const record of blueprints.list()) {
      if (record.revokedAt !== null) continue;
      const heading = this.blueprintHeadings.get(record.id) ?? blueprints.heading(record.id);
      this.blueprintHeadings.set(record.id, heading);
      cards.push({ kind: 'blueprint', share: record.id, slate: record.slate, ...heading, createdAt: record.createdAt, users: [...record.users] });
    }

    for (const record of this.live.list()) {
      if (record.revokedAt !== null) continue;

      cards.push({
        kind: 'live', share: record.id, slate: record.slate, title: titles.get(record.slate) ?? record.slate, description: '',
        createdAt: record.createdAt, users: [...record.users],
        visibility: record.visibility, fork: record.grant.fork !== false,
      });
    }

    return cards;
  }

  liveShareAdmitsUser(share: string, userId: string): boolean {
    return this.viewers.admits(share, userId);
  }

  /** Admission is checked only by the caller. */
  liveShareBundle(record: LiveShareRecord): Promise<SlateAnswer<BlueprintBundle>> {
    return this.blueprintAnswer(`exporting live share ${record.id}`, (blueprints) => blueprints.liveBundle(record.slate));
  }

  shareLive(share: string): Promise<SlateAnswer<{ share: LiveShareRecord; url: string | null }>> {
    return this.blueprintAnswer('opening share ' + share, async () => {
      const record = this.live.get(share);

      if (record === undefined) throw new KinuError('missing', 'No such share');

      return { share: record, url: await this.deps.shareUrl(record.handle) };
    });
  }

  private async sources(cred: VfsCred): Promise<WorkspaceSlates> {
    const session = await this.deps.session();
    this.content ??= session.vfs.withTransaction(() => new WorkspaceSlateContentStore(session.vfs.as(CRED_KERNEL)));
    const key = slateAuthority(cred);
    let runtime = this.sourceRuntimes.get(key);

    if (runtime === undefined) {
      runtime = new WorkspaceSlates({
        workspaceId: new WorkspaceId(this.deps.workspace), store: this.store,
        files: new SlateFiles(session.vfs.as(cred), this.content, this.deps.ctx.storage.sql, (body) => session.vfs.withTransaction(body)),
        mutations: { mutate: async (request, mutation) => {
          if (request.workspaceId.value !== this.deps.workspace) throw new KinuError('denied', 'Slate mutation belongs to another workspace');

          return session.vfs.withTransaction(mutation);
        } },
      });
      this.sourceRuntimes.set(key, runtime);
    }

    return runtime;
  }

  private async unshare(share: string, blueprints: WorkspaceBlueprints): Promise<SlateCallResult> {
    if (this.live.get(share) === undefined) {
      return { ok: true, value: projectJsonValue({ value: blueprints.unshare(share) }) };
    }

    const revoked = this.live.revoke(share);

    // Invocations outlive the revoke so an in-flight viewer call is refused as 'no longer shared'.
    await this.processes.stopWhere((running) => running.caller.share === revoked.id);

    return { ok: true, value: projectJsonValue({ value: revoked }) };
  }

  async operation(caller: SlateCaller, input: SlateOperation): Promise<SlateCallResult> {
    try {
      const parsed = v.safeParse(SlateOperationSchema, input);

      if (!parsed.success) throw new KinuError('bad_input', 'Slate operation does not match its declared fields', { cause: new v.ValiError(parsed.issues) });
      const operation = parsed.output;
      requireSlateWorkMode(operation, caller.workMode);

      switch (operation.op) {
        case 'list': {
          const listing = await this.list(caller);

          return { ok: true, value: { slates: listing.slates.map((slate) => ({ ...slate })), problems: listing.problems.map((problem) => ({ ...problem })) } };
        }

        case 'preview': return await this.preview(caller, operation.id);
        case 'methods': return { ok: true, value: [...(await this.ensure(caller, operation.id)).methods] };
        case 'call': return await this.call({ caller, id: operation.id, method: operation.method, args: operation.args ?? [] });
        case 'remove': return await this.remove(caller, operation.id);
        case 'history': {
          await this.deps.session();
          const id = new SlateId(operation.id);
          const slate = this.store.getSlate(id);

          if (slate === undefined) throw new KinuError('missing', 'No durable slate record; commit source or open a preview first');

          if (slate.workspaceId.value !== this.deps.workspace) throw new KinuError('denied', 'Slate belongs to another workspace');

          const page = this.store.versionPage(id, operation.after);

          return { ok: true, value: projectJsonValue({ value: { slate: slate.toData(), versions: page.versions.map((version) => version.toData()), next: page.next } }) };
        }

        case 'commit': return { ok: true, value: projectJsonValue({ value: (await (await this.sources(caller.cred)).commit(new SlateId(operation.id))).toData() }) };
        case 'fork': return { ok: true, value: projectJsonValue({ value: (await (await this.sources(caller.cred)).fork(new SlateVersionId(operation.version))).toData() }) };
        case 'restore': return { ok: true, value: projectJsonValue({ value: (await (await this.sources(caller.cred)).restore(new SlateId(operation.id), new SlateVersionId(operation.version))).toData() }) };
        case 'inspect':
        case 'publish':
        case 'unshare':
        case 'shares':
        case 'share':
        case 'liveShares':
        case 'viewerRequests': return await this.sharing(caller, operation);

        case 'graph': return { ok: true, value: projectJsonValue({ value: await this.graph(operation.id) }) };
        case 'save': return await this.savePage(caller, operation.page);
      }
    } catch (cause) {
      return { ok: false, ...refusalOf(toKinuError({ doing: 'slate operation', cause, otherwise: 'io' })) };
    }
  }

  /** Publishing and sharing are the owner's alone; a hosted actor never exports on the owner's behalf. */
  private async sharing(caller: SlateCaller, operation: Extract<SlateOperation, { op: SharingOp }>): Promise<SlateCallResult> {
    if (caller.path.length > 0) throw new KinuError('denied', 'Only the workspace root publishes, shares or revokes slates');
    const blueprints = await this.blueprints();

    switch (operation.op) {
      case 'inspect': return { ok: true, value: projectJsonValue({ value: blueprints.inspect(operation.id, operation.version, operation.include) }) };
      case 'publish': return await this.changedShares({ ok: true, value: projectJsonValue({ value: await blueprints.publish(operation.id, operation.version, operation.include) }) });
      case 'unshare': return await this.changedShares(await this.unshare(operation.share, blueprints));

      case 'shares': return { ok: true, value: projectJsonValue({ value: blueprints.list() }) };
      case 'share': {
        const created = await shareLiveSlate({
          shares: this.live, graph: await this.graph(operation.id), visibility: operation.visibility, approved: operation.approved,
          fork: operation.fork, url: (handle) => this.deps.shareUrl(handle),
        });

        return await this.changedShares({ ok: true, value: projectJsonValue({ value: created }) });
      }

      case 'liveShares': return { ok: true, value: projectJsonValue({ value: this.live.list().map((row) => ({ ...row, paused: this.viewers.paused(row) })) }) };
      case 'viewerRequests': return { ok: true, value: projectJsonValue({ value: this.live.requests(operation.share) }) };
    }
  }

  async list(caller: SlateCaller): Promise<{ slates: SlateSummary[]; problems: SlateProblem[] }> {
    const session = await this.deps.session();
    const vfs = session.vfs.as(caller.cred);
    const slates: SlateSummary[] = [];
    const problems: SlateProblem[] = [];

    if (!vfs.exists(SLATES_ROOT)) return { slates, problems };
    // The application's own reservation, held across evictions and activations, not this activation's memory of it.
    const held = new Map([...await this.deps.apps.owners()].map(([port, owner]) => [owner, port]));

    for (const entry of vfs.readdir(SLATES_ROOT)) {
      if (entry.type !== 'directory') continue;

      try {
        const project = await this.project(caller.cred, entry.name);
        const port = held.get(entry.name);
        const summary: SlateSummary = { id: entry.name, title: slateTitle(project, entry.name), ...(port !== undefined && { port }) };

        slates.push(summary);
      } catch (cause) {
        problems.push({ id: entry.name, ...refusalOf(toKinuError({ doing: 'slate ' + entry.name, cause, otherwise: 'io' })) });
      }
    }

    return { slates, problems };
  }

  /** An answer's page kept as a slate of the workspace's own: its HTML as the slate's page, under the page's title. */
  savePage(caller: SlateCaller, page: string): Promise<SlateCallResult> {
    return settle(Effect.gen({ self: this }, function* () {
      // The owner's choice to keep it, as publishing is; an agent writes a slate's files itself.
      if (caller.path.length > 0) return yield* new KinuError('denied', 'Only the workspace root keeps an answer\'s page as a slate');

      if (ephemeralSlateAddress(page) === null) return yield* new KinuError('bad_input', `${page} names no answer's page`);
      const source = yield* Effect.promise(async () => this.slateSources.resolve(caller.cred, page));

      if (source.kind !== 'message') return yield* new KinuError('bad_input', `${page} names no answer's page`);
      const files = (yield* Effect.promise(async () => this.deps.session())).vfs.as(caller.cred);
      const title = slateTitle(source.project, page);
      const id = slateIdFor(title, (taken) => files.exists(`${SLATES_ROOT}/${taken}`));

      files.mkdir(`${SLATES_ROOT}/${id}`, { recursive: true });
      files.writeFile(`${SLATES_ROOT}/${id}/package.json`, `${JSON.stringify({ browser: 'index.html', slate: { title } }, null, 2)}\n`);
      files.writeFile(`${SLATES_ROOT}/${id}/index.html`, source.html);

      return { ok: true as const, value: { id, title } };
    }));
  }

  /** Each port a slate's application holds, called by the slate's title: a directory slate's, or its page's `<title>`. */
  portTitles(): Promise<ReadonlyMap<number, string>> {
    return settle(Effect.gen({ self: this }, function* () {
      const titles = new Map<number, string>();

      for (const [port, owner] of yield* Effect.promise(async () => this.deps.apps.owners())) {
        const source = yield* Effect.tryPromise({
          try: async () => this.slateSources.resolve(CRED_SESSION_USER, owner),
          catch: (cause) => toKinuError({ doing: `naming port ${String(port)}`, cause, otherwise: 'io' }),
        }).pipe(
          // A slate removed, or left unreadable, since its port was held keeps the port's own name.
          Effect.catchIf((error) => error.code === 'missing' || error.code === 'bad_input', () => Effect.succeed(null)),
        );

        if (source !== null) titles.set(port, slateTitle(source.project, owner));
      }

      return titles;
    }));
  }

  /**
   * Whether the slate builds, by the build its preview serves: nothing is shown, so the turn's answer still draws the
   * slate it changed. `{ broken }` is the compiler's words when its latest source does not build.
   */
  async build(caller: SlateCaller, id: string): Promise<SlateCallResult> {
    return await this.answerServed(caller, id, 'build', async ({ broken }): Promise<JsonValue> => (broken === null ? {} : { broken }));
  }

  /** The application is the root's, so the URL is the same whoever asks and across launches. */
  async preview(caller: SlateCaller, id: string): Promise<SlateCallResult> {
    return await this.answerServed(caller, id, 'preview', async ({ source, app, broken }) => {
      const preview = await this.deps.apps.url(app.port, app.capability);

      if (preview.url === undefined) throw new KinuError('unavailable', 'This deployment cannot mint a slate preview URL: ' + preview.unavailable);

      // An answer's own block is shown where the answer is, never again as a card of the turn's slates.
      if (source.kind === 'files') this.deps.previewed?.(id);
      // Every page the runner answers reports its height, its class's own `fetch` pages too.
      const shown = { url: preview.url, port: app.port, sized: true, title: slateTitle(source.project, id) };

      // Its latest source does not build: the last that did is what this URL serves, and the compiler's words say why.
      return broken === null ? shown : { ...shown, broken };
    });
  }

  /** The slate's served build, booted for `caller`, as `answer` reads it; a slate that cannot be served is refused. */
  private async answerServed(
    caller: SlateCaller, id: string, doing: 'build' | 'preview',
    answer: (served: RunningSlate<SlateSource, ResidentSlateProcess> & { readonly app: DurableAppIdentity }) => Promise<JsonValue>,
  ): Promise<SlateCallResult> {
    try {
      requireWorkModePermission(caller.workMode, false, 'Starting or exposing a slate preview');

      return { ok: true, value: await answer(await this.processes.served(ROOT_SLATE_CALLER, id)) };
    } catch (cause) {
      return { ok: false, ...refusalOf(toKinuError({ doing: 'slate ' + id + ' ' + doing, cause, otherwise: 'io' })) };
    }
  }

  /** Every slate whose latest source does not build for the workspace's own agent, in the compiler's words. */
  failingBuilds(): FailingSlateBuild[] {
    return this.builds.failing(ROOT_SLATE_CALLER.cred);
  }

  /** Answers the refusal instead of throwing, so the route can tell `missing` from `bad_input`. */
  async ensureDurable(owner: string): Promise<Refusal | null> {
    try {
      await this.serve(owner);

      return null;
    } catch (cause) {
      return refusalOf(toKinuError({ doing: 'slate ' + owner + ' durable app', cause, otherwise: 'io' }));
    }
  }

  private async serve(id: string): Promise<DurableAppIdentity> {
    return (await this.processes.served(ROOT_SLATE_CALLER, id)).app;
  }

  /** Ends processes, the durable application, the authored tree and its storage; committed versions stay. */
  async remove(caller: SlateCaller, id: string): Promise<SlateCallResult> {
    try {
      const session = await this.deps.session();
      const root = slateDirectory(new SlateId(id));

      await this.processes.stopWhere((running) => running.id === id);

      const removed = await this.deps.apps.remove(id);
      const vfs = session.vfs.as(caller.cred);

      session.vfs.withTransaction(() => {
        if (vfs.exists(root)) vfs.removeRecursive(root);
        forgetSlateFiles(this.deps.ctx.storage.sql, new SlateId(id));
        this.state.forget(id);
        this.usage.forget(id);
        this.builds.forget(id);
      });
      await this.deps.forgetPicture?.(id);

      return { ok: true, value: { id, removed: removed.removed, port: removed.port } };
    } catch (cause) {
      return { ok: false, ...refusalOf(toKinuError({ doing: 'slate ' + id + ' remove', cause, otherwise: 'io' })) };
    }
  }

  private readonly invocations = new Map<string, SlateInvocation & { readonly held?: string }>();

  /**
   * A named root invocation for a request this host did not originate; unnamed, a slate could replay a preview's calls
   * from inside a hop. A socket's invocation is released by its close listener via `__host`.
   */
  slateInvocation(port: number, socket: boolean): { readonly value: string; release: () => void } | null {
    const running = this.processes.onPort(port);

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

    if (issued.viewer !== undefined) this.live.settleRequest(issued.viewer.request, 'closed');

    return { ok: true, value: null };
  }

  /** Every call a slate makes, routed and held to its caller's reach as of now: a held stub proves its slate, nothing more. */
  async surfaceCall(caller: SlateCaller, id: string, name: string, request: JsonValue): Promise<SlateSurfaceResult> {
    try {
      const parsed = v.safeParse(SlateCallRequestSchema, request);

      if (!parsed.success) throw new KinuError('bad_input', 'A slate call is { path: string[], args: JSON[], invocation: string | null }', { cause: new v.ValiError(parsed.issues) });

      if (name === SLATE_HOST_BINDING) return this.releaseInvocation(caller, id, parsed.output);

      // Answered here, not dispatched: it carries no actor capability.
      if (name === SLATE_STORAGE_BINDING) return slateStorageCall(this.state, caller, id, { member: parsed.output.path.join('.'), args: parsed.output.args });
      const issued = issuedSlateInvocation({ invocations: this.invocations, id, invocation: parsed.output.invocation });
      const chain = issued?.chain ?? [];

      // The share row is re-read now, so a revoked share refuses mid-flight.
      if (caller.share !== undefined) {
        return await this.viewers.call({
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
      const record = (namespace: string, member: string) => { if (source.kind !== 'message') this.usage.record(id, { namespace, member }); };

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
    return (await this.processes.booted(caller, id)).process;
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
    const ids = this.processes.filesChanged(paths);

    if (ids.length > 0) markStoreChanged(this.deps.ctx.storage.sql);

    return ids;
  }
}
