/**
 * A workspace's slates as one owner: the operations a caller may run and the checks each makes, who may publish, share
 * or revoke, what a removal ends and in which order, and the stores, processes and share viewers behind them. The
 * backend supplies the platform: where a slate's source comes from, how it compiles and launches, how a method is
 * invoked in its process, and the preview URL and share links it serves.
 */
import { WorkspaceId } from '@agent-core/core';
import { SlateId, SlateVersionId } from '@agent-core/core/slates';
import { CRED_KERNEL, CRED_SESSION_USER, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { Effect } from 'effect';
import * as v from 'valibot';
import { requireWorkModePermission } from '../execution/work-mode';
import { classifyErrorCode, KinuError, type Refusal } from '../obs/error';
import { refusing, settle } from '../obs/effect';
import type { SqlExec } from '../types/primitives';
import { projectJsonValue, type JsonValue } from '../utils/json';
import type { WorkspaceSession } from '../vfs/nimbus-workspace';
import { SLATES_ROOT } from '../vfs/workspace-path';
import { slateAuthority } from './authority';
import { WorkspaceBlueprints } from './blueprints';
import type { SlateBuilds } from './builds';
import { ROOT_SLATE_CALLER, type SlateCaller } from './caller';
import { slateCapabilityGraph, type SlateSurfaceCatalog } from './capability-graph';
import { WorkspaceSlateContentStore } from './content';
import type { DurableApps } from './durable-app';
import { EphemeralSlates } from './ephemeral';
import { forgetSlateFiles, slateDirectory, SlateFiles } from './files';
import { SlateProcesses, type RunnableSlateSource, type RunningSlate, type SlateProcessPorts } from './processes';
import type { SlateProcess } from './process';
import { parseSlateProject, slateTitle, type SlateProject } from './project';
import {
  requireSlateWorkMode, slateIdFor, SlateOperationSchema, type SlateAnswer, type SlateCallResult, type SlateOperation, type SlateProblem, type SlateSummary,
} from './rpc';
import { WorkspaceSlates } from './runtime';
import type { BlueprintBundle, BlueprintFork, SlateCapabilityGraph } from './sharing';
import { SqliteSlateStateStore } from './state';
import { SqliteSlateStore } from './store';
import { ephemeralSlateAddress } from './ui-blocks';
import { SlateUsageStore } from './usage';

/** The applications slates run as: a reservation each, the URL it is served at, and who holds each port. */
export interface SlateApps extends DurableApps {
  /** The URL an application is served at, or why this deployment cannot mint one. */
  url(port: number, capability: string): Promise<{ readonly url: string; readonly unavailable?: undefined } | { readonly url?: undefined; readonly unavailable: string }>;
  /** Each held port's owner, the slate whose application serves on it. */
  owners(): Promise<ReadonlyMap<number, string>>;
}

export interface HeldSlatePorts {
  readonly titles: ReadonlyMap<number, string>;
  /** The ports answers' pages hold. */
  readonly pages: ReadonlySet<number>;
}

/** A method called on a slate's class, as `caller`; a hop from one slate to another carries the chain. */
export interface SlateAppCall {
  readonly caller: SlateCaller;
  readonly id: string;
  readonly method: string;
  readonly args: JsonValue[];
  readonly chain?: readonly string[];
}

/** A slate's process, with the methods its class exports. */
export interface SlateClassProcess extends SlateProcess {
  readonly methods: readonly string[];
}

export interface SlateControllerPorts<Source extends RunnableSlateSource, Process extends SlateClassProcess>
  extends Pick<SlateProcessPorts<Source, Process>, 'resolve' | 'digest' | 'build' | 'launch' | 'ended'> {
  readonly workspace: string;
  readonly sql: SqlExec;
  /** The object's one build record: its owner reads it before any controller exists. */
  readonly builds: SlateBuilds;
  transaction<Result>(body: () => Result): Result;
  session(): Promise<Pick<WorkspaceSession, 'vfs'>>;
  readonly apps: SlateApps;
  /** The slate's page in its room, entered as the workspace's owner: what a preview shows. */
  frame(id: string): Promise<string>;
  /** Invokes a method in the slate's process. */
  call(request: SlateAppCall): Promise<SlateCallResult>;
  catalog(): Promise<SlateSurfaceCatalog>;
  forgetPicture?(slate: string): Promise<void>;
  /** The slate's room goes with it: its people, grants, state and sessions, so its pages answer nothing. */
  forgetRoom?(slate: string): Promise<void>;
  previewed?(slate: string): void;
}

/** `body`'s value, or its failure as the refusal `doing` names: a slate answer never fails. */
export function answer<Value>(doing: string, body: Effect.Effect<Value, KinuError>): Effect.Effect<SlateAnswer<Value>> {
  return Effect.catchCause(
    Effect.map(body, (value): SlateAnswer<Value> => ({ ok: true, value })),
    (failed) => Effect.map(refusing(doing, 'io')(failed), (refusal): SlateAnswer<Value> => ({ ok: false, ...refusal })),
  );
}

/** A JSON answer of `input.value`. */
function answered(input: { readonly value: unknown }): SlateCallResult {
  return { ok: true, value: projectJsonValue(input) };
}

export class SlateController<Source extends RunnableSlateSource, Process extends SlateClassProcess> {
  readonly processes: SlateProcesses<Source, Process>;
  readonly builds: SlateBuilds;
  readonly state: SqliteSlateStateStore;
  readonly usage: SlateUsageStore;
  private readonly store: SqliteSlateStore;
  private content: WorkspaceSlateContentStore | undefined;
  private readonly sourceRuntimes = new Map<string, WorkspaceSlates>();

  constructor(private readonly ports: SlateControllerPorts<Source, Process>) {
    this.store = new SqliteSlateStore(ports.sql, (body) => ports.transaction(body));
    this.state = new SqliteSlateStateStore(ports.sql);
    this.usage = new SlateUsageStore(ports.sql);
    this.builds = ports.builds;
    this.processes = new SlateProcesses({
      workspace: ports.workspace, builds: this.builds, pages: new EphemeralSlates(ports.sql), apps: ports.apps,
      resolve: (cred, id) => ports.resolve(cred, id),
      digest: (cred, id, source) => ports.digest(cred, id, source),
      build: (caller, id, source) => ports.build(caller, id, source),
      launch: (launch) => ports.launch(launch),
      ...(ports.ended !== undefined && { ended: ports.ended.bind(ports) }),
    });
  }

  /** A slate's package.json, as `cred` reads it. */
  async project(cred: VfsCred, id: string): Promise<SlateProject> {
    const session = await this.ports.session();
    const path = `${slateDirectory(new SlateId(id))}/package.json`;

    return parseSlateProject(JSON.parse(session.vfs.as(cred).readFileString(path)));
  }

  /** The slates' sources as `cred` reads and writes them: their trees, versions and commits. */
  async slates(cred: VfsCred): Promise<WorkspaceSlates> {
    const session = await this.ports.session();
    this.content ??= session.vfs.withTransaction(() => new WorkspaceSlateContentStore(session.vfs.as(CRED_KERNEL)));
    const key = slateAuthority(cred);
    const known = this.sourceRuntimes.get(key);

    if (known !== undefined) return known;
    const workspace = this.ports.workspace;

    const runtime = new WorkspaceSlates({
      workspaceId: new WorkspaceId(workspace), store: this.store,
      files: new SlateFiles(session.vfs.as(cred), this.content, this.ports.sql, (body) => session.vfs.withTransaction(body)),
      mutations: { mutate: (request, mutation) => settle(Effect.gen(function* () {
        if (request.workspaceId.value !== workspace) return yield* new KinuError('denied', 'Slate mutation belongs to another workspace');

        return session.vfs.withTransaction(mutation);
      })) },
    });

    this.sourceRuntimes.set(key, runtime);

    return runtime;
  }

  /** As the owner's root: a fork reads the slate's synchronized tree, never the caller's live one. */
  private blueprints(): Effect.Effect<WorkspaceBlueprints, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const slates = yield* Effect.promise(async () => this.slates(CRED_SESSION_USER));

      if (this.content === undefined) return yield* new KinuError('io', 'Slate content was not initialized');

      return new WorkspaceBlueprints({
        slates, content: this.content, usage: (slate) => this.usage.list(slate),
      });
    });
  }

  private blueprintAnswer<Value>(doing: string, body: (blueprints: WorkspaceBlueprints) => Promise<Value> | Value): Effect.Effect<SlateAnswer<Value>> {
    return answer(doing, Effect.flatMap(this.blueprints(), (blueprints) => Effect.promise(async () => body(blueprints))));
  }

  private async graph(slate: string): Promise<SlateCapabilityGraph> {
    return slateCapabilityGraph({ slate, workspace: this.ports.workspace, catalog: await this.ports.catalog(), usage: (id) => this.usage.list(id) });
  }

  /** Unparseable slates are omitted; they surface as `problem` rows on the graph. */
  projects(caller: SlateCaller): Promise<Record<string, SlateProject>> {
    return settle(Effect.gen({ self: this }, function* () {
      const vfs = (yield* Effect.promise(async () => this.ports.session())).vfs.as(caller.cred);
      const projects: Record<string, SlateProject> = {};

      if (!vfs.exists(SLATES_ROOT)) return projects;

      for (const entry of vfs.readdir(SLATES_ROOT)) {
        if (entry.type !== 'directory') continue;

        const project = yield* Effect.tryPromise({ try: async () => this.project(caller.cred, entry.name), catch: (cause) => cause }).pipe(
          Effect.catch((cause) => (classifyErrorCode({ cause }) === 'bad_input' ? Effect.succeed(null) : Effect.die(cause))),
        );

        if (project !== null) projects[entry.name] = project;
      }

      return projects;
    }));
  }

  /** Never starts its process. */
  admitBlueprint(bundle: BlueprintBundle): Promise<SlateAnswer<BlueprintFork>> {
    return settle(this.blueprintAnswer('admitting a blueprint', (blueprints) => blueprints.admit(this.ports.workspace, bundle)));
  }

  /** The version of `slate` a publish names: its tree now, retained. */
  currentSource(slate: string): Promise<SlateAnswer<string>> {
    return settle(this.blueprintAnswer(`reading slate ${slate}'s version`, (blueprints) => blueprints.currentSource(slate)));
  }

  /** A fork's bundle of the version of `slate` its room published. Who may fork is the room's to say. */
  forkBundle(slate: string, source: string): Promise<SlateAnswer<BlueprintBundle>> {
    return settle(this.blueprintAnswer(`forking slate ${slate}`, (blueprints) => blueprints.bundleAt(slate, source)));
  }

  /**
   * One operation a caller runs on the workspace's slates, checked against the caller's mode first. A slate's history
   * answers only for this workspace's slates.
   */
  operation(caller: SlateCaller, input: SlateOperation): Promise<SlateCallResult> {
    return settle(Effect.catchCause(Effect.gen({ self: this }, function* () {
      const parsed = v.safeParse(SlateOperationSchema, input);

      if (!parsed.success) return yield* new KinuError('bad_input', 'Slate operation does not match its declared fields', { cause: new v.ValiError(parsed.issues) });
      const operation = parsed.output;

      requireSlateWorkMode(operation, caller.workMode);

      return yield* this.dispatch(caller, operation);
    }), (failed) => Effect.map(refusing('slate operation', 'io')(failed), (refusal): SlateCallResult => ({ ok: false, ...refusal }))));
  }

  private dispatch(caller: SlateCaller, operation: SlateOperation): Effect.Effect<SlateCallResult, KinuError> {
    const running = <Value>(run: () => Promise<Value>) => Effect.promise(run);

    switch (operation.op) {
      case 'list': return Effect.map(running(async () => this.list(caller)), (value) => answered({ value }));
      case 'preview': return running(async () => this.preview(caller, operation.id));
      case 'methods': return Effect.map(running(async () => this.processes.booted(caller, operation.id)), ({ process }) => answered({ value: [...process.methods] }));
      case 'call': return running(async () => this.ports.call({ caller, id: operation.id, method: operation.method, args: operation.args ?? [] }));
      case 'remove': return running(async () => this.remove(caller, operation.id));
      case 'history': return Effect.map(this.history(operation.id, operation.after), (value) => answered({ value }));
      case 'commit': return running(async () => answered({ value: (await (await this.slates(caller.cred)).commit(new SlateId(operation.id))).toData() }));
      case 'fork': return running(async () => answered({ value: (await (await this.slates(caller.cred)).fork(new SlateVersionId(operation.version))).toData() }));
      case 'restore': return running(async () => answered({ value: (await (await this.slates(caller.cred)).restore(new SlateId(operation.id), new SlateVersionId(operation.version))).toData() }));
      case 'graph': return running(async () => answered({ value: await this.graph(operation.id) }));
      case 'save': return running(async () => this.savePage(caller, operation.page));
    }
  }

  private history(slateId: string, after: string | undefined): Effect.Effect<JsonValue, KinuError> {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.promise(async () => this.ports.session());
      const id = new SlateId(slateId);
      const slate = this.store.getSlate(id);

      if (slate === undefined) return yield* new KinuError('missing', 'No durable slate record; commit source or open a preview first');

      if (slate.workspaceId.value !== this.ports.workspace) return yield* new KinuError('denied', 'Slate belongs to another workspace');
      const page = this.store.versionPage(id, after);

      return projectJsonValue({ value: { slate: slate.toData(), versions: page.versions.map((version) => version.toData()), next: page.next } });
    });
  }

  list(caller: SlateCaller): Promise<{ slates: SlateSummary[]; problems: SlateProblem[] }> {
    return settle(Effect.gen({ self: this }, function* () {
      const vfs = (yield* Effect.promise(async () => this.ports.session())).vfs.as(caller.cred);
      const slates: SlateSummary[] = [];
      const problems: SlateProblem[] = [];

      if (!vfs.exists(SLATES_ROOT)) return { slates, problems };
      // The application's own reservation, held across evictions and activations, not this activation's memory of it.
      const held = new Map([...yield* Effect.promise(async () => this.ports.apps.owners())].map(([port, owner]) => [owner, port]));

      for (const entry of vfs.readdir(SLATES_ROOT)) {
        if (entry.type !== 'directory') continue;

        const read = yield* Effect.exit(Effect.tryPromise({ try: async () => this.project(caller.cred, entry.name), catch: (cause) => cause }));

        if (read._tag === 'Success') {
          const port = held.get(entry.name);
          const summary: SlateSummary = { id: entry.name, title: slateTitle(read.value, entry.name), ...(port !== undefined && { port }) };

          slates.push(summary);
        } else {
          problems.push({ id: entry.name, ...yield* refusing('slate ' + entry.name, 'io')(read.cause) });
        }
      }

      return { slates, problems };
    }));
  }

  /** An answer's page kept as a slate of the workspace's own: its HTML as the slate's page, under the page's title. */
  savePage(caller: SlateCaller, page: string): Promise<SlateCallResult> {
    return settle(Effect.gen({ self: this }, function* () {
      // The owner's choice to keep it, as publishing is; an agent writes a slate's files itself.
      if (caller.path.length > 0) return yield* new KinuError('denied', 'Only the workspace root keeps an answer\'s page as a slate');

      if (ephemeralSlateAddress(page) === null) return yield* new KinuError('bad_input', `${page} names no answer's page`);
      const source = yield* Effect.promise(async () => this.ports.resolve(caller.cred, page));

      if (source.kind !== 'message') return yield* new KinuError('bad_input', `${page} names no answer's page`);
      const files = (yield* Effect.promise(async () => this.ports.session())).vfs.as(caller.cred);
      const title = slateTitle(source.project, page);
      const id = slateIdFor(title, (taken) => files.exists(`${SLATES_ROOT}/${taken}`));

      files.mkdir(`${SLATES_ROOT}/${id}`, { recursive: true });
      files.writeFile(`${SLATES_ROOT}/${id}/package.json`, `${JSON.stringify({ browser: 'index.html', slate: { title } }, null, 2)}\n`);
      files.writeFile(`${SLATES_ROOT}/${id}/index.html`, source.html);

      return answered({ value: { id, title } });
    }));
  }

  /**
   * The ports slates' applications hold: a directory slate's called by its title, and an answer's page apart. A page is
   * its answer's, drawn in the chat, so the workspace's previews leave it out until it is saved as a slate.
   */
  heldPorts(): Promise<HeldSlatePorts> {
    return settle(Effect.gen({ self: this }, function* () {
      const titles = new Map<number, string>();
      const pages = new Set<number>();

      for (const [port, owner] of yield* Effect.promise(async () => this.ports.apps.owners())) {
        if (ephemeralSlateAddress(owner) !== null) {
          pages.add(port);
          continue;
        }

        const source = yield* Effect.tryPromise({
          try: async () => this.ports.resolve(CRED_SESSION_USER, owner),
          catch: (cause) => cause,
        }).pipe(
          // A slate removed, or left unreadable, since its port was held keeps the port's own name.
          Effect.catch((cause) => {
            const code = classifyErrorCode({ cause });

            return code === 'missing' || code === 'bad_input' ? Effect.succeed(null) : Effect.die(cause);
          }),
        );

        if (source !== null) titles.set(port, slateTitle(source.project, owner));
      }

      return { titles, pages };
    }));
  }

  /**
   * Whether the slate builds, by the build its preview serves: nothing is shown, so the turn's answer still draws the
   * slate it changed. `{ broken }` is the compiler's words when its latest source does not build.
   */
  build(caller: SlateCaller, id: string): Promise<SlateCallResult> {
    return settle(this.answerServed(caller, id, 'build', ({ broken }) => Effect.succeed<JsonValue>(broken === null ? {} : { broken })));
  }

  /** Every slate runs in its room (docs/SLATE-SHARING-SECURITY.md §2.7): a preview is its page there, as the owner. */
  preview(caller: SlateCaller, id: string): Promise<SlateCallResult> {
    return settle(this.answerServed(caller, id, 'preview', ({ source, broken }) => Effect.gen({ self: this }, function* () {
      const url = yield* Effect.promise(async () => this.ports.frame(id));

      if (url === '') return yield* new KinuError('unavailable', 'This deployment cannot mint a slate page address');

      // An answer's own block is shown where the answer is, never again as a card of the turn's slates.
      if (source.kind === 'files') this.ports.previewed?.(id);
      // Every page the runner answers reports its height, its class's own `fetch` pages too.
      const shown = { url, sized: true, title: slateTitle(source.project, id) };

      // Its latest source does not build: the last that did is what this URL serves, and the compiler's words say why.
      return broken === null ? shown : { ...shown, broken };
    })));
  }

  /** The slate's served build, booted for the workspace root, as `read` reads it; a slate that cannot be served is
   *  refused, and a caller who may not start one is refused first. */
  private answerServed(
    caller: SlateCaller, id: string, doing: 'build' | 'preview',
    read: (served: RunningSlate<Source, Process>) => Effect.Effect<JsonValue, KinuError>,
  ): Effect.Effect<SlateCallResult> {
    return answer('slate ' + id + ' ' + doing, Effect.gen({ self: this }, function* () {
      requireWorkModePermission(caller.workMode, false, 'Starting or exposing a slate preview');

      return yield* read(yield* Effect.promise(async () => this.processes.served(ROOT_SLATE_CALLER, id)));
    }));
  }

  /** Answers the refusal instead of failing, so the route can tell `missing` from `bad_input`. */
  ensureDurable(owner: string): Promise<Refusal | null> {
    return settle(Effect.catchCause(
      Effect.as(Effect.promise(async () => this.processes.served(ROOT_SLATE_CALLER, owner)), null),
      refusing('slate ' + owner + ' durable app', 'io'),
    ));
  }

  /**
   * Ends a slate, in order: its processes, then its durable application, then, in one transaction, its authored tree,
   * file manifest, storage, usage and builds, then its picture. Committed versions stay.
   */
  remove(caller: SlateCaller, id: string): Promise<SlateCallResult> {
    return settle(answer('slate ' + id + ' remove', Effect.gen({ self: this }, function* () {
      const session = yield* Effect.promise(async () => this.ports.session());
      const root = slateDirectory(new SlateId(id));

      yield* Effect.promise(async () => this.processes.stopWhere((running) => running.id === id));
      // A slate built before rooms held an application of the workspace's; one built since holds none.
      const held = [...(yield* Effect.promise(async () => this.ports.apps.owners())).values()].includes(id);
      const removed = held ? yield* Effect.promise(async () => this.ports.apps.remove(id)) : { removed: false, port: null };
      const vfs = session.vfs.as(caller.cred);

      session.vfs.withTransaction(() => {
        if (vfs.exists(root)) vfs.removeRecursive(root);
        forgetSlateFiles(this.ports.sql, new SlateId(id));
        this.state.forget(id);
        this.usage.forget(id);
        this.builds.forget(id);
      });
      yield* Effect.promise(async () => this.ports.forgetPicture?.(id));
      yield* Effect.promise(async () => this.ports.forgetRoom?.(id));

      return { id, removed: removed.removed, port: removed.port };
    })));
  }

  /** The slates `paths` changed, each to be built again before it next serves. */
  filesChanged(paths: readonly string[]): string[] {
    return this.processes.filesChanged(paths);
  }
}
