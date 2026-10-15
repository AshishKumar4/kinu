/**
 * `SlateRoom`: one per slate, the one object every use of it goes through (docs/SLATE-SHARING-SECURITY.md §2.3). Its
 * caretaker (`RoomCaretaker`) holds who may do what; this object holds the sockets, runs the slate's code, and pushes
 * each session its own `RoomView` after every change. A session whose access ends is told why and closed, at once.
 *
 * Code runs two ways (§2.4). The slate's shared server, a facet of the image now running, holds no grant: it serves the
 * slate's pages and every call that needs nothing of anyone's, its writes are public state, and its network is the
 * mediated egress every slate had. A call that holds a grant runs confined: its own isolate with no network, its env one
 * sealed stub per binding, its one output a cell allocated at admission with its label. What reaches a person goes
 * through the caretaker's release and render checks.
 *
 * Named by its workspace and handle (`room/passes.ts`). The Worker's routes authenticate, then hand the room a person:
 * an email and a name, or nobody for a visitor who has not signed in.
 */
import { DurableObject, exports } from 'cloudflare:workers';
import * as v from 'valibot';
import { Effect } from 'effect';
import {
  censusOf, durableStamps, readStamp, repairSchema, requireOps, SCHEMA_TABLES, StoragePredatesReleaseError, writeStamp,
  JsonValueSchema, McpToolSurfaceSchema, ownerCaller, roomFramePath, roomPagePath, roomPartPath, sha256Hex, slateAddressImpact, slateCallAddress,
  RoomClientFrameSchema,
  type JsonValue, type OpsCaller, type PartView, type Repair, type RoomAccess, type RoomAsk, type RoomAudience, type RoomCall,
  type RoomPerson, type RoomReach, type RoomServerFrame, type RoomService, type RoomSource, type RoomView, type SheetView,
  GALLERY_CATEGORIES, slateHostOrigin, type BlueprintBundle, type ForkPreview, type SlateAnswer, type SlateSurfaceResult, type SlateSurfaceValue, type TablesAnswer,
} from '@kinu.run/core';
import {
  canonicalRoot, frameTicket, linkKeyHolds, linkUrl, ROOM_ENTER_PATH, type FrameClaim,
  RoomCaretaker, codecIsFree, flows, initSlateRoomTables, slateAnswer, ROOT_SLATE_CALLER,
  type Access, type Audience, type Codec, type Elem, type Grant, type RoomMember, type Run, type Session, type Tag,
} from '@kinu.run/core/slates';
import { attempt, diagnostics, inItsWords, KinuError, settle, settleSync, type ErrorCode } from '@kinu.run/core/obs';
import { workspaceOwner } from '../workspace-owner-rpc';
import { accountIdFor } from '../auth/store';
import { callUserMcpTool } from '../user-mcp-call';
import { codemodeEgress } from '../codemode-egress';
import { slateBatchStub } from './rpc-transport';
import type { RoomBindingName, RoomBindingProps } from './room-bindings';
import { sealedPart } from './room-parts';
import { GALLERY_OBJECT } from '../gallery/gallery-do';
import type { UserDO } from '../user/user-do';

/** Who a request is, as the Worker's route proved it. */
export interface RoomVisitor {
  readonly email: string;
  readonly name: string;
}

/** The answer to "may this person open the room now", before any socket. */
export type RoomEntryAnswer =
  | { readonly status: 200; readonly title: string; readonly owner: RoomPerson; readonly access: RoomAccess }
  | { readonly status: 401 | 403 | 404 | 410 };

/** What one call of the slate's code comes to: its value, or a part only the slate's page can show. */
export type RoomCallOutcome = { readonly value: JsonValue } | { readonly part: { readonly key: string; readonly frame: string } };

const AccessSchema = v.variant('kind', [
  v.object({ kind: v.literal('owner') }),
  v.object({ kind: v.literal('member'), gen: v.number() }),
  v.object({ kind: v.literal('link'), gen: v.number() }),
]);

/** What a socket remembers through hibernation: the session it was opened as, and what its page reports. */
const SocketState = v.object({
  email: v.nullable(v.string()),
  name: v.nullable(v.string()),
  access: AccessSchema,
  parts: v.array(v.string()),
  where: v.nullable(v.string()),
  typing: v.nullable(v.string()),
});

type SocketState = v.InferOutput<typeof SocketState>;

/** The headers the Worker's routes set, after deleting any the request carried. */
export const ROOM_PERSON_HEADER = 'x-kinu-room-person';

export const ROOM_KEY_HEADER = 'x-kinu-room-key';

/** A request for the slate's own host, with the session its cookie names (or none). */
export const ROOM_HOST_HEADER = 'x-kinu-room-host';

const RoomPersonHeader = v.object({ email: v.string(), name: v.string() });

const HostClaimHeader = v.nullable(v.object({ email: v.nullable(v.string()), access: AccessSchema }));

const CallBody = v.object({ method: v.string(), args: v.array(JsonValueSchema) });

const WorkspaceBody = v.object({ path: v.array(v.string()), args: v.array(JsonValueSchema) });

const HereBody = v.object({ where: v.nullable(v.string()), typing: v.nullable(v.string()) });

/** The runner's answer to its boot: its methods, or why its module would not start (`resident.ts`'s runner). */
const Started = v.object({ methods: v.array(v.string()) });

const NotStarted = v.object({ error: v.string() });

/** The process facet's surface: the runner's own boot (parsed by `Started` or `NotStarted`), and its HTTP. */
interface ProcessFacet extends Rpc.DurableObjectBranded {
  startProcess(): Promise<JsonValue>;
  fetch(request: Request): Promise<Response>;
}

/** What a call of the slate's code needed and did not hold: a connection of the requester's, for one function. */
interface Need {
  readonly fn: string;
  readonly server: string;
  readonly tool: string;
  readonly root: Readonly<Record<string, string>>;
  readonly requester: string | null;
}

/** The main module every slate image starts from (resident.ts). */
const RUNNER_MODULE = 'runner.js';

const RUNNER_CLASS = 'NimbusProcess';

/** The function a page's own `workspace` call runs as: no method of the slate's, so no lend names it. */
const PAGE_CALL = '$page';

const NO_STORE = { 'cache-control': 'no-store' };

function refuse(code: ErrorCode, message: string): Effect.Effect<never, KinuError> {
  return Effect.fail(new KinuError(code, message));
}

/** A caretaker step: its refusal kept in its own words. */
function care<A>(body: () => A): Effect.Effect<A, KinuError> {
  return inItsWords('io', Effect.sync(body));
}

/** How many of their own connections one call of someone's own code may come to hold before it answers a part. */
const OWN_GRANTS_PER_CALL = 8;

/** What a personal grant made for its holder's own code admits: any input up to this size. */
const OWN_GRANT_INPUT_BYTES = 256 * 1024;

/** The GitHub tool a reader check asks with the reader's own connection: a repository it finds is one they read. */
const READER_CHECK_TOOL = 'search_repositories';

/** A part's key: one function on one input, for one person when what it reads is theirs. */
function partKey(fn: string, args: readonly JsonValue[], requester: string | null): string {
  return `${fn}.${sha256Hex(JSON.stringify(args), 16)}.${requester === null ? 'all' : sha256Hex(requester, 12)}`;
}

/** The fixed arguments a grant is made for: a GitHub call's repository, nothing for any other. */
function rootOf(server: string, args: JsonValue): Record<string, string> {
  if (!server.startsWith('mcp.') || args === null || typeof args !== 'object' || Array.isArray(args)) return {};
  const { owner, repo } = args;

  return typeof owner === 'string' && typeof repo === 'string' ? { owner, repo } : {};
}

function serviceOf(server: string): RoomService {
  if (server === 'ai') return { title: 'AI', kind: 'ai' };

  if (server.startsWith('mcp.')) {
    const name = server.slice('mcp.'.length);

    return { title: name, kind: name.toLowerCase().includes('github') ? 'github' : 'mcp' };
  }

  return { title: server, kind: 'workspace' };
}

function scopeText(root: string): string | null {
  const fixed = v.parse(v.record(v.string(), v.string()), JSON.parse(root));
  const { owner, repo } = fixed;

  if (owner !== undefined && repo !== undefined) return `${owner}/${repo}`;
  const values = Object.values(fixed);

  return values.length === 0 ? null : values.join(' · ');
}

export class SlateRoom extends DurableObject<Env> {
  private readonly caretaker: RoomCaretaker;

  /** What this activation's repair did, for the deploy's walk; null where the storage was at this build. */
  private readonly schemaRepair: Repair | null;

  /** Why this room's storage may not be read: its repair could not bring it to this build. */
  private readonly storageRefusal: StoragePredatesReleaseError | undefined;

  /** An invocation the room handed to code, and the run it is. */
  private readonly invocations = new Map<string, number>();

  /** Parts that asked for a connection their requester has not allowed, by part key. */
  private readonly needs = new Map<string, Need>();

  /** Parts computing now. */
  private readonly computing = new Set<string>();

  /** A run's step waiting for its holder, and how to wake it. */
  private readonly waiters = new Map<string, () => void>();

  /** The shared server, started for the image it was loaded from. */
  private server: { readonly image: string; readonly facet: Fetcher<ProcessFacet>; readonly methods: readonly string[] } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Asked once, never caught, as every class's database is (core state/schema-repair.ts). A room is made only by
    // `create`: one asked before that (the deploy's walk names every slate's) stays unmade, holding nothing.
    const stamps = durableStamps(ctx.storage.kv);
    const stamp = readStamp(stamps, ctx.storage.sql, 'room');

    this.schemaRepair = repairSchema(ctx.storage.sql, {
      schema: 'room', tables: SCHEMA_TABLES.room, stamps, transactionSync: (write) => ctx.storage.transactionSync(write), init: () => { this.initTables(); },
    }, `room ${ctx.id.toString()}`);

    if (this.schemaRepair?.refused != null) this.storageRefusal = new StoragePredatesReleaseError('room', this.schemaRepair.refused);

    if (this.storageRefusal === undefined && stamp !== 'unmade') this.initTables();
    this.caretaker = new RoomCaretaker({ db: ctx.storage.sql });
  }

  private initTables(): void {
    initSlateRoomTables((ddl) => { this.ctx.storage.sql.exec(ddl); });
  }

  /** The deploy's walk: this room's tables and what its repair did. */
  async opsTables(caller: OpsCaller): Promise<TablesAnswer> {
    await requireOps(this.env, caller);

    return {
      name: null, census: censusOf(this.ctx.storage.sql), repair: this.schemaRepair, refused: this.storageRefusal?.reason ?? null,
      workspaces: [], accounts: [], agents: [], rooms: [],
    };
  }

  /** The owner's workspace makes its slate's room on the slate's first run; a second call changes nothing. */
  create(input: { readonly workspace: string; readonly slate: string; readonly title: string; readonly owner: string; readonly parent: string | null }): void {
    if (this.storageRefusal !== undefined) return settleSync(Effect.fail(this.storageRefusal));
    const stamps = durableStamps(this.ctx.storage.kv);

    if (readStamp(stamps, this.ctx.storage.sql, 'room') === 'unmade') {
      this.initTables();
      writeStamp(stamps, 'room');
    }

    this.caretaker.create(input);
  }

  /** A person leaves the slate: their membership ends, and every session they hold on it with it. */
  leave(email: string): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      yield* care(() => { this.caretaker.remove(email, email); });
      yield* this.broadcast();
    }));
  }

  /** Its slate was removed: everyone's sessions end, and the room keeps nothing, so every address of it answers 404. */
  retire(): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      if (this.exists()) {
        const room = this.caretaker.room();

        if (this.caretaker.listing() !== null) {
          yield* attempt({ doing: 'unlisting the slate', otherwise: 'unavailable' },
            async () => this.env.GALLERY.get(this.env.GALLERY.idFromName(GALLERY_OBJECT)).unlist(room.workspace, room.slate));
        }

        for (const member of this.caretaker.members()) {
          if (member.role === 'edit' || member.role === 'use') yield* this.cardOrRecord(member.email, null);
        }
      }

      for (const socket of this.ctx.getWebSockets()) socket.close(1000, 'The slate was removed');
      this.server = null;
      // The shared server's facet holds the slate's own storage: it goes too, so a slate made again starts empty.
      this.ctx.facets.delete('server');
      yield* Effect.promise(async () => this.ctx.storage.deleteAll());
    }));
  }

  /** A Drive card the room could not write is recorded, not fatal: the slate itself is unchanged by it. */
  private cardOrRecord(email: string, card: { readonly role?: 'edit' | 'use'; readonly url?: string } | null): Effect.Effect<void> {
    const room = this.caretaker.room();

    return Effect.catch(this.card(email, card), (failure) => Effect.sync(() => {
      diagnostics.failure('slate.card_failed', failure, { workspace: room.workspace, slate: room.slate });
    }));
  }

  exists(): boolean {
    if (this.storageRefusal !== undefined) return settleSync(Effect.fail(this.storageRefusal));
    const made = this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'room'").toArray().length > 0;

    return made && this.ctx.storage.sql.exec('SELECT 1 FROM room WHERE id = 1').toArray().length > 0;
  }

  /** The room's object name, as the bindings it mints are sealed with. */
  private name(): string {
    const room = this.caretaker.room();

    return `${room.workspace}/${this.handle()}`;
  }

  private handle(): string {
    const room = this.caretaker.room();

    return sha256Hex(`kinu:slate-room:v1:${room.workspace}/${room.slate}`, 10);
  }

  // ── Code ────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * A good build of the slate, from its workspace: its image, written by `author`. The shared server starts again on it;
   * the author's own grants follow it and everyone else's wait for their holders (`RoomCaretaker.publish`).
   */
  publish(input: {
    readonly author: string; readonly image: string; readonly modules: Readonly<Record<string, string>>; readonly title: string;
    readonly secret: { readonly file: string; readonly line: number; readonly kind: string } | null;
  }): Promise<{ readonly methods: readonly string[] }> {
    return settle(Effect.gen({ self: this }, function* () {
      const before = this.caretaker.room().image;

      yield* care(() => { this.caretaker.publish(input.author, { image: input.image, modules: input.modules, title: input.title, secret: input.secret }); });

      if (before !== input.image && this.server !== null) {
        this.server = null;
        this.ctx.facets.abort('server', new Error('the slate was published again'));
      }

      // The image starts here and now, so a build that will not run is the build's error, not its first visitor's.
      yield* this.sharedServer();

      if (this.caretaker.listing() !== null) yield* this.syncGallery();
      yield* this.broadcast();

      return { methods: this.server?.methods ?? [] };
    }));
  }

  private moduleTexts(modules: Readonly<Record<string, string>>): Effect.Effect<Record<string, string>, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const room = this.caretaker.room();

      const texts = yield* attempt({ doing: "reading the slate's image", otherwise: 'unavailable' },
        async () => workspaceOwner(this.env, room.workspace).slateImageModules(room.slate, Object.values(modules)));

      if (!texts.ok) return yield* refuse(texts.reason, `The slate's image could not be read: ${texts.error}`);
      const loaded: Record<string, string> = {};

      for (const [name, digest] of Object.entries(modules)) {
        const text = texts.value[digest];

        if (text === undefined) return yield* refuse('unavailable', `The slate's image lost ${name}; its workspace builds it again on its next run`);
        loaded[name] = text;
      }

      return loaded;
    });
  }

  private binding(name: RoomBindingName, run: number | null): Fetcher {
    const props: RoomBindingProps = { room: this.name(), binding: name, run };

    return exports.RoomBinding({ props });
  }

  /**
   * A worker of the image now running, its env the bindings for `run`; one isolate per id. The shared server keeps the
   * mediated egress every slate had; a confined run reaches no network at all.
   */
  private worker(id: string, run: number | null): Effect.Effect<WorkerStub, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const room = this.caretaker.room();
      const modules = room.modules;

      if (room.image === null || modules === null) return yield* refuse('missing', 'This slate has not been built yet');
      const texts = yield* this.moduleTexts(modules);
      // Loaded on a room's first run, not at the Worker's start: the vendor module carries the whole slate runtime.
      const { workerCompatibility } = yield* attempt({ doing: 'loading the slate runtime', otherwise: 'unavailable' }, async () => import('virtual:kinu-slate-vendor'));
      const globalOutbound = run === null ? codemodeEgress({ workspace: room.workspace, actor: null, asOwner: false }) : null;

      if (run === null && globalOutbound === null) return yield* refuse('unsupported', 'A slate\'s shared server needs the shared outbound policy binding');

      return this.env.LOADER.get(id, async () => ({
        ...workerCompatibility,
        mainModule: RUNNER_MODULE,
        modules: texts,
        env: { workspace: this.binding('workspace', run), __storage: this.binding('__storage', run), __host: this.binding('__host', run) },
        globalOutbound,
      }));
    });
  }

  /** The shared server: the image's process class, one facet whose storage outlives each image. */
  private sharedServer(): Effect.Effect<Fetcher<ProcessFacet>, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const image = this.caretaker.room().image ?? '';

      if (this.server?.image === image) return this.server.facet;
      const worker = yield* this.worker(`kinu-room:${this.name()}:${image}`, null);
      const process = this.ctx.facets.get<ProcessFacet>('server', () => ({ class: worker.getDurableObjectClass<ProcessFacet>(RUNNER_CLASS) }));
      const methods = yield* this.started(process);

      this.server = { image, facet: process, methods };

      return process;
    });
  }

  private started(process: Fetcher<ProcessFacet>): Effect.Effect<readonly string[], KinuError> {
    return Effect.gen(function* () {
      const started = yield* attempt({ doing: 'starting the slate', otherwise: 'unavailable' }, async () => process.startProcess());

      if (v.is(Started, started)) return started.methods;
      const failed = v.safeParse(NotStarted, started);

      return yield* refuse('bad_input', failed.success ? failed.output.error : 'The slate\'s runner answered its start with nothing it reads');
    });
  }

  /** A confined run's facet: its own isolate, its env its own sealed stubs, its storage its own and dropped after. */
  private confined(run: Run): Effect.Effect<Fetcher<ProcessFacet>, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const label = sha256Hex(JSON.stringify(run.label), 16);
      const worker = yield* this.worker(`kinu-room-run:${this.name()}:${run.image}:${run.requester?.email ?? 'slate'}:${label}`, run.id);
      const facet = this.ctx.facets.get<ProcessFacet>(`run:${String(run.id)}`, () => ({ class: worker.getDurableObjectClass<ProcessFacet>(RUNNER_CLASS) }));

      yield* this.started(facet);

      return facet;
    });
  }

  // ── Entry and sockets ───────────────────────────────────────────────────────────────────────────────────────────

  /** How a person would open the room now: the live page reads this before its socket, to say why it cannot. */
  async entry(visitor: RoomVisitor | null, key: string | null): Promise<RoomEntryAnswer> {
    if (!this.exists()) return { status: 404 };
    const access = await this.access(visitor, key);

    if (access !== null) {
      const owner = this.caretaker.members().find((member) => member.role === 'owner');

      return {
        status: 200, title: this.caretaker.room().title,
        owner: { email: owner?.email ?? '', name: owner?.name ?? null }, access: this.roomAccess(visitor?.email ?? null, access),
      };
    }

    if (key !== null && !this.caretaker.room().link) return { status: 410 };

    if (key !== null) return { status: 404 };

    return { status: visitor === null ? 401 : 403 };
  }

  private async access(visitor: RoomVisitor | null, key: string | null): Promise<Access | null> {
    const room = this.caretaker.room();
    const holdsKey = key !== null && room.link && await linkKeyHolds(this.env, room, key);

    return this.caretaker.open(visitor?.email ?? null, holdsKey);
  }

  private roomAccess(email: string | null, access: Access): RoomAccess {
    if (access.kind === 'owner') return 'owner';

    if (access.kind === 'link') return 'link';

    return this.caretaker.members().find((member) => member.email === email)?.role === 'edit' ? 'edit' : 'use';
  }

  override async fetch(request: Request): Promise<Response> {
    if (!this.exists()) return new Response('Not found', { status: 404 });
    const host = request.headers.get(ROOM_HOST_HEADER);

    if (host !== null) return settle(this.hostRequest(request, v.parse(HostClaimHeader, JSON.parse(host))));

    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Not found', { status: 404 });

    return settle(this.socketFor(request));
  }

  /** A person's socket on the room: refused unless they may open it, then every view pushed to it. */
  private socketFor(request: Request): Effect.Effect<Response, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const header = request.headers.get(ROOM_PERSON_HEADER);
      const visitor = header === null ? null : v.parse(RoomPersonHeader, JSON.parse(header));
      const access = yield* Effect.promise(async () => this.access(visitor, request.headers.get(ROOM_KEY_HEADER)));

      if (access === null) return new Response('Not shared with you', { status: 403 });

      if (visitor !== null && access.kind !== 'link') this.caretaker.named(visitor.email, visitor.name);

      // Someone signed in who came by the link keeps it in their Drive, under Used, with the link to come back by.
      if (visitor !== null && access.kind === 'link') {
        const link = yield* Effect.promise(async () => linkUrl(this.env, this.caretaker.room()));

        if (link !== null) yield* this.cardOrRecord(visitor.email, { url: new URL(link).pathname + new URL(link).search });
      }

      const pair = new WebSocketPair();
      const state: SocketState = { email: visitor?.email ?? null, name: visitor?.name ?? null, access, parts: [], where: null, typing: null };

      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment(state);
      yield* this.broadcast();

      return new Response(null, { status: 101, webSocket: pair[0] });
    });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const state = this.socketState(ws);
    const frame = v.safeParse(RoomClientFrameSchema, JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)));

    if (state === null || !frame.success) return;

    return settle(Effect.gen({ self: this }, function* () {
      ws.send(JSON.stringify(yield* this.answer(ws, state, frame.output.id, frame.output.call)));
      yield* this.broadcast();
    }));
  }

  override async webSocketClose(): Promise<void> {
    return settle(this.broadcast());
  }

  private socketState(ws: WebSocket): SocketState | null {
    const parsed = v.safeParse(SocketState, ws.deserializeAttachment());

    return parsed.success ? parsed.output : null;
  }

  /** A call's answer frame: done, or refused in the room's words. It never fails. */
  private answer(ws: WebSocket, state: SocketState, id: number, call: RoomCall): Effect.Effect<RoomServerFrame> {
    return Effect.catch(Effect.as(this.call(ws, state, call), { id, refusal: null } satisfies RoomServerFrame), (error) => {
      const reason = error.code === 'denied' || error.code === 'missing' || error.code === 'bad_input' ? error.code : 'unavailable';

      return Effect.succeed({ id, refusal: { reason, message: error.message } } satisfies RoomServerFrame);
    });
  }

  /** One call of a session, as the caretaker allows it. */
  private call(ws: WebSocket, state: SocketState, call: RoomCall): Effect.Effect<void, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const session: Session = { email: state.email, access: state.access };

      if (!this.caretaker.current(session)) return yield* refuse('denied', 'This session has ended');
      const actor = state.email;

      switch (call.op) {
        case 'setAudience': {
          yield* care(() => { this.setAudience(actor, call.audience); });

          return yield* this.syncGallery();
        }

        case 'invite': case 'setRole': {
          const email = call.email.trim().toLowerCase();

          yield* care(() => { this.caretaker.invite(actor, email, call.role); });

          return yield* this.card(email, { role: call.role });
        }

        case 'remove': {
          yield* care(() => { this.caretaker.remove(actor, call.email); });

          return yield* this.card(call.email, null);
        }

        case 'leave': {
          if (actor === null) return yield* refuse('denied', 'Sign in to leave a slate');
          yield* care(() => { this.caretaker.remove(actor, actor); });

          return yield* this.card(actor, null);
        }

        case 'here': {
          ws.serializeAttachment({ ...state, where: call.where, typing: call.typing } satisfies SocketState);

          return;
        }

        case 'open': {
          if (!state.parts.includes(call.part)) ws.serializeAttachment({ ...state, parts: [...state.parts, call.part] } satisfies SocketState);

          return;
        }

        case 'allow': return yield* this.allow(session, call.part);
        case 'ask': return yield* care(() => { this.ask(session, call.part); });
        case 'show': return yield* care(() => { this.showPart(session, call.part, call.scope); });
        case 'unshow': return yield* care(() => { this.unshowPart(session, call.part); });
        case 'setLend': return yield* care(() => { this.setLend(actor, call.fn, call.on); });
        case 'setLendShown': return yield* care(() => { this.setLendShown(actor, call.fn, call.shown); });
        case 'showTo': case 'showToMembers': case 'decline': return yield* care(() => { this.answerAsk(actor, call.ask, call.op); });
        case 'approve': case 'send': return yield* care(() => { this.decideWaiting(actor, call.ask, true); });
        case 'check': return yield* this.check(session, call.part);
        case 'list': {
          yield* care(() => { this.caretaker.list(actor, { line: call.line, category: call.category }, Date.now()); });

          return yield* this.syncGallery();
        }

        case 'unlist': {
          yield* care(() => { this.caretaker.unlist(actor); });

          return yield* this.syncGallery();
        }
      }
    });
  }

  private sheetListing(): SheetView['listing'] {
    const listing = this.caretaker.listing();
    const category = v.safeParse(v.picklist(GALLERY_CATEGORIES), listing?.category);

    return listing === null || !category.success ? null : { line: listing.line, category: category.output };
  }

  /**
   * The Gallery says what the room says: the slate's listing while it has one, with its link, title, what a fork needs
   * and whether a part runs with its author's own lend; nothing once it has none.
   */
  private syncGallery(): Effect.Effect<void, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const room = this.caretaker.room();
      const listing = this.sheetListing();
      const gallery = this.env.GALLERY.get(this.env.GALLERY.idFromName(GALLERY_OBJECT));
      const url = listing === null ? null : yield* Effect.promise(async () => linkUrl(this.env, room));

      if (listing === null || url === null) {
        yield* attempt({ doing: 'unlisting the slate', otherwise: 'unavailable' }, async () => gallery.unlist(room.workspace, room.slate));

        return;
      }

      const owner = this.caretaker.members().find((member) => member.role === 'owner');
      const grants = this.caretaker.grants();
      const needs = new Map(grants.map((grant) => [serviceOf(grant.server).title, serviceOf(grant.server)]));

      yield* attempt({ doing: 'listing the slate', otherwise: 'unavailable' }, async () => gallery.list({
        workspace: room.workspace, slate: room.slate, title: room.title, line: listing.line, category: listing.category,
        ownerName: owner?.name ?? owner?.email.slice(0, owner.email.indexOf('@')) ?? '', url: new URL(url).pathname + new URL(url).search,
        needs: [...needs.values()], files: Object.keys(room.modules ?? {}).filter((name) => name !== RUNNER_MODULE).sort(),
        readsAuthor: grants.some((grant) => !grant.personal), picture: null,
      }));
    });
  }

  /**
   * The card a person's Drive holds for this slate: shared with them as `role`, or used through its link (`role`
   * absent), or none. Written to their account by the room, which alone knows; their Drive reads it without asking.
   */
  private card(email: string, card: { readonly role?: 'edit' | 'use'; readonly url?: string } | null): Effect.Effect<void, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const room = this.caretaker.room();
      const owner = this.caretaker.owner();
      const caller = yield* attempt({ doing: 'reaching the account', otherwise: 'unavailable' }, async () => ownerCaller(this.env));

      const [recipient, ownerAccount] = yield* attempt({ doing: 'naming the accounts', otherwise: 'unavailable' },
        async () => Promise.all([accountIdFor(this.env, email), accountIdFor(this.env, owner)]));

      const account = this.userObject(recipient);

      if (card === null) {
        yield* attempt({ doing: `taking ${email}'s card back`, otherwise: 'unavailable' }, async () => account.shareCards_remove(caller, ownerAccount, room.workspace, room.slate));

        return;
      }

      yield* attempt({ doing: `giving ${email} the slate's card`, otherwise: 'unavailable' }, async () => account.shareCards_put(caller, {
        ownerUserId: ownerAccount, workspace: room.workspace, shareId: room.slate,
        card: {
          kind: 'live', title: room.title, description: '', createdAt: Date.now(), owner,
          ...(card.role !== undefined && { role: card.role }),
          url: card.url ?? roomPagePath(room.workspace, room.slate),
        },
      }));
    });
  }

  /** The sheet's three audiences, each one call: the link on, the link off, or the link off and everyone removed. */
  private setAudience(actor: string | null, audience: RoomAudience): void {
    if (audience === 'anyone') return this.caretaker.setLink(actor, true);

    this.caretaker.setLink(actor, false);

    if (audience === 'only-you') {
      for (const member of this.caretaker.members()) {
        if (member.role === 'edit' || member.role === 'use') this.caretaker.remove(actor, member.email);
      }
    }
  }

  // ── Grants a person makes ───────────────────────────────────────────────────────────────────────────────────────

  /** What a grant for `need` would be: its effect and its sink, by what the call does. */
  private contract(need: Need, holder: string): Effect.Effect<{ effect: boolean; sink: Audience }, KinuError> {
    return Effect.gen({ self: this }, function* () {
      if (need.server === 'ai') return { effect: false, sink: [] };

      if (need.server.startsWith('mcp.')) {
        const descriptor = yield* this.mcpDescriptor(holder, need.server, need.tool);

        return descriptor?.readOnly === true ? { effect: false, sink: [] } : { effect: true, sink: 'anyone' };
      }

      const impact = slateAddressImpact({ namespace: need.server, member: need.tool });

      if (impact === null) return yield* refuse('denied', `${need.server}.${need.tool} is not something a slate reaches`);

      return { effect: impact !== 'observe', sink: impact === 'externalSend' || impact === 'execute' ? 'anyone' : [] };
    });
  }

  /** "Allow" on a part: the requester grants their own connection to the function it needed, for their own requests. */
  private allow(session: Session, part: string): Effect.Effect<void, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const need = this.needs.get(part);

      if (need === undefined || session.email === null || need.requester !== session.email) {
        return yield* refuse('missing', 'This part asks nothing of you now');
      }

      const holder = session.email;
      const { effect, sink } = yield* this.contract(need, holder);

      yield* care(() => {
        this.caretaker.mint(holder, {
          personal: true, server: need.server, root: need.root, tools: this.toolsFor(holder, need), fn: need.fn,
          domain: { kind: 'json', maxBytes: 65_536 }, effect, sink,
        });
      });
      this.needs.delete(part);
    });
  }

  /**
   * The reader check (docs/SLATE-SHARING-SECURITY.md §2.1): for each source in the part this person may not see, their
   * own connection is asked whether it reads that source directly. A GitHub repository reads to them when their own
   * search finds it; what the room records is what their account answered now, a yes or a no.
   */
  private check(session: Session, part: string): Effect.Effect<void, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const email = session.email;
      const cell = this.caretaker.cell(part);

      if (email === null || cell === null) return yield* refuse('missing', 'Sign in and open the part to check it');
      const facts = this.caretaker.facts();
      const closed = cell.label.filter((elem) => elem.holder !== email && !flows(facts, [elem], email));

      for (const elem of closed) {
        const root = v.parse(v.record(v.string(), v.string()), JSON.parse(elem.root));
        const { owner, repo } = root;

        if (serviceOf(elem.server).kind !== 'github' || owner === undefined || repo === undefined) {
          return yield* refuse('unsupported', `${serviceOf(elem.server).title} cannot say who reads it; ask ${elem.holder} instead`);
        }

        const descriptor = yield* this.mcpDescriptor(email, elem.server, READER_CHECK_TOOL);

        if (descriptor === null) return yield* refuse('missing', `Connect your own ${serviceOf(elem.server).title} to check`);
        const account = yield* attempt({ doing: 'naming the account', otherwise: 'unavailable' }, async () => accountIdFor(this.env, email));
        const caller = yield* attempt({ doing: 'reaching the account', otherwise: 'unavailable' }, async () => ownerCaller(this.env));

        const answered = yield* attempt({ doing: `asking ${serviceOf(elem.server).title} who reads ${owner}/${repo}`, otherwise: 'unavailable' },
          async () => callUserMcpTool({ stub: this.userObject(account), caller }, descriptor, { query: `repo:${owner}/${repo}` }, undefined));

        const reads = answered.toLowerCase().includes(`${owner}/${repo}`.toLowerCase());

        yield* care(() => { this.caretaker.checked(email, elem, reads); });
      }
    });
  }

  /** The tools a renewed grant keeps: the ones the person already granted that function, and the one it asked for now. */
  private toolsFor(holder: string, need: Need): string[] {
    const held = this.caretaker.grants().find((grant) => grant.personal && grant.holder === holder && grant.fn === need.fn
      && grant.server === need.server);

    return [...new Set([...held?.tools ?? [], need.tool])];
  }

  /** The owner's lend of one function: what the owner's own grant for it reaches, for anyone's call. */
  private setLend(actor: string | null, fn: string, on: boolean): void {
    const owner = this.caretaker.owner();
    const own = this.caretaker.grants().filter((grant) => grant.holder === owner && grant.fn === fn);

    if (actor === owner) for (const grant of own.filter((each) => !each.personal)) this.caretaker.revoke(actor, grant.id);

    if (!on) return;

    for (const grant of own.filter((each) => each.personal)) {
      this.caretaker.mint(actor, {
        personal: false, server: grant.server, root: v.parse(v.record(v.string(), v.string()), JSON.parse(grant.root)), tools: grant.tools,
        fn, domain: grant.domain, effect: grant.effect, sink: grant.sink,
      });
    }
  }

  /** Whether what a lend returns is shown to everyone: a show, by the owner, of each source the lend reads, for that function. */
  private setLendShown(actor: string | null, fn: string, shown: 'everyone' | 'holder'): void {
    const owner = this.caretaker.owner();

    for (const show of this.caretaker.shows().filter((each) => each.holder === owner && each.fn === fn && each.audience === 'anyone')) {
      this.caretaker.unshow(actor, show.id);
    }

    if (shown === 'holder') return;

    for (const grant of this.caretaker.grants().filter((each) => !each.personal && each.holder === owner && each.fn === fn)) {
      this.caretaker.show(actor, grant, fn, 'anyone');
    }
  }

  // ── Showing and asking ──────────────────────────────────────────────────────────────────────────────────────────

  private cellLabel(part: string): readonly Elem[] {
    return this.caretaker.cell(part)?.label ?? [];
  }

  /** "Ask Alice": the holders of what a part hides each get one ask. */
  private ask(session: Session, part: string): void {
    const seen = this.caretaker.render(part, session);

    if (!seen.shown) this.caretaker.ask(session.email, seen.hidden);
  }

  /** "Show to everyone here": the person shows their own sources in a part, for that part's function. */
  private showPart(session: Session, part: string, scope: 'members' | 'anyone'): void {
    const audience: Audience = scope === 'anyone' ? 'anyone' : this.everyoneAdded();

    for (const elem of this.cellLabel(part).filter((each) => each.holder === session.email)) this.caretaker.show(session.email, elem, elem.fn, audience);
  }

  private everyoneAdded(): string[] {
    return this.caretaker.members().filter((member) => member.role !== 'removed').map((member) => member.email);
  }

  private unshowPart(session: Session, part: string): void {
    const label = this.cellLabel(part);

    for (const show of this.caretaker.shows().filter((each) => each.holder === session.email && label.some((elem) => elem.holder === each.holder
      && elem.server === each.server && elem.root === each.root && (each.fn === null || each.fn === elem.fn)))) {
      this.caretaker.unshow(session.email, show.id);
    }
  }

  /** A holder answers someone's ask to see a part: to them, to everyone added, or not now. */
  private answerAsk(actor: string | null, id: string, op: 'showTo' | 'showToMembers' | 'decline'): void {
    const [asker, server, root, fn] = v.parse(v.tuple([v.string(), v.string(), v.string(), v.string()]), JSON.parse(id));
    const tag: Tag = { holder: actor ?? '', server, root };

    if (op === 'showTo') this.caretaker.show(actor, tag, fn, [asker]);
    else if (op === 'showToMembers') this.caretaker.show(actor, tag, fn, this.everyoneAdded());
    else this.caretaker.dismissAsk(actor ?? '', asker, tag, fn);
  }

  private decideWaiting(actor: string | null, id: string, approve: boolean): void {
    this.caretaker.decide(actor, id, approve);
    this.waiters.get(id)?.();
  }

  // ── The slate's own host ────────────────────────────────────────────────────────────────────────────────────────

  /**
   * A request to the slate's own host, with the session its cookie names. Pages and assets are the shared server's; a
   * call of the slate's code, or a page's own `workspace` call, is run here as the caretaker admits it.
   */
  private hostRequest(request: Request, claim: { readonly email: string | null; readonly access: Access } | null): Effect.Effect<Response, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const session: Session | null = claim;

      if (session === null || !this.caretaker.current(session)) {
        return new Response('Open this slate from its page in Kinu.', { status: 403, headers: NO_STORE });
      }

      const url = new URL(request.url);

      if (request.method === 'POST' && (url.pathname === '/__kinu/call' || url.pathname === '/__kinu/part')) {
        const body = v.parse(CallBody, yield* attempt({ doing: 'reading the call', otherwise: 'bad_input' }, async () => request.json()));
        const answer = yield* slateAnswer(`slate ${body.method}`, this.callMethod(session, body.method, body.args, url.pathname === '/__kinu/part' ? 'part' : 'page'));

        return Response.json(answer, { headers: NO_STORE });
      }

      if (request.method === 'POST' && url.pathname === '/__kinu/workspace') {
        const body = v.parse(WorkspaceBody, yield* attempt({ doing: 'reading the call', otherwise: 'bad_input' }, async () => request.json()));
        const answer = yield* slateAnswer('slate workspace', this.pageCall(session, body.path, body.args));

        return Response.json(answer, { headers: NO_STORE });
      }

      if (request.method === 'POST' && url.pathname === '/__kinu/here') {
        const body = v.parse(HereBody, yield* attempt({ doing: 'reading presence', otherwise: 'bad_input' }, async () => request.json()));

        for (const ws of this.ctx.getWebSockets()) {
          const state = this.socketState(ws);

          if (state !== null && state.email !== null && state.email === session.email) ws.serializeAttachment({ ...state, ...body } satisfies SocketState);
        }

        yield* this.broadcast();

        return new Response(null, { status: 204 });
      }

      if (url.pathname === '/__rpc') return new Response('A slate page calls its server through kinu:slate', { status: 404, headers: NO_STORE });
      const run = yield* care(() => this.caretaker.admit({ requester: session, fn: 'fetch', input: null, grants: [], inputs: [], out: null }));
      const invocation = this.invoke(run);
      const headers = new Headers(request.headers);

      headers.set('x-slate-call', invocation);

      return yield* Effect.ensuring(
        Effect.flatMap(this.sharedServer(), (server) => attempt({ doing: 'serving the slate page', otherwise: 'unavailable' },
          async () => server.fetch(new Request(request, { headers })))),
        Effect.sync(() => {
          this.settleRun(invocation);
          this.caretaker.finish(run.id);
        }),
      );
    });
  }

  private invoke(run: Run): string {
    const invocation = `run:${String(run.id)}:${crypto.randomUUID()}`;

    this.invocations.set(invocation, run.id);

    return invocation;
  }

  /** The run's code has answered: its invocation goes. The run itself ends once its output is written and released. */
  private settleRun(invocation: string): void {
    this.invocations.delete(invocation);
  }

  /**
   * A call of the slate's code made for a person by their own agent (their workspace's hop), or for the slate's own work
   * (null): admitted as that person now holds the slate.
   */
  callAs(email: string | null, fn: string, args: JsonValue[]): Promise<SlateAnswer<RoomCallOutcome>> {
    return settle(slateAnswer(`slate ${fn}`, Effect.gen({ self: this }, function* () {
      if (email === null) return yield* this.callMethod(null, fn, args, 'page');
      const access = this.caretaker.open(email, false);

      if (access === null) return yield* refuse('denied', `${email} cannot open this slate`);

      return yield* this.callMethod({ email, access }, fn, args, 'person');
    })));
  }

  /** The slate's page here, entered as its owner: what the owner's previews show. */
  ownerFrame(): Promise<string> {
    return settle(this.frame({ email: this.caretaker.owner(), name: null, access: { kind: 'owner' }, parts: [], where: null, typing: null }));
  }

  /**
   * One call of the slate's code from its page or the slate's own work. With no grant it runs in the shared server and
   * answers its value; with grants it runs confined and its output is a part, answered as its value only when everyone
   * may see it. One that needed a connection its requester has not allowed answers the part that asks for it.
   */
  /**
   * One call of the slate's code. Its answer goes back as itself to a `person` who may see its label (their own agent's
   * call); to a `page`, whose code anyone who opens the slate runs, only if everyone who can open it may see it; to a
   * `part`, never: it shows in the part's sealed frame.
   */
  private callMethod(session: Session | null, fn: string, args: readonly JsonValue[], to: 'page' | 'part' | 'person'): Effect.Effect<RoomCallOutcome, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const requester = session?.email ?? null;

      // Someone running code they wrote themselves holds their own connections as it reaches them, no one asked: each
      // need becomes a personal grant of theirs, at this image, and the call runs again (decision 1 of the design).
      for (let tries = 0; ; tries++) {
        const outcome = yield* this.callOnce(session, fn, args, to);
        const need = [...this.needs.entries()].find(([, each]) => each.fn === fn && each.requester === requester);

        if (!('part' in outcome) || need === undefined || requester === null || tries >= OWN_GRANTS_PER_CALL) return outcome;

        if (this.caretaker.room().imageAuthor !== requester) return outcome;
        yield* care(() => { this.ownGrant(requester, need[1]); });
        this.needs.delete(need[0]);
      }
    });
  }

  /** A personal grant of `holder`'s for what their own code needed, widened by the tool if they held one already. */
  private ownGrant(holder: string, need: Need): void {
    const root = canonicalRoot(need.root);

    const held = this.caretaker.grants().find((grant) => grant.personal && grant.holder === holder && grant.server === need.server
      && grant.root === root && grant.fn === need.fn);

    const impact = slateAddressImpact({ namespace: need.server, member: need.tool });

    this.caretaker.mint(holder, {
      personal: true, server: need.server, root: need.root, tools: [...new Set([...held?.tools ?? [], need.tool])], fn: need.fn,
      domain: { kind: 'json', maxBytes: OWN_GRANT_INPUT_BYTES }, effect: impact !== 'observe', sink: impact === 'externalSend' ? 'anyone' : [],
    });
  }

  private callOnce(session: Session | null, fn: string, args: readonly JsonValue[], to: 'page' | 'part' | 'person'): Effect.Effect<RoomCallOutcome, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const asPart = to === 'part';
      const input: JsonValue = [...args];
      const grants = this.caretaker.grantsFor(session, fn, input);
      const requester = session?.email ?? null;
      const mine = grants.some((grant) => grant.personal) || this.needs.has(partKey(fn, args, requester));
      const key = partKey(fn, args, mine ? requester : null);

      if (grants.length === 0 && !asPart) {
        const run = yield* care(() => this.caretaker.admit({ requester: session, fn, input, grants: [], inputs: [], out: null }));
        const answered = yield* Effect.result(Effect.ensuring(this.runMethod(run, this.sharedServer()), Effect.sync(() => { this.caretaker.finish(run.id); })));

        if (answered._tag === 'Success') return { value: answered.success };
        const need = [...this.needs.entries()].find(([, each]) => each.fn === fn && each.requester === requester);

        if (need !== undefined) return { part: { key: need[0], frame: this.partFrame(need[0]) } };

        return yield* Effect.fail(answered.failure);
      }

      const run = yield* care(() => this.caretaker.admit({ requester: session, fn, input, grants: grants.map((grant) => grant.id), inputs: [], out: key }));

      return yield* Effect.ensuring(this.confinedCall(run, { session, key, to }), Effect.sync(() => { this.caretaker.finish(run.id); }));
    });
  }

  /** A confined run's call, its output written and then released as `to` may see it. */
  private confinedCall(run: Run, call: { readonly session: Session | null; readonly key: string; readonly to: 'page' | 'part' | 'person' }): Effect.Effect<RoomCallOutcome, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const { session, key, to } = call;

      this.computing.add(key);
      yield* this.broadcast();

      const answered = yield* Effect.result(Effect.ensuring(this.runMethod(run, this.confined(run)), Effect.sync(() => {
        this.computing.delete(key);
        this.ctx.facets.delete(`run:${String(run.id)}`);
      })));

      if (answered._tag === 'Success') this.caretaker.write(run.id, answered.success);
      else if (!this.needs.has(key)) this.caretaker.write(run.id, { failed: answered.failure.message });
      yield* this.broadcast();

      if (answered._tag === 'Success' && to === 'person' && session !== null && (yield* care(() => this.caretaker.release(run.id, session)))) {
        return { value: answered.success };
      }

      if (answered._tag === 'Success' && to === 'page' && this.openToEveryone(run.label)) return { value: answered.success };

      return { part: { key, frame: this.partFrame(key) } };
    });
  }

  /** Whether everyone who can open the slate may see a label: then a part's value goes back as itself. */
  private openToEveryone(label: readonly Elem[]): boolean {
    const facts = this.caretaker.facts();

    return this.caretaker.room().link ? flows(facts, label, null) : this.everyoneAdded().every((email) => flows(facts, label, email));
  }

  /** A page's own `workspace` call: a run of no method of the slate's, for its session, with what that session holds. */
  private pageCall(session: Session, path: readonly string[], args: readonly JsonValue[]): Effect.Effect<RoomCallOutcome, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const grants = this.caretaker.grantsFor(session, PAGE_CALL, [...args]);
      const run = yield* care(() => this.caretaker.admit({ requester: session, fn: PAGE_CALL, input: [...args], grants: grants.map((grant) => grant.id), inputs: [], out: null }));
      const value = yield* Effect.ensuring(this.surfaceCall(run, path, args), Effect.sync(() => { this.caretaker.finish(run.id); }));

      if (value instanceof ReadableStream || (value !== null && typeof value === 'object' && 'reply' in value)) {
        return yield* refuse('unsupported', 'A page reads a streamed answer through its slate\'s server');
      }

      if (!this.caretaker.release(run.id, session)) return yield* refuse('denied', 'This answer holds data you cannot see');

      return { value };
    });
  }

  private partFrame(key: string): string {
    const room = this.caretaker.room();

    return `${this.env.CLI_PUBLIC_ORIGIN ?? ''}${roomPartPath(room.workspace, room.slate, key)}`;
  }

  /** Runs `run.fn` in a process, under an invocation naming the run, and settles it. */
  private runMethod(run: Run, process: Effect.Effect<Fetcher<ProcessFacet>, KinuError>): Effect.Effect<JsonValue, KinuError> {
    return Effect.acquireUseRelease(
      Effect.sync(() => this.invoke(run)),
      (invocation) => Effect.gen({ self: this }, function* () {
        const facet = yield* process;

        const answered = yield* attempt({ doing: `slate ${run.fn}`, otherwise: 'io' }, async () => {
          const stub = slateBatchStub<Record<string, (...args: JsonValue[]) => Promise<JsonValue | undefined>>>({ request: (request) => facet.fetch(request) }, invocation);

          try {
            return await stub[run.fn](...(Array.isArray(run.input) ? run.input : []));
          } finally {
            stub[Symbol.dispose]();
          }
        });

        const value = v.safeParse(JsonValueSchema, answered ?? null);

        if (!value.success) return yield* refuse('bad_input', `${run.fn} must return a JSON value`);

        return value.output;
      }),
      (invocation) => Effect.sync(() => { this.settleRun(invocation); }),
    );
  }

  // ── What code calls ─────────────────────────────────────────────────────────────────────────────────────────────

  /** Every call a slate's code makes, through the stub its env holds: the stub's sealed props name its binding and run. */
  bindingCall(props: RoomBindingProps, request: { readonly path: string[]; readonly args: JsonValue[]; readonly invocation: string | null }): Promise<SlateSurfaceResult> {
    return settle(slateAnswer(`slate ${props.binding}`, Effect.gen({ self: this }, function* () {
      const runId = request.invocation === null ? null : this.invocations.get(request.invocation) ?? null;

      // A confined run's stub names its run; the shared server's names none and is told the run by its invocation.
      if (props.run !== null && runId !== props.run) return yield* refuse('denied', 'This call belongs to no run of this stub');
      const run = runId === null ? null : this.caretaker.run(runId);

      switch (props.binding) {
        case '__host': return null;
        case '__storage': return yield* this.storage(run, request.path.join('.'), request.args);
        case 'workspace': {
          if (run === null) return yield* refuse('denied', 'workspace is called outside a slate method; there is no invocation to run it under');

          return yield* this.surfaceCall(run, request.path, request.args);
        }
      }
    })));
  }

  /** A cell the shared server may read: public state only. */
  private publicValue(key: string): JsonValue {
    const cell = this.caretaker.cell(key);

    return cell === null || cell.label.length > 0 ? null : cell.value;
  }

  /** The slate's key-value state: public cells for the shared server; a confined run reads within its label and writes only by returning. */
  private storage(run: Run | null, member: string, args: readonly JsonValue[]): Effect.Effect<JsonValue, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const key = v.parse(v.string(), args[0] ?? '');

      switch (member) {
        case 'get': {
          const value = run === null ? this.publicValue(key) : yield* care(() => this.caretaker.observe(run.id, key));

          return value === null ? null : { value };
        }

        case 'put': return yield* care(() => { this.caretaker.post(run?.id ?? null, key, v.parse(JsonValueSchema, args[1] ?? null));

 return null; });
        case 'delete': {
          if (run !== null && run.label.length > 0) return yield* refuse('denied', 'A part that read private data can only return its result');

          return yield* care(() => this.caretaker.deleteCell(key));
        }

        case 'list': {
          const options = v.parse(v.object({ prefix: v.optional(v.string()), limit: v.optional(v.number()) }), args[0] ?? {});

          return this.caretaker.publicCells(options.prefix ?? '', Math.min(options.limit ?? 1000, 1000)).map((cell): JsonValue => [cell.key, cell.value]);
        }

        default: return yield* refuse('denied', 'slate storage offers get, put, delete and list');
      }
    });
  }

  /**
   * A workspace call from a run: through a grant the run holds for that service and tool, under the caretaker's tool
   * step; with none, the run's requester is asked to allow their own connection, and the call refuses.
   */
  private surfaceCall(run: Run, path: readonly string[], args: readonly JsonValue[]): Effect.Effect<SlateSurfaceValue, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const address = slateCallAddress(path);
      const server = address.namespace;
      const tool = address.member;
      const callArgs: JsonValue = args.length === 1 ? args[0] ?? null : [...args];
      const root = rootOf(server, callArgs);

      const held = run.caps.map((cap) => this.caretaker.grant(cap.grant)).find((grant): grant is Grant => grant !== null
        && grant.server === server && grant.tools.includes(tool) && JSON.stringify(JSON.parse(grant.root)) === JSON.stringify(root));

      if (held === undefined) {
        const requester = run.requester?.email ?? null;
        const key = partKey(run.fn, Array.isArray(run.input) ? run.input : [], requester);

        this.needs.set(key, { fn: run.fn, server, tool, root, requester });
        yield* this.broadcast();

        return yield* refuse('denied', requester === null ? `${run.fn} needs a connection someone lends it` : `${run.fn} needs your ${serviceOf(server).title}: allow it on the part`);
      }

      const verdict = yield* care(() => this.caretaker.toolStep(run.id, held.id, tool, callArgs));

      if (verdict.kind === 'wait') {
        yield* this.broadcast();
        yield* Effect.promise(async () => new Promise<void>((resolve) => { this.waiters.set(verdict.pending.id, resolve); }));
        this.waiters.delete(verdict.pending.id);
        yield* care(() => { this.caretaker.resume(verdict.pending.id); });
      }

      return yield* this.exercise(held, path, args);
    });
  }

  /** A tool step, exercised in its holder's own account: the owner's through their workspace, anyone else's MCP server through their own account. */
  private exercise(grant: Grant, path: readonly string[], args: readonly JsonValue[]): Effect.Effect<SlateSurfaceValue, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const room = this.caretaker.room();

      if (grant.holder === this.caretaker.owner()) {
        const result = yield* attempt({ doing: `${grant.server} for the slate`, otherwise: 'unavailable' },
          async () => workspaceOwner(this.env, room.workspace).slateCallAs(ROOT_SLATE_CALLER, room.slate, 'workspace', { path: [...path], args: [...args], invocation: null }));

        if (!result.ok) return yield* refuse(result.reason, result.error);

        return result.value;
      }

      if (!grant.server.startsWith('mcp.')) return yield* refuse('unsupported', `Only the slate's owner lends ${grant.server}; a person's own connections in a room are MCP servers`);
      const tool = path.at(-1) ?? '';
      const descriptor = yield* this.mcpDescriptor(grant.holder, grant.server, tool);

      if (descriptor === null) return yield* refuse('missing', `${grant.holder}'s ${grant.server.slice(4)} offers no ${tool}`);
      const account = yield* attempt({ doing: 'naming the account', otherwise: 'unavailable' }, async () => accountIdFor(this.env, grant.holder));
      const caller = yield* attempt({ doing: 'reaching the account', otherwise: 'unavailable' }, async () => ownerCaller(this.env));
      const callArgs = v.parse(v.record(v.string(), JsonValueSchema), args[0] ?? {});

      const answered = yield* attempt({ doing: `${tool} for the slate`, otherwise: 'unavailable' },
        async () => callUserMcpTool({ stub: this.userObject(account), caller }, descriptor, callArgs, undefined));

      return v.parse(JsonValueSchema, JSON.parse(answered));
    });
  }

  private userObject(account: string): DurableObjectStub<UserDO> {
    return this.env.UserDO.get(this.env.UserDO.idFromName(account));
  }

  private mcpDescriptor(holder: string, server: string, tool: string) {
    return Effect.gen({ self: this }, function* () {
      const account = yield* attempt({ doing: 'naming the account', otherwise: 'unavailable' }, async () => accountIdFor(this.env, holder));
      const caller = yield* attempt({ doing: 'reaching the account', otherwise: 'unavailable' }, async () => ownerCaller(this.env));
      const listed = yield* attempt({ doing: 'reading the connections', otherwise: 'unavailable' }, async () => this.userObject(account).userMcp_toolDescriptors(caller));
      const surface = v.parse(McpToolSurfaceSchema, listed);

      return surface.descriptors.find((each) => each.serverName === server.slice('mcp.'.length) && each.name === tool) ?? null;
    });
  }

  // ── Parts ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /** A part's sealed content, as a current session may see it (`room-parts.ts`). */
  async partContent(claim: Pick<FrameClaim, 'email' | 'access'>, key: string): Promise<Response> {
    const session: Session = claim;

    if (!this.caretaker.current(session) || this.caretaker.cell(key) === null) return new Response('Not found', { status: 404 });
    const seen = this.caretaker.render(key, session);

    return sealedPart(seen.shown ? seen.value : null);
  }

  private source(tag: Tag): RoomSource {
    const member = this.caretaker.members().find((each) => each.email === tag.holder);
    const scope = scopeText(tag.root);
    const service = serviceOf(tag.server);

    return {
      holder: { email: tag.holder, name: member?.name ?? null }, service, scope, label: scope ?? service.title,
      checkable: service.kind === 'github' && scope !== null,
    };
  }

  private reach(grant: Pick<Grant, 'server' | 'tools' | 'root' | 'effect'>): RoomReach {
    return {
      service: serviceOf(grant.server), scope: scopeText(grant.root), effect: grant.effect,
      tools: grant.tools.map((name) => ({ name, title: name, readOnly: slateAddressImpact({ namespace: grant.server, member: name }) === 'observe' })),
    };
  }

  private partView(key: string, state: SocketState): Effect.Effect<PartView, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const fn = key.slice(0, key.indexOf('.'));
      const session: Session = { email: state.email, access: state.access };
      const need = this.needs.get(key);

      if (need !== undefined && need.requester === state.email) {
        if (state.email === null) return { state: 'needs-sign-in', key, fn } satisfies PartView;
        const { effect } = yield* this.contract(need, state.email);
        const reach = this.reach({ server: need.server, tools: [need.tool], root: JSON.stringify(need.root), effect });
        const connected = !need.server.startsWith('mcp.') || (yield* this.mcpDescriptor(state.email, need.server, need.tool)) !== null;

        return { state: 'needs-connection', key, fn, reach, connected } satisfies PartView;
      }

      const cell = this.caretaker.cell(key);

      if (this.computing.has(key) || cell === null) return { state: 'running', key, fn } satisfies PartView;
      const room = this.caretaker.room();
      const suspended = this.caretaker.grants().find((grant) => grant.fn === fn && grant.image !== room.image);

      if (suspended !== undefined && room.imageAuthor !== null && room.imageAuthor !== suspended.holder) {
        const editor = { email: room.imageAuthor, name: this.caretaker.members().find((member) => member.email === room.imageAuthor)?.name ?? null };

        if (suspended.personal && suspended.holder === state.email) return { state: 'edited', key, fn, editor, reach: this.reach(suspended) } satisfies PartView;

        if (!suspended.personal) return { state: 'waiting', key, fn, holder: { email: suspended.holder, name: null } } satisfies PartView;
      }

      const failed = v.safeParse(v.object({ failed: v.string() }), cell.value);

      if (failed.success) return { state: 'failed', key, fn, message: failed.output.failed } satisfies PartView;
      const seen = this.caretaker.render(key, session);

      if (!seen.shown) {
        const asked = state.email !== null && seen.hidden.every((elem) => this.caretaker.asks(elem.holder).some((ask) => ask.asker === state.email));

        return { state: 'placeholder', key, fn, sources: seen.hidden.map((elem) => this.source(elem)), asked } satisfies PartView;
      }

      const content = yield* this.contentUrl(key, state);
      const mine = cell.label.filter((elem) => elem.holder === state.email);
      const first = mine[0];

      if (first !== undefined && mine.length === cell.label.length) {
        const shows = this.caretaker.shows().filter((show) => show.holder === state.email && mine.some((elem) => elem.server === show.server && elem.root === show.root));
        let shownTo: 'anyone' | 'members' | 'me' = 'me';

        if (shows.some((show) => show.audience === 'anyone')) shownTo = 'anyone';
        else if (shows.length > 0) shownTo = 'members';

        return { state: 'mine', key, fn, source: this.source(first), shownTo, content } satisfies PartView;
      }

      return { state: 'shown', key, fn, from: cell.label.filter((elem) => elem.holder !== state.email).map((elem) => this.source(elem)), content } satisfies PartView;
    });
  }

  /** The script-free content frame's address: the app's route, with a ticket naming this session and nothing else. */
  private contentUrl(key: string, state: SocketState): Effect.Effect<string> {
    return Effect.promise(async () => {
      const room = this.caretaker.room();
      const ticket = await frameTicket(this.env, { workspace: room.workspace, handle: this.handle() }, { email: state.email, access: state.access });
      const path = `/api/rooms/${encodeURIComponent(room.workspace)}/${encodeURIComponent(room.slate)}/parts/${encodeURIComponent(key)}/content`;

      return `${this.env.CLI_PUBLIC_ORIGIN ?? ''}${path}?t=${ticket ?? ''}`;
    });
  }

  // ── Views ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Every socket gets its own view; a session that is no longer current gets why, and is closed. */
  private broadcast(): Effect.Effect<void, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const states = this.ctx.getWebSockets().map((ws) => ({ ws, state: this.socketState(ws) }));
      const sheet = yield* this.sheet();

      for (const { ws, state } of states) {
        if (state === null) continue;
        const view = yield* this.view(state, states.flatMap((each) => each.state === null || each.ws === ws ? [] : [each.state]), sheet);
        const frame: RoomServerFrame = { view };

        ws.send(JSON.stringify(frame));

        if (view.ended !== null) ws.close(4403, view.ended.kind);
      }
    });
  }

  private person(member: RoomMember | undefined, email: string): RoomPerson {
    return { email, name: member?.name ?? null };
  }

  /**
   * The slate's page for a session: the app's frame route, which knows its visitor and sends them on to the slate's own
   * host with a ticket of their own. The address names no one, so it lets no one in who holds only it; a link
   * session's carries the link's key, which its holder already has.
   */
  private frame(state: SocketState): Effect.Effect<string> {
    return Effect.promise(async () => {
      const room = this.caretaker.room();
      const path = roomFramePath(room.workspace, room.slate);
      const link = state.access.kind === 'link' ? await linkUrl(this.env, room) : null;
      const key = link === null ? null : new URL(link).searchParams.get('k');

      return `${this.env.CLI_PUBLIC_ORIGIN ?? ''}${path}${key === null ? '' : `?k=${encodeURIComponent(key)}`}`;
    });
  }

  /**
   * What forking the slate would bring this visitor: its code, and per function whether it runs with someone's lend,
   * which a fork does not keep (`Confinement.lean`: `a_fork_starts_with_its_code_alone`). Null when they may not fork.
   */
  async forkPreview(visitor: RoomVisitor | null, key: string | null): Promise<ForkPreview | null> {
    if (!this.exists() || visitor === null || await this.access(visitor, key) === null || !this.caretaker.mayFork(visitor.email)) return null;
    const room = this.caretaker.room();
    const owner = this.caretaker.members().find((member) => member.role === 'owner');
    const grants = this.caretaker.grants();
    const fns = [...new Set(grants.map((grant) => grant.fn))].sort();

    return {
      title: room.title, owner: this.person(owner, owner?.email ?? ''),
      parts: fns.map((fn) => {
        const lent = grants.find((grant) => grant.fn === fn && !grant.personal);
        const used = lent ?? grants.find((grant) => grant.fn === fn);

        return { fn, lent: lent !== undefined, needs: used === undefined ? null : serviceOf(used.server) };
      }),
    };
  }

  /** The code a visitor who may fork the slate gets: its workspace's bundle of it, or null when they may not. */
  async forkBundle(visitor: RoomVisitor, key: string | null): Promise<SlateAnswer<BlueprintBundle> | null> {
    if (await this.forkPreview(visitor, key) === null) return null;
    const room = this.caretaker.room();

    return await workspaceOwner(this.env, room.workspace).slateForkBundle(room.slate);
  }

  /** The slate's own host, entered by this visitor now: a ticket of theirs for its entry, or null when they may not open it. */
  async ticketFor(visitor: RoomVisitor | null, key: string | null): Promise<string | null> {
    if (!this.exists()) return null;
    const access = await this.access(visitor, key);

    if (access === null) return null;
    const room = this.caretaker.room();
    const origin = await slateHostOrigin(this.env, room.workspace, this.handle());
    const ticket = await frameTicket(this.env, { workspace: room.workspace, handle: this.handle() }, { email: visitor?.email ?? null, access });

    return origin === null || ticket === null ? null : `${origin}${ROOM_ENTER_PATH}?t=${ticket}`;
  }

  private view(state: SocketState, others: readonly SocketState[], sheet: SheetView): Effect.Effect<RoomView, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const room = this.caretaker.room();
      const members = this.caretaker.members();
      const owner = members.find((member) => member.role === 'owner');
      const ownerPerson = this.person(owner, owner?.email ?? '');
      const session: Session = { email: state.email, access: state.access };
      const current = this.caretaker.current(session);
      const signedIn = new Map<string, SocketState>();

      for (const each of [state, ...others]) if (each.email !== null && !signedIn.has(each.email)) signedIn.set(each.email, each);
      const removed = state.email !== null && members.some((member) => member.email === state.email && member.role === 'removed');
      const parts: Record<string, PartView> = {};

      if (current) for (const key of state.parts) parts[key] = yield* this.partView(key, state);

      return {
        session: {
          me: state.email === null ? null : this.person(members.find((member) => member.email === state.email), state.email),
          access: this.roomAccess(state.email, state.access),
          title: room.title,
          owner: ownerPerson,
          mayEdit: this.caretaker.canEdit(state.email),
          mayFork: this.caretaker.mayFork(state.email),
          members: state.access.kind === 'link' ? [] : members.filter((member) => member.role !== 'removed').map((member) => this.person(member, member.email)),
          frame: current ? yield* this.frame(state) : '',
        },
        presence: {
          here: [...signedIn.values()].map((each) => ({
            person: this.person(members.find((member) => member.email === each.email), each.email ?? ''), where: each.where, typing: each.typing,
          })),
          signedOut: [state, ...others].filter((each) => each.email === null).length,
        },
        parts,
        asks: state.email === null || !current ? [] : this.asks(state.email),
        ended: current ? null : { kind: removed ? 'removed' : 'stopped', by: ownerPerson },
        sheet: state.access.kind === 'owner' ? sheet : null,
      };
    });
  }

  private asks(holder: string): RoomAsk[] {
    const people = this.caretaker.members();
    const personOf = (email: string): RoomPerson => ({ email, name: people.find((member) => member.email === email)?.name ?? null });

    const shows: RoomAsk[] = this.caretaker.asks(holder).map((ask) => ({
      kind: 'show', id: JSON.stringify([ask.asker, ask.tag.server, ask.tag.root, ask.fn]), from: personOf(ask.asker),
      part: { key: ask.fn, fn: ask.fn }, source: this.source(ask.tag),
    }));

    const waiting: RoomAsk[] = this.caretaker.waiting(holder).flatMap((pending): RoomAsk[] => {
      const run = this.caretaker.run(pending.run);
      const grant = this.caretaker.grant(pending.grant);

      if (run === null || grant === null) return [];
      const tool = { name: pending.tool, title: pending.tool, readOnly: !grant.effect };

      if (pending.kind === 'outflow') {
        return [{ kind: 'outflow', id: pending.id, fn: run.fn, source: this.source(run.label[0] ?? grant), service: serviceOf(grant.server), tool, argument: JSON.stringify(pending.args) }];
      }

      return [{
        kind: 'effect', id: pending.id, from: personOf(run.requester?.email ?? ''), fn: run.fn, service: serviceOf(grant.server), tool,
        scope: scopeText(grant.root), argument: JSON.stringify(pending.args),
      }];
    });

    return [...shows, ...waiting];
  }

  private sheet(): Effect.Effect<SheetView> {
    return Effect.gen({ self: this }, function* () {
      const room = this.caretaker.room();
      const owner = this.caretaker.owner();
      const people = this.caretaker.members().filter((member) => member.role === 'edit' || member.role === 'use');
      let audience: RoomAudience = 'only-you';

      if (room.link) audience = 'anyone';
      else if (people.length > 0) audience = 'people';
      const grants = this.caretaker.grants();
      const personal = new Set(grants.filter((grant) => grant.personal).map((grant) => grant.holder));
      const ownFns = [...new Set(grants.filter((grant) => grant.holder === owner).map((grant) => grant.fn))];
      const shows = this.caretaker.shows();
      const url = room.link ? yield* Effect.promise(async () => linkUrl(this.env, room)) : null;

      return {
        audience, url,
        people: people.map((member) => ({ person: this.person(member, member.email), role: member.role === 'edit' ? 'edit' : 'use' })),
        privateOf: this.caretaker.members().filter((member) => member.email !== owner && personal.has(member.email)).map((member) => this.person(member, member.email)),
        listing: this.sheetListing(),
        lends: ownFns.flatMap((fn) => {
          const own = grants.find((grant) => grant.holder === owner && grant.fn === fn && grant.personal);
          const lend = grants.find((grant) => grant.holder === owner && grant.fn === fn && !grant.personal);
          const terms = lend ?? own;

          if (terms === undefined) return [];
          const suspended = lend !== undefined && lend.image !== room.image && room.imageAuthor !== null && room.imageAuthor !== owner;
          const domain: Codec = terms.domain;

          return [{
            fn, reach: this.reach(terms), free: codecIsFree(domain),
            shown: shows.some((show) => show.holder === owner && show.fn === fn && show.audience === 'anyone') ? 'everyone' as const : 'holder' as const,
            on: lend !== undefined && !suspended,
            suspendedBy: suspended ? { email: room.imageAuthor ?? '', name: null } : null,
          }];
        }),
        uses: this.caretaker.lendUses().map((use) => ({
          fn: use.fn, calls: use.calls, lastAt: use.lastAt,
          person: this.person(this.caretaker.members().find((member) => member.email === use.email), use.email),
        })),
        secret: room.secret,
      };
    });
  }
}
