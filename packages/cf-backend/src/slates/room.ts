/**
 * `SlateRoom`: one per slate, the one object every use of it goes through (docs/SLATE-SHARING-SECURITY.md §2.3). Its
 * caretaker (`RoomCaretaker`) holds who may do what; this object holds the sockets, and pushes each session its own
 * `RoomView` after every change. A session whose access ends is told why and closed, at once.
 *
 * Named by its workspace and handle (`room-passes.ts`). The Worker's routes authenticate, then hand the room a person:
 * an email and a name, or nobody for a visitor who has not signed in.
 */
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import {
  censusOf, durableStamps, readStamp, repairSchema, requireOps, SCHEMA_TABLES, StoragePredatesReleaseError, writeStamp,
  type OpsCaller, type Repair, type TablesAnswer,
  RoomClientFrameSchema, type RoomAccess, type RoomAsk, type RoomAudience, type RoomCall, type RoomPerson, type RoomServerFrame,
  type RoomView, type SheetView,
} from '@kinu.run/core';
import { RoomCaretaker, initSlateRoomTables, linkKeyHolds, linkUrl, type Access, type RoomMember, type Session } from '@kinu.run/core/slates';
import { Effect, Result } from 'effect';
import { attempt, inItsWords, KinuError, settle, settleSync } from '@kinu.run/core/obs';


/** Who a request is, as the Worker's route proved it. */
export interface RoomVisitor {
  readonly email: string;
  readonly name: string;
}

/** The answer to "may this person open the room now", before any socket. */
export type RoomEntryAnswer =
  | { readonly status: 200; readonly title: string; readonly owner: RoomPerson; readonly access: RoomAccess }
  | { readonly status: 401 | 403 | 404 | 410 };

/** What a socket remembers through hibernation: the session it was opened as, and what its page reports. */
const SocketState = v.object({
  email: v.nullable(v.string()),
  name: v.nullable(v.string()),
  access: v.variant('kind', [
    v.object({ kind: v.literal('owner') }),
    v.object({ kind: v.literal('member'), gen: v.number() }),
    v.object({ kind: v.literal('link'), gen: v.number() }),
  ]),
  parts: v.array(v.string()),
  where: v.nullable(v.string()),
  typing: v.nullable(v.string()),
});

type SocketState = v.InferOutput<typeof SocketState>;

/** The headers the Worker's route sets, after deleting any the request carried. */
export const ROOM_PERSON_HEADER = 'x-kinu-room-person';

export const ROOM_KEY_HEADER = 'x-kinu-room-key';

const RoomPersonHeader = v.object({ email: v.string(), name: v.string() });

export class SlateRoom extends DurableObject<Env> {
  private readonly caretaker: RoomCaretaker;

  /** What this activation's repair did, for the deploy's walk; null where the storage was at this build. */
  private readonly schemaRepair: Repair | null;

  /** Why this room's storage may not be read: its repair could not bring it to this build. */
  private readonly storageRefusal: StoragePredatesReleaseError | undefined;

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
      yield* inItsWords('io', Effect.sync(() => { this.caretaker.remove(email, email); }));
      yield* Effect.promise(async () => this.broadcast());
    }));
  }

  exists(): boolean {
    if (this.storageRefusal !== undefined) return settleSync(Effect.fail(this.storageRefusal));
    const made = this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'room'").toArray().length > 0;

    return made && this.ctx.storage.sql.exec('SELECT 1 FROM room WHERE id = 1').toArray().length > 0;
  }

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

  // ── Sockets ─────────────────────────────────────────────────────────────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Not found', { status: 404 });

    if (!this.exists()) return new Response('Not found', { status: 404 });
    const header = request.headers.get(ROOM_PERSON_HEADER);
    const visitor = header === null ? null : v.parse(RoomPersonHeader, JSON.parse(header));
    const access = await this.access(visitor, request.headers.get(ROOM_KEY_HEADER));

    if (access === null) return new Response('Not shared with you', { status: 403 });

    if (visitor !== null && access.kind !== 'link') this.caretaker.named(visitor.email, visitor.name);
    const pair = new WebSocketPair();
    const state: SocketState = { email: visitor?.email ?? null, name: visitor?.name ?? null, access, parts: [], where: null, typing: null };

    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment(state);
    await this.broadcast();

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const state = this.socketState(ws);
    const frame = v.safeParse(RoomClientFrameSchema, JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)));

    if (state === null || !frame.success) return;

    return settle(Effect.gen({ self: this }, function* () {
      ws.send(JSON.stringify(yield* this.answer(ws, state, frame.output.id, frame.output.call)));
      yield* Effect.promise(async () => this.broadcast());
    }));
  }

  override async webSocketClose(): Promise<void> {
    await this.broadcast();
  }

  private socketState(ws: WebSocket): SocketState | null {
    const parsed = v.safeParse(SocketState, ws.deserializeAttachment());

    return parsed.success ? parsed.output : null;
  }

  /** A call's answer frame: done, or refused in the room's words. It never fails. */
  private answer(ws: WebSocket, state: SocketState, id: number, call: RoomCall): Effect.Effect<RoomServerFrame> {
    return Effect.map(Effect.result(this.call(ws, state, call)), (done): RoomServerFrame => {
      if (Result.isSuccess(done)) return { id, refusal: null };
      const error = done.failure;
      const reason = error.code === 'denied' || error.code === 'missing' || error.code === 'bad_input' ? error.code : 'unavailable';

      return { id, refusal: { reason, message: error.message } };
    });
  }

  /** One call of a session, as the caretaker allows it. */
  private call(ws: WebSocket, state: SocketState, call: RoomCall): Effect.Effect<void, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const session: Session = { email: state.email, access: state.access };

      if (!this.caretaker.current(session)) return yield* new KinuError('denied', 'This session has ended');
      const actor = state.email;
      const caretaking = (doing: string, body: () => void | Promise<void>) => attempt({ doing, otherwise: 'io' }, async () => body());

      switch (call.op) {
        case 'setAudience': return yield* caretaking('setting the audience', async () => this.setAudience(actor, call.audience));
        case 'invite': return yield* caretaking('adding someone', () => { this.caretaker.invite(actor, call.email.trim().toLowerCase(), call.role); });
        case 'setRole': return yield* caretaking('changing a role', () => { this.caretaker.invite(actor, call.email, call.role); });
        case 'remove': return yield* caretaking('removing someone', () => { this.caretaker.remove(actor, call.email); });
        case 'leave': {
          if (actor === null) return yield* new KinuError('denied', 'Sign in to leave a slate');

          return yield* caretaking('leaving', () => { this.caretaker.remove(actor, actor); });
        }

        case 'here': {
          ws.serializeAttachment({ ...state, where: call.where, typing: call.typing } satisfies SocketState);

          return;
        }

        case 'list': case 'unlist': case 'setLend': case 'setLendShown': case 'open': case 'ask': case 'check': case 'allow':
        case 'show': case 'unshow': case 'showTo': case 'showToMembers': case 'approve': case 'send': case 'decline':
          return yield* new KinuError('unsupported', `${call.op} is not available yet`);
      }
    });
  }

  /** The sheet's three audiences, each one call: the link on, the link off, or the link off and everyone removed. */
  private async setAudience(actor: string | null, audience: RoomAudience): Promise<void> {
    if (audience === 'anyone') return this.caretaker.setLink(actor, true);

    this.caretaker.setLink(actor, false);

    if (audience === 'only-you') {
      for (const member of this.caretaker.members()) {
        if (member.role === 'edit' || member.role === 'use') this.caretaker.remove(actor, member.email);
      }
    }
  }

  // ── Views ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Every socket gets its own view; a session that is no longer current gets why, and is closed. */
  private async broadcast(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    const states = sockets.map((ws) => ({ ws, state: this.socketState(ws) }));
    const sheet = await this.sheet();

    for (const { ws, state } of states) {
      if (state === null) continue;
      const view = this.view(state, states.flatMap((each) => each.state === null || each.ws === ws ? [] : [each.state]), sheet);
      const frame: RoomServerFrame = { view };

      ws.send(JSON.stringify(frame));

      if (view.ended !== null) ws.close(4403, view.ended.kind);
    }
  }

  private person(member: RoomMember | undefined, email: string): RoomPerson {
    return { email, name: member?.name ?? null };
  }

  private view(state: SocketState, others: readonly SocketState[], sheet: SheetView | null): RoomView {
    const room = this.caretaker.room();
    const members = this.caretaker.members();
    const owner = members.find((member) => member.role === 'owner');
    const ownerPerson = this.person(owner, owner?.email ?? '');
    const session: Session = { email: state.email, access: state.access };
    const current = this.caretaker.current(session);
    const here = [state, ...others];
    const signedIn = new Map<string, SocketState>();

    for (const each of here) if (each.email !== null && !signedIn.has(each.email)) signedIn.set(each.email, each);
    const removed = state.email !== null && members.some((member) => member.email === state.email && member.role === 'removed');

    return {
      session: {
        me: state.email === null ? null : this.person(members.find((member) => member.email === state.email), state.email),
        access: this.roomAccess(state.email, state.access),
        title: room.title,
        owner: ownerPerson,
        mayEdit: this.caretaker.canEdit(state.email),
        mayFork: this.caretaker.mayFork(state.email),
        members: state.access.kind === 'link' ? [] : members.filter((member) => member.role !== 'removed').map((member) => this.person(member, member.email)),
        frame: '',
      },
      presence: {
        here: [...signedIn.values()].map((each) => ({
          person: this.person(members.find((member) => member.email === each.email), each.email ?? ''), where: each.where, typing: each.typing,
        })),
        signedOut: here.filter((each) => each.email === null).length,
      },
      parts: {},
      asks: state.email === null ? [] : this.asks(state.email),
      ended: current ? null : { kind: removed ? 'removed' : 'stopped', by: ownerPerson },
      sheet: state.access.kind === 'owner' ? sheet : null,
    };
  }

  private asks(holder: string): RoomAsk[] {
    return this.caretaker.asks(holder).map((ask) => ({
      kind: 'show', id: JSON.stringify([ask.asker, ask.tag.server, ask.tag.root, ask.fn]),
      from: { email: ask.asker, name: this.caretaker.members().find((member) => member.email === ask.asker)?.name ?? null },
      part: { key: ask.fn, fn: ask.fn },
      source: {
        holder: { email: ask.tag.holder, name: null }, service: { title: ask.tag.server, kind: 'mcp' }, scope: null,
        label: ask.tag.server, checkable: false,
      },
    }));
  }

  private async sheet(): Promise<SheetView> {
    const room = this.caretaker.room();
    const people = this.caretaker.members().filter((member) => member.role === 'edit' || member.role === 'use');
    let audience: RoomAudience = 'only-you';

    if (room.link) audience = 'anyone';
    else if (people.length > 0) audience = 'people';
    const personal = new Set(this.caretaker.grants().filter((grant) => grant.personal).map((grant) => grant.holder));

    return {
      audience,
      url: room.link ? await linkUrl(this.env, room) : null,
      people: people.map((member) => ({ person: this.person(member, member.email), role: member.role === 'edit' ? 'edit' : 'use' })),
      privateOf: this.caretaker.members().filter((member) => personal.has(member.email)).map((member) => this.person(member, member.email)),
      listing: null,
      lends: [],
      uses: this.caretaker.lendUses().map((use) => ({
        fn: use.fn, calls: use.calls, lastAt: use.lastAt,
        person: this.person(this.caretaker.members().find((member) => member.email === use.email), use.email),
      })),
      secret: room.secret,
    };
  }
}
