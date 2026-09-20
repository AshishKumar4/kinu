import { exports } from 'cloudflare:workers';
import { WorkspaceId } from '@agent-core/core';
import { SlateId, SlateVersionId } from '@agent-core/core/slates';
import * as v from 'valibot';
import { CRED_KERNEL, CRED_SESSION_USER, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import {
  SlateFiles, SlateShareStore, WorkspaceSlateContentStore, SqliteSlateStateStore, SqliteSlateStore, WorkspaceBlueprints, WorkspaceSlates, slateDirectory,
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
  type SlateBindingRoute, type SlateCallResult, type SlateInvocation, type SlateSummary, type SlateProblem, type WorkspacePreviewUrl,
  type SlateBindingCatalog, type LiveShareRecord, type SlateViewer, type ViewerCall, type ShareViewerClaim, type WorkspaceOverviewSlate,
  type MissionGovernor,
} from '@kinu.run/core';
import type { KvStore } from '@kinu.run/agent-utils';
import { ERROR_CODES, KinuError, classifyErrorCode, refusalOf, toKinuError, type Refusal } from '@kinu.run/core/obs';
import { ResidentSlateProcesses, type ResidentSlateDeps, type ResidentSlateProcess } from './resident';
import { slateBatchStub } from './rpc-transport';
import { ROOT_SLATE_CALLER, slateCallerKey, slateCredentialKey, shareCaller, type SlateBinding, type SlateBindingProps, type SlateCaller } from './bindings';
import { codemodeEgress } from '../codemode-egress';

/** A binding route the calling actor answers with its own capability set. */
export type SlateCapabilityRoute = Exclude<SlateBindingRoute, { kind: 'app' }>;

/** The durable-application seam a slate host reaches Nimbus through, plus the URL this deployment fronts a reservation at. */
export interface SlateApps extends DurableApps {
  url(port: number, capability: string): Promise<WorkspacePreviewUrl>;
}

export interface SlateHostDeps extends ResidentSlateDeps {
  readonly ctx: DurableObjectState;
  readonly workspace: string;
  /** Run a capability route as the caller: its own providers, its own role reach, its own read models, its own gates. */
  dispatch(caller: SlateCaller, route: SlateCapabilityRoute): Promise<JsonValue>;
  readonly apps: SlateApps;
  /** The workspace's live executors, MCP servers, crafted tools, model tiers
   *  and slates — what a live-share graph is drawn against. */
  catalog(): Promise<SlateBindingCatalog>;
  /** The public URL a share handle serves, or null where no share host is wired. */
  shareUrl(handle: string): Promise<string | null>;
  /** AUTH_KV, for the per-viewer request bound on the share rail. Absent
   *  means no rate bound — the same answer AUTH_KV's absence gives the edge
   *  rails `ingressAdmitted` already serves. */
  kv?: KvStore;
  /** The workspace's mission governor — the per-share per-day spend bound
   *  debits its `share:<id>:<day>` label here. Absent means no spend bound. */
  budget?(): MissionGovernor;
  /** Who the consent page says is sharing, before it names the slate. */
  ownerTitle?(): Promise<string>;
}

/** What a viewer request admitted under a share carries through its life:
 *  the caller it dispatches as, the share and subject it admitted under, and
 *  the settle/record pair the audit row needs. */
interface ViewerAdmission {
  readonly caller: SlateCaller;
  readonly invocation: string;
  readonly share: LiveShareRecord;
  readonly viewer: SlateViewer;
  /** A viewer binding call lands on the request's audit row — as `ok`, refused, or faulted. */
  readonly record: (call: ViewerCall) => void;
  readonly settle: (outcome: string) => void;
}

/**
 * A guest binding refusal crosses Cap'n Web as a plain Error whose message is
 * `reason: error`; the reason is one of the shared codes or nothing.
 */
const SLATE_REFUSAL_MESSAGE = new RegExp(`^(${ERROR_CODES.join('|')}): ([\\s\\S]*)$`);

function refusalFromThrown(input: { cause: unknown }): Refusal | null {
  const match = input.cause instanceof Error ? SLATE_REFUSAL_MESSAGE.exec(input.cause.message) : null;
  const reason = match === null ? undefined : v.safeParse(v.picklist(ERROR_CODES), match[1]);

  return reason?.success === true && match !== null ? { reason: reason.output, error: match[2] } : null;
}

interface RunningSlate {
  readonly key: string;
  readonly revision: number;
  readonly caller: SlateCaller;
  readonly id: string;
  readonly process: ResidentSlateProcess;
  /** The slate's durable identity when this process is the one serving it; null for a caller's private process. */
  readonly app: DurableAppIdentity | null;
}

/**
 * One process per authored tree PER CALLER, and one DURABLE APPLICATION per
 * slate.
 *
 * The application is Nimbus's: the slate id is its owner, and
 * `apps.ensure` reserves — or answers again — the port and the capability its
 * URL is built on, before the process that serves it is spawned. That record
 * lives in this object's storage, so the URL outlives the process, the
 * isolate and every redeploy; a request for it re-drives the process
 * (`ensureDurable`). The process behind the URL runs as the workspace root —
 * a preview is the owner's own view, whoever asked for it — and keeps its
 * facet, so the `this.sql` an authored slate sees is the same SQLite on every
 * launch until `remove`. Every other caller's process is private to that
 * caller: its bindings carry the caller's reach, it is reached by RPC alone
 * and it binds no port.
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

  /**
   * The blueprint plane, as the owner's root: publishing reads committed
   * versions and content-store bytes, never the caller's live tree, and
   * admission lands files as the workspace root the way a fork does.
   */
  private async blueprints(): Promise<WorkspaceBlueprints> {
    const slates = await this.sources(CRED_SESSION_USER);

    if (this.content === undefined) throw new KinuError('io', 'Slate content was not initialized');

    return new WorkspaceBlueprints({ slates, content: this.content,
      shares: new SlateShareStore(this.deps.ctx.storage.sql),
    });
  }

  /** A blueprint answer as a value: a refusal keeps its reason across the RPC hop. */
  private async blueprintAnswer<Value>(doing: string, body: (blueprints: WorkspaceBlueprints) => Promise<Value> | Value): Promise<SlateAnswer<Value>> {
    try {
      await this.deps.session();

      return { ok: true, value: await body(await this.blueprints()) };
    } catch (cause) {
      return { ok: false, ...refusalOf(toKinuError({ doing, cause, otherwise: 'io' })) };
    }
  }

  /**
   * The live-share plane, as the owner's root: the grant is cut against THIS
   *   workspace's catalog, the URL comes from the share host, and the store is
   *   this object's own table.
   */
  private async liveShares(): Promise<WorkspaceLiveShares> {
    return new WorkspaceLiveShares({
      workspace: this.deps.workspace,
      shares: this.live,
      catalog: () => this.deps.catalog(),
      shareUrl: (handle) => this.deps.shareUrl(handle),
    });
  }

  /**
   * The live share the app host's surfaces name — `get`, not `live`: a revoked
   *   row still reads as a record, and refusing it here is the caller's job
   *   (`/open` answers no URL; `routeShare` goes through `live()` itself).
   *   `null` when no share of that id exists. Title and description come from
   *   the slate's own package.json, and a slate deleted under its share reads
   *   as itself rather than refusing.
   */
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

  /** `readLiveShare` through the S6 gate: a missing id is 'missing', a revoked
   *   one is 'denied' — what the owner's DO surfaces answer to callers that
   *   must not distinguish "revoked" from "minted". */
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

  /**
   * Admit one viewer request under a share: the row re-read now — S6, a
   *   revoked share refuses before a process starts — the `users` check, the
   *   audit row, and the named-root invocation it runs under.
   */
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

    // S2: the per-viewer request bound, counted on every request the share
    // admits — one viewer past it is one viewer refused, never the share
    // paused. No KV is the same answer it gives the edge: unbounded.
    if (this.deps.kv !== undefined && !await ingressAdmitted(this.deps.kv, 'slate-share', `${share.id}:${subject}`, SHARE_VIEWER_REQUESTS_PER_MINUTE)) {
      return new Response('Too many requests', { status: 429, headers: { 'cache-control': 'no-store' } });
    }

    // D3: a viewer who never saw the consent page sees it before anything of
    // the owner's runs — named viewers too: a ticket cookie names an account,
    // it never signed the disclaimer. A slate that reaches nothing of the
    // owner's has nothing to disclose, and a project that cannot be read
    // keeps today's failure mode rather than hiding it behind a page.
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
  /**
   * The consent page a credentialed share answers until the viewer's cookie
   *   is the consent-minted one: who is sharing, what the slate reaches, and
   *   the button whose GET the edge mints that cookie on. `null` when the
   *   slate reaches nothing of the owner's — nothing to disclose.
   */
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

  /** Whether the share's per-day spend bound is already spent. A read of the
   *   ledger's own row — never `guard`, which stamps exhaustion and fires the
   *   once-per-label event the viewer's own call is for. */
  private sharePaused(share: LiveShareRecord): boolean {
    const governor = this.deps.budget?.();

    if (governor === undefined) return false;

    return governor.snapshot(shareSpendLabel(share.id)).some((row) => row.exhausted);
  }

  /**
   * The share's per-day spend bound, as the mission ledger keeps it: the
   *   label is the share's row and the UTC day, so the bound renews at
   *   midnight without a rollover job. `debit` records the call and whatever
   *   usage the route reported; a route that reports none debits the call
   *   alone. Declared here and unparented — a share's bound is its own, not a
   *   child of whichever turn happened to declare first.
   */
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

  /**
   * One request on a share origin: admission, the boot, and the port hop —
   *   and the audit row, which records admission refused the same as it does
   *   each settled outcome.
   */
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
      // A share's process is private — no port, no registry — so the request
      // goes to the process handle itself, on the path the share URL carried.
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
        admission.settle(response.ok ? 'ok' : response.status < 500 ? 'refused' : 'error');
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

  /** Every slate in the workspace as its parsed project — the catalog's `slates`
   *   field, which the capability graph walks through app bindings. Slates that
   *   fail to parse are omitted; they surface as `problem` rows on the graph. */
  async projects(caller: SlateCaller): Promise<Record<string, SlateProject>> {
    const session = await this.deps.session();
    const vfs = session.vfs.as(caller.cred);
    const projects: Record<string, SlateProject> = {};

    if (!vfs.exists('/home/user/slates')) return projects;

    for (const entry of vfs.readdir('/home/user/slates')) {
      if (entry.type !== 'directory') continue;

      try {
        projects[entry.name] = await this.project(caller.cred, entry.name);
      } catch (cause) {
        // A malformed project is the `problem` row the graph shows; anything
        // else is an I/O failure the catalog cannot answer for.
        if (classifyErrorCode({ cause }) !== 'bad_input') throw cause;
      }
    }

    return projects;
  }

  /** A viewer's read of one blueprint: the row re-read now, refused when revoked. */
  readBlueprint(share: string): Promise<SlateAnswer<BlueprintReading>> {
    return this.blueprintAnswer('reading blueprint ' + share, (blueprints) => blueprints.read(share));
  }

  /** The bytes a fork carries; same re-read, same refusal. */
  blueprintBundle(share: string): Promise<SlateAnswer<BlueprintBundle>> {
    return this.blueprintAnswer('exporting blueprint ' + share, (blueprints) => blueprints.bundle(share));
  }

  /** Name users on a blueprint. The rows are the owner's record; the projection each user reads is written by the caller. */
  shareBlueprintWith(share: string, users: readonly ShareUser[]): Promise<SlateAnswer<SlateShareRecord>> {
    return this.blueprintAnswer('sharing blueprint ' + share, (blueprints) => blueprints.shareWith(share, users));
  }

  /** Admit a blueprint into this workspace as a new slate. Never starts its
   *  process; the landed files reach the UI through the session's own change hook. */
  admitBlueprint(bundle: BlueprintBundle): Promise<SlateAnswer<BlueprintFork>> {
    return this.blueprintAnswer('admitting a blueprint', (blueprints) => blueprints.admit(this.deps.workspace, bundle));
  }

  /** Name users on a live share — the same `ShareUser` list a blueprint takes,
   *  on the running slate's row. */
  shareLiveWith(share: string, users: readonly ShareUser[]): Promise<SlateAnswer<LiveShareRecord>> {
    return this.blueprintAnswer('sharing slate ' + share, () => this.live.addUsers(share, users));
  }

  /** Whether the share's `users` list names this account — the live-fork
   *  admission test the app host's fork route runs through the owner object. */
  liveShareAdmitsUser(share: string, userId: string): boolean {
    return this.live.hasUser(share, userId);
  }

  /** The skeleton bundle a live-share fork carries — the running slate's own
   *  export, checked only by the caller above this method. */
  liveShareBundle(record: LiveShareRecord): Promise<SlateAnswer<BlueprintBundle>> {
    return this.blueprintAnswer(`exporting live share ${record.id}`, (blueprints) => blueprints.liveBundle(record.slate));
  }

  /** The live share as the app host returns it: the record plus its URL. */
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
        files: new SlateFiles(session.vfs.as(cred), this.content, (body) => session.vfs.withTransaction(body)),
        mutations: { mutate: async (request, mutation) => {
          if (request.workspaceId.value !== this.deps.workspace) throw new KinuError('denied', 'Slate mutation belongs to another workspace');

          return session.vfs.withTransaction(mutation);
        } },
      });
      this.sourceRuntimes.set(key, runtime);
    }

    return runtime;
  }

  async operation<Input>(caller: SlateCaller, input: Input): Promise<SlateCallResult> {
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
        case 'call': return await this.call(caller, operation.id, operation.method, operation.args ?? []);
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
        // Blueprints are the owner's to publish: a hosted actor edits its own
        // slates but never exports one on the owner's behalf. The share surface
        // — the graph, the grant, the rows, the audit — is the owner's too.
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
            case 'unshare': {
              if (this.live.get(operation.share) !== undefined) {
                const revoked = this.live.revoke(operation.share);

                // The invocations stay until the process carrying them stops:
                // a viewer call on a revoked share must still find its own
                // invocation, so the refusal names the share — 'no longer
                // shared' — instead of the caller's dead process.
                for (const [key, running] of this.running) {
                  if (running.caller.share !== revoked.id) continue;
                  this.running.delete(key);
                  await running.process.stop();
                }

                return { ok: true, value: projectJsonValue({ value: revoked }) };
              }

              return { ok: true, value: projectJsonValue({ value: blueprints.unshare(operation.share) }) };
            }

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

    if (!vfs.exists('/home/user/slates')) return { slates, problems };

    for (const entry of vfs.readdir('/home/user/slates')) {
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

  /**
   * The slate's URL, with its durable application running behind it. The
   * caller's mode gates the act; the application itself is the root's, so the
   * URL is the same whoever asks and stays the same across every launch.
   */
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

  /**
   * Every slate the caller can see, each with the URL its durable
   * application ALREADY answers at — the same `apps.url` mint `preview`
   * ends on, over the reservation `apps.reserved` reads instead of the
   * identity `serve` boots. A slate nothing has reserved yet answers `null`
   * rather than a launch, so a roster read costs a storage read and no
   * process. A slate this deployment cannot mint a URL for answers `null`
   * too: there is no picture to draw either way.
   */
  async addressed(caller: SlateCaller): Promise<WorkspaceOverviewSlate[]> {
    const { slates } = await this.list(caller);

    return Promise.all(slates.map(async (slate) => {
      const app = await this.deps.apps.reserved(slate.id);
      const preview = app === null ? null : await this.deps.apps.url(app.port, app.capability);

      return { id: slate.id, title: slate.title, url: preview?.url ?? null };
    }));
  }

  /**
   * Bring the durable application `owner` names to life for a request on its
   * URL: the process a reset took is re-driven, one whose source changed is
   * replaced, a live one is left alone. Answers the refusal instead of
   * throwing, so the route can say `missing` from `bad_input` apart.
   */
  async ensureDurable(owner: string): Promise<Refusal | null> {
    try {
      await this.serve(owner);

      return null;
    } catch (cause) {
      return refusalOf(toKinuError({ doing: 'slate ' + owner + ' durable app', cause, otherwise: 'io' }));
    }
  }

  /** The process serving the slate's durable application, and the identity it serves. */
  private async serve(id: string): Promise<DurableAppIdentity> {
    const running = await this.booted(ROOT_SLATE_CALLER, id);

    if (running.app === null) throw new KinuError('io', `Slate ${id} is running without its durable application`);

    return running.app;
  }

  /**
   * End a slate: every process it has, its durable application (the port,
   * the capability, the retained facet storage) and its authored tree. Its
   * committed versions stay in the store; `fork` brings one back as a new
   * slate. The root's act: the application it ends is the root's own.
   */
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

      if (vfs.exists(root)) session.vfs.withTransaction(() => { vfs.removeRecursive(root); });

      return { ok: true, value: { id, removed: removed.removed, port: removed.port } };
    } catch (cause) {
      return { ok: false, ...refusalOf(toKinuError({ doing: 'slate ' + id + ' remove', cause, otherwise: 'io' })) };
    }
  }

  private readonly invocations = new Map<string, SlateInvocation & { readonly held?: string }>();

  /**
   * An invocation for a request this host did not originate — a browser hitting
   * the preview, or a viewer request admitted under a share. The lineage is
   * the root, but it is a NAMED root: without one, a slate could keep a preview
   * request's bindings and present them from inside a hop to get an empty
   * chain, which is the same replay the hop path refuses. Released when the
   * routed request settles — a socket's, when the socket's close listener on
   * `__host` reaches `release`, which is what the `socket` flag remembers.
   *
   * `null` when no running slate serves that port; there is then nothing whose
   * bindings could be kept.
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

  /**
   * The process's one call back to its host: the socket close listener's
   * `release`, retiring the invocation the socket ran under. A retired or
   * never-minted id refuses like any other invocation replay.
   */
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
    // Only the invocation THIS process holds: another slate's, a batch call's,
    // or a dead id all refuse alike, so one process cannot retire a socket's
    // lineage it does not own.

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

      // `__host` is the process's channel back: today the one call `release`,
      // which a socket's close listener fires to retire its invocation.
      if (name === SLATE_HOST_BINDING) return this.releaseInvocation(caller, id, parsed.output);

      // The reserved binding is the slate's own durable KV on this object —
      // answered here rather than dispatched: it carries no actor capability.
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

      // A share's process routes under the grant — the share row is re-read
      // NOW, so a revoked share refuses mid-flight — and the call lands on the
      // request's audit row either way.
      if (caller.share !== undefined) {
        if (issued?.viewer === undefined) {
          throw new KinuError('denied', 'A viewer binding call must name the invocation it was issued under');
        }

        const viewer = issued.viewer;

        // S2: the share's per-day spend bound. A spent bound refuses the call
        // as 'budget' — the audit row takes the refusal like any other, and
        // the bound renews when the day in the label rolls over.
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
        // A member that ANSWERED a refusal refused; authored code sees the class.
        const refused = answeredRefusal(value);

        return refused === null ? { ok: true, value } : { ok: false, ...refused };
      }

      // MCP owns CallToolResult.isError; read models are application data.
      // Neither producer declares the internal namespace refusal vocabulary.
      case 'mcp':
      case 'rpc': return { ok: true, value: await this.deps.dispatch(caller, route) };
      case 'tool':
      case 'codemode': return { ok: true, value: await this.deps.dispatch(caller, route) };
      // The agent's inbox and the model call are the calling actor's own
      // surfaces, answered inside the same dispatch as the capability planes.
      case 'agent':
      case 'ai': return { ok: true, value: await this.deps.dispatch(caller, route) };
      // The hop keeps the CALLER's authority: the callee runs for whoever asked,
      // never as its author — and the viewer follows the chain, so a binding the
      // callee calls is granted exactly as the root's own are.
      case 'app': return this.call(caller, route.id, route.method, [...route.args], route.chain, viewer);
    }
  }

  /**
   * An app call is one Cap'n Web HTTP-batch RPC against the slate's forwarder:
   * the method resolves on the instance's prototype chain and runs under the
   * invocation this request carries. The id is issued before the session opens
   * and retired when it settles, so the callee names a live call and nothing
   * else.
   */
  async call(caller: SlateCaller, id: string, method: string, args: JsonValue[], chain: readonly string[] = [], viewer?: SlateViewer): Promise<SlateCallResult> {
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
        // Shut the session down once the call settles: disposing the main stub
        // aborts the read-loop, and doing it here — not at transport end — is
        // the difference between a rejection capnweb observes and one workerd
        // reports as unhandled.
        // SAFETY: `RpcStub` always carries a `Symbol.dispose` hook for its
        // session (capnweb's RpcStub constructor sets it) — the interface
        // merely doesn't declare it.
        (stub as { [Symbol.dispose](): void })[Symbol.dispose]();
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

      // The reserved stubs every slate carries: its own durable KV, answered by
      // `bindingCall`'s `__storage` arm over this object's `slate_state` table —
      // and `__host`, the process's channel back for `release` on socket close.
      bindings[SLATE_STORAGE_BINDING] = exports.SlateBinding({
        props: { workspace: this.deps.workspace, id, name: SLATE_STORAGE_BINDING, caller },
      });
      bindings[SLATE_HOST_BINDING] = exports.SlateBinding({
        props: { workspace: this.deps.workspace, id, name: SLATE_HOST_BINDING, caller },
      });

      // Reserve first, launch after: the root's BUILD process is the slate's
      // durable application, so its port and capability are Nimbus's
      // reservation for this slate — the same ones on every launch — and the
      // facet it boots into is the one pinned for this owner. Any other
      // caller's process is private: reached by RPC, no port, its own facet —
      // a share's process too, so a share never attaches to the owner's app.
      // A Plan root is another caller: its process runs without egress and
      // must never attach to the build application's live facet.
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
      const match = /^\/?home\/user\/slates\/([^/]+)(?:\/|$)/.exec(path);
      const id = match?.[1];

      if (id !== undefined) ids.add(id);
    }

    for (const id of ids) this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);

    return [...ids];
  }
}

