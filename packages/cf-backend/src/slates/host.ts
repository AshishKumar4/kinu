import { markStoreChanged } from '@kinu.run/core';
import { exports } from 'cloudflare:workers';
import { WorkspaceId } from '@agent-core/core';
import { SlateId, SlateVersionId } from '@agent-core/core/slates';
import * as v from 'valibot';
import { CRED_KERNEL, CRED_SESSION_USER, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import {
  forgetSlateFiles, SlateFiles, SlateShareStore, WorkspaceSlateContentStore, SqliteSlateStateStore, SqliteSlateStore, WorkspaceBlueprints, WorkspaceSlates, slateDirectory,
  type BlueprintReading, type DurableAppIdentity, type DurableApps, type ShareUser,
} from '@kinu.run/core/slates';
import { SlateLiveShareStore, initSlateLiveShareTables, shareLiveSlate } from '@kinu.run/core/slates';
import { EphemeralSlates, initEphemeralSlateTable, SlateUsageStore, initSlateUsageTable } from '@kinu.run/core/slates';
import {
  ingressAdmitted,
  parseSlateProject, slateIdFor, slateTitle, routeSlateStorageCall, SLATE_STORAGE_BINDING, SLATE_HOST_BINDING,
  SlateCallRequestSchema, SlateOperationSchema, requireSlateWorkMode, requireWorkModePermission, routeSlateCall, issuedSlateInvocation,
  routeViewerCall, admitNestedViewerCall, slateCallAddress, slateAddressImpact, JsonValueSchema, projectJsonValue, isSlateMethodName, answeredRefusal, reoriginateRequest,
  escapeHtml, publicPage, UsageSchema, usageTotal,
  SHARE_SPEND_CAP_USD_PER_DAY, SHARE_VIEWER_REQUESTS_PER_MINUTE, shareSpendLabel, VIEWER_EXCHANGE_PATH,
  type BlueprintBundle, type BlueprintFork, type JsonValue, type SlateAnswer, type SlateProject, type SlateShareRecord,
  type SlateRoute, type SlateCallRequest, type SlateCallResult, type SlateInvocation, type SlateOperation, type SlateSummary, type SlateProblem, type WorkspacePreviewUrl,
  type SlateSurfaceCatalog, type LiveShareRecord, type SlateViewer, type ViewerCall, type ShareViewerClaim,
  type MissionGovernor, type WorkspaceOverviewShare, slateCapabilityGraph, type SlateCapabilityGraph,
  ephemeralSlateAddress, type EphemeralSlateAddress,
} from '@kinu.run/core';
import { SLATES_ROOT } from '@kinu.run/core';
import type { KvStore } from '@kinu.run/agent-utils';
import { ERROR_CODES, KinuError, classifyErrorCode, refusalOf, settle, toKinuError, type Refusal } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import { ResidentSlateProcesses, type ResidentSlateDeps, type ResidentSlateProcess } from './resident';
import { slateBatchStub } from './rpc-transport';
import { ROOT_SLATE_CALLER, slateCallerKey, slateCredentialKey, shareCaller, type SlateBinding, type SlateBindingProps, type SlateCaller } from './bindings';
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

export interface SlateHostDeps extends ResidentSlateDeps {
  readonly ctx: DurableObjectState;
  readonly workspace: string;
  /** Runs as the caller: its own providers, role reach, read models and gates. */
  dispatch(caller: SlateCaller, route: SlateCapabilityRoute, context: SlateDispatchContext): Promise<JsonValue>;
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


/**
 * The key a slate's process is held under: one per caller for a directory slate, and one per answer's page, whose
 * author's mode is read at each call rather than fixed by the process.
 */
function heldKey(caller: SlateCaller, id: string): string {
  return ephemeralSlateAddress(id) === null ? `${slateCallerKey(caller)}#${id}` : `page#${id}`;
}

/** The one surface every slate is given, as its process sees it. */
const SLATE_SURFACE = 'workspace';

/** Answers' pages that keep a process and a reservation at once; drawing another retires the least recently drawn. */
const EPHEMERAL_SLATES_KEPT = 16;

interface ViewerAdmission {
  readonly caller: SlateCaller;
  readonly invocation: string;
  readonly share: LiveShareRecord;
  readonly viewer: SlateViewer;
  readonly record: (call: ViewerCall) => void;
  readonly settle: (outcome: string) => void;
}

/** A guest refusal crosses Cap'n Web as a plain Error with message `reason: error`. */
const SLATE_REFUSAL_MESSAGE = new RegExp(`^(${ERROR_CODES.join('|')}): ([\\s\\S]*)$`);

const SLATE_FILE = new RegExp(`^${SLATES_ROOT}/([^/]+)(?:/|$)`);

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

interface RunningSlate {
  readonly key: string;
  readonly revision: number;
  readonly caller: SlateCaller;
  readonly id: string;
  readonly source: SlateSource;
  readonly process: ResidentSlateProcess;
  readonly app: DurableAppIdentity | null;
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
  private readonly running = new Map<string, RunningSlate>();
  private readonly starting = new Map<string, Promise<RunningSlate>>();
  private readonly revisions = new Map<string, number>();
  private readonly live: SlateLiveShareStore;
  private readonly pages: EphemeralSlates;
  private readonly slateSources: SlateSources;
  /** A published blueprint never changes. */
  private readonly blueprintHeadings = new Map<string, { title: string; description: string }>();
  private readonly usage: SlateUsageStore;

  constructor(private readonly deps: SlateHostDeps) {
    this.resident = new ResidentSlateProcesses({ session: deps.session, facetManager: deps.facetManager, bundler: deps.bundler });
    this.store = new SqliteSlateStore(deps.ctx.storage.sql, (body) => deps.ctx.storage.transactionSync(body));
    this.state = new SqliteSlateStateStore(deps.ctx.storage.sql);
    initSlateLiveShareTables((ddl) => { deps.ctx.storage.sql.exec(ddl); });
    this.live = new SlateLiveShareStore(deps.ctx.storage.sql);
    initEphemeralSlateTable((ddl) => { deps.ctx.storage.sql.exec(ddl); });
    this.pages = new EphemeralSlates(deps.ctx.storage.sql);
    initSlateUsageTable((ddl) => { deps.ctx.storage.sql.exec(ddl); });
    this.usage = new SlateUsageStore(deps.ctx.storage.sql);
    this.slateSources = new SlateSources({
      project: (cred, id) => this.project(cred, id), trees: (cred) => this.sources(cred), host: deps,
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

  /** Re-reads the share row now (S6: a revoked share refuses before a process starts). */
  async admitViewerRequest(input: {
    readonly handle: string;
    readonly claim: ShareViewerClaim;
    readonly pathname: string;
  }): Promise<ViewerAdmission | Response> {
    const share = this.live.byHandle(input.handle);

    if (share === undefined) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });

    // A visitor not yet known signs in at the app, whose ticket brings them back as themselves.
    const entry = share.visibility === 'users' && input.claim.userId === null ? this.deps.shareEntry(share.id) : null;

    if (entry !== null) return new Response(null, { status: 303, headers: { location: entry, 'cache-control': 'no-store' } });

    if (share.visibility === 'users' && (input.claim.userId === null || !this.liveShareAdmitsUser(share.id, input.claim.userId))) {
      return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
    }

    const caller = shareCaller(share.id);

    const subject = input.claim.userId === null ? `source:${input.claim.source}` : `user:${input.claim.userId}`;

    // S2: a viewer past the bound is refused; the share is never paused.
    if (this.deps.kv !== undefined && !await ingressAdmitted(this.deps.kv, 'slate-share', `${share.id}:${subject}`, SHARE_VIEWER_REQUESTS_PER_MINUTE)) {
      return new Response('Too many requests', { status: 429, headers: { 'cache-control': 'no-store' } });
    }

    // D3: the consent page precedes anything of the owner's running, for named viewers too.
    if (!input.claim.consented) {
      const page = await this.consentPage(share);

      if (page !== null) return page;
    }

    const viewer: SlateViewer = {
      share: share.id,
      subject,
      request: this.live.openRequest({
        share: share.id,
        viewer: subject,
        path: input.pathname,
      }),
    };

    const invocation = crypto.randomUUID();
    this.invocations.set(invocation, { id: share.slate, chain: [], viewer });

    return {
      caller,
      invocation,
      share,
      viewer,
      record: (call) => { this.live.recordCall(viewer.request, call); },
      settle: (outcome) => { this.live.settleRequest(viewer.request, outcome); },
    };
  }
  /** `null` when the grant reaches nothing of the owner's: nothing to disclose. */
  private async consentPage(share: LiveShareRecord): Promise<Response | null> {
    const namespaces = [...new Set(share.grant.members.map((member) => member.namespace))];

    if (namespaces.length === 0) return null;
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

  /** Reads the ledger row, never `guard`, which stamps exhaustion and fires the once-per-label event. */
  private sharePaused(share: LiveShareRecord): boolean {
    const governor = this.deps.budget?.();

    if (governor === undefined) return false;

    return governor.snapshot(shareSpendLabel(share.id)).some((row) => row.exhausted);
  }

  /** The label carries the UTC day, so the bound renews without a rollover job; unparented so no turn owns it. */
  private shareGovernor(share: LiveShareRecord): MissionGovernor | undefined {
    const governor = this.deps.budget?.();

    if (governor === undefined) return undefined;
    governor.declare(shareSpendLabel(share.id), { usd: SHARE_SPEND_CAP_USD_PER_DAY }, { parent: '' });

    return governor;
  }

  private debitShare(share: LiveShareRecord, value: JsonValue): void {
    const governor = this.shareGovernor(share);

    if (governor === undefined) return;
    const usage = v.safeParse(v.object({ usage: v.optional(UsageSchema) }), value);

    governor.debit(usage.success && usage.output.usage !== undefined ? usageTotal(usage.output.usage) ?? 0 : 0, {
      labels: [shareSpendLabel(share.id)], calls: 1,
      usage: usage.success ? usage.output.usage : undefined,
    });
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
    return userId === this.deps.ownerUserId?.() || this.live.hasUser(share, userId);
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
    const key = slateCredentialKey(cred);
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
    for (const [key, running] of this.running) {
      if (running.caller.share !== revoked.id) continue;
      this.running.delete(key);
      await running.process.stop();
    }

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

      case 'liveShares': return { ok: true, value: projectJsonValue({ value: this.live.list().map((row) => ({ ...row, paused: this.sharePaused(row) })) }) };
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

  /** The application is the root's, so the URL is the same whoever asks and across launches. */
  async preview(caller: SlateCaller, id: string): Promise<SlateCallResult> {
    try {
      requireWorkModePermission(caller.workMode, false, 'Starting or exposing a slate preview');
      const { source, app } = await this.served(id);
      const preview = await this.deps.apps.url(app.port, app.capability);

      if (preview.url === undefined) throw new KinuError('unavailable', 'This deployment cannot mint a slate preview URL: ' + preview.unavailable);

      // An answer's own block is shown where the answer is, never again as a card of the turn's slates.
      if (source.kind === 'files') this.deps.previewed?.(id);
      // Every page the runner serves reports its height; a slate's own server serves pages that do not.
      const sized = source.project.browser !== undefined && source.project.slate.runtime === 'worker';

      return { ok: true, value: { url: preview.url, port: app.port, sized } };
    } catch (cause) {
      return { ok: false, ...refusalOf(toKinuError({ doing: 'slate ' + id + ' preview', cause, otherwise: 'io' })) };
    }
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
    return (await this.served(id)).app;
  }

  private async served(id: string): Promise<RunningSlate & { readonly app: DurableAppIdentity }> {
    const running = await this.booted(ROOT_SLATE_CALLER, id);

    if (running.app === null) throw new KinuError('io', `Slate ${id} is running without its durable application`);

    return { ...running, app: running.app };
  }

  /** Ends processes, the durable application, the authored tree and its storage; committed versions stay. */
  async remove(caller: SlateCaller, id: string): Promise<SlateCallResult> {
    try {
      const session = await this.deps.session();
      const root = slateDirectory(new SlateId(id));

      for (const [held, running] of this.running) {
        if (running.id !== id) continue;
        this.running.delete(held);
        await running.process.stop();
      }

      const removed = await this.deps.apps.remove(id);
      const vfs = session.vfs.as(caller.cred);

      session.vfs.withTransaction(() => {
        if (vfs.exists(root)) vfs.removeRecursive(root);
        forgetSlateFiles(this.deps.ctx.storage.sql, new SlateId(id));
        this.state.forget(id);
        this.usage.forget(id);
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
    for (const [held, running] of this.running) {
      if (running.app?.port !== port) continue;
      const value = crypto.randomUUID();
      this.invocations.set(value, socket ? { id: running.id, chain: [], held } : { id: running.id, chain: [] });

      return { value, release: () => { this.invocations.delete(value); } };
    }

    return null;
  }

  private releaseInvocation(caller: SlateCaller, id: string, request: SlateCallRequest): SlateCallResult {
    const target = request.args[0];

    if (request.path.join('.') !== 'release' || !v.is(v.string(), target)) {
      return { ok: false, ...refusalOf(toKinuError({ doing: `slate ${id} host call`, cause: new KinuError('bad_input', 'The host binding answers only release(invocation)'), otherwise: 'io' })) };
    }

    const issued = this.invocations.get(target);
    // Only the invocation this process holds, so it cannot retire another's lineage.

    if (issued === undefined || issued.id !== id || issued.held !== heldKey(caller, id)) {
      return { ok: false, ...refusalOf(toKinuError({ doing: `slate ${id} host call`, cause: new KinuError('denied', `Slate ${id} named app invocation ${target}, which this host is not running`), otherwise: 'io' })) };
    }

    this.invocations.delete(target);

    if (issued.viewer !== undefined) this.live.settleRequest(issued.viewer.request, 'closed');

    return { ok: true, value: null };
  }

  /** Every call a slate makes, routed and held to its caller's reach as of now: a held stub proves its slate, nothing more. */
  async surfaceCall(caller: SlateCaller, id: string, name: string, request: JsonValue): Promise<SlateCallResult> {
    try {
      const parsed = v.safeParse(SlateCallRequestSchema, request);

      if (!parsed.success) throw new KinuError('bad_input', 'A slate call is { path: string[], args: JSON[], invocation: string | null }', { cause: new v.ValiError(parsed.issues) });

      if (name === SLATE_HOST_BINDING) return this.releaseInvocation(caller, id, parsed.output);

      // Answered here, not dispatched: it carries no actor capability.
      if (name === SLATE_STORAGE_BINDING) return this.storageCall(caller, id, parsed.output);
      const issued = issuedSlateInvocation({ invocations: this.invocations, id, invocation: parsed.output.invocation });
      const chain = issued?.chain ?? [];

      // The share row is re-read now, so a revoked share refuses mid-flight.
      if (caller.share !== undefined) return await this.viewerCall({ caller, share: caller.share, id, request: parsed.output, chain, issued });

      const source = await this.slateSources.resolve(caller.cred, id);

      if (source.kind === 'message' && !source.bound) {
        throw new KinuError('denied', `Slate ${id} is a hired agent's page, drawn with no authority lent to it: its calls would not run where that agent's stores are`);
      }

      // An answer's page calls as its author as of now, in the mode the author's next turn runs in.
      const callsAs = source.kind === 'message' ? source.author : caller;
      const call = routeSlateCall({ id, request: parsed.output, chain });
      // An answer's page is never shared or published, so what it calls is no slate's graph.
      const record = (namespace: string, member: string) => { if (source.kind !== 'message') this.usage.record(id, { namespace, member }); };

      record(call.address.namespace, call.address.member);

      return await this.run(callsAs, call.route, { nested: record, ...(parsed.output.authorize && { authorizeOnly: true }) });
    } catch (cause) {
      return { ok: false, ...refusalOf(toKinuError({ doing: `slate ${id} ${name}`, cause, otherwise: 'io' })) };
    }
  }

  private storageCall(caller: SlateCaller, id: string, request: SlateCallRequest): SlateCallResult {
    const operation = routeSlateStorageCall({ member: request.path.join('.'), args: request.args });

    if (operation.op === 'put' || operation.op === 'delete') {
      requireWorkModePermission(caller.workMode, false, 'slate storage write');
    }

    switch (operation.op) {
      case 'get': return { ok: true, value: this.state.get(id, operation.key) };
      case 'put': {
        this.state.put(id, operation.key, operation.value);

        return { ok: true, value: null };
      }

      case 'delete': return { ok: true, value: this.state.delete(id, operation.key) };
      case 'list': return { ok: true, value: this.state.list(id, { prefix: operation.prefix, limit: operation.limit }) };
    }
  }

  /** A viewer's call: the grant decides, every call is audited, and what it spends is the share's. */
  private async viewerCall(input: {
    readonly caller: SlateCaller;
    readonly share: string;
    readonly id: string;
    readonly request: SlateCallRequest;
    readonly chain: readonly string[];
    readonly issued: SlateInvocation | null;
  }): Promise<SlateCallResult> {
    const { caller, id, request, chain, issued } = input;

    if (issued?.viewer === undefined) throw new KinuError('denied', 'A viewer call must name the invocation it was issued under');
    const viewer = issued.viewer;
    const named = slateCallAddress(request.path);
    // What the audit row says, as far as the call got: refused until it is routed and answered.
    let row: ViewerCall = { slate: id, ...named, impact: slateAddressImpact(named) ?? 'administer', ok: false };
    // A revoked share refuses here, before there is a call of it to audit.
    const share = this.live.live(input.share);

    try {
      // S2: the per-day spend bound refuses as 'budget'.
      const governor = this.deps.budget?.();

      if (governor !== undefined && governor.guard('model_call', [shareSpendLabel(share.id)]) !== null) {
        throw new KinuError('budget', 'This share is paused for today');
      }

      const call = routeViewerCall({ id, request, chain, viewer, grant: share.grant });
      row = { slate: id, ...call.address, impact: call.impact, ok: false };

      // What the call reaches inside itself meets the grant as it stands then: a revoke mid-call ends it there.
      const nested = (namespace: string, member: string) => { admitNestedViewerCall(this.live.live(input.share).grant, id, { namespace, member }); };

      const result = await this.run(caller, call.route, { nested, ...(request.authorize && { authorizeOnly: true }) }, viewer);
      row = { ...row, ok: result.ok };

      if (result.ok) this.debitShare(share, result.value);

      return result;
    } finally {
      this.live.recordCall(viewer.request, row);
    }
  }

  private async run(caller: SlateCaller, route: SlateRoute, context: SlateDispatchContext, viewer?: SlateViewer): Promise<SlateCallResult> {
    switch (route.kind) {
      case 'namespace': {
        const value = await this.deps.dispatch(caller, route, context);
        const refused = answeredRefusal(value);

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
    return (await this.booted(caller, id)).process;
  }

  /** A stored answer's block runs as its author, whoever looks at it; its source is resolved once for the boot. */
  private async booted(viewer: SlateCaller, id: string): Promise<RunningSlate> {
    const source = await this.slateSources.resolve(viewer.cred, id);
    const caller = source.kind === 'message' ? source.author : viewer;
    const held = heldKey(caller, id);
    const starting = this.starting.get(held);

    if (starting !== undefined) return starting;
    const boot = this.boot(caller, id, held, source).finally(() => { this.starting.delete(held); });
    this.starting.set(held, boot);

    return boot;
  }

  /** Ends a process this host started and the socket invocations it held. */
  private async stopHeld(held: string): Promise<void> {
    const running = this.running.get(held);

    if (running === undefined) return;
    this.running.delete(held);
    await running.process.stop();

    // A socket-held invocation dies with the process that held it.
    for (const [invocationId, issued] of this.invocations) {
      if (issued.held === held) this.invocations.delete(invocationId);
    }
  }

  /** Only the answers' pages drawn most recently keep a process: the rest give up their process and reservation, and are
   *  booted again if drawn again. */
  private async keepPage(id: string): Promise<void> {
    for (const retired of this.pages.drawn(id, Date.now(), EPHEMERAL_SLATES_KEPT)) {
      for (const [other, running] of this.running) {
        if (running.id === retired) await this.stopHeld(other);
      }

      await this.deps.apps.remove(retired);
    }
  }

  private async boot(caller: SlateCaller, id: string, held: string, resolved: SlateSource): Promise<RunningSlate> {
    for (let source = resolved; ; source = await this.slateSources.resolve(caller.cred, id)) {
      const revision = this.revisions.get(id) ?? 0;
      const { project, root } = source;
      const globalOutbound = caller.workMode === 'plan' ? null : codemodeEgress({ workspace: this.deps.workspace, actor: await this.deps.browserActor(caller) });

      if (caller.workMode === 'build' && globalOutbound === null) {
        throw new KinuError('unsupported', 'Resident slate egress requires the shared outbound policy binding');
      }

      if (project.slate.runtime !== 'worker') throw new KinuError('unsupported', 'Resident slate previews require slate.runtime worker; run node projects through the sandbox executor');
      // The loader evaluates boot options only on a cache miss. This identity
      // must not reuse an image created before outbound mediation was supplied.
      const key = `slate:mediated:${this.deps.workspace}:${held}:${await this.slateSources.digest(caller.cred, id, source)}`;
      const running = this.running.get(held);

      if (running?.key === key && await running.process.isRunning()) {
        const refreshed = { ...running, revision };
        this.running.set(held, refreshed);

        return refreshed;
      }

      await this.stopHeld(held);

      if (source.kind === 'message') await this.keepPage(id);
      const bindings: Record<string, Fetcher<SlateBinding>> = {};

      for (const name of [SLATE_SURFACE, SLATE_STORAGE_BINDING, SLATE_HOST_BINDING]) {
        const props: SlateBindingProps = { workspace: this.deps.workspace, id, name, caller };
        bindings[name] = exports.SlateBinding({ props });
      }

      // Only the root's build process is the durable application; shares and Plan roots are private and must never
      // attach to its facet. A block is only ever seen through its preview, so it always has one.
      const app = source.kind === 'message' || (caller.share === undefined && caller.path.length === 0 && caller.workMode === 'build')
        ? await this.deps.apps.ensure({ owner: id, preferredPort: project.slate.port })
        : null;

      const process = await this.resident.start({
        key, owner: id, root, project, read: await this.slateSources.reader(caller.cred, source), cred: caller.cred, bindings, globalOutbound,
        app: app === null ? null : { port: app.port },
      });

      if ((this.revisions.get(id) ?? 0) !== revision) { await process.stop(); continue; }

      const started = { key, revision, caller, id, source, process, app };
      this.running.set(held, started);

      return started;
    }
  }

  filesChanged(paths: readonly string[]): string[] {
    const ids = new Set<string>();

    for (const path of paths) {
      const match = SLATE_FILE.exec(path.startsWith('/') ? path : `/${path}`);
      const id = match?.[1];

      if (id !== undefined) ids.add(id);
    }

    for (const id of ids) this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);

    if (ids.size > 0) markStoreChanged(this.deps.ctx.storage.sql);

    return [...ids];
  }
}

