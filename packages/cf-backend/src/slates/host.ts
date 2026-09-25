import { exports } from 'cloudflare:workers';
import { WorkspaceId } from '@agent-core/core';
import { SlateId, SlateVersionId } from '@agent-core/core/slates';
import * as v from 'valibot';
import { CRED_KERNEL, CRED_SESSION_USER, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import {
  forgetSlateFiles, SlateFiles, SlateShareStore, WorkspaceSlateContentStore, SqliteSlateStateStore, SqliteSlateStore, WorkspaceBlueprints, WorkspaceSlates, slateDirectory,
  type BlueprintReading, type DurableAppIdentity, type DurableApps, type ShareUser,
} from '@kinu.run/core/slates';
import { SlateLiveShareStore, initSlateLiveShareTables, WorkspaceLiveShares } from '@kinu.run/core/slates';
import {
  credentialedBindings, ingressAdmitted,
  parseSlateProject, routeSlateStorageCall, SLATE_STORAGE_BINDING, SLATE_HOST_BINDING,
  SlateBindingRequestSchema, SlateOperationSchema, requireSlateWorkMode, requireWorkModePermission, routeSlateBindingCall, issuedSlateInvocation,
  routeViewerBindingCall, JsonValueSchema, projectJsonValue, isSlateMethodName, answeredRefusal, reoriginateRequest,
  escapeHtml, publicPage, UsageSchema, usageTotal,
  SHARE_SPEND_CAP_USD_PER_DAY, SHARE_VIEWER_REQUESTS_PER_MINUTE, shareSpendLabel, VIEWER_EXCHANGE_PATH,
  type BlueprintBundle, type BlueprintFork, type JsonValue, type SlateAnswer, type SlateProject, type SlateShareRecord,
  type SlateBindingRoute, type SlateCallResult, type SlateInvocation, type SlateOperation, type SlateSummary, type SlateProblem, type WorkspacePreviewUrl,
  type SlateBindingCatalog, type LiveShareRecord, type SlateViewer, type ViewerCall, type ShareViewerClaim,
  type MissionGovernor,
} from '@kinu.run/core';
import { canonicalWorkspacePath, workspacePath, WORKSPACE_ROOT } from '@kinu.run/core';
import type { KvStore } from '@kinu.run/agent-utils';
import { ERROR_CODES, KinuError, classifyErrorCode, refusalOf, toKinuError, type Refusal } from '@kinu.run/core/obs';
import { ResidentSlateProcesses, type ResidentSlateDeps, type ResidentSlateProcess } from './resident';
import { slateBatchStub } from './rpc-transport';
import { ROOT_SLATE_CALLER, slateCallerKey, slateCredentialKey, shareCaller, type SlateBinding, type SlateBindingProps, type SlateCaller } from './bindings';
import { codemodeEgress } from '../codemode-egress';

export type SlateCapabilityRoute = Exclude<SlateBindingRoute, { kind: 'app' }>;

export interface SlateApps extends DurableApps {
  url(port: number, capability: string): Promise<WorkspacePreviewUrl>;
}

export interface SlateHostDeps extends ResidentSlateDeps {
  readonly ctx: DurableObjectState;
  readonly workspace: string;
  /** Runs as the caller: its own providers, role reach, read models and gates. */
  dispatch(caller: SlateCaller, route: SlateCapabilityRoute): Promise<JsonValue>;
  readonly apps: SlateApps;
  catalog(): Promise<SlateBindingCatalog>;
  shareUrl(handle: string): Promise<string | null>;
  /** Absent means no per-viewer rate bound, as at the edge. */
  kv?: KvStore;
  /** Debits the per-share per-day spend label; absent means no spend bound. */
  budget?(): MissionGovernor;
  ownerTitle?(): Promise<string>;
}

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

const SLATES_DIRECTORY = workspacePath('slates');

const SLATE_FILE = new RegExp(`^${WORKSPACE_ROOT}/slates/([^/]+)(?:/|$)`);

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

  constructor(private readonly deps: SlateHostDeps) {
    this.resident = new ResidentSlateProcesses({ session: deps.session, facetManager: deps.facetManager });
    this.store = new SqliteSlateStore(deps.ctx.storage.sql, (body) => deps.ctx.storage.transactionSync(body));
    this.state = new SqliteSlateStateStore(deps.ctx.storage.sql);
    initSlateLiveShareTables((ddl) => { deps.ctx.storage.sql.exec(ddl); });
    this.live = new SlateLiveShareStore(deps.ctx.storage.sql);
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

  private async liveShares(): Promise<WorkspaceLiveShares> {
    return new WorkspaceLiveShares({
      workspace: this.deps.workspace,
      shares: this.live,
      catalog: () => this.deps.catalog(),
      shareUrl: (handle) => this.deps.shareUrl(handle),
    });
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
      title: project?.slate.title ?? project?.name ?? record.slate,
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

    if (share.visibility === 'users' && (input.claim.userId === null || !this.live.hasUser(share.id, input.claim.userId))) {
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
        slate: share.slate,
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
  /** `null` when the slate reaches nothing credentialed of the owner's: nothing to disclose. */
  private async consentPage(share: LiveShareRecord): Promise<Response | null> {
    const project = await this.project(CRED_SESSION_USER, share.slate);
    const credentialed = credentialedBindings(project);

    if (credentialed.length === 0) return null;

    const owner = (await this.deps.ownerTitle?.()) ?? this.deps.workspace;
    const title = project.slate.title ?? project.name ?? share.slate;
    const bindings = credentialed.map((binding) => `<li>${escapeHtml(`${binding.name} (${binding.target})`)}</li>`).join('');

    const html = publicPage({
      title: `${owner} shared ${title}`,
      body: `<main><section class="section">
<h1>${escapeHtml(owner)} shared ${escapeHtml(title)}</h1>
<p class="dim">This slate runs in ${escapeHtml(owner)}'s workspace and calls these connections with their credentials:</p>
<ul>${bindings}</ul>
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

    if (!vfs.exists(SLATES_DIRECTORY)) return projects;

    for (const entry of vfs.readdir(SLATES_DIRECTORY)) {
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
  shareBlueprintWith(share: string, users: readonly ShareUser[]): Promise<SlateAnswer<SlateShareRecord>> {
    return this.blueprintAnswer('sharing blueprint ' + share, (blueprints) => blueprints.shareWith(share, users));
  }

  /** Never starts its process. */
  admitBlueprint(bundle: BlueprintBundle): Promise<SlateAnswer<BlueprintFork>> {
    return this.blueprintAnswer('admitting a blueprint', (blueprints) => blueprints.admit(this.deps.workspace, bundle));
  }

  shareLiveWith(share: string, users: readonly ShareUser[]): Promise<SlateAnswer<LiveShareRecord>> {
    return this.blueprintAnswer('sharing slate ' + share, () => this.live.addUsers(share, users));
  }

  liveShareAdmitsUser(share: string, userId: string): boolean {
    return this.live.hasUser(share, userId);
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

          return { ok: true, value: { slates: listing.slates.map((slate) => ({ ...slate, bindings: [...slate.bindings] })), problems: listing.problems.map((problem) => ({ ...problem })) } };
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

          return { ok: true, value: projectJsonValue({ value: { slate: slate.toData(), versions: this.store.listVersions(id).map((version) => version.toData()) } }) };
        }

        case 'commit': return { ok: true, value: projectJsonValue({ value: (await (await this.sources(caller.cred)).commit(new SlateId(operation.id))).toData() }) };
        case 'fork': return { ok: true, value: projectJsonValue({ value: (await (await this.sources(caller.cred)).fork(new SlateVersionId(operation.version))).toData() }) };
        case 'restore': return { ok: true, value: projectJsonValue({ value: (await (await this.sources(caller.cred)).restore(new SlateId(operation.id), new SlateVersionId(operation.version))).toData() }) };
        // Publishing and sharing are the owner's alone; a hosted actor never exports on the owner's behalf.
        case 'inspect':
        case 'publish':
        case 'unshare':
        case 'shares':
        case 'share':
        case 'liveShares':
        case 'viewerRequests': {
          if (caller.path.length > 0) throw new KinuError('denied', 'Only the workspace root publishes, shares or revokes slates');
          const blueprints = await this.blueprints();

          switch (operation.op) {
            case 'inspect': return { ok: true, value: projectJsonValue({ value: blueprints.inspect(operation.id, operation.version, operation.include) }) };
            case 'publish': return { ok: true, value: projectJsonValue({ value: await blueprints.publish(operation.id, operation.version, operation.include) }) };
            case 'unshare': return await this.unshare(operation.share, blueprints);

            case 'shares': return { ok: true, value: projectJsonValue({ value: blueprints.list() }) };
            case 'share': {
              return { ok: true, value: projectJsonValue({ value: await (await this.liveShares()).share(operation.id, operation.visibility, operation.approved, operation.fork) }) };
            }

            case 'liveShares': return { ok: true, value: projectJsonValue({ value: this.live.list().map((row) => ({ ...row, paused: this.sharePaused(row) })) }) };
            case 'viewerRequests': return { ok: true, value: projectJsonValue({ value: this.live.requests(operation.share) }) };
          }
        }

        case 'graph': return { ok: true, value: projectJsonValue({ value: await (await this.liveShares()).graph(operation.id) }) };
      }
    } catch (cause) {
      return { ok: false, ...refusalOf(toKinuError({ doing: 'slate operation', cause, otherwise: 'io' })) };
    }
  }

  async list(caller: SlateCaller): Promise<{ slates: SlateSummary[]; problems: SlateProblem[] }> {
    const session = await this.deps.session();
    const vfs = session.vfs.as(caller.cred);
    const slates: SlateSummary[] = [];
    const problems: SlateProblem[] = [];

    if (!vfs.exists(SLATES_DIRECTORY)) return { slates, problems };

    for (const entry of vfs.readdir(SLATES_DIRECTORY)) {
      if (entry.type !== 'directory') continue;

      try {
        const project = await this.project(caller.cred, entry.name);
        const running = this.running.get(`${slateCallerKey(caller)}#${entry.name}`);

        const live = running !== undefined && await running.process.isRunning()
          && running === this.running.get(`${slateCallerKey(caller)}#${entry.name}`)
          && running.revision === (this.revisions.get(entry.name) ?? 0);

        const summary: SlateSummary = {
          id: entry.name,
          title: project.slate.title ?? project.name ?? entry.name,
          bindings: Object.keys(project.slate.bindings),
          port: live && running !== undefined ? running.app?.port : undefined,
        };

        slates.push(summary);
      } catch (cause) {
        problems.push({ id: entry.name, ...refusalOf(toKinuError({ doing: 'slate ' + entry.name, cause, otherwise: 'io' })) });
      }
    }

    return { slates, problems };
  }

  /** The application is the root's, so the URL is the same whoever asks and across launches. */
  async preview(caller: SlateCaller, id: string): Promise<SlateCallResult> {
    try {
      requireWorkModePermission(caller.workMode, false, 'Starting or exposing a slate preview');
      const project = await this.project(caller.cred, id);
      const app = await this.serve(id);
      const preview = await this.deps.apps.url(app.port, app.capability);

      if (preview.url === undefined) throw new KinuError('unavailable', 'This deployment cannot mint a slate preview URL: ' + preview.unavailable);

      return { ok: true, value: { url: preview.url, port: app.port, inline: { height: project.slate.inline.height } } };
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
    const running = await this.booted(ROOT_SLATE_CALLER, id);

    if (running.app === null) throw new KinuError('io', `Slate ${id} is running without its durable application`);

    return running.app;
  }

  /** Ends processes, the durable application and the authored tree; committed versions stay. Root only. */
  async remove(caller: SlateCaller, id: string): Promise<SlateCallResult> {
    try {
      if (caller.path.length > 0) throw new KinuError('denied', 'Only the workspace root removes a slate');
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
      });

      return { ok: true, value: { id, removed: removed.removed, port: removed.port } };
    } catch (cause) {
      return { ok: false, ...refusalOf(toKinuError({ doing: 'slate ' + id + ' remove', cause, otherwise: 'io' })) };
    }
  }

  private readonly invocations = new Map<string, SlateInvocation & { readonly held?: string }>();

  /**
   * A named root invocation for a request this host did not originate; unnamed, a slate could replay a preview's bindings
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

  private releaseInvocation(caller: SlateCaller, id: string, request: JsonValue): SlateCallResult {
    const parsed = v.safeParse(SlateBindingRequestSchema, request);

    if (!parsed.success) {
      return { ok: false, ...refusalOf(toKinuError({ doing: `slate ${id} host call`, cause: new v.ValiError(parsed.issues), otherwise: 'io' })) };
    }

    const target = parsed.output.args[0];

    if (parsed.output.member !== 'release' || !v.is(v.string(), target)) {
      return { ok: false, ...refusalOf(toKinuError({ doing: `slate ${id} host call`, cause: new KinuError('bad_input', 'The host binding answers only release(invocation)'), otherwise: 'io' })) };
    }

    const issued = this.invocations.get(target);
    // Only the invocation this process holds, so it cannot retire another's lineage.

    if (issued === undefined || issued.id !== id || issued.held !== `${slateCallerKey(caller)}#${id}`) {
      return { ok: false, ...refusalOf(toKinuError({ doing: `slate ${id} host call`, cause: new KinuError('denied', `Slate ${id} named app invocation ${target}, which this host is not running`), otherwise: 'io' })) };
    }

    this.invocations.delete(target);

    if (issued.viewer !== undefined) this.live.settleRequest(issued.viewer.request, 'closed');

    return { ok: true, value: null };
  }

  /** Re-read the slate field on every call: a held stub proves its name, not today's reach. */
  async bindingCall(caller: SlateCaller, id: string, name: string, request: JsonValue): Promise<SlateCallResult> {
    try {
      const parsed = v.safeParse(SlateBindingRequestSchema, request);

      if (!parsed.success) throw new KinuError('bad_input', 'A binding call is { member, args: JSON[], invocation: string | null }', { cause: new v.ValiError(parsed.issues) });

      if (name === SLATE_HOST_BINDING) return this.releaseInvocation(caller, id, parsed.output);

      // Answered here, not dispatched: it carries no actor capability.
      if (name === SLATE_STORAGE_BINDING) {
        const operation = routeSlateStorageCall(parsed.output);

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

      const issued = issuedSlateInvocation({ invocations: this.invocations, id, invocation: parsed.output.invocation });
      const chain = issued?.chain ?? [];

      // The share row is re-read now, so a revoked share refuses mid-flight.
      if (caller.share !== undefined) {
        if (issued?.viewer === undefined) {
          throw new KinuError('denied', 'A viewer binding call must name the invocation it was issued under');
        }

        const viewer = issued.viewer;

        // S2: the per-day spend bound refuses as 'budget'.
        const share = this.live.live(caller.share);
        const governor = this.deps.budget?.();

        if (governor !== undefined && governor.guard('model_call', [shareSpendLabel(share.id)]) !== null) {
          this.live.recordCall(viewer.request, { slate: id, binding: name, member: parsed.output.member, effect: 'mutate', ok: false });
          throw new KinuError('budget', 'This share is paused for today');
        }

        const project = await this.project(caller.cred, id);
        let call;

        try {
          call = routeViewerBindingCall({ id, project, name, request: parsed.output, chain, viewer, grant: share.grant });
        } catch (cause) {
          this.live.recordCall(viewer.request, { slate: id, binding: name, member: parsed.output.member, effect: 'mutate', ok: false });
          throw cause;
        }

        let result: SlateCallResult;

        try {
          result = await this.run(caller, call.route, viewer);
        } catch (cause) {
          this.live.recordCall(viewer.request, { slate: id, binding: name, member: call.member, effect: call.effect, ok: false });
          throw cause;
        }

        this.live.recordCall(viewer.request, { slate: id, binding: name, member: call.member, effect: call.effect, ok: result.ok });

        if (result.ok) this.debitShare(share, result.value);

        return result;
      }

      const project = await this.project(caller.cred, id);

      return await this.run(caller, routeSlateBindingCall({ id, project, name, request: parsed.output, chain }));
    } catch (cause) {
      return { ok: false, ...refusalOf(toKinuError({ doing: `slate ${id} binding ${name}`, cause, otherwise: 'io' })) };
    }
  }

  private async run(caller: SlateCaller, route: SlateBindingRoute, viewer?: SlateViewer): Promise<SlateCallResult> {
    switch (route.kind) {
      case 'namespace': {
        const value = await this.deps.dispatch(caller, route);
        const refused = answeredRefusal(value);

        return refused === null ? { ok: true, value } : { ok: false, ...refused };
      }

      // MCP owns CallToolResult.isError; read models are application data.
      // Neither producer declares the internal namespace refusal vocabulary.
      case 'mcp':
      case 'rpc': return { ok: true, value: await this.deps.dispatch(caller, route) };
      case 'tool':
      case 'codemode': return { ok: true, value: await this.deps.dispatch(caller, route) };
      case 'agent':
      case 'ai': return { ok: true, value: await this.deps.dispatch(caller, route) };
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

  private booted(caller: SlateCaller, id: string): Promise<RunningSlate> {
    const held = `${slateCallerKey(caller)}#${id}`;
    const starting = this.starting.get(held);

    if (starting !== undefined) return starting;
    const boot = this.boot(caller, id, held).finally(() => { this.starting.delete(held); });
    this.starting.set(held, boot);

    return boot;
  }

  private async boot(caller: SlateCaller, id: string, held: string): Promise<RunningSlate> {
    const globalOutbound = caller.workMode === 'plan' ? null : codemodeEgress();

    if (caller.workMode === 'build' && globalOutbound === null) {
      throw new KinuError('unsupported', 'Resident slate egress requires the shared outbound policy binding');
    }

    const root = slateDirectory(new SlateId(id));
    const sources = await this.sources(caller.cred);

    for (;;) {
      const revision = this.revisions.get(id) ?? 0;
      const project = await this.project(caller.cred, id);

      if (project.slate.runtime !== 'worker') throw new KinuError('unsupported', 'Resident slate previews require slate.runtime worker; run node projects through the sandbox executor');
      const source = (await sources.synchronize(new SlateId(id))).source;
      // The loader evaluates boot options only on a cache miss. This identity
      // must not reuse an image created before outbound mediation was supplied.
      const key = `slate:mediated:${this.deps.workspace}:${held}:${source.digest.value}`;
      const running = this.running.get(held);

      if (running?.key === key && await running.process.isRunning()) {
        const refreshed = { ...running, revision };
        this.running.set(held, refreshed);

        return refreshed;
      }

      if (running !== undefined) {
        this.running.delete(held);
        await running.process.stop();

        // A socket-held invocation dies with the process that held it.
        for (const [invocationId, issued] of this.invocations) {
          if (issued.held === held) this.invocations.delete(invocationId);
        }
      }

      const bindings: Record<string, Fetcher<SlateBinding>> = {};

      for (const name of Object.keys(project.slate.bindings)) {
        const props: SlateBindingProps = { workspace: this.deps.workspace, id, name, caller };
        bindings[name] = exports.SlateBinding({ props });
      }

      bindings[SLATE_STORAGE_BINDING] = exports.SlateBinding({
        props: { workspace: this.deps.workspace, id, name: SLATE_STORAGE_BINDING, caller },
      });
      bindings[SLATE_HOST_BINDING] = exports.SlateBinding({
        props: { workspace: this.deps.workspace, id, name: SLATE_HOST_BINDING, caller },
      });

      // Only the root's build process is the durable application; shares and Plan roots are private and must never
      // attach to its facet.
      const app = caller.share === undefined && caller.path.length === 0 && caller.workMode === 'build'
        ? await this.deps.apps.ensure({ owner: id, preferredPort: project.slate.port })
        : null;

      const process = await this.resident.start({
        key, owner: id, root, project, cred: caller.cred, bindings, globalOutbound,
        app: app === null ? null : { port: app.port },
      });

      if ((this.revisions.get(id) ?? 0) !== revision) { await process.stop(); continue; }

      const started = { key, revision, caller, id, process, app };
      this.running.set(held, started);

      return started;
    }
  }

  filesChanged(paths: readonly string[]): string[] {
    const ids = new Set<string>();

    for (const path of paths) {
      const match = SLATE_FILE.exec(canonicalWorkspacePath(path.startsWith('/') ? path : `/${path}`));
      const id = match?.[1];

      if (id !== undefined) ids.add(id);
    }

    for (const id of ids) this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);

    return [...ids];
  }
}

