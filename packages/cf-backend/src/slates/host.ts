import { exports } from 'cloudflare:workers';
import { WorkspaceId } from '@agent-core/core';
import { SlateId, SlateVersionId } from '@agent-core/core/slates';
import * as v from 'valibot';
import { CRED_SESSION_USER, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import {
  SlateFiles, SlateShareStore, SqliteSlateContentStore, SqliteSlateStateStore, SqliteSlateStore, WorkspaceBlueprints, WorkspaceSlates, slateDirectory,
  type BlueprintReading, type DurableAppIdentity, type DurableApps, type ShareUser,
} from '@kinu.run/core/slates';
import {
  parseSlateProject, routeSlateStorageCall, SLATE_STORAGE_BINDING,
  SlateBindingRequestSchema, SlateOperationSchema, requireSlateWorkMode, requireWorkModePermission, routeSlateBindingCall, resolveSlateChain, JsonValueSchema, projectJsonValue, isSlateMethodName, answeredRefusal,
  type BlueprintBundle, type BlueprintFork, type JsonValue, type SlateAnswer, type SlateProject, type SlateShareRecord,
  type SlateBindingRoute, type SlateCallResult, type SlateInvocation, type SlateSummary, type SlateProblem, type WorkspacePreviewUrl,
} from '@kinu.run/core';
import { ERROR_CODES, KinuError, refusalOf, toKinuError, type Refusal } from '@kinu.run/core/obs';
import { ResidentSlateProcesses, type ResidentSlateDeps, type ResidentSlateProcess } from './resident';
import { slateBatchStub } from './rpc-transport';
import { ROOT_SLATE_CALLER, slateCallerKey, slateCredentialKey, type SlateBinding, type SlateBindingProps, type SlateCaller } from './bindings';
import { codemodeEgress } from '../codemode-egress';

/** A binding route the calling actor answers with its own capability set. */
export type SlateCapabilityRoute = Exclude<SlateBindingRoute, { kind: 'app' }>;

/** The durable-application seam a slate host reaches Nimbus through, plus the URL this deployment fronts a reservation at. */
export interface SlateApps extends DurableApps {
  url(port: number, capability: string): Promise<WorkspacePreviewUrl>;
}

export interface SlateHostDeps extends Omit<ResidentSlateDeps, 'content'> {
  /** Run a capability route as the caller: its own providers, its own role reach, its own read models, its own gates. */
  dispatch(caller: SlateCaller, route: SlateCapabilityRoute): Promise<JsonValue>;
  readonly apps: SlateApps;
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
  private readonly content: SqliteSlateContentStore;
  private readonly resident: ResidentSlateProcesses;
  private readonly store: SqliteSlateStore;
  private readonly state: SqliteSlateStateStore;
  private readonly sourceRuntimes = new Map<string, WorkspaceSlates>();
  private readonly running = new Map<string, RunningSlate>();
  private readonly starting = new Map<string, Promise<RunningSlate>>();
  private readonly revisions = new Map<string, number>();

  constructor(private readonly deps: SlateHostDeps) {
    this.content = new SqliteSlateContentStore(deps.ctx.storage.sql, (body) => deps.ctx.storage.transactionSync(body));
    this.resident = new ResidentSlateProcesses({ ...deps, content: this.content });
    this.store = new SqliteSlateStore(deps.ctx.storage.sql, (body) => deps.ctx.storage.transactionSync(body));
    this.state = new SqliteSlateStateStore(deps.ctx.storage.sql);
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
    return new WorkspaceBlueprints({
      slates: await this.sources(CRED_SESSION_USER), content: this.content,
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

  private async sources(cred: VfsCred): Promise<WorkspaceSlates> {
    const session = await this.deps.session();
    const key = slateCredentialKey(cred);
    let runtime = this.sourceRuntimes.get(key);

    if (runtime === undefined) {
      runtime = new WorkspaceSlates({
        workspaceId: new WorkspaceId(this.deps.workspace), store: this.store,
        files: new SlateFiles(session.vfs.as(cred), this.content),
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
        // slates but never exports one on the owner's behalf.
        case 'inspect':
        case 'publish':
        case 'unshare':
        case 'shares': {
          if (caller.path.length > 0) throw new KinuError('denied', 'Only the workspace root publishes or revokes blueprints');
          const blueprints = await this.blueprints();

          switch (operation.op) {
            case 'inspect': return { ok: true, value: projectJsonValue({ value: blueprints.inspect(operation.id, operation.version, operation.include) }) };
            case 'publish': return { ok: true, value: projectJsonValue({ value: await blueprints.publish(operation.id, operation.version, operation.include) }) };
            case 'unshare': return { ok: true, value: projectJsonValue({ value: blueprints.unshare(operation.share) }) };
            case 'shares': return { ok: true, value: projectJsonValue({ value: blueprints.list() }) };
          }
        }
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

  /**
   * The app invocations this host is running right now, by the id it issued.
   *
   * A guest never sends a chain: it sends the id of the invocation it is
   * serving, and this map is what turns that into a lineage. An entry lives
   * exactly as long as the call it names, so a slate that keeps an older
   * request's bindings and replays them holds an id that has been retired.
   */
  private readonly invocations = new Map<string, SlateInvocation>();

  /**
   * An invocation for a request this host did not originate — a browser hitting
   * the preview. The lineage is the root, but it is a NAMED root: without one,
   * a slate could keep a preview request's bindings and present them from
   * inside a hop to get an empty chain, which is the same replay the hop path
   * refuses. Released when the routed request settles.
   *
   * `null` when no running slate serves that port; there is then nothing whose
   * bindings could be kept.
   */
  previewInvocation(port: number): { readonly value: string; release: () => void } | null {
    for (const running of this.running.values()) {
      if (running.app?.port !== port) continue;
      const value = crypto.randomUUID();
      this.invocations.set(value, { id: running.id, chain: [] });

      return { value, release: () => { this.invocations.delete(value); } };
    }

    return null;
  }

  /** Re-read the slate field on every call: a held stub proves its name, not today's reach. */
  async bindingCall(caller: SlateCaller, id: string, name: string, request: JsonValue): Promise<SlateCallResult> {
    try {
      const parsed = v.safeParse(SlateBindingRequestSchema, request);

      if (!parsed.success) throw new KinuError('bad_input', 'A binding call is { member, args: JSON[], invocation: string | null }', { cause: new v.ValiError(parsed.issues) });
      const chain = resolveSlateChain({ invocations: this.invocations, id, invocation: parsed.output.invocation });

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

      const project = await this.project(caller.cred, id);

      return await this.run(caller, routeSlateBindingCall({ id, project, name, request: parsed.output, chain }));
    } catch (cause) {
      return { ok: false, ...refusalOf(toKinuError({ doing: `slate ${id} binding ${name}`, cause, otherwise: 'io' })) };
    }
  }

  private async run(caller: SlateCaller, route: SlateBindingRoute): Promise<SlateCallResult> {
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
      // The hop keeps the CALLER's authority: the callee runs for whoever asked, never as its author.
      case 'app': return this.call(caller, route.id, route.method, [...route.args], route.chain);
    }
  }

  /**
   * An app call is one Cap'n Web HTTP-batch RPC against the slate's forwarder:
   * the method resolves on the instance's prototype chain and runs under the
   * invocation this request carries. The id is issued before the session opens
   * and retired when it settles, so the callee names a live call and nothing
   * else.
   */
  async call(caller: SlateCaller, id: string, method: string, args: JsonValue[], chain: readonly string[] = []): Promise<SlateCallResult> {
    const invocation = crypto.randomUUID();
    this.invocations.set(invocation, { id, chain });

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
      }

      const bindings: Record<string, Fetcher<SlateBinding>> = {};

      for (const name of Object.keys(project.slate.bindings)) {
        const props: SlateBindingProps = { workspace: this.deps.workspace, id, name, caller };
        bindings[name] = exports.SlateBinding({ props });
      }

      // The reserved stub every slate carries: its own durable KV, answered by
      // `bindingCall`'s `__storage` arm over this object's `slate_state` table.
      bindings[SLATE_STORAGE_BINDING] = exports.SlateBinding({
        props: { workspace: this.deps.workspace, id, name: SLATE_STORAGE_BINDING, caller },
      });

      // Reserve first, launch after: the root's BUILD process is the slate's
      // durable application, so its port and capability are Nimbus's
      // reservation for this slate — the same ones on every launch — and the
      // facet it boots into is the one pinned for this owner. Any other
      // caller's process is private: reached by RPC, no port, its own facet.
      // A Plan root is another caller: its process runs without egress and
      // must never attach to the build application's live facet.
      const app = caller.path.length === 0 && caller.workMode === 'build'
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

