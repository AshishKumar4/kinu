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
  JsonValueSchema, McpToolSurfaceSchema, ownerCaller, roomFramePath, roomPagePath, roomPartPath, sha256Hex, slateCallAddress,
  RoomClientFrameSchema,
  type JsonValue, type OpsCaller, type PartView, type Repair, type RoomAccess, type RoomAudience, type RoomCall,
  type RoomPerson, type RoomServerFrame, type RoomView, type SheetView,
  GALLERY_CATEGORIES, slateHostOrigin, type BlueprintBundle, type ForkPreview, type SerializableToolDescriptor, type SlateAnswer, type SlateSurfaceResult,
  type SharedSlateFiles, type SlateFileChange,
  type SlateSurfaceValue, type TablesAnswer,
} from '@kinu.run/core';
import {
  canonicalRoot, frameTicket, linkKeyHolds, linkUrl, ROOM_ENTER_PATH, type FrameClaim,
  RoomCaretaker, flows, initSlateRoomTables, slateAnswer, ROOT_SLATE_CALLER, planReaderCheck, searchFindsRepository,
  UNDECLARED, accessName, callArgument, joinTerms, partDecision, partFn, partKey, personOf, reachOf, rootOf, roomAsks, serviceOf, sheetView, toolTerms,
  type Access, type Audience, type Codec, type Elem, type Grant, type GrantTerms, type Need, type Run, type Session, type Tag,
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
import { browserCamera, pictureKey } from './pictures';
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

/** The process facet's surface: the runner's own boot (parsed by `Started` or `NotStarted`), its HTTP, and a call's end. */
interface ProcessFacet extends Rpc.DurableObjectBranded {
  startProcess(): Promise<JsonValue>;
  fetch(request: Request): Promise<Response>;
  /** The call may change the slate no more: whether it changed the slate's own SQL. */
  settleInvocation(invocation: string): Promise<{ readonly wrote: boolean }>;
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

/**
 * What the room records and carries on past: a Drive card it could not write, a Gallery picture it could not take, a
 * shared server it could not tell that a call's writes ended.
 */
const RECORDED = {
  card: 'slate.card_failed', picture: 'slate.gallery_picture_failed', writes: 'slate.writes_end_failed', listing: 'slate.gallery_listing_failed',
} as const;

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

  /** Parts whose call must be asked again by its requester, and why: it changed something before it stopped. */
  private readonly again = new Map<string, { readonly requester: string | null; readonly message: string }>();

  /** Parts computing now. */
  private readonly computing = new Set<string>();

  /** A run's step waiting for its holder, and how to wake it. */
  private readonly waiters = new Map<string, () => void>();

  /** The shared server, started for the image it was loaded from. */
  private server: { readonly image: string; readonly facet: Fetcher<ProcessFacet>; readonly methods: readonly string[] } | null = null;

  /** This incarnation of the room: a room retired and made again under its name loads its shared server afresh. */
  private incarnation: string = crypto.randomUUID();

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

  /**
   * The deploy's walk: this room's tables and what its repair did. A listed room writes its listing to the Gallery again
   * on the way, so a Gallery whose tables were made anew is filled again by the walk that reaches it.
   */
  opsTables(caller: OpsCaller): Promise<TablesAnswer> {
    return settle(Effect.gen({ self: this }, function* () {
      yield* attempt({ doing: 'admitting the deploy\'s walk', otherwise: 'denied' }, async () => requireOps(this.env, caller));

      if (this.storageRefusal === undefined && this.exists() && this.caretaker.listing() !== null) yield* this.recorded('listing', this.syncGallery());

      return {
        name: null, census: censusOf(this.ctx.storage.sql), repair: this.schemaRepair, refused: this.storageRefusal?.reason ?? null,
        workspaces: [], accounts: [], agents: [], rooms: [],
      } satisfies TablesAnswer;
    }));
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
      this.incarnation = crypto.randomUUID();
      // The shared server's facet holds the slate's own storage: it goes too, so a slate made again starts empty.
      this.ctx.facets.delete('server');
      yield* Effect.promise(async () => this.ctx.storage.deleteAll());
    }));
  }

  /** A Drive card the room could not write is recorded, not fatal: the slate itself is unchanged by it. */
  private cardOrRecord(email: string, card: { readonly role?: 'edit' | 'use'; readonly url?: string } | null): Effect.Effect<void> {
    return this.recorded('card', this.card(email, card));
  }

  /** Work whose failure leaves the slate as it was: recorded as `RECORDED[kind]`, and not the caller's failure. */
  private recorded(kind: keyof typeof RECORDED, work: Effect.Effect<void, KinuError>): Effect.Effect<void> {
    const room = this.caretaker.room();

    return Effect.catch(work, (failure) => Effect.sync(() => { diagnostics.failure(RECORDED[kind], failure, { workspace: room.workspace, slate: room.slate }); }));
  }

  /** The room's one alarm: the listing's picture, taken again once a sync asked for it (`repicture`). */
  override alarm(): Promise<void> {
    return settle(this.repicture());
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
    readonly secret: { readonly file: string; readonly line: number; readonly kind: string } | null; readonly source: string | null;
    readonly contracts: Readonly<Record<string, Codec>>;
  }): Promise<{ readonly methods: readonly string[] }> {
    return settle(Effect.gen({ self: this }, function* () {
      const before = this.caretaker.room().image;

      yield* care(() => { this.caretaker.publish(input.author, input); });

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
   * A worker of `image`, its env the bindings for `run`. The loader caches a worker by `id` for as long as this isolate
   * lives, its env and its module state with it: an id is never given to two runs, nor to two incarnations of the room.
   * A confined run loads the image it was admitted at, never one published since. The shared server keeps the mediated
   * egress every slate had; a confined run reaches no network at all.
   */
  private worker(id: string, image: string | null, run: number | null): Effect.Effect<WorkerStub, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const room = this.caretaker.room();
      const modules = image === null ? null : this.caretaker.modulesOf(image);

      if (modules === null) return yield* refuse('missing', 'This slate has not been built yet');
      const texts = yield* this.moduleTexts(modules);
      // Loaded on a room's first run, not at the Worker's start: the vendor module carries the whole slate runtime.
      const { workerCompatibility } = yield* attempt({ doing: 'loading the slate runtime', otherwise: 'unavailable' }, async () => import('virtual:kinu-slate-vendor'));
      const globalOutbound = run === null ? codemodeEgress({ workspace: room.workspace, actor: null, asOwner: false }) : null;

      if (run === null && globalOutbound === null) return yield* refuse('unsupported', 'A slate\'s shared server needs the shared outbound policy binding');

      return this.env.LOADER.get(id, async () => ({
        ...workerCompatibility,
        mainModule: RUNNER_MODULE,
        modules: texts,
        // `__writes`: the runner holds the slate's own SQL to the room's word on each call (`x-slate-writes`).
        env: { workspace: this.binding('workspace', run), __storage: this.binding('__storage', run), __host: this.binding('__host', run), __writes: 'room' },
        globalOutbound,
      }));
    });
  }

  /** The shared server: the image's process class, one facet whose storage outlives each image. */
  private sharedServer(): Effect.Effect<Fetcher<ProcessFacet>, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const image = this.caretaker.room().image ?? '';

      if (this.server?.image === image) return this.server.facet;
      const worker = yield* this.worker(`kinu-room:${this.name()}:${this.incarnation}:${image}`, image, null);
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

  /**
   * A confined run's facet: an isolate of its own, `isolate` naming this run and this call alone, so no other run's
   * sealed stubs or module state are in it (the model's premise that a run's label covers its whole heap). Its storage
   * is its own and dropped after.
   */
  private confined(run: Run, isolate: string): Effect.Effect<Fetcher<ProcessFacet>, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const worker = yield* this.worker(`kinu-room-run:${this.name()}:${run.image}:${isolate}`, run.image, run.id);
      const facet = this.ctx.facets.get<ProcessFacet>(`run:${isolate}`, () => ({ class: worker.getDurableObjectClass<ProcessFacet>(RUNNER_CLASS) }));

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
        owner: { email: owner?.email ?? '', name: owner?.name ?? null }, access: accessName(this.caretaker, { email: visitor?.email ?? null, access }),
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
    const called = Effect.ensuring(this.call(ws, state, call), this.releaseEnded());

    return Effect.catch(Effect.as(called, { id, refusal: null } satisfies RoomServerFrame), (error) => {
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
          yield* this.card(call.email, null);

          // The owner's removal re-keys the link: the listing carries the new one.
          return yield* this.syncGallery();
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
        case 'unshow': {
          yield* care(() => { this.unshowPart(session, call.part); });

          // What a visitor sees may be less now: the listing's picture is taken again.
          return yield* this.syncGallery();
        }

        case 'setLend': return yield* care(() => { this.setLend(actor, call.fn, call.on); });
        case 'setLendShown': {
          yield* care(() => { this.setLendShown(actor, call.fn, call.shown); });

          return yield* this.syncGallery();
        }

        // A step waiting for its holder is declined by them, which ends the run; any other `decline` answers an ask.
        case 'decline': return yield* care(() => {
          if (this.caretaker.waiting(actor ?? '').some((each) => each.id === call.ask)) this.decideWaiting(actor, call.ask, false);
          else this.answerAsk(actor, call.ask, 'decline');
        });
        case 'showTo': case 'showToMembers': return yield* care(() => { this.answerAsk(actor, call.ask, call.op); });
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
        readsAuthor: grants.some((grant) => !grant.personal), picture: this.caretaker.listing()?.picture ?? null,
      }));
      // Taken past this call: a browser takes seconds, and the listing is right without it.
      yield* Effect.promise(async () => this.ctx.storage.setAlarm(Date.now()));
    });
  }

  /**
   * The Gallery's picture of the slate: its page as a visitor holding only the link sees it, never its owner's own view,
   * taken again each time the listing is synced, from the room's alarm. A failure is recorded.
   */
  private repicture(): Effect.Effect<void> {
    const { BROWSER: browser, SLATE_PICTURES: bucket } = this.env;

    if (!this.exists()) return Effect.void;
    const room = this.caretaker.room();

    if (browser === undefined || bucket === undefined || !room.link || this.caretaker.listing() === null) return Effect.void;
    const at = { workspace: room.workspace, handle: this.handle() };

    return this.recorded('picture', Effect.gen({ self: this }, function* () {
      const origin = yield* Effect.promise(async () => slateHostOrigin(this.env, at.workspace, at.handle));
      const ticket = yield* Effect.promise(async () => frameTicket(this.env, at, { email: null, access: { kind: 'link', gen: room.linkGen } }));

      if (origin === null || ticket === null) return;
      const camera = yield* attempt({ doing: 'opening a browser', otherwise: 'unavailable' }, async () => browserCamera(browser));

      const shot = yield* Effect.ensuring(
        attempt({ doing: 'photographing the slate as a visitor sees it', otherwise: 'unavailable' }, async () => camera.shoot(`${origin}${ROOM_ENTER_PATH}?t=${ticket}`)),
        Effect.promise(async () => camera.close()),
      );

      const digest = sha256Hex(shot);
      const previous = this.caretaker.listing()?.picture ?? null;

      if (digest === previous) return;
      yield* attempt({ doing: 'storing the Gallery picture', otherwise: 'unavailable' },
        async () => bucket.put(pictureKey(room.workspace, room.slate, digest), shot, { httpMetadata: { contentType: 'image/webp' } }));

      if (this.caretaker.pictured(digest)) {
        yield* attempt({ doing: 'showing the picture in the Gallery', otherwise: 'unavailable' },
          async () => this.env.GALLERY.get(this.env.GALLERY.idFromName(GALLERY_OBJECT)).pictured(room.workspace, room.slate, digest));
      }

      if (previous !== null) yield* attempt({ doing: 'dropping the last Gallery picture', otherwise: 'unavailable' }, async () => bucket.delete(pictureKey(room.workspace, room.slate, previous)));
    }));
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

  /**
   * What a grant of `tool` is, held by `holder` (`room/terms.ts`): an MCP tool by its own server's read-only mark, as the
   * holder's account describes it; the workspace's own by what each member does.
   */
  private termsFor(holder: string, server: string, tool: string): Effect.Effect<GrantTerms, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const readOnly = server.startsWith('mcp.') && (yield* this.mcpDescriptor(holder, server, tool))?.readOnly === true;

      return toolTerms(server, tool, readOnly) ?? (yield* refuse('denied', `${server}.${tool} is not something a slate reaches`));
    });
  }

  /**
   * "Allow" on a part: the requester grants their own connection to the function that needed it, and the call that
   * needed it runs once more, now holding it. "Use again" after someone else's edit: their own grant follows the image
   * now running, and the part's call runs once more.
   */
  private allow(session: Session, part: string): Effect.Effect<void, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const need = this.needs.get(part);
      const email = session.email;

      if (email === null) return yield* refuse('denied', 'Sign in to allow anything');

      if (need !== undefined && need.requester === email) {
        yield* this.personalGrant(email, need);
        this.needs.delete(part);

        return yield* this.completeOnce(part, need.call.session ?? session, need.call.args);
      }

      const output = this.caretaker.output(part);
      const room = this.caretaker.room();
      const edited = output === null ? [] : this.caretaker.grants().filter((grant) => grant.personal && grant.holder === email && grant.fn === output.fn && grant.image !== room.image);

      if (output === null || edited.length === 0 || output.requester !== email) return yield* refuse('missing', 'This part asks nothing of you now');
      yield* care(() => this.caretaker.renew(email, output.fn));

      return yield* this.completeOnce(part, session, Array.isArray(output.input) ? output.input : []);
    });
  }

  /** A part's call, run once more for its requester, its answer going to the part. A refusal shows on the part. */
  private completeOnce(part: string, session: Session, args: readonly JsonValue[]): Effect.Effect<void, KinuError> {
    return Effect.gen({ self: this }, function* () {
      this.again.delete(part);
      const outcome = yield* Effect.result(this.callMethod(session, partFn(part), args, 'part'));

      if (outcome._tag === 'Failure' && !this.needs.has(part)) this.again.set(part, { requester: session.email, message: outcome.failure.message });
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
        // Decided by what each connection is, never by its name: a server someone named GitHub takes no part in a check.
        const plan = planReaderCheck(elem, yield* this.mcpSurface(elem.holder), yield* this.mcpSurface(email));

        if (plan.kind === 'unsupported') return yield* refuse('unsupported', `${serviceOf(elem.server).title} cannot say who reads it; ask ${elem.holder} instead`);

        if (plan.kind === 'no-connection') return yield* refuse('missing', 'Connect your own GitHub to check');
        const { tool: descriptor, owner, repo } = plan;
        const account = yield* attempt({ doing: 'naming the account', otherwise: 'unavailable' }, async () => accountIdFor(this.env, email));
        const caller = yield* attempt({ doing: 'reaching the account', otherwise: 'unavailable' }, async () => ownerCaller(this.env));

        const answered = yield* attempt({ doing: `asking ${serviceOf(elem.server).title} who reads ${owner}/${repo}`, otherwise: 'unavailable' },
          async () => callUserMcpTool({ stub: this.userObject(account), caller }, descriptor, { query: `repo:${owner}/${repo}` }, undefined));

        yield* care(() => { this.caretaker.checked(email, elem, searchFindsRepository(answered, owner, repo)); });
      }
    });
  }

  /**
   * A person's own connection granted to the function that needed it, for their own requests. A grant they hold for that
   * function on that very source keeps its tools and takes this one, its terms the join of both (`joinTerms`).
   */
  private personalGrant(holder: string, need: Need): Effect.Effect<void, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const root = canonicalRoot(need.root);

      const held = this.caretaker.grants().find((grant) => grant.personal && grant.holder === holder && grant.server === need.server
        && grant.root === root && grant.fn === need.fn);

      const asked = yield* this.termsFor(holder, need.server, need.tool);
      const terms = held === undefined ? asked : joinTerms(held, asked);

      yield* care(() => {
        this.caretaker.mint(holder, {
          personal: true, server: need.server, root: need.root, tools: [...new Set([...held?.tools ?? [], need.tool])], fn: need.fn,
          domain: this.caretaker.contract(need.fn) ?? UNDECLARED, effect: terms.effect, sink: terms.sink,
        });
      });
    });
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
        // A lend admits only what the function declares it takes; one that declares nothing takes what its call carries.
        fn, domain: this.caretaker.contract(fn) ?? UNDECLARED, effect: grant.effect, sink: grant.sink,
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
    const audience: Audience = scope === 'anyone' ? 'anyone' : this.caretaker.everyoneAdded();

    for (const elem of this.cellLabel(part).filter((each) => each.holder === session.email)) this.caretaker.show(session.email, elem, elem.fn, audience);
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
    else if (op === 'showToMembers') this.caretaker.show(actor, tag, fn, this.caretaker.everyoneAdded());
    else this.caretaker.dismissAsk(actor ?? '', asker, tag, fn);
  }

  /**
   * After every call of a session: each step still waiting whose run that call ended (a grant taken back, a person
   * removed, the link stopped) is woken, so its run meets the refusal at once; and the shared server is told of each run
   * that may change the slate no more.
   */
  private releaseEnded(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      for (const [id, wake] of this.waiters) {
        if (!this.caretaker.stillWaiting(id) && !this.caretaker.decided(id)) wake();
      }

      for (const [invocation, runId] of this.invocations) {
        const run = this.caretaker.run(runId);

        if (run !== null && !this.caretaker.mayPost(runId) && this.server !== null) {
          const { facet } = this.server;

          yield* this.recorded('writes', attempt({ doing: 'ending a call\'s writes', otherwise: 'unavailable' }, async () => { await facet.settleInvocation(invocation); }));
        }
      }
    });
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
      // A page's own request runs as a call of its own: it may change the slate only for someone signed in, now.
      const run = yield* care(() => this.caretaker.admit({ requester: session, fn: 'fetch', input: null, grants: [], inputs: [], out: null }));
      const invocation = this.invoke(run);
      const headers = new Headers(request.headers);

      headers.set('x-slate-call', invocation);

      if (this.caretaker.mayPost(run.id)) headers.set('x-slate-writes', '1');

      return yield* Effect.ensuring(
        Effect.flatMap(this.sharedServer(), (server) => attempt({ doing: 'serving the slate page', otherwise: 'unavailable' },
          async () => server.fetch(new Request(request, { headers })))),
        Effect.gen({ self: this }, function* () {
          yield* this.settleRun(invocation, true);
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

  /**
   * The run's code has answered: its invocation goes, and the shared server ends its writes. What it answers is whether
   * the call changed the slate's own SQL, which is one of the call's effects.
   */
  private settleRun(invocation: string, shared: boolean): Effect.Effect<boolean> {
    return Effect.gen({ self: this }, function* () {
      this.invocations.delete(invocation);
      const server = shared ? this.server : null;

      if (server === null) return false;
      const settled = yield* Effect.result(attempt({ doing: 'ending the call\'s writes', otherwise: 'unavailable' }, async () => server.facet.settleInvocation(invocation)));

      return settled._tag === 'Success' && settled.success.wrote;
    });
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
   * One call of the slate's code. Its answer goes back as itself to a `person` who may see its label (their own agent's
   * call); to a `page`, whose code anyone who opens the slate runs, only if its label is empty or shown to anyone; to a
   * `part`, never: it shows in the part's sealed frame.
   *
   * A call that reaches a connection it does not hold stops there. When its requester runs code wholly theirs and it
   * changed nothing yet, the connection is granted (their own code is their consent) and it runs again, once per
   * connection it reaches; otherwise its part asks the requester, and runs once more when they allow it. A call that
   * already changed something is never run again by the room: its part says to ask it again.
   */
  private callMethod(session: Session | null, fn: string, args: readonly JsonValue[], to: 'page' | 'part' | 'person'): Effect.Effect<RoomCallOutcome, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const requester = session?.email ?? null;
      const asked = partKey(fn, args, requester);

      if (this.needs.get(asked)?.requester === requester) return { part: { key: asked, frame: this.partFrame(asked) } };

      for (;;) {
        const attempted = yield* this.attemptCall(session, fn, args, to);

        if (attempted.kind === 'done') return attempted.outcome;
        const need = this.needs.get(asked);

        if (need === undefined) return yield* Effect.fail(attempted.failure);

        if (requester === null || !this.caretaker.ownCode(requester)) {
          if (attempted.changed) {
            this.needs.delete(asked);
            this.again.set(asked, { requester, message: `${fn} changed something before it reached a connection it needs: ask it again once you allow it` });
          }

          return { part: { key: asked, frame: this.partFrame(asked) } };
        }

        yield* this.personalGrant(requester, need);
        this.needs.delete(asked);

        if (attempted.changed) return yield* refuse('unavailable', `${fn} changed something before it reached your ${serviceOf(need.server).title}: it holds it now, so call it again`);
      }
    });
  }

  /** One admission of a call, run to its end: its outcome, or its failure and whether it changed anything first. */
  private attemptCall(session: Session | null, fn: string, args: readonly JsonValue[], to: 'page' | 'part' | 'person'): Effect.Effect<
    { readonly kind: 'done'; readonly outcome: RoomCallOutcome } | { readonly kind: 'failed'; readonly failure: KinuError; readonly changed: boolean }, KinuError
  > {
    return Effect.gen({ self: this }, function* () {
      const input: JsonValue = [...args];
      const grants = this.caretaker.grantsFor(session, fn, input);
      const requester = session?.email ?? null;
      const shared = grants.length === 0;
      const key = partKey(fn, args, grants.some((grant) => grant.personal) ? requester : null);
      // A call that holds a grant keeps its output as a part; one that holds none answers straight back, unless asked for a part.
      const out = shared && to !== 'part' ? null : key;
      const run = yield* care(() => this.caretaker.admit({ requester: session, fn, input, grants: grants.map((grant) => grant.id), inputs: [], out }));

      return yield* Effect.ensuring(Effect.gen({ self: this }, function* () {
        const answered = yield* this.runMethod(run, shared);

        if (answered.kind === 'failed') {
          // A run whose session ended meanwhile writes nothing: its refusal is the caller's answer.
          if (out !== null && !this.needs.has(key) && this.caretaker.runOk(run)) yield* care(() => { this.caretaker.write(run.id, { failed: answered.failure.message }); });

          return { kind: 'failed' as const, failure: answered.failure, changed: answered.changed || run.effects > 0 };
        }

        return { kind: 'done' as const, outcome: yield* this.delivered(run, { session, key: out, to }, answered.value) };
      }), Effect.sync(() => {
        this.caretaker.finish(run.id);
      }));
    });
  }

  /**
   * What a run returns, delivered: written to its own output, then let through one final check for every way it goes
   * back (`release` for a person, `releaseToPage` for page code), the run and the session both current now.
   */
  private delivered(run: Run, call: { readonly session: Session | null; readonly key: string | null; readonly to: 'page' | 'part' | 'person' }, value: JsonValue): Effect.Effect<RoomCallOutcome, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const { session, key, to } = call;

      if (key !== null) {
        yield* care(() => { this.caretaker.write(run.id, value); });
        yield* this.broadcast();
      }

      const released = to === 'person' && session !== null
        ? yield* care(() => this.caretaker.release(run.id, session))
        : to === 'page' && (yield* care(() => this.caretaker.releaseToPage(run.id, session)));

      if (released) return { value };

      if (key === null) return yield* refuse('denied', 'This answer holds data you cannot see');

      return { part: { key, frame: this.partFrame(key) } };
    });
  }

  /**
   * A page's own `workspace` call: a run of no method of the slate's, for its session, released to it before it ends.
   * One that reaches a connection its person does not hold stops before it reaches anything; when the page is code wholly
   * theirs, the connection is granted (their own code is their consent) and the call is made once more, now holding it.
   */
  private pageCall(session: Session, path: readonly string[], args: readonly JsonValue[]): Effect.Effect<RoomCallOutcome, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const asked = partKey(PAGE_CALL, args, session.email);
      const first = yield* Effect.result(this.pageCallOnce(session, path, args));

      if (first._tag === 'Success') return first.success;
      const need = this.needs.get(asked);
      const email = session.email;

      if (need === undefined || email === null || !this.caretaker.ownCode(email)) return yield* Effect.fail(first.failure);
      yield* this.personalGrant(email, need);
      this.needs.delete(asked);

      return yield* this.pageCallOnce(session, path, args);
    });
  }

  private pageCallOnce(session: Session, path: readonly string[], args: readonly JsonValue[]): Effect.Effect<RoomCallOutcome, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const grants = this.caretaker.grantsFor(session, PAGE_CALL, [...args]);
      const run = yield* care(() => this.caretaker.admit({ requester: session, fn: PAGE_CALL, input: [...args], grants: grants.map((grant) => grant.id), inputs: [], out: null }));

      return yield* Effect.ensuring(Effect.gen({ self: this }, function* () {
        const value = yield* this.surfaceCall(run, path, args);

        if (value instanceof ReadableStream || (value !== null && typeof value === 'object' && 'reply' in value)) {
          return yield* refuse('unsupported', 'A page reads a streamed answer through its slate\'s server');
        }

        if (!(yield* care(() => this.caretaker.release(run.id, session)))) return yield* refuse('denied', 'This answer holds data you cannot see');

        return { value };
      }), Effect.sync(() => { this.caretaker.finish(run.id); }));
    });
  }

  private partFrame(key: string): string {
    const room = this.caretaker.room();

    return `${this.env.CLI_PUBLIC_ORIGIN ?? ''}${roomPartPath(room.workspace, room.slate, key)}`;
  }

  /**
   * Runs `run.fn` under an invocation naming the run: in the shared server for a call that holds no grant, which may
   * change the slate only as `mayPost` says; else confined, in an isolate of its own for this call alone (the model's
   * premise that a run's label covers its whole heap), dropped after. Its failure answers whether it changed anything.
   */
  private runMethod(run: Run, shared: boolean): Effect.Effect<{ readonly kind: 'done'; readonly value: JsonValue } | { readonly kind: 'failed'; readonly failure: KinuError; readonly changed: boolean }, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const isolate = `${String(run.id)}:${crypto.randomUUID()}`;
      const invocation = this.invoke(run);
      const writes = !shared || this.caretaker.mayPost(run.id);

      if (!shared) {
        this.computing.add(run.out ?? '');
        yield* this.broadcast();
      }

      let changed = false;

      const answered = yield* Effect.result(Effect.ensuring(Effect.gen({ self: this }, function* () {
        const facet = shared ? yield* this.sharedServer() : yield* this.confined(run, isolate);

        return yield* attempt({ doing: `slate ${run.fn}`, otherwise: 'io' }, async () => {
          const stub = slateBatchStub<Record<string, (...args: JsonValue[]) => Promise<JsonValue | undefined>>>({
            request: async (request) => {
              const headers = new Headers(request.headers);

              if (writes) headers.set('x-slate-writes', '1');

              return facet.fetch(new Request(request, { headers }));
            },
          }, invocation);

          try {
            return await stub[run.fn](...(Array.isArray(run.input) ? run.input : []));
          } finally {
            stub[Symbol.dispose]();
          }
        });
      }), Effect.gen({ self: this }, function* () {
        changed = yield* this.settleRun(invocation, shared);

        if (!shared) {
          this.computing.delete(run.out ?? '');
          this.ctx.facets.delete(`run:${isolate}`);
        }
      })));

      if (answered._tag === 'Failure') return { kind: 'failed' as const, failure: answered.failure, changed };
      const value = v.safeParse(JsonValueSchema, answered.success ?? null);

      if (!value.success) return { kind: 'failed' as const, failure: new KinuError('bad_input', `${run.fn} must return a JSON value`), changed };

      return { kind: 'done' as const, value: value.output };
    });
  }

  // ── What code calls ─────────────────────────────────────────────────────────────────────────────────────────────

  /** Every call a slate's code makes, through the stub its env holds: the stub's sealed props name its binding and run. */
  bindingCall(props: RoomBindingProps, request: { readonly path: string[]; readonly args: JsonValue[]; readonly invocation: string | null }): Promise<SlateSurfaceResult> {
    return settle(slateAnswer(`slate ${props.binding}`, Effect.gen({ self: this }, function* () {
      // A confined run's stub names its run, and every call through it is that run's; the shared server's names none, and
      // is told the run by its invocation. Outside any call (a class's constructor) there is no run at all.
      const invoked = request.invocation === null ? null : this.invocations.get(request.invocation) ?? null;

      if (props.run !== null && invoked !== null && invoked !== props.run) return yield* refuse('denied', 'This call belongs to no run of this stub');
      const runId = props.run ?? invoked;
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

  /**
   * The slate's key-value state. Outside a call, its public state may be read and nothing changed; in a call, what it
   * reads lies within its label and what it changes is the caretaker's to allow (`post`): its run current and signed in,
   * and nothing private read.
   */
  private storage(run: Run | null, member: string, args: readonly JsonValue[]): Effect.Effect<JsonValue, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const key = v.parse(v.string(), args[0] ?? '');

      switch (member) {
        case 'get': {
          const cell = this.caretaker.cell(key);
          let value: JsonValue = null;

          if (run !== null) value = yield* care(() => this.caretaker.observe(run.id, key));
          else if (cell !== null && cell.label.length === 0) value = cell.value;

          return value === null ? null : { value };
        }

        case 'put': case 'delete': {
          if (run === null) return yield* refuse('denied', 'The slate changes only in a call');
          const value = member === 'put' ? v.parse(JsonValueSchema, args[1] ?? null) : null;

          return yield* care(() => this.caretaker.post(run.id, key, value));
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
   * A workspace call from a run: through a grant the run holds for that service and tool. Its transport is made ready
   * first; then the caretaker's tool step, and, at once after it (or after the holder's approval and its resumption),
   * the call itself, so no revoke lands between the last check and the dispatch. With no grant, the run's requester is
   * asked to allow their own connection, and the call refuses.
   */
  private surfaceCall(run: Run, path: readonly string[], args: readonly JsonValue[]): Effect.Effect<SlateSurfaceValue, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const address = slateCallAddress(path);
      const server = address.namespace;
      const tool = address.member;
      const callArgs = callArgument(args);
      const root = canonicalRoot(rootOf(server, callArgs));

      const held = run.caps.map((id) => this.caretaker.grant(id)).find((grant): grant is Grant => grant !== null
        && grant.server === server && grant.tools.includes(tool) && grant.root === root);

      if (held === undefined) {
        const requester = run.requester?.email ?? null;
        const key = partKey(run.fn, Array.isArray(run.input) ? run.input : [], requester);

        this.needs.set(key, { fn: run.fn, server, tool, root: rootOf(server, callArgs), requester, call: { session: run.requester, args: Array.isArray(run.input) ? run.input : [] } });
        yield* this.broadcast();

        return yield* refuse('denied', requester === null ? `${run.fn} needs a connection someone lends it` : `${run.fn} needs your ${serviceOf(server).title}: allow it on the part`);
      }

      const send = yield* this.transport(held, path, args);
      const verdict = yield* care(() => this.caretaker.toolStep(run.id, held.id, tool, callArgs));

      if (verdict.kind === 'wait') {
        const decided = new Promise<void>((resolve) => { this.waiters.set(verdict.pending.id, resolve); });

        yield* Effect.ensuring(Effect.gen({ self: this }, function* () {
          yield* this.broadcast();
          yield* Effect.promise(async () => decided);
        }), Effect.sync(() => { this.waiters.delete(verdict.pending.id); }));
        yield* care(() => { this.caretaker.resume(verdict.pending.id); });
      }

      return yield* send;
    });
  }

  /**
   * How a tool step reaches its holder's own account, made ready before the step is checked: the owner's through their
   * workspace, anyone else's MCP server through their own account. Nothing it does reaches a service until it is called.
   */
  private transport(grant: Grant, path: readonly string[], args: readonly JsonValue[]): Effect.Effect<Effect.Effect<SlateSurfaceValue, KinuError>, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const room = this.caretaker.room();

      if (grant.holder === this.caretaker.owner()) {
        const owner = workspaceOwner(this.env, room.workspace);

        return Effect.gen(function* () {
          const result = yield* attempt({ doing: `${grant.server} for the slate`, otherwise: 'unavailable' },
            async () => owner.slateCallAs(ROOT_SLATE_CALLER, room.slate, 'workspace', { path: [...path], args: [...args], invocation: null }));

          return result.ok ? result.value : yield* refuse(result.reason, result.error);
        });
      }

      if (!grant.server.startsWith('mcp.')) return yield* refuse('unsupported', `Only the slate's owner lends ${grant.server}; a person's own connections in a room are MCP servers`);
      const tool = path.at(-1) ?? '';
      const descriptor = (yield* this.mcpDescriptor(grant.holder, grant.server, tool)) ?? (yield* refuse('missing', `${grant.holder}'s ${grant.server.slice(4)} offers no ${tool}`));
      const account = yield* attempt({ doing: 'naming the account', otherwise: 'unavailable' }, async () => accountIdFor(this.env, grant.holder));
      const caller = yield* attempt({ doing: 'reaching the account', otherwise: 'unavailable' }, async () => ownerCaller(this.env));
      const callArgs = v.parse(v.record(v.string(), JsonValueSchema), args[0] ?? {});
      const stub = this.userObject(account);

      return Effect.map(attempt({ doing: `${tool} for the slate`, otherwise: 'unavailable' }, async () => callUserMcpTool({ stub, caller }, descriptor, callArgs, undefined)),
        (answered): SlateSurfaceValue => v.parse(JsonValueSchema, JSON.parse(answered)));
    });
  }

  private userObject(account: string): DurableObjectStub<UserDO> {
    return this.env.UserDO.get(this.env.UserDO.idFromName(account));
  }

  /** A person's MCP tools, as their own account describes them. */
  private mcpSurface(email: string): Effect.Effect<SerializableToolDescriptor[], KinuError> {
    return Effect.gen({ self: this }, function* () {
      const account = yield* attempt({ doing: 'naming the account', otherwise: 'unavailable' }, async () => accountIdFor(this.env, email));
      const caller = yield* attempt({ doing: 'reaching the account', otherwise: 'unavailable' }, async () => ownerCaller(this.env));
      const listed = yield* attempt({ doing: 'reading the connections', otherwise: 'unavailable' }, async () => this.userObject(account).userMcp_toolDescriptors(caller));

      return v.parse(McpToolSurfaceSchema, listed).descriptors;
    });
  }

  private mcpDescriptor(holder: string, server: string, tool: string): Effect.Effect<SerializableToolDescriptor | null, KinuError> {
    return Effect.map(this.mcpSurface(holder), (descriptors) => descriptors.find((each) => each.serverName === server.slice('mcp.'.length) && each.name === tool) ?? null);
  }

  // ── Parts ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /** A part's sealed content, as a current session may see it (`room-parts.ts`). */
  async partContent(claim: Pick<FrameClaim, 'email' | 'access'>, key: string): Promise<Response> {
    const session: Session = claim;

    if (!this.caretaker.current(session) || this.caretaker.cell(key) === null) return new Response('Not found', { status: 404 });
    const seen = this.caretaker.render(key, session);
    const host = await slateHostOrigin(this.env, this.caretaker.room().workspace, this.handle());

    return sealedPart(seen.shown ? seen.value : null, host);
  }

  /** A part as a session sees it: decided by `partDecision` before anything it holds is read, then dressed for the view. */
  private partView(key: string, state: SocketState): Effect.Effect<PartView, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const fn = partFn(key);
      const session: Session = { email: state.email, access: state.access };
      const decided = partDecision(this.caretaker, key, session, { need: this.needs.get(key), computing: this.computing.has(key), again: this.again.get(key) });

      switch (decided.kind) {
        case 'needs-sign-in': case 'running': return { state: decided.kind, key, fn } satisfies PartView;
        case 'needs-connection': {
          const { need } = decided;
          const email = state.email ?? '';
          const { effect } = yield* this.termsFor(email, need.server, need.tool);
          const connected = !need.server.startsWith('mcp.') || (yield* this.mcpDescriptor(email, need.server, need.tool)) !== null;

          return { state: 'needs-connection', key, fn, reach: reachOf({ server: need.server, tools: [need.tool], root: JSON.stringify(need.root), effect }), connected } satisfies PartView;
        }

        case 'edited': return { state: 'edited', key, fn, editor: decided.editor, reach: reachOf(decided.grant) } satisfies PartView;
        case 'waiting': return { state: 'waiting', key, fn, holder: decided.holder } satisfies PartView;
        case 'placeholder': return { state: 'placeholder', key, fn, sources: decided.sources, asked: decided.asked } satisfies PartView;
        case 'failed': return { state: 'failed', key, fn, message: decided.message } satisfies PartView;
        case 'mine': return { state: 'mine', key, fn, source: decided.source, shownTo: decided.shownTo, content: yield* this.contentUrl(key, state) } satisfies PartView;
        case 'shown': return { state: 'shown', key, fn, from: decided.from, content: yield* this.contentUrl(key, state) } satisfies PartView;
      }
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
      const room = this.caretaker.room();
      const url = room.link ? yield* Effect.promise(async () => linkUrl(this.env, room)) : null;
      const sheet = sheetView(this.caretaker, url, this.sheetListing());

      for (const { ws, state } of states) {
        if (state === null) continue;
        const view = yield* this.view(state, states.flatMap((each) => each.state === null || each.ws === ws ? [] : [each.state]), sheet);
        const frame: RoomServerFrame = { view };

        ws.send(JSON.stringify(frame));

        if (view.ended !== null) ws.close(4403, view.ended.kind);
      }
    });
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
    const owner = this.caretaker.owner();
    const grants = this.caretaker.grants();
    const fns = [...new Set(grants.map((grant) => grant.fn))].sort();

    return {
      title: room.title, owner: personOf(this.caretaker.members(), owner),
      parts: fns.map((fn) => {
        const lent = grants.find((grant) => grant.fn === fn && !grant.personal);
        const used = lent ?? grants.find((grant) => grant.fn === fn);

        return { fn, lent: lent !== undefined, needs: used === undefined ? null : serviceOf(used.server) };
      }),
    };
  }

  /** Who published the code running now: its owner, or someone they added to edit it. Null before it first ran. */
  async author(): Promise<string | null> {
    return this.exists() ? this.caretaker.room().imageAuthor : null;
  }

  /**
   * The slate's files, for someone the owner added to edit it, read by their own agent from their own workspace. The
   * workspace that asks names its owner; the room answers only a person it lets edit.
   */
  async editorFiles(editor: string): Promise<SlateAnswer<SharedSlateFiles> | null> {
    if (!this.exists() || !this.caretaker.canEdit(editor)) return null;
    const room = this.caretaker.room();

    return await workspaceOwner(this.env, room.workspace).slateFilesFor(room.slate);
  }

  /**
   * An editor's change to the slate's files: written in its owner's workspace, built there, and published here as the
   * editor's, so the editor's own grants follow it and everyone else's wait for their holders (`RoomCaretaker.publish`).
   */
  async editorEdit(editor: string, files: SlateFileChange): Promise<SlateAnswer<readonly string[]> | null> {
    if (!this.exists() || !this.caretaker.canEdit(editor)) return null;
    const room = this.caretaker.room();

    return await workspaceOwner(this.env, room.workspace).editSlateAs(room.slate, editor, files);
  }

  /** The code a visitor who may fork the slate gets: its workspace's bundle of it, or null when they may not. */
  async forkBundle(visitor: RoomVisitor, key: string | null): Promise<SlateAnswer<BlueprintBundle> | null> {
    if (await this.forkPreview(visitor, key) === null) return null;
    const room = this.caretaker.room();
    const { source } = room;

    if (source === null) return await settle(slateAnswer('forking the slate', Effect.fail(new KinuError('missing', 'This slate has no files to fork'))));

    return await workspaceOwner(this.env, room.workspace).slateForkBundle(room.slate, source);
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
      const ownerPerson = personOf(members, this.caretaker.owner());
      const session: Session = { email: state.email, access: state.access };
      const current = this.caretaker.current(session);
      const signedIn = new Map<string, SocketState>();

      for (const each of [state, ...others]) if (each.email !== null && !signedIn.has(each.email)) signedIn.set(each.email, each);
      const removed = state.email !== null && members.some((member) => member.email === state.email && member.role === 'removed');
      const parts: Record<string, PartView> = {};

      if (current) for (const key of state.parts) parts[key] = yield* this.partView(key, state);

      return {
        session: {
          me: state.email === null ? null : personOf(members, state.email),
          access: accessName(this.caretaker, session),
          title: room.title,
          owner: ownerPerson,
          mayEdit: this.caretaker.canEdit(state.email),
          mayFork: this.caretaker.mayFork(state.email),
          members: state.access.kind === 'link' ? [] : members.filter((member) => member.role !== 'removed').map((member) => personOf(members, member.email)),
          frame: current ? yield* this.frame(state) : '',
        },
        presence: {
          here: [...signedIn.values()].map((each) => ({ person: personOf(members, each.email ?? ''), where: each.where, typing: each.typing })),
          signedOut: [state, ...others].filter((each) => each.email === null).length,
        },
        parts,
        asks: state.email === null || !current ? [] : roomAsks(this.caretaker, state.email),
        ended: current ? null : { kind: removed ? 'removed' : 'stopped', by: ownerPerson },
        sheet: state.access.kind === 'owner' ? sheet : null,
      };
    });
  }
}
