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
import { refusing, settle, settleSync } from '../obs/effect';
import { sha256Hex } from '../safety/argument-digest';
import type { MissionGovernor } from '../mission-budget';
import type { SqlExec } from '../types/primitives';
import { projectJsonValue, type JsonValue } from '../utils/json';
import type { WorkspaceSession } from '../vfs/nimbus-workspace';
import { SLATES_ROOT } from '../vfs/workspace-path';
import { slateAuthority } from './authority';
import { WorkspaceBlueprints, type BlueprintReading } from './blueprints';
import type { SlateBuilds } from './builds';
import { ROOT_SLATE_CALLER, type SlateCaller } from './caller';
import { slateCapabilityGraph, visitorNeeds, type SlateSurfaceCatalog } from './capability-graph';
import type { RoomService } from './room-api';
import { WorkspaceSlateContentStore } from './content';
import type { DurableApps } from './durable-app';
import { EphemeralSlates } from './ephemeral';
import { forgetSlateFiles, slateDirectory, SlateFiles } from './files';
import { SlateLiveShareStore } from './live-shares';
import { setShareMode, shareLiveSlate } from './live-sharing';
import { SlateProcesses, type RunnableSlateSource, type SlateProcessPorts } from './processes';
import type { SlateProcess } from './process';
import { parseSlateProject, slateTitle, type SlateProject } from './project';
import {
  requireSlateWorkMode, slateIdFor, SlateFilePath, SlateOperationSchema,
  type SharedSlateFiles, type SlateAnswer, type SlateCallResult, type SlateFileChange, type SlateOperation, type SlateProblem, type SlateSummary,
} from './rpc';
import { WorkspaceSlates } from './runtime';
import { SlateShareViewers } from './share-viewers';
import { SharedServers, type OwnerEffects } from './shared-server';
import { slateRevision, type ToolContract } from './share-policy';
import { confinedTo } from './scoped-reader';
import { rollbackSlateBatch, writeSlateBatch, type SlateFileBatch } from './slate-writer';
import type {
  BlueprintBundle, BlueprintFork, LiveShareListingBody, LiveShareModeBody, LiveShareRecord, OwnedLiveShare, SlateCapabilityGraph, SharePreapproval, SlatePreapprovals, SlatePreapprovalWithdraw,
  SlateReach, SlateShareCard, SlateShareRecord,
} from './sharing';
import { SlateShareStore, type ShareUser } from './shares';
import { SqliteSlateStateStore } from './state';
import { SqliteSlateStore } from './store';
import { ephemeralSlateAddress } from './ui-blocks';
import { SlateUsageStore } from './usage';
import type { SlateViewer } from './surface';

type SharingOp = 'inspect' | 'publish' | 'unshare' | 'shares' | 'share' | 'liveShares' | 'viewerRequests';

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

/** A method called on a slate's class, as `caller`; a hop from one slate to another carries the chain and the viewer. */
export interface SlateAppCall {
  readonly caller: SlateCaller;
  readonly id: string;
  readonly method: string;
  readonly args: JsonValue[];
  readonly chain?: readonly string[];
  readonly viewer?: SlateViewer;
  /** The caller's word on the call, read again where it is sent with nothing awaited between: it throws to refuse. */
  readonly admit?: () => void;
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
  /** Invokes a method in the slate's process. */
  call(request: SlateAppCall): Promise<SlateCallResult>;
  catalog(): Promise<SlateSurfaceCatalog>;
  /** The app's page a share is entered through, its one link (LiveSharePage frames its host and hosts its parts), or
   *  null where this deployment names no app origin. */
  shareEntry(share: string): string | null;
  /** Whether one more viewer request under `key` fits `perMinute`; absent means no per-viewer rate bound. */
  admitted?(key: string, perMinute: number): Promise<boolean>;
  /** Debits the per-share per-day spend label; absent means no spend bound. */
  budget?(): MissionGovernor;
  ownerUserId?(): string | null;
  forgetPicture?(slate: string): Promise<void>;
  sharesChanged?(): Promise<'current' | 'pending'>;
  /** A live share of `slate` started or stopped: its server's authority changed, so its running app ends. */
  shareChanged?(slate: string): Promise<void>;
  /** How the workspace's owner is named to people a share refuses: absent, "Its owner". */
  ownerTitle?(): Promise<string>;
  /** Where `owner` shares' effects wait for the owner, and how a share's open ones retire with it; `only`, those of one
   *  standing approval's shape, as its owner takes it back. */
  readonly ownerEffects?: OwnerEffects & { retire(slate: string, only?: Omit<SharePreapproval, 'revision'>): void };
  /** What the owner's catalog knows of a connection's tool: what a shared server's approvals name its root by. */
  toolContract?(namespace: string, member: string): Promise<ToolContract | null>;
  /** The Gallery's copy of a live share's listing is behind it, where its owner waits on the change: told now. The host
   *  logs its own failure, which the next start's {@link SlateController.relist} mends. */
  listingChanged?(share: LiveShareRecord): Promise<void>;
  /** The Gallery told again of these listed shares, in the background: its index refills from them. */
  relisted?(shares: readonly LiveShareRecord[]): void;
  previewed?(slate: string): void;
  /** This workspace's owner reading or changing a slate another workspace shared with them to edit; absent off the cloud. */
  shared?(caller: SlateCaller, operation: Extract<SlateOperation, { op: 'sharedFiles' | 'sharedEdit' }>): Promise<SlateCallResult>;
}

/** A slate's package.json as a copy of it rewrites its title, every other field kept as it was. */
const CopiedManifestSchema = v.looseObject({ slate: v.optional(v.looseObject({ title: v.optional(v.string()) })) });

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
  readonly viewers: SlateShareViewers;
  /** Each shared slate's server, as the one principal it is (shared-server.ts). */
  readonly servers: SharedServers;
  readonly builds: SlateBuilds;
  readonly live: SlateLiveShareStore;
  readonly state: SqliteSlateStateStore;
  readonly usage: SlateUsageStore;
  private readonly store: SqliteSlateStore;
  private content: WorkspaceSlateContentStore | undefined;
  private readonly sourceRuntimes = new Map<string, WorkspaceSlates>();
  /** A published blueprint never changes. */
  private readonly blueprintHeadings = new Map<string, { title: string; description: string }>();

  constructor(private readonly ports: SlateControllerPorts<Source, Process>) {
    this.store = new SqliteSlateStore(ports.sql, (body) => ports.transaction(body));
    this.state = new SqliteSlateStateStore(ports.sql);
    this.live = new SlateLiveShareStore(ports.sql);
    this.usage = new SlateUsageStore(ports.sql);
    this.builds = ports.builds;
    // A root build of new code is a new revision: the owner's own edits carry their `owner` shares' approval with them.
    this.builds.whenBuilt((slate, authority, key) => {
      if (authority !== slateAuthority(ROOT_SLATE_CALLER.cred)) return;
      this.reapproveOnBuild(slate, key);
      // A new revision may name it anew: its listing's card is read again.
      this.relist(slate);
    });
    this.viewers = new SlateShareViewers({
      live: this.live, shareEntry: (share) => ports.shareEntry(share),
      ...(ports.admitted !== undefined && { admitted: ports.admitted.bind(ports) }),
      ...(ports.budget !== undefined && { budget: ports.budget.bind(ports) }),
      ...(ports.ownerUserId !== undefined && { ownerUserId: ports.ownerUserId.bind(ports) }),
      ...(ports.ownerEffects !== undefined && { ownerEffects: ports.ownerEffects }),
    });
    this.servers = new SharedServers({
      authoritiesOf: (slate) => this.live.authoritiesOf(slate),
      revision: (slate) => slateRevision(this.builds, slate),
      generation: (slate) => this.live.generation(slate),
      ...(ports.ownerEffects !== undefined && { ownerEffects: ports.ownerEffects }),
      ...(ports.toolContract !== undefined && { toolContract: ports.toolContract.bind(ports) }),
    }, async () => (await ports.ownerTitle?.()) ?? 'Its owner');
    this.processes = new SlateProcesses({
      workspace: ports.workspace, builds: this.builds, pages: new EphemeralSlates(ports.sql), apps: ports.apps,
      resolve: (cred, id) => ports.resolve(cred, id),
      digest: (cred, id, source) => ports.digest(cred, id, source),
      build: (caller, id, source) => ports.build(caller, id, source),
      launch: (launch) => ports.launch(launch),
      ...(ports.ended !== undefined && { ended: ports.ended.bind(ports) }),
    });
    // The Gallery's index is a copy of the listed shares, which may have lost them (a repair drops it): each start of the
    // workspace's slates tells it again.
    this.relist();
  }

  /** A slate's package.json, as `cred` reads it. */
  async project(cred: VfsCred, id: string): Promise<SlateProject> {
    const session = await this.ports.session();
    const root = slateDirectory(new SlateId(id));
    const path = `${root}/package.json`;

    if (this.live.isShared(id)) {
      const reader = confinedTo(session.vfs.as(cred), [root], []);

      return settle(Effect.gen(function* () {
        if (!(yield* Effect.promise(async () => reader.exists(path)))) return yield* new KinuError('bad_input', `package.json is not a file inside ${root}`);

        return parseSlateProject(JSON.parse(yield* Effect.promise(async () => reader.readFileString(path))));
      }));
    }

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

  /** As the owner's root: publishing reads committed versions, never the caller's live tree. */
  private blueprints(): Effect.Effect<WorkspaceBlueprints, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const slates = yield* Effect.promise(async () => this.slates(CRED_SESSION_USER));

      if (this.content === undefined) return yield* new KinuError('io', 'Slate content was not initialized');

      return new WorkspaceBlueprints({
        slates, content: this.content, shares: new SlateShareStore(this.ports.sql), usage: (slate) => this.usage.list(slate),
      });
    });
  }

  private blueprintAnswer<Value>(doing: string, body: (blueprints: WorkspaceBlueprints) => Promise<Value> | Value): Effect.Effect<SlateAnswer<Value>> {
    return answer(doing, Effect.flatMap(this.blueprints(), (blueprints) => Effect.promise(async () => body(blueprints))));
  }

  private async graph(slate: string): Promise<SlateCapabilityGraph> {
    return slateCapabilityGraph({ slate, workspace: this.ports.workspace, catalog: await this.ports.catalog(), usage: (id) => this.usage.list(id) });
  }

  /** Uses `get`, not `live`: a revoked row still reads; refusing it is the caller's job. A slate unreadable now is
   *  titled by its id, unless reading it was denied. */
  readLiveShare(share: string): Promise<{ share: LiveShareRecord; title: string; description: string } | null> {
    return settle(Effect.gen({ self: this }, function* () {
      const record = this.live.get(share);

      if (record === undefined) return null;

      const project = yield* Effect.tryPromise({
        try: async () => this.project(CRED_SESSION_USER, record.slate),
        catch: (cause) => cause,
      }).pipe(Effect.catch((cause) => (cause instanceof KinuError && cause.code === 'denied' ? Effect.fail(cause) : Effect.succeed(undefined))));

      return { share: record, title: project === undefined ? record.slate : slateTitle(project, record.slate), description: '' };
    }));
  }

  /** `readLiveShare` through the S6 gate: missing is 'missing', revoked is 'denied'. */
  readLiveShareRecord(share: string): Promise<SlateAnswer<{ record: LiveShareRecord; title: string; description: string }>> {
    return settle(answer(`read live share ${share}`, Effect.gen({ self: this }, function* () {
      const record = this.live.live(share);
      const read = yield* Effect.promise(async () => this.readLiveShare(share));

      return { record, title: read?.title ?? record.slate, description: read?.description ?? '' };
    })));
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

  /** Re-reads the row now; refused when revoked. */
  readBlueprint(share: string): Promise<SlateAnswer<BlueprintReading>> {
    return settle(this.blueprintAnswer('reading blueprint ' + share, (blueprints) => blueprints.read(share)));
  }

  blueprintBundle(share: string): Promise<SlateAnswer<BlueprintBundle>> {
    return settle(this.blueprintAnswer('exporting blueprint ' + share, (blueprints) => blueprints.bundle(share)));
  }

  /** The projection each user reads is written by the caller. */
  shareBlueprintWith(share: string, users: readonly ShareUser[]): Promise<SlateAnswer<SlateShareRecord>> {
    return settle(Effect.flatMap(this.blueprintAnswer('sharing blueprint ' + share, (blueprints) => blueprints.shareWith(share, users)), (shared) => Effect.promise(async () => this.changedShares(shared))));
  }

  /** Never starts its process. */
  admitBlueprint(bundle: BlueprintBundle): Promise<SlateAnswer<BlueprintFork>> {
    return settle(this.blueprintAnswer('admitting a blueprint', (blueprints) => blueprints.admit(this.ports.workspace, bundle)));
  }

  shareLiveWith(share: string, users: readonly ShareUser[]): Promise<SlateAnswer<OwnedLiveShare>> {
    return settle(Effect.flatMap(this.blueprintAnswer('sharing slate ' + share, () => this.owned(this.live.addUsers(share, users))), (shared) => Effect.promise(async () => this.changedShares(shared))));
  }

  private async changedShares<Answer extends { readonly ok: boolean }>(changed: Answer): Promise<Answer> {
    return changed.ok && await this.ports.sharesChanged?.() === 'pending' ? { ...changed, listing: 'pending' } : changed;
  }

  /** A live share goes by its slate's title. */
  shareCards(titles: ReadonlyMap<string, string>): Promise<SlateShareCard[]> {
    return settle(Effect.map(this.blueprints(), (blueprints) => {
      const cards: SlateShareCard[] = [];

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
    }));
  }

  /** A live share's tree, for a user forking it: its row read live (a revoked share is refused), a `users` share only
   *  for a user it admits, `public` for anyone signed in, and none whose grant forbids forking. */
  liveShareBundle(share: string, userId: string): Promise<SlateAnswer<BlueprintBundle>> {
    return settle(answer(`exporting live share ${share}`, Effect.gen({ self: this }, function* () {
      const record = this.live.live(share);

      if (record.visibility === 'users' && !this.viewers.admits(record.id, userId)) return yield* new KinuError('missing', 'No such share');

      if (record.grant.fork === false) return yield* new KinuError('denied', 'This share does not allow forking');
      const blueprints = yield* this.blueprints();

      return yield* Effect.promise(async () => blueprints.liveBundle(record.slate));
    })));
  }

  shareLive(share: string): Promise<SlateAnswer<{ share: LiveShareRecord; url: string | null }>> {
    return settle(answer('opening share ' + share, Effect.gen({ self: this }, function* () {
      const record = this.live.get(share);

      if (record === undefined) return yield* new KinuError('missing', 'No such share');

      return { share: record, url: this.ports.shareEntry(record.id) };
    })));
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
      case 'inspect':
      case 'publish':
      case 'unshare':
      case 'shares':
      case 'share':
      case 'liveShares':
      case 'viewerRequests': return this.sharing(caller, operation);
      case 'graph': return running(async () => answered({ value: { ...await this.graph(operation.id), revision: slateRevision(this.builds, operation.id) } satisfies SlateReach }));
      case 'save': return running(async () => this.savePage(caller, operation.page));
      case 'sharedFiles': case 'sharedEdit': {
        if (this.ports.shared === undefined) return Effect.fail(new KinuError('unsupported', 'Editing a slate someone shared with you needs the cloud'));

        return running(async () => this.ports.shared?.(caller, operation) ?? answered({ value: null }));
      }
    }
  }

  /** The text files of `slate`'s tree, as an editor's agent reads them: its source, not its dependencies or history. */
  sharedFiles(slate: string): Promise<SlateAnswer<SharedSlateFiles>> {
    return settle(answer(`reading slate ${slate}'s files`, Effect.gen({ self: this }, function* () {
      const vfs = (yield* Effect.promise(async () => this.ports.session())).vfs.as(CRED_SESSION_USER);
      const root = `${SLATES_ROOT}/${slate}`;

      if (!vfs.exists(root)) return yield* new KinuError('missing', `No slate ${slate}`);

      if (vfs.lstat(root).type !== 'directory') return yield* new KinuError('bad_input', 'A shared slate must be a real directory, not a symlink');
      const files: SharedSlateFiles['files'] = [];
      const pending = [root];

      for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
        for (const entry of vfs.readdir(dir)) {
          const path = `${dir}/${entry.name}`;
          const relative = path.slice(root.length + 1);

          if (!v.is(SlateFilePath, relative)) continue;

          if (entry.type === 'directory') pending.push(path);

          if (entry.type !== 'file') continue;
          const bytes = vfs.readFile(path);

          if (!bytes.includes(0)) files.push({ path: relative, text: new TextDecoder().decode(bytes), sha256: sha256Hex(bytes) });
        }
      }

      return { files: files.sort((a, b) => a.path.localeCompare(b.path)) };
    })));
  }

  /** An editor's change to `slate`'s files, written where the workspace keeps them, with what each held before. */
  writeShared(slate: string, files: SlateFileChange, editor: string): Promise<SlateAnswer<SlateFileBatch>> {
    return settle(answer(`changing slate ${slate}'s files`, Effect.gen({ self: this }, function* () {
      const session = yield* Effect.promise(async () => this.ports.session());
      const root = `${SLATES_ROOT}/${slate}`;
      const batch = writeSlateBatch({ session, root, files, slate, editor, marks: this.live, revision: slateRevision(this.builds, slate) });

      for (const share of this.live.list().filter((row) => row.slate === slate && row.revokedAt === null && row.mode === 'owner')) this.ports.ownerEffects?.retire(share.slate);
      this.filesChanged(batch.paths.map((path) => `${root}/${path}`));

      return batch;
    })));
  }

  /** Failed builds may take back only the revision their editor wrote, never a later save. */
  rollbackShared(slate: string, batch: SlateFileBatch): Promise<SlateAnswer<{ readonly restored: readonly string[]; readonly conflicts: readonly string[] }>> {
    return settle(answer(`taking back slate ${slate}'s edit`, Effect.gen({ self: this }, function* () {
      const session = yield* Effect.promise(async () => this.ports.session());
      const root = `${SLATES_ROOT}/${slate}`;
      const rolled = rollbackSlateBatch({ session, root, slate, batch, marks: this.live });
      this.filesChanged(rolled.restored.map((path) => `${root}/${path}`));

      return rolled;
    })));
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

  /** Publishing and sharing are the owner's alone; a hosted actor never exports on the owner's behalf. */
  private sharing(caller: SlateCaller, operation: Extract<SlateOperation, { op: SharingOp }>): Effect.Effect<SlateCallResult, KinuError> {
    return Effect.gen({ self: this }, function* () {
      if (caller.path.length > 0) return yield* new KinuError('denied', 'Only the workspace root publishes, shares or revokes slates');
      const blueprints = yield* this.blueprints();

      if (operation.op === 'share' && operation.start === 'empty') return yield* this.shareCopy(caller, operation);

      return yield* Effect.promise(async (): Promise<SlateCallResult> => {
        switch (operation.op) {
          case 'inspect': return answered({ value: blueprints.inspect(operation.id, operation.version, operation.include) });
          case 'publish': return await this.changedShares(answered({ value: await blueprints.publish(operation.id, operation.version, operation.include) }));
          case 'unshare': return await this.changedShares(answered({ value: await this.unshare(operation.share, blueprints) }));
          case 'shares': return answered({ value: blueprints.list() });
          case 'share': return await this.shareSlateLive(operation, operation.id);

          case 'liveShares': return answered({ value: this.live.list().map((row) => this.owned(row)) });
          case 'viewerRequests': return answered({ value: this.live.requests(operation.share) });
        }
      });
    });
  }

  /** How many times `slate`'s sharing changed in this object's life (shared-server.ts `SlateLineage`). */
  generation(slate: string): number {
    return this.live.generation(slate);
  }

  /**
   * `slate`'s sharing changed (a share began, ended or changed mode): its running app ends. Its fence already advanced,
   * in the store's own write of the row (`SlateLiveShareStore.generation`), before anything here awaited.
   */
  private async sharingChanged(slate: string): Promise<void> {
    await this.ports.shareChanged?.(slate);
  }


  /** `slate` shared live as the op asks, in `own` mode. */
  private async shareSlateLive(operation: Extract<SlateOperation, { op: 'share' }>, slate: string): Promise<SlateCallResult> {
    const created = shareLiveSlate({
      shares: this.live, graph: await this.graph(slate), visibility: operation.visibility, approved: operation.approved,
      fork: operation.fork, url: (share) => this.ports.shareEntry(share),
    });

    await this.sharingChanged(slate);

    return await this.changedShares(answered({ value: { ...created, share: this.owned(created.share) } }));
  }

  /**
   * H7's "Start the shared copy empty": the slate as it is now, committed and forked here (code only, so its state starts
   * empty), its title saying it is a copy, and shared. A copy has run nothing, so it reaches nothing: no member is
   * approved on it. Its manifest is read before any copy is made, and a copy whose share then fails is removed again.
   */
  private shareCopy(caller: SlateCaller, operation: Extract<SlateOperation, { op: 'share' }>): Effect.Effect<SlateCallResult, KinuError> {
    return Effect.gen({ self: this }, function* () {
      if (operation.approved.length > 0) return yield* new KinuError('bad_input', 'A copy that starts empty has reached nothing yet, so nothing is approved on it');
      const vfs = (yield* Effect.promise(async () => this.ports.session())).vfs.as(caller.cred);
      const read = (dir: string) => v.parse(CopiedManifestSchema, JSON.parse(vfs.readFileString(`${dir}/package.json`)));
      const manifest = yield* Effect.try({ try: () => read(slateDirectory(new SlateId(operation.id))), catch: () => new KinuError('bad_input', `Slate ${operation.id} has no package.json a copy can carry`) });

      const fork = yield* Effect.promise(async () => {
        const slates = await this.slates(caller.cred);

        return slates.fork((await slates.commit(new SlateId(operation.id))).id);
      });

      const path = `${slateDirectory(fork.id)}/package.json`;
      const copy = fork.id.value;

      return yield* Effect.tryPromise({
        try: async () => {
          vfs.writeFile(path, JSON.stringify({ ...manifest, slate: { ...manifest.slate, title: `${manifest.slate?.title ?? operation.id} (shared copy)` } }, null, 2));
          this.filesChanged([path]);

          return await this.shareSlateLive(operation, copy);
        },
        catch: (cause) => new KinuError('io', `Sharing a copy of ${operation.id} failed, so the copy was removed`, { cause }),
      }).pipe(Effect.tapError(() => Effect.promise(async () => this.remove(caller, copy))));
    });
  }

  /** A blueprint's share ends; a live share is revoked and its viewers' processes stop. Invocations outlive the revoke,
   *  so an in-flight viewer call is refused as 'no longer shared'. */
  private async unshare(share: string, blueprints: WorkspaceBlueprints): Promise<JsonValue> {
    const held = this.live.get(share);

    if (held === undefined) return projectJsonValue({ value: blueprints.unshare(share) });

    return projectJsonValue({ value: await this.endLiveShare(held) });
  }

  /** A live share revoked: what its owner's access still owed it retires, it leaves the Gallery (a revoked share is
   *  listed nowhere), and its viewers' processes stop. */
  private async endLiveShare(held: LiveShareRecord): Promise<LiveShareRecord> {
    const revoked = this.live.revoke(held.id);

    this.ports.ownerEffects?.retire(revoked.slate);

    if (held.gallery !== null) await this.ports.listingChanged?.(revoked);

    await this.processes.stopWhere((running) => running.caller.share === revoked.id);
    await this.sharingChanged(revoked.slate);

    return revoked;
  }

  /**
   * Every live share of `slate` ended, or of every slate here: before a slate's source is removed, or its workspace is
   * deleted, so nothing removed is still shared or found in the Gallery. Whether any was.
   */
  async endLiveShares(slate?: string): Promise<boolean> {
    const live = this.live.list().filter((row) => row.revokedAt === null && (slate === undefined || row.slate === slate));

    for (const share of live) await this.endLiveShare(share);

    if (live.length > 0) await this.ports.sharesChanged?.();

    return live.length > 0;
  }

  /** An `owner` share whose slate was built anew since its reach was approved: its server acts with nothing. */
  private stale(share: LiveShareRecord): boolean {
    return share.mode === 'owner' && share.grantRevision !== slateRevision(this.builds, share.slate);
  }

  /** `share` as its owner reads it (`OwnedLiveShare`): the one place what holds of it now is added to its record. */
  private owned(share: LiveShareRecord): OwnedLiveShare {
    return { ...share, paused: this.viewers.paused(share), stale: this.stale(share), views: this.live.views(share.id) };
  }

  /**
   * The owner's word on a live share's mode, from their own share sheet only (never a slate op an agent can make):
   * `owner`, over the reach they read at `revision`, which must be the slate's revision still; or `own`. Either way the
   * share's effects still waiting on them are retired: what they would admit was asked under another authority. No Drive
   * card names a mode, so the Drive is not told.
   */
  setLiveShareMode(input: LiveShareModeBody): Promise<SlateAnswer<OwnedLiveShare>> {
    return settle(answer(`setting share ${input.share}'s mode`, Effect.gen({ self: this }, function* () {
      const held = this.live.get(input.share);

      if (held === undefined || held.revokedAt !== null) return yield* new KinuError('missing', 'No such share');

      if (input.mode === 'owner' && held.gallery !== null) {
        return yield* new KinuError('bad_input', 'Take it off the Gallery first: a share on your access is never listed there');
      }

      const graph = yield* Effect.promise(async () => this.graph(held.slate));
      const session = yield* Effect.promise(async () => this.ports.session());

      // The graph may await a build. Check the current revision and mark only after that await, in the update's turn.
      yield* Effect.sync(() => session.vfs.withTransaction(() => settleSync(Effect.gen({ self: this }, function* () {
        const revision = slateRevision(this.builds, held.slate);
        const mark = this.live.editMark(held.slate);

        if (input.mode === 'owner' && input.revision !== revision) {
          return yield* new KinuError('bad_input', 'This slate changed since you reviewed what it reaches; review it again');
        }

        if (input.mode === 'owner' && mark !== null) {
          // A different last-good revision can belong to an older in-flight build. The reviewed tree must itself be
          // the one the current root image compiled, not merely newer than revisionBefore. Capture joins this VFS/SQL
          // transaction directly, without an await or a nested files.transaction().
          const content = this.content ?? new WorkspaceSlateContentStore(session.vfs.as(CRED_KERNEL));
          const files = new SlateFiles(session.vfs.as(CRED_SESSION_USER), content, this.ports.sql, (body) => session.vfs.withTransaction(body));
          const id = new SlateId(held.slate);
          // Approval proves bytes, not a stat-based cache entry; rebuild this slate's manifest from fresh reads.
          forgetSlateFiles(this.ports.sql, id);
          const source = files.capture(id);
          const good = this.builds.good(held.slate, slateAuthority(ROOT_SLATE_CALLER.cred));

          if (good?.image.scope !== 'tree' || !revision?.startsWith(`${source.digest.value}:tree:`)) {
            return yield* new KinuError('bad_input', `${mark.editor}'s change is still building; approve once it has built`);
          }
        }

        setShareMode({ shares: this.live, share: held.id, graph, mode: input.mode, approved: input.mode === 'owner' ? input.approved : [], revision });

        if (input.mode === 'owner' && mark !== null) this.live.restoreEditMark(held.slate, null);
      }))));
      this.ports.ownerEffects?.retire(held.slate);
      yield* Effect.promise(async () => this.sharingChanged(held.slate));

      return this.owned(this.live.get(held.id) ?? held);
    })));
  }

  /** The standing approvals its owner gave `slate`'s shared server that stand now, at its revision: what its share
   *  sheet lists beside the reach. */
  slatePreapprovals(slate: string): Promise<SlateAnswer<SlatePreapprovals>> {
    return settle(answer(`reading slate ${slate}'s standing approvals`, Effect.sync(() => {
      const revision = slateRevision(this.builds, slate);

      return { slate, revision, preapproved: this.live.preapprovalsOf(slate, revision) };
    })));
  }

  /** Its owner takes one standing approval back, from their share sheet only: from every share of its slate at once. */
  withdrawSlatePreapproval(input: SlatePreapprovalWithdraw): Promise<SlateAnswer<SlatePreapprovals>> {
    this.live.withdrawPreapproval(input.slate, input.entry);
    // An ask of its shape still open, approved or not, would otherwise run a call the owner no longer allows.
    this.ports.ownerEffects?.retire(input.slate, input.entry);

    return this.slatePreapprovals(input.slate);
  }

  /**
   * Its owner lists a live share in the Gallery with its card's words, or takes it off, from their share sheet only. Only
   * a share on each viewer's own access is listed (§2). The Gallery holds one listing per slate, so a share listed in
   * another's place replaces it there.
   */
  setLiveShareListing(input: LiveShareListingBody): Promise<SlateAnswer<OwnedLiveShare>> {
    return settle(answer(`listing share ${input.share}`, Effect.gen({ self: this }, function* () {
      const held = this.live.get(input.share);

      if (held === undefined || held.revokedAt !== null) return yield* new KinuError('missing', 'No such share');

      if (input.listed && held.mode !== 'own') {
        return yield* new KinuError('bad_input', "A share on your access is never listed in the Gallery: turn it to each viewer's own access to list it");
      }

      this.live.setListing(held.id, input.listed ? { line: input.line, category: input.category } : null);
      const listed = this.live.get(held.id) ?? held;

      yield* Effect.promise(async () => this.ports.listingChanged?.(listed));

      return this.owned(listed);
    })));
  }

  /** What a visitor's own parts will ask them for, of a share listed in the Gallery: read from its slate's reach now.
   *  Any other share is missing here, as the Gallery's public page asks. */
  galleryNeeds(share: string): Promise<SlateAnswer<RoomService[]>> {
    return settle(answer(`reading what share ${share} needs`, Effect.gen({ self: this }, function* () {
      const held = this.live.get(share);

      if (held === undefined || held.gallery === null) return yield* new KinuError('missing', 'No such listing');

      return visitorNeeds(yield* Effect.promise(async () => this.graph(held.slate)));
    })));
  }

  /** The Gallery told again of every listed live share, or of `slate`'s alone: its index refills from these. */
  relist(slate?: string): void {
    const listed = this.live.list().filter((share) => share.gallery !== null && (slate === undefined || share.slate === slate));

    if (listed.length > 0) this.ports.relisted?.(listed);
  }

  /**
   * A slate built anew as the workspace root: each of its `owner` shares carries its approval to the new revision, and
   * their effects asked under the old one retire. Only the root's build moves it: the root is the workspace's owner, and
   * a build as anyone else (a viewer's part) is not their edit.
   */
  reapproveOnBuild(slate: string, revision: string): void {
    if (this.live.editMark(slate) !== null) return;

    for (const share of this.live.list().filter((row) => row.slate === slate && row.revokedAt === null && row.mode === 'owner' && row.grantRevision !== revision)) {
      this.live.setAuthority(share.id, { mode: 'owner', grantRevision: revision }, share.grant);
      this.ports.ownerEffects?.retire(slate);
    }
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
   * Whether the slate builds, as its preview would serve it: nothing is shown, so the turn's answer still draws the slate
   * it changed, and nothing is restarted, so a call of the slate's own that made the change is answered before its
   * process gives way to the build (`SlateProcesses.built`). `{ broken }` is the compiler's words when its latest source
   * does not build.
   */
  build(caller: SlateCaller, id: string): Promise<SlateCallResult> {
    return settle(answer('slate ' + id + ' build', Effect.gen({ self: this }, function* () {
      requireWorkModePermission(caller.workMode, false, 'Building a slate');
      const { broken } = yield* Effect.promise(async () => this.processes.built(ROOT_SLATE_CALLER, id));
      const builds: JsonValue = broken === null ? {} : { broken };

      return builds;
    })));
  }

  /**
   * The slate's served build, booted for the workspace root, at its preview's URL: the application is the root's, so the
   * URL is the same whoever asks and across launches. A slate that cannot be served is refused, and a caller who may not
   * start one is refused first.
   */
  preview(caller: SlateCaller, id: string): Promise<SlateCallResult> {
    return settle(answer('slate ' + id + ' preview', Effect.gen({ self: this }, function* () {
      requireWorkModePermission(caller.workMode, false, 'Starting or exposing a slate preview');
      const { source, app, broken } = yield* Effect.promise(async () => this.processes.served(ROOT_SLATE_CALLER, id));
      const preview = yield* Effect.promise(async () => this.ports.apps.url(app.port, app.capability));

      if (preview.url === undefined) return yield* new KinuError('unavailable', 'This deployment cannot mint a slate preview URL: ' + preview.unavailable);

      // An answer's own block is shown where the answer is, never again as a card of the turn's slates.
      if (source.kind === 'files') this.ports.previewed?.(id);
      // Every page the runner answers reports its height, its class's own `fetch` pages too.
      const shown = { url: preview.url, port: app.port, sized: true, title: slateTitle(source.project, id) };

      // Its latest source does not build: the last that did is what this URL serves, and the compiler's words say why.
      const served: JsonValue = broken === null ? shown : { ...shown, broken };

      return served;
    })));
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

      yield* Effect.promise(async () => this.endLiveShares(id));
      yield* Effect.promise(async () => this.processes.stopWhere((running) => running.id === id));
      const removed = yield* Effect.promise(async () => this.ports.apps.remove(id));
      const vfs = session.vfs.as(caller.cred);

      session.vfs.withTransaction(() => {
        if (vfs.exists(root)) vfs.removeRecursive(root);
        forgetSlateFiles(this.ports.sql, new SlateId(id));
        this.state.forget(id);
        this.usage.forget(id);
        this.builds.forget(id);
        this.live.restoreEditMark(id, null);
      });
      yield* Effect.promise(async () => this.ports.forgetPicture?.(id));

      return { id, removed: removed.removed, port: removed.port };
    })));
  }

  /** The slates `paths` changed, each to be built again before it next serves. */
  filesChanged(paths: readonly string[]): string[] {
    return this.processes.filesChanged(paths);
  }
}
