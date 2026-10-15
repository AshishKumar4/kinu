/**
 * A slate room's caretaker: every check of `lean/Kinu/Sharing/Model.lean`'s `permits`, made on the room's own rows in
 * the one object that serializes them (docs/SLATE-SHARING-SECURITY.md §8). Each method is one event of the model; it
 * checks, then changes the rows, before anything else of the room runs.
 *
 * People are named by email; an account id is derived from it. The owner is a member row with role `owner`. Every
 * generation and id comes from `room.next`, which only grows. Runs live in memory: a run is one admitted call, alive
 * while its request is, and a revoke reaches it through the generations it holds.
 */
import * as v from 'valibot';
import { Effect } from 'effect';
import { KinuError } from '../../obs/error';
import { settleSync } from '../../obs/effect';
import type { RawSqlExec, SqlExec } from '../../types/primitives';
import { parseJsonValue, type JsonValue } from '../../utils/json';
import type { RoomRole } from '../room-api';
import { READER_CHECK_LIFETIME_MS } from './reader-check';
import { codecAdmits, CodecSchema, type Codec } from './codec';
import {
  audienceFlows, canonicalRoot, dedup, flows, hidden, observers, sameTag, within,
  type Audience, type Elem, type LabelFacts, type Show, type Tag,
} from './labels';

export function initSlateRoomTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS room (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    workspace TEXT NOT NULL,
    slate TEXT NOT NULL,
    title TEXT NOT NULL,
    link INTEGER NOT NULL,
    link_gen INTEGER NOT NULL,
    image TEXT,
    image_author TEXT,
    secret TEXT,
    source TEXT,
    foreign_code INTEGER NOT NULL,
    parent TEXT,
    next INTEGER NOT NULL
  )`);
  // Each image the slate was published at: its modules by content digest, as its workspace stores them. Keyed by the
  // image, so the room's image and the modules it runs can never describe two builds.
  execRaw(`CREATE TABLE IF NOT EXISTS room_images (
    image TEXT PRIMARY KEY,
    modules TEXT NOT NULL,
    contracts TEXT NOT NULL
  )`);
  // name: a display copy, written when the person opens the slate; NULL while only invited.
  execRaw(`CREATE TABLE IF NOT EXISTS room_members (
    email TEXT PRIMARY KEY,
    name TEXT,
    role TEXT NOT NULL CHECK (role IN ('owner', 'edit', 'use', 'removed')),
    gen INTEGER NOT NULL
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS room_grants (
    id INTEGER PRIMARY KEY,
    holder TEXT NOT NULL,
    personal INTEGER NOT NULL,
    server TEXT NOT NULL,
    root TEXT NOT NULL,
    tools TEXT NOT NULL,
    fn TEXT NOT NULL,
    image TEXT NOT NULL,
    domain TEXT NOT NULL,
    effect INTEGER NOT NULL,
    sink TEXT NOT NULL,
    gen INTEGER NOT NULL
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS room_shows (
    id INTEGER PRIMARY KEY,
    holder TEXT NOT NULL,
    server TEXT NOT NULL,
    root TEXT NOT NULL,
    fn TEXT,
    images TEXT,
    audience TEXT NOT NULL
  )`);
  // A check is of one tag, the holder's read of the source included: what one person's connection reads of a source
  // need not be what another's does (`Model.Core.readers`).
  execRaw(`CREATE TABLE IF NOT EXISTS room_readers (
    email TEXT NOT NULL,
    holder TEXT NOT NULL,
    server TEXT NOT NULL,
    root TEXT NOT NULL,
    checked_at INTEGER NOT NULL,
    PRIMARY KEY (email, holder, server, root)
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS room_cells (
    key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    value TEXT NOT NULL
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS room_asks (
    asker TEXT NOT NULL,
    holder TEXT NOT NULL,
    server TEXT NOT NULL,
    root TEXT NOT NULL,
    fn TEXT NOT NULL,
    PRIMARY KEY (asker, holder, server, root, fn)
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS room_lend_uses (
    fn TEXT NOT NULL,
    email TEXT NOT NULL,
    calls INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    PRIMARY KEY (fn, email)
  )`);
  // The slate's Gallery listing while it is listed: its owner's words for it. Only while its link is on.
  execRaw(`CREATE TABLE IF NOT EXISTS room_listing (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    line TEXT NOT NULL,
    category TEXT NOT NULL,
    listed_at INTEGER NOT NULL,
    picture TEXT
  )`);
}

// ── Rows ────────────────────────────────────────────────────────────────────────────────────────────────────────

const AudienceSchema = v.union([v.literal('anyone'), v.array(v.string())]);

const RoomRow = v.object({
  workspace: v.string(), slate: v.string(), title: v.string(), link: v.number(), link_gen: v.number(), image: v.nullable(v.string()),
  modules: v.nullable(v.string()),
  image_author: v.nullable(v.string()), secret: v.nullable(v.string()), source: v.nullable(v.string()), foreign_code: v.number(), parent: v.nullable(v.string()),
  next: v.number(),
});

export interface RoomRecord {
  readonly workspace: string;
  readonly slate: string;
  /** The slate's title, from the image running: written with the image. */
  readonly title: string;
  readonly link: boolean;
  readonly linkGen: number;
  readonly image: string | null;
  /** The image's modules, each by its content digest, as its workspace stores them. */
  readonly modules: Readonly<Record<string, string>> | null;
  readonly imageAuthor: string | null;
  readonly secret: SecretSighting | null;
  /** The version of the slate's files the image was built from: what a fork gets. */
  readonly source: string | null;
  /** Code by someone other than the owner has entered: no grant is implied by authorship from then on. */
  readonly foreign: boolean;
  readonly parent: string | null;
}

const SecretSightingSchema = v.object({ file: v.string(), line: v.number(), kind: v.string() });

export type SecretSighting = v.InferOutput<typeof SecretSightingSchema>;

const MemberRow = v.object({
  email: v.string(), name: v.nullable(v.string()), role: v.picklist(['owner', 'edit', 'use', 'removed'] as const), gen: v.number(),
});

export type RoomMember = v.InferOutput<typeof MemberRow>;

/**
 * What a function's contract is of: its one argument. A room's call carries its arguments as a list, so none is null,
 * one is itself, and more than one is the list of them.
 */
function contractInput(input: JsonValue): JsonValue {
  if (!Array.isArray(input) || input.length > 1) return input;

  return input[0] ?? null;
}

const GrantRow = v.object({
  id: v.number(), holder: v.string(), personal: v.number(), server: v.string(), root: v.string(), tools: v.string(),
  fn: v.string(), image: v.string(), domain: v.string(), effect: v.number(), sink: v.string(), gen: v.number(),
});

/** A durable grant: a lend (`personal` false) or a person's own connection, bound to one function's image. */
export interface Grant extends Tag {
  readonly id: number;
  readonly personal: boolean;
  readonly tools: readonly string[];
  readonly fn: string;
  readonly image: string;
  readonly domain: Codec;
  readonly effect: boolean;
  readonly sink: Audience;
  readonly gen: number;
}

const ShowRow = v.object({
  id: v.number(), holder: v.string(), server: v.string(), root: v.string(), fn: v.nullable(v.string()),
  images: v.nullable(v.string()), audience: v.string(),
});

const CellRow = v.object({ key: v.string(), label: v.string(), value: v.string() });

const ElemSchema = v.object({
  holder: v.string(), server: v.string(), root: v.string(), fn: v.string(), image: v.string(),
});

export interface Cell {
  readonly key: string;
  readonly label: readonly Elem[];
  /** Null until the run that owns the cell writes it. */
  readonly value: JsonValue;
}

// ── Sessions and runs ───────────────────────────────────────────────────────────────────────────────────────────

/** How a session holds the slate, at the generation it was opened under (the model's `Acc`). */
export type Access =
  | { readonly kind: 'owner' }
  | { readonly kind: 'member'; readonly gen: number }
  | { readonly kind: 'link'; readonly gen: number };

/** A session: a person, null for a visitor who has not signed in, and how they hold the slate. */
export interface Session {
  readonly email: string | null;
  readonly access: Access;
}

/** One admitted call (the model's `Run`): requested by a session, or by the slate itself (`requester` null). */
export interface Run {
  readonly id: number;
  readonly out: string | null;
  readonly requester: Session | null;
  readonly fn: string;
  readonly image: string;
  readonly input: JsonValue;
  readonly caps: readonly { readonly grant: number; readonly gen: number }[];
  readonly label: readonly Elem[];
  live: boolean;
  /** Tool steps taken: an approval names one. */
  steps: number;
}

/** An effect someone else's call asks for, waiting at its step for the grant's holder. */
export interface PendingEffect {
  readonly id: string;
  readonly run: number;
  readonly grant: number;
  readonly gen: number;
  readonly step: number;
  readonly tool: string;
  readonly args: JsonValue;
  readonly kind: 'effect' | 'outflow';
  decided: 'approved' | 'declined' | null;
}

/** What a tool step comes to: go ahead, wait for the holder (approval or outflow), or never. */
export type ToolVerdict =
  | { readonly kind: 'go' }
  | { readonly kind: 'wait'; readonly pending: PendingEffect };

/** A refusal, as an Effect: every method runs its body once, at its edge. */
function refused(code: 'denied' | 'missing' | 'bad_input', message: string): Effect.Effect<never, KinuError> {
  return Effect.fail(new KinuError(code, message));
}

function parseElems(text: string): Elem[] {
  return v.parse(v.array(ElemSchema), JSON.parse(text));
}

/** The grant's element in a run's label: its tag, and the function and image the run is of. */
function capElem(grant: Grant, fn: string, image: string): Elem {
  return { holder: grant.holder, server: grant.server, root: grant.root, fn, image };
}

/** Whether `args` keep the grant's root: every fixed argument is passed, as fixed. */
function keepsRoot(root: string, args: JsonValue): boolean {
  const fixed = v.parse(v.record(v.string(), v.string()), JSON.parse(root));

  return Object.entries(fixed).every(([name, value]) =>
    args !== null && typeof args === 'object' && !Array.isArray(args) && args[name] === value);
}

export interface RoomCaretakerDeps {
  readonly db: SqlExec;
  readonly now?: () => number;
}

export class RoomCaretaker {
  private readonly db: SqlExec;
  private readonly now: () => number;
  private readonly runs = new Map<number, Run>();
  private readonly pending = new Map<string, PendingEffect>();

  constructor(deps: RoomCaretakerDeps) {
    this.db = deps.db;
    this.now = deps.now ?? (() => Date.now());
  }

  // ── The room ──────────────────────────────────────────────────────────────────────────────────────────────────

  /** A room is created once, by its owner's first run of the slate; a fork's names the room it was forked from. */
  create(input: {
    readonly workspace: string; readonly slate: string; readonly title: string; readonly owner: string; readonly parent: string | null;
  }): void {
    if (this.maybeRoom() !== null) return;
    this.db.exec(
      'INSERT INTO room (id, workspace, slate, title, link, link_gen, image, image_author, secret, foreign_code, parent, next) VALUES (1, ?, ?, ?, 0, 0, NULL, NULL, NULL, ?, ?, 1)',
      input.workspace, input.slate, input.title, input.parent === null ? 0 : 1, input.parent,
    );
    this.db.exec("INSERT INTO room_members (email, name, role, gen) VALUES (?, NULL, 'owner', 0)", input.owner);
  }

  private maybeRoom(): RoomRecord | null {
    const row = this.db.exec('SELECT room.*, room_images.modules AS modules FROM room LEFT JOIN room_images ON room_images.image = room.image WHERE id = 1').toArray()[0];

    if (row === undefined) return null;
    const parsed = v.parse(RoomRow, row);

    return {
      workspace: parsed.workspace, slate: parsed.slate, title: parsed.title, link: parsed.link === 1, linkGen: parsed.link_gen,
      image: parsed.image, imageAuthor: parsed.image_author,
      modules: parsed.modules === null ? null : v.parse(v.record(v.string(), v.string()), JSON.parse(parsed.modules)),
      secret: parsed.secret === null ? null : v.parse(SecretSightingSchema, JSON.parse(parsed.secret)), source: parsed.source,
      foreign: parsed.foreign_code === 1, parent: parsed.parent,
    };
  }

  room(): RoomRecord {
    return settleSync(Effect.gen({ self: this }, function* () {
      return this.maybeRoom() ?? (yield* refused('missing', 'This slate has no room'));
    }));
  }

  /** A fresh generation or id: the model's counter, which only grows. */
  private fresh(): number {
    const row = this.db.exec('UPDATE room SET next = next + 1 WHERE id = 1 RETURNING next - 1 AS issued').toArray()[0];

    return v.parse(v.object({ issued: v.number() }), row).issued;
  }

  owner(): string {
    const row = this.db.exec("SELECT email FROM room_members WHERE role = 'owner'").toArray()[0];

    return v.parse(v.object({ email: v.string() }), row).email;
  }

  members(): RoomMember[] {
    return this.db.exec('SELECT * FROM room_members ORDER BY email').toArray().map((row) => v.parse(MemberRow, row));
  }

  private member(email: string): RoomMember | null {
    const row = this.db.exec('SELECT * FROM room_members WHERE email = ?', email).toArray()[0];

    return row === undefined ? null : v.parse(MemberRow, row);
  }

  /** The model's `canEdit`: the owner, or someone added with Edit. */
  canEdit(email: string | null): boolean {
    const role = email === null ? null : this.member(email)?.role;

    return role === 'owner' || role === 'edit';
  }

  /** The model's `hasAccess`. */
  hasAccess(email: string | null): boolean {
    const role = email === null ? null : this.member(email)?.role;

    if (role === 'owner' || role === 'edit' || role === 'use') return true;

    return this.room().link && role !== 'removed';
  }

  // ── Sessions ──────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * How a person may open the slate now: as its owner, as someone added, or through the link when they hold its key.
   * Null when they may not. The session holds the generation it was opened under (`Model.current`).
   */
  open(email: string | null, linkKey: boolean): Access | null {
    const room = this.room();
    const member = email === null ? null : this.member(email);

    if (member?.role === 'owner') return { kind: 'owner' };

    if (member?.role === 'edit' || member?.role === 'use') return { kind: 'member', gen: member.gen };

    if (room.link && linkKey && member?.role !== 'removed') return { kind: 'link', gen: room.linkGen };

    return null;
  }

  /** The model's `Slate.current`: a session is current while the access it was opened under is. */
  current(session: Session): boolean {
    const { access, email } = session;

    switch (access.kind) {
      case 'owner': return email !== null && this.member(email)?.role === 'owner';
      case 'member': {
        const member = email === null ? null : this.member(email);

        return member !== null && (member.role === 'edit' || member.role === 'use') && member.gen === access.gen;
      }

      case 'link': {
        const room = this.room();

        return room.link && room.linkGen === access.gen && (email === null || this.member(email)?.role !== 'removed');
      }
    }
  }

  /**
   * Whether the code running is `email`'s own: they published it, and no one else's code ever entered it, a fork's
   * included. Only then is running it their consent to what it reaches with their connections.
   */
  ownCode(email: string): boolean {
    const room = this.room();

    return room.imageAuthor === email && !room.foreign;
  }

  /** The display copy of a person's name, refreshed each time they open the slate. */
  named(email: string, name: string): void {
    this.db.exec('UPDATE room_members SET name = ? WHERE email = ?', name, email);
  }

  // ── The owner's ───────────────────────────────────────────────────────────────────────────────────────────────

  private requireOwner(actor: string | null, doing: string): Effect.Effect<void, KinuError> {
    return Effect.gen({ self: this }, function* () {
      if (actor === null || this.member(actor)?.role !== 'owner') return yield* refused('denied', `Only the slate's owner can ${doing}`);
    });
  }

  /** `share`: the link on or off, at a new generation, so no session of the old one is current again. */
  setLink(actor: string | null, on: boolean): void {
    return settleSync(Effect.gen({ self: this }, function* () {
      yield* this.requireOwner(actor, 'change the link');

      if (on && this.room().secret !== null) return yield* refused('denied', 'The code holds a secret: the link stays off until it is gone');
      this.db.exec('UPDATE room SET link = ?, link_gen = ? WHERE id = 1', on ? 1 : 0, this.fresh());

      // A listing is the link: with the link off, nothing is listed.
      if (!on) this.db.exec('DELETE FROM room_listing');
    }));
  }

  /** `publish`, in the model's words: the owner lists the slate in the Gallery. Its link must be on. */
  list(actor: string | null, listing: { readonly line: string; readonly category: string }, now: number): void {
    return settleSync(Effect.gen({ self: this }, function* () {
      yield* this.requireOwner(actor, 'list it');

      if (!this.room().link) return yield* refused('denied', 'Only a slate anyone with its link can open is listed: turn its link on first');
      const line = listing.line.trim();

      if (line === '' || line.length > 140) return yield* refused('bad_input', 'A listing says what the slate is in 1 to 140 characters');
      this.db.exec(
        'INSERT INTO room_listing (id, line, category, listed_at) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET line = excluded.line, category = excluded.category',
        line, listing.category, now,
      );
    }));
  }

  unlist(actor: string | null): void {
    return settleSync(Effect.gen({ self: this }, function* () {
      yield* this.requireOwner(actor, 'unlist it');
      this.db.exec('DELETE FROM room_listing');
    }));
  }

  /** The listing while the slate is listed. */
  listing(): { readonly line: string; readonly category: string; readonly listedAt: number; readonly picture: string | null } | null {
    const row = this.db.exec('SELECT line, category, listed_at, picture FROM room_listing WHERE id = 1').toArray()[0];

    if (row === undefined) return null;
    const parsed = v.parse(v.object({ line: v.string(), category: v.string(), listed_at: v.number(), picture: v.nullable(v.string()) }), row);

    return { line: parsed.line, category: parsed.category, listedAt: parsed.listed_at, picture: parsed.picture };
  }

  /** The listing's picture: the page as a visitor with only the link saw it. False when it is no longer listed. */
  pictured(digest: string): boolean {
    return this.db.exec('UPDATE room_listing SET picture = ? WHERE id = 1 RETURNING id', digest).toArray().length > 0;
  }

  /** `collaborate`: someone added, or their role changed, at a new generation. */
  invite(actor: string | null, email: string, role: RoomRole): void {
    return settleSync(Effect.gen({ self: this }, function* () {
      yield* this.requireOwner(actor, 'add people');

      const address = v.safeParse(v.pipe(v.string(), v.email()), email);

      if (!address.success) return yield* refused('bad_input', `${email} is not an email address`);

      if (this.member(email)?.role === 'owner') return yield* refused('bad_input', 'The owner is already on the slate');
      this.db.exec(
        'INSERT INTO room_members (email, name, role, gen) VALUES (?, NULL, ?, ?) ON CONFLICT (email) DO UPDATE SET role = excluded.role, gen = excluded.gen',
        email, role, this.fresh(),
      );
    }));
  }

  /**
   * `remove`. By the owner: every session the person holds ends, through membership or the link, the link is re-keyed so
   * no old link session stays current, and they stay off the link until added again. By the person themselves: their
   * membership ends, and nothing else.
   */
  remove(actor: string | null, email: string): void {
    return settleSync(Effect.gen({ self: this }, function* () {
      if (actor === email) {
        if (this.member(email)?.role === 'owner') return yield* refused('denied', 'The owner cannot leave their own slate');
        this.db.exec("DELETE FROM room_members WHERE email = ? AND role IN ('edit', 'use')", email);

        return;
      }

      yield* this.requireOwner(actor, 'remove people');

      if (this.member(email)?.role === 'owner') return yield* refused('denied', 'The owner cannot be removed');
      const gen = this.fresh();

      this.db.exec(
        "INSERT INTO room_members (email, name, role, gen) VALUES (?, NULL, 'removed', ?) ON CONFLICT (email) DO UPDATE SET role = 'removed', gen = excluded.gen",
        email, gen,
      );
      this.db.exec('UPDATE room SET link_gen = ? WHERE id = 1', this.fresh());
      // Their own grants and shows go with them.
      this.db.exec('DELETE FROM room_grants WHERE holder = ?', email);
      this.db.exec('DELETE FROM room_shows WHERE holder = ?', email);
    }));
  }

  // ── Code ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * `editCode`: a new image, written by `author`. The author's own grants and function-scoped shows follow it; everyone
   * else's stay at the image they were made for, so they are suspended until their holder renews them. The secret
   * sighting is the new image's, set in the same statement.
   */
  publish(author: string, built: {
    readonly image: string; readonly modules: Readonly<Record<string, string>>; readonly title: string; readonly secret: SecretSighting | null;
    readonly source?: string;
    /** Each function's input contract, as the image's slate declares it: what a grant of it admits from then on. */
    readonly contracts?: Readonly<Record<string, Codec>>;
  }): void {
    return settleSync(Effect.gen({ self: this }, function* () {
      if (!this.canEdit(author)) return yield* refused('denied', `${author} cannot change this slate`);
      const owner = this.owner();
      const { image, title, secret } = built;
      const source = built.source ?? null;

      // The same image again: the version a fork gets stays the one that built it, so files added since reach no fork.
      if (this.room().image === image) return;

      const contracts = built.contracts ?? {};

      this.db.exec('INSERT OR IGNORE INTO room_images (image, modules, contracts) VALUES (?, ?, ?)', image, JSON.stringify(built.modules), JSON.stringify(contracts));
      this.db.exec(
        'UPDATE room SET image = ?, image_author = ?, title = ?, secret = ?, source = ?, foreign_code = CASE WHEN ? THEN 1 ELSE foreign_code END, link = CASE WHEN ? THEN 0 ELSE link END WHERE id = 1',
        image, author, title, secret === null ? null : JSON.stringify(secret), source, author !== owner ? 1 : 0, secret !== null ? 1 : 0,
      );
      this.db.exec('UPDATE room_grants SET image = ? WHERE holder = ?', image, author);

      // The author's own grants take the new image's contract for their function, where it declares one.
      for (const [fn, contract] of Object.entries(contracts)) {
        this.db.exec('UPDATE room_grants SET domain = ? WHERE holder = ? AND fn = ?', JSON.stringify(contract), author, fn);
      }

      for (const show of this.shows().filter((each) => each.holder === author && each.fn !== null)) {
        this.db.exec('UPDATE room_shows SET images = ? WHERE id = ?', JSON.stringify([...show.images ?? [], image]), show.id);
      }
    }));
  }

  // ── Grants ────────────────────────────────────────────────────────────────────────────────────────────────────

  /** What the running image declares `fn` takes, or null where it declares nothing. */
  contract(fn: string): Codec | null {
    const image = this.room().image;
    const row = image === null ? undefined : this.db.exec('SELECT contracts FROM room_images WHERE image = ?', image).toArray()[0];

    if (row === undefined) return null;

    return v.parse(v.record(v.string(), CodecSchema), JSON.parse(v.parse(v.object({ contracts: v.string() }), row).contracts))[fn] ?? null;
  }

  grants(): Grant[] {
    return this.db.exec('SELECT * FROM room_grants ORDER BY id').toArray().map((row) => {
      const parsed = v.parse(GrantRow, row);

      return {
        id: parsed.id, holder: parsed.holder, personal: parsed.personal === 1, server: parsed.server, root: parsed.root,
        tools: v.parse(v.array(v.string()), JSON.parse(parsed.tools)), fn: parsed.fn, image: parsed.image,
        domain: v.parse(CodecSchema, JSON.parse(parsed.domain)), effect: parsed.effect === 1,
        sink: v.parse(AudienceSchema, JSON.parse(parsed.sink)), gen: parsed.gen,
      };
    });
  }

  grant(id: number): Grant | null {
    return this.grants().find((grant) => grant.id === id) ?? null;
  }

  /**
   * `mint`: a person grants their own connection to one function, for their own requests (`personal`) or, as a lend, for
   * anyone's. Any grant they held for that function on that source is replaced. Bound to the image now running.
   */
  mint(actor: string | null, input: {
    readonly personal: boolean; readonly server: string; readonly root: Readonly<Record<string, string>>;
    readonly tools: readonly string[]; readonly fn: string; readonly domain: Codec; readonly effect: boolean; readonly sink: Audience;
  }): Grant {
    return settleSync(Effect.gen({ self: this }, function* () {
      if (actor === null) return yield* refused('denied', 'Sign in to connect anything to this slate');

      if (input.personal ? !this.hasAccess(actor) : !this.canEdit(actor)) {
        return yield* refused('denied', input.personal ? 'Only someone who can open this slate can connect to it' : 'Only an editor can lend a function');
      }

      const image = this.room().image ?? (yield* refused('missing', 'The slate has not run yet'));
      const root = canonicalRoot(input.root);

      this.db.exec('DELETE FROM room_grants WHERE holder = ? AND server = ? AND root = ? AND fn = ? AND personal = ?',
        actor, input.server, root, input.fn, input.personal ? 1 : 0);
      const id = this.fresh();

      this.db.exec(
        'INSERT INTO room_grants (id, holder, personal, server, root, tools, fn, image, domain, effect, sink, gen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, actor, input.personal ? 1 : 0, input.server, root, JSON.stringify([...input.tools]), input.fn, image,
        JSON.stringify(input.domain), input.effect ? 1 : 0, JSON.stringify(input.sink), id,
      );

      return this.grant(id) ?? (yield* refused('missing', `Grant ${id} vanished`));
    }));
  }

  /** `setCap` off: the holder takes a grant back, or the owner ends a lend. Every run holding it stops at its next step. */
  revoke(actor: string | null, id: number): void {
    return settleSync(Effect.gen({ self: this }, function* () {
      const grant = this.grant(id) ?? (yield* refused('missing', `No grant ${id}`));

      if (actor !== grant.holder && !(actor !== null && !grant.personal && this.member(actor)?.role === 'owner')) {
        return yield* refused('denied', 'Only its holder can take a grant back');
      }

      this.db.exec('DELETE FROM room_grants WHERE id = ?', id);
    }));
  }

  // ── Shows and readers ─────────────────────────────────────────────────────────────────────────────────────────

  shows(): Show[] {
    return this.db.exec('SELECT * FROM room_shows ORDER BY id').toArray().map((row) => {
      const parsed = v.parse(ShowRow, row);

      return {
        id: parsed.id, holder: parsed.holder, server: parsed.server, root: parsed.root, fn: parsed.fn,
        images: parsed.images === null ? null : v.parse(v.array(v.string()), JSON.parse(parsed.images)),
        audience: v.parse(AudienceSchema, JSON.parse(parsed.audience)),
      };
    });
  }

  /** `declassify`: only a tag's holder shows it, to an audience, for anything or for one function at its current image. */
  show(actor: string | null, tag: Tag, fn: string | null, audience: Audience): Show {
    return settleSync(Effect.gen({ self: this }, function* () {
      if (actor === null || actor !== tag.holder) return yield* refused('denied', 'Only the person whose data it is can show it');
      const image = this.room().image;
      const images = fn === null ? null : JSON.stringify(image === null ? [] : [image]);
      const id = this.fresh();

      this.db.exec(
        'INSERT INTO room_shows (id, holder, server, root, fn, images, audience) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, tag.holder, tag.server, tag.root, fn, images, JSON.stringify(audience),
      );
      this.db.exec('DELETE FROM room_asks WHERE holder = ? AND server = ? AND root = ?', tag.holder, tag.server, tag.root);

      return this.shows().find((show) => show.id === id) ?? (yield* refused('missing', `Show ${id} vanished`));
    }));
  }

  /** `undeclassify`: its holder withdraws a show; what it let through renders as a placeholder from the next render. */
  unshow(actor: string | null, id: number): void {
    return settleSync(Effect.gen({ self: this }, function* () {
      const show = this.shows().find((each) => each.id === id) ?? (yield* refused('missing', `No show ${id}`));

      if (actor !== show.holder) return yield* refused('denied', 'Only the person whose data it is can stop showing it');
      this.db.exec('DELETE FROM room_shows WHERE id = ?', id);
    }));
  }

  /** `readerCheck`: what the source's own check said, with the reader's own connection. */
  checked(email: string, tag: Tag, reads: boolean): void {
    if (reads) {
      this.db.exec(
        'INSERT INTO room_readers (email, holder, server, root, checked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (email, holder, server, root) DO UPDATE SET checked_at = excluded.checked_at',
        email, tag.holder, tag.server, tag.root, this.now(),
      );
    }
    else this.db.exec('DELETE FROM room_readers WHERE email = ? AND holder = ? AND server = ? AND root = ?', email, tag.holder, tag.server, tag.root);
  }

  facts(): LabelFacts {
    // A yes lapses: a reader who lost the repository since must be asked again (`READER_CHECK_LIFETIME_MS`).
    const readers = this.db.exec('SELECT email, holder, server, root FROM room_readers WHERE checked_at > ?', this.now() - READER_CHECK_LIFETIME_MS).toArray()
      .map((row) => v.parse(v.object({ email: v.string(), holder: v.string(), server: v.string(), root: v.string() }), row));

    return {
      reads: (email, tag) => readers.some((row) => row.email === email && sameTag(row, tag)),
      shows: this.shows(),
    };
  }

  // ── Asks ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Someone asks the holders of what a part hides to show it: one ask each, kept until answered. */
  ask(asker: string | null, elems: readonly Elem[]): void {
    return settleSync(Effect.gen({ self: this }, function* () {
      if (asker === null) return yield* refused('denied', 'Sign in to ask');

      for (const elem of elems) {
        this.db.exec('INSERT OR IGNORE INTO room_asks (asker, holder, server, root, fn) VALUES (?, ?, ?, ?, ?)',
          asker, elem.holder, elem.server, elem.root, elem.fn);
      }
    }));
  }

  asks(holder: string): { asker: string; tag: Tag; fn: string }[] {
    return this.db.exec('SELECT * FROM room_asks WHERE holder = ? ORDER BY rowid', holder).toArray().map((row) => {
      const parsed = v.parse(v.object({ asker: v.string(), holder: v.string(), server: v.string(), root: v.string(), fn: v.string() }), row);

      return { asker: parsed.asker, tag: { holder: parsed.holder, server: parsed.server, root: parsed.root }, fn: parsed.fn };
    });
  }

  dismissAsk(holder: string, asker: string, tag: Tag, fn: string): void {
    return settleSync(Effect.gen({ self: this }, function* () {
      if (holder !== tag.holder) return yield* refused('denied', 'Only the asked holder answers an ask');
      this.db.exec('DELETE FROM room_asks WHERE asker = ? AND holder = ? AND server = ? AND root = ? AND fn = ?',
        asker, tag.holder, tag.server, tag.root, fn);
    }));
  }

  // ── Runs ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The model's `capAdmits` for one grant, at the image now running. */
  private admits(grant: Grant, call: { readonly requester: Session | null; readonly fn: string; readonly input: JsonValue; readonly image: string }): boolean {
    const { requester } = call;

    if (grant.fn !== call.fn || grant.image !== call.image || !codecAdmits(grant.domain, contractInput(call.input))) return false;

    return grant.personal ? requester?.email === grant.holder : requester === null || requester.email !== null;
  }

  /** The grants a call of `fn` holds when `requester` asks for it: theirs, and every lend that admits it. */
  grantsFor(requester: Session | null, fn: string, input: JsonValue): Grant[] {
    const image = this.room().image;

    return image === null ? [] : this.grants().filter((grant) => this.admits(grant, { requester, fn, input, image }));
  }

  /**
   * `admit`: one call of `fn` on `input`, for a current session or the slate itself, holding the grants it is admitted
   * with at their generations. Its output cell is allocated now, under `out`, with the run's label, so whether a cell
   * exists never depends on what a run read.
   */
  admit(input: {
    readonly requester: Session | null; readonly fn: string; readonly input: JsonValue; readonly grants: readonly number[];
    /** Null for a call whose answer goes straight back to its caller and is kept nowhere. */
    readonly inputs: readonly string[]; readonly out: string | null;
  }): Run {
    return settleSync(Effect.gen({ self: this }, function* () {
      const { requester, fn } = input;
      const image = this.room().image ?? (yield* refused('missing', 'The slate has not run yet'));

      if (requester !== null && !this.current(requester)) return yield* refused('denied', 'This session has ended');

      const grants: Grant[] = [];

      for (const id of input.grants) {
        const grant = this.grant(id);

        if (grant === null || !this.admits(grant, { requester, fn, input: input.input, image })) return yield* refused('denied', `Grant ${id} does not admit this call of ${fn}`);
        grants.push(grant);
      }

      const inputLabels: Elem[] = [];

      for (const key of input.inputs) inputLabels.push(...(this.cell(key) ?? (yield* refused('missing', `No cell ${key}`))).label);
      const label = dedup([...grants.map((grant) => capElem(grant, fn, image)), ...inputLabels]);
      const id = this.fresh();

      const visitor = requester?.email ?? null;

      if (visitor !== null && grants.some((grant) => !grant.personal)) this.used(fn, visitor);

      if (input.out !== null) {
        this.db.exec(
          'INSERT INTO room_cells (key, label, value) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET label = excluded.label, value = excluded.value',
          input.out, JSON.stringify(label), 'null',
        );
      }

      const run: Run = {
        id, out: input.out, requester, fn, image, input: input.input,
        caps: grants.map((grant) => ({ grant: grant.id, gen: grant.gen })), label, live: true, steps: 0,
      };

      this.runs.set(id, run);

      return run;
    }));
  }

  private used(fn: string, email: string): void {
    this.db.exec(
      'INSERT INTO room_lend_uses (fn, email, calls, last_at) VALUES (?, ?, 1, ?) ON CONFLICT (fn, email) DO UPDATE SET calls = calls + 1, last_at = excluded.last_at',
      fn, email, this.now(),
    );
  }

  lendUses(): { fn: string; email: string; calls: number; lastAt: number }[] {
    return this.db.exec('SELECT fn, email, calls, last_at AS lastAt FROM room_lend_uses ORDER BY last_at DESC').toArray()
      .map((row) => v.parse(v.object({ fn: v.string(), email: v.string(), calls: v.number(), lastAt: v.number() }), row));
  }

  run(id: number): Run | null {
    return this.runs.get(id) ?? null;
  }

  /** The model's `runOk`: live, its session current, every grant it holds at the generation it was admitted under. */
  runOk(run: Run): boolean {
    if (!run.live || (run.requester !== null && !this.current(run.requester))) return false;

    return run.caps.every((cap) => this.grant(cap.grant)?.gen === cap.gen);
  }

  private liveRun(id: number): Effect.Effect<Run, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const run = this.runs.get(id) ?? (yield* refused('missing', `No run ${id}`));

      if (!this.runOk(run)) return yield* refused('denied', 'This call was revoked');

      return run;
    });
  }

  /**
   * `toolStep`: a run calls one tool through one of its grants. The grant must be one it holds, the tool one it reaches,
   * the arguments within its root, and everyone who observes the call (its holder, and its sink) must be able to see the
   * run's label. An effect another person's call asks for waits at this step for the holder; so does the holder's own
   * data on its way to more people than may see it, which is the holder's to send.
   */
  toolStep(runId: number, grantId: number, tool: string, args: JsonValue): ToolVerdict {
    return settleSync(Effect.gen({ self: this }, function* () {
      const run = yield* this.liveRun(runId);
      const grant = this.grant(grantId) ?? (yield* refused('denied', 'This grant was taken back'));

      if (!run.caps.some((cap) => cap.grant === grant.id)) return yield* refused('denied', 'This call holds no such grant');

      if (!grant.tools.includes(tool)) return yield* refused('denied', `${tool} is not one of the tools this grant reaches`);

      if (!keepsRoot(grant.root, args)) return yield* refused('denied', `${tool} must keep to ${grant.root}`);

      if (grant.personal && run.requester?.email !== grant.holder) return yield* refused('denied', 'A person\'s own connection acts only in their own requests');
      const step = run.steps;
      run.steps += 1;

      if (!audienceFlows(this.facts(), run.label, observers(grant.holder, grant.sink))) {
        const own = run.requester?.email === grant.holder && run.label.every((elem) => elem.holder === grant.holder);

        if (!own) return yield* refused('denied', 'This call would send data to someone who cannot see it');

        // Their own data, in their own request, through code they wrote themselves: the request is their consent. Code
        // someone else wrote waits for them to see where it sends their data (`Attacks.lean`, the sink audience).
        if (!this.ownCode(grant.holder)) return { kind: 'wait', pending: this.wait(run, grant, step, { tool, args, kind: 'outflow' }) };
      }

      if (grant.effect && run.requester?.email !== grant.holder) return { kind: 'wait', pending: this.wait(run, grant, step, { tool, args, kind: 'effect' }) };

      return { kind: 'go' };
    }));
  }

  private wait(run: Run, grant: Grant, step: number, call: Pick<PendingEffect, 'tool' | 'args' | 'kind'>): PendingEffect {
    const pending: PendingEffect = {
      id: `${run.id}:${step}`, run: run.id, grant: grant.id, gen: grant.gen, step, ...call, decided: null,
    };

    this.pending.set(pending.id, pending);

    return pending;
  }

  /** The effects and outflows waiting for `holder`, of runs still current. */
  waiting(holder: string): PendingEffect[] {
    return [...this.pending.values()].filter((each) => {
      const run = this.runs.get(each.run);

      return each.decided === null && run !== undefined && this.runOk(run) && this.grant(each.grant)?.holder === holder;
    });
  }

  /**
   * `approve`: the holder decides one waiting step. Approving an outflow is the holder showing their data to the grant's
   * sink, for that function at this image.
   */
  decide(actor: string | null, pendingId: string, approve: boolean): void {
    return settleSync(Effect.gen({ self: this }, function* () {
      const pending = this.pending.get(pendingId) ?? (yield* refused('missing', 'Nothing waits under that name'));
      const grant = this.grant(pending.grant) ?? (yield* refused('denied', 'This grant was taken back'));

      if (actor !== grant.holder) return yield* refused('denied', 'Only the grant\'s holder decides');
      pending.decided = approve ? 'approved' : 'declined';
      const run = this.runs.get(pending.run);

      if (approve && pending.kind === 'outflow' && run !== undefined) {
        for (const tag of run.label.filter((elem) => elem.holder === grant.holder)) this.show(actor, tag, run.fn, grant.sink);
      }
    }));
  }

  /**
   * After the wait: the step goes ahead only if it was approved, the run is still current and the grant still at the
   * generation the approval named; an outflow passes the sink check again with the holder's show in place.
   */
  resume(pendingId: string): void {
    return settleSync(Effect.gen({ self: this }, function* () {
      const pending = this.pending.get(pendingId) ?? (yield* refused('denied', 'This step was dropped'));

      this.pending.delete(pendingId);

      if (pending.decided !== 'approved') return yield* refused('denied', 'Its holder declined this step');
      const run = yield* this.liveRun(pending.run);
      const grant = this.grant(pending.grant);

      if (grant === null || grant.gen !== pending.gen) return yield* refused('denied', 'This grant changed while the step waited');

      if (!audienceFlows(this.facts(), run.label, observers(grant.holder, grant.sink))) {
        return yield* refused('denied', 'This call would send data to someone who cannot see it');
      }
    }));
  }

  /** `observe`: a run reads a cell whose label lies inside its own. */
  observe(runId: number, key: string): JsonValue {
    return settleSync(Effect.gen({ self: this }, function* () {
      const run = yield* this.liveRun(runId);
      const cell = this.cell(key);

      if (cell === null) return null;

      if (!within(cell.label, run.label)) return yield* refused('denied', 'This call cannot read that');

      return cell.value;
    }));
  }

  /** `write`: a run writes its own output cell, and only that. */
  write(runId: number, value: JsonValue): void {
    return settleSync(Effect.gen({ self: this }, function* () {
      const run = yield* this.liveRun(runId);

      if (run.requester !== null && run.requester.email === null) return yield* refused('denied', 'Sign in to change this slate');

      if (run.out === null) return yield* refused('denied', 'This call keeps no output');
      this.db.exec('UPDATE room_cells SET value = ? WHERE key = ?', JSON.stringify(value), run.out);
    }));
  }

  /** `post`: only a run with an empty label adds or replaces public state. */
  post(runId: number | null, key: string, value: JsonValue): void {
    return settleSync(Effect.gen({ self: this }, function* () {
      if (runId !== null) {
        const run = yield* this.liveRun(runId);

        if (run.label.length > 0) return yield* refused('denied', 'A part that read private data can only return its result');

        if (run.requester !== null && run.requester.email === null) return yield* refused('denied', 'Sign in to change this slate');
      }

      const existing = this.cell(key);

      if (existing !== null && existing.label.length > 0) return yield* refused('denied', `${key} holds a part's private result`);
      this.db.exec(
        "INSERT INTO room_cells (key, label, value) VALUES (?, '[]', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        key, JSON.stringify(value),
      );
    }));
  }

  /** `release`: what a run returns reaches a current session only if every element of its label may reach its person. */
  release(runId: number, to: Session): boolean {
    return settleSync(Effect.gen({ self: this }, function* () {
      const run = yield* this.liveRun(runId);

      if (!this.current(to)) return yield* refused('denied', 'This session has ended');

      return flows(this.facts(), run.label, to.email);
    }));
  }

  /** `finish`. */
  finish(runId: number): void {
    const run = this.runs.get(runId);

    if (run !== undefined) run.live = false;
    this.runs.delete(runId);

    for (const [id, pending] of this.pending) if (pending.run === runId) this.pending.delete(id);
  }

  // ── Cells ─────────────────────────────────────────────────────────────────────────────────────────────────────

  cell(key: string): Cell | null {
    const row = this.db.exec('SELECT * FROM room_cells WHERE key = ?', key).toArray()[0];

    if (row === undefined) return null;
    const parsed = v.parse(CellRow, row);

    return { key: parsed.key, label: parseElems(parsed.label), value: parseJsonValue(parsed.value) };
  }

  /** Public state, as the shared server lists it: unlabelled cells only. */
  publicCells(prefix: string, limit: number): Cell[] {
    return this.db.exec("SELECT * FROM room_cells WHERE label = '[]' AND key >= ? ORDER BY key LIMIT ?", prefix, limit).toArray()
      .map((row) => v.parse(CellRow, row))
      .filter((row) => row.key.startsWith(prefix))
      .map((row) => ({ key: row.key, label: [], value: parseJsonValue(row.value) }));
  }

  deleteCell(key: string): boolean {
    return settleSync(Effect.gen({ self: this }, function* () {
      const existing = this.cell(key);

      if (existing !== null && existing.label.length > 0) return yield* refused('denied', `${key} holds a part's private result`);

      return this.db.exec('DELETE FROM room_cells WHERE key = ? RETURNING key', key).toArray().length > 0;
    }));
  }

  /**
   * `render`: a cell as a current session sees it: its value if every element may reach the person, else the elements
   * they may not read, whose holders a placeholder asks.
   */
  render(key: string, to: Session): { readonly shown: true; readonly value: JsonValue } | { readonly shown: false; readonly hidden: Elem[] } {
    return settleSync(Effect.gen({ self: this }, function* () {
      if (!this.current(to)) return yield* refused('denied', 'This session has ended');
      const cell = this.cell(key) ?? (yield* refused('missing', `No cell ${key}`));
      const facts = this.facts();

      return flows(facts, cell.label, to.email) ? { shown: true, value: cell.value } : { shown: false, hidden: hidden(facts, cell.label, to.email) };
    }));
  }

  // ── Forks ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /** `fork`: anyone signed in who can open the slate may copy its code; nothing else of the room goes with it. */
  mayFork(email: string | null): boolean {
    return email !== null && this.hasAccess(email);
  }

  /** The sources a person's grants read, once each, for the sheet and the part views. */
  holderTags(email: string): Tag[] {
    const tags: Tag[] = [];

    for (const grant of this.grants()) {
      if (grant.holder === email && !tags.some((seen) => sameTag(seen, grant))) tags.push({ holder: grant.holder, server: grant.server, root: grant.root });
    }

    return tags;
  }
}
