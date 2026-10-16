/**
 * A slate room's caretaker: every check of `lean/Kinu/Sharing/Model.lean`'s `permits`, made on the room's own rows in
 * the one object that serializes them (docs/SLATE-SHARING-SECURITY.md §8). Each method is one event of the model; it
 * checks, then changes the rows, before anything else of the room runs. The rows are `schema.ts`'s.
 *
 * People are named by email; an account id is derived from it. The owner is a member row with role `owner`. Every
 * generation and id comes from `room.next`, which only grows. Runs live in memory: a run is one admitted call, alive
 * while its request is, and a revoke reaches it through the grants it holds, each of which is its own generation.
 */
import * as v from 'valibot';
import { Effect } from 'effect';
import { KinuError } from '../../obs/error';
import { settleSync } from '../../obs/effect';
import type { SqlExec } from '../../types/primitives';
import type { JsonValue } from '../../utils/json';
import type { RoomRole } from '../room-api';
import { READER_CHECK_LIFETIME_MS } from './reader-check';
import { codecAdmits, type Codec } from './codec';
import {
  audienceFlows, canonicalRoot, dedup, flows, hidden, observers, sameTag, within,
  type Audience, type Elem, type LabelFacts, type Show, type Tag,
} from './labels';
import {
  contractsOf, grantRow, memberRow, modulesOf, outputRow, publicCell, roomRecord, showRow,
  type Cell, type Grant, type Output, type RoomMember, type RoomRecord, type SecretSighting,
} from './schema';

export { initSlateRoomTables, type Cell, type Grant, type Output, type RoomMember, type RoomRecord, type SecretSighting } from './schema';

/**
 * What a function's contract is of: its one argument. A room's call carries its arguments as a list, so none is null,
 * one is itself, and more than one is the list of them.
 */
function contractInput(input: JsonValue): JsonValue {
  if (!Array.isArray(input) || input.length > 1) return input;

  return input[0] ?? null;
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
  /** The part its output belongs to, or null for a call whose answer goes straight back and is kept nowhere. */
  readonly out: string | null;
  readonly requester: Session | null;
  readonly fn: string;
  readonly image: string;
  readonly input: JsonValue;
  /** The grants it was admitted with: a grant's id is its generation. */
  readonly caps: readonly number[];
  readonly label: readonly Elem[];
  live: boolean;
  /** What it has read so far, observes and tool steps that went ahead (the model's `reads`): an approval names its step by this count. */
  steps: number;
  /** Effects it brought about: tool steps through an effect grant that went ahead, and posts to public state. */
  effects: number;
}

/** An effect someone else's call asks for, waiting at its step for the grant's holder. */
export interface PendingEffect {
  readonly id: string;
  readonly run: number;
  readonly grant: number;
  readonly step: number;
  readonly tool: string;
  readonly args: JsonValue;
  readonly kind: 'effect' | 'outflow';
  decided: 'approved' | 'declined' | null;
}

/** What a tool step comes to: go ahead, or wait for the holder (an approval or an outflow). */
export type ToolVerdict =
  | { readonly kind: 'go' }
  | { readonly kind: 'wait'; readonly pending: PendingEffect };

/** A refusal, as an Effect: every method runs its body once, at its edge. */
function refused(code: 'denied' | 'missing' | 'bad_input', message: string): Effect.Effect<never, KinuError> {
  return Effect.fail(new KinuError(code, message));
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

    return row === undefined ? null : roomRecord(row);
  }

  room(): RoomRecord {
    return settleSync(Effect.gen({ self: this }, function* () {
      return this.maybeRoom() ?? (yield* refused('missing', 'This slate has no room'));
    }));
  }

  /** The modules of one image the slate was published at: a run loads the image it was admitted at, never a later one. */
  modulesOf(image: string): Readonly<Record<string, string>> | null {
    const row = this.db.exec('SELECT modules FROM room_images WHERE image = ?', image).toArray()[0];

    return row === undefined ? null : modulesOf(v.parse(v.object({ modules: v.string() }), row).modules);
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
    return this.db.exec('SELECT * FROM room_members ORDER BY email').toArray().map(memberRow);
  }

  private member(email: string): RoomMember | null {
    const row = this.db.exec('SELECT * FROM room_members WHERE email = ?', email).toArray()[0];

    return row === undefined ? null : memberRow(row);
  }

  /** Everyone added and not removed, the owner included: "everyone here now". */
  everyoneAdded(): string[] {
    return this.members().filter((member) => member.role !== 'removed').map((member) => member.email);
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
   * `editCode`: a new image, written by `author`. The author's own grants and function-scoped shows follow it, each a new
   * grant; everyone else's stay at the image they were made for, so they are suspended until their holder renews them.
   * The secret sighting is the new image's, set in the same statement.
   */
  publish(author: string, built: {
    readonly image: string; readonly modules: Readonly<Record<string, string>>; readonly title: string; readonly secret: SecretSighting | null;
    /** The version of the files the image was built from; absent for a page that has none. */
    readonly source?: string | null;
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

      // The author's own grants follow, each re-granted at the new image under a new generation, with the contract the
      // image declares for its function: a run holding the old grant does not carry over.
      for (const grant of this.grants().filter((each) => each.holder === author)) this.regrant(grant, image, contracts[grant.fn] ?? grant.domain);

      for (const show of this.shows().filter((each) => each.holder === author && each.fn !== null)) {
        this.db.exec('UPDATE room_shows SET images = ? WHERE id = ?', JSON.stringify([...show.images ?? [], image]), show.id);
      }
    }));
  }

  private regrant(grant: Grant, image: string, domain: Codec): Grant {
    const id = this.fresh();

    this.db.exec('DELETE FROM room_grants WHERE id = ?', grant.id);
    this.db.exec(
      'INSERT INTO room_grants (id, holder, personal, server, root, tools, fn, image, domain, effect, sink) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, grant.holder, grant.personal ? 1 : 0, grant.server, grant.root, JSON.stringify([...grant.tools]), grant.fn, image,
      JSON.stringify(domain), grant.effect ? 1 : 0, JSON.stringify(grant.sink),
    );

    return { ...grant, id, image, domain };
  }

  // ── Grants ────────────────────────────────────────────────────────────────────────────────────────────────────

  /** What the running image declares `fn` takes, or null where it declares nothing. */
  contract(fn: string): Codec | null {
    const image = this.room().image;
    const row = image === null ? undefined : this.db.exec('SELECT contracts FROM room_images WHERE image = ?', image).toArray()[0];

    if (row === undefined) return null;

    return contractsOf(v.parse(v.object({ contracts: v.string() }), row).contracts)[fn] ?? null;
  }

  grants(): Grant[] {
    return this.db.exec('SELECT * FROM room_grants ORDER BY id').toArray().map(grantRow);
  }

  grant(id: number): Grant | null {
    const row = this.db.exec('SELECT * FROM room_grants WHERE id = ?', id).toArray()[0];

    return row === undefined ? null : grantRow(row);
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
        'INSERT INTO room_grants (id, holder, personal, server, root, tools, fn, image, domain, effect, sink) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, actor, input.personal ? 1 : 0, input.server, root, JSON.stringify([...input.tools]), input.fn, image,
        JSON.stringify(input.domain), input.effect ? 1 : 0, JSON.stringify(input.sink),
      );

      return this.grant(id) ?? (yield* refused('missing', `Grant ${id} vanished`));
    }));
  }

  /**
   * "Use again" after someone else's edit: the holder grants their own connection, as they had it, to the image now
   * running. Their grants for `fn` made for an earlier image are re-granted, each under a new generation.
   */
  renew(actor: string | null, fn: string): Grant[] {
    return settleSync(Effect.gen({ self: this }, function* () {
      if (actor === null) return yield* refused('denied', 'Sign in to use it again');
      const image = this.room().image ?? (yield* refused('missing', 'The slate has not run yet'));
      const stale = this.grants().filter((grant) => grant.holder === actor && grant.fn === fn && grant.image !== image);

      if (stale.length === 0) return yield* refused('missing', 'Nothing of yours waits for this part');

      if (stale.some((grant) => !grant.personal) && !this.canEdit(actor)) return yield* refused('denied', 'Only an editor can lend a function');

      return stale.map((grant) => this.regrant(grant, image, this.contract(fn) ?? grant.domain));
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
    return this.db.exec('SELECT * FROM room_shows ORDER BY id').toArray().map(showRow);
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
    } else {
      this.db.exec('DELETE FROM room_readers WHERE email = ? AND holder = ? AND server = ? AND root = ?', email, tag.holder, tag.server, tag.root);
    }
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
   * with. Its output is allocated now, as its own row with the run's label, so whether it exists never depends on what
   * the run read, and no later admission relabels it.
   */
  admit(input: {
    readonly requester: Session | null; readonly fn: string; readonly input: JsonValue; readonly grants: readonly number[];
    /** The part its output belongs to; null for a call whose answer goes straight back to its caller and is kept nowhere. */
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
          'INSERT INTO room_outputs (run, part, fn, input, requester, label, value, written) VALUES (?, ?, ?, ?, ?, ?, NULL, 0)',
          id, input.out, fn, JSON.stringify(input.input), requester?.email ?? null, JSON.stringify(label),
        );
      }

      const run: Run = {
        id, out: input.out, requester, fn, image, input: input.input, caps: grants.map((grant) => grant.id), label, live: true, steps: 0, effects: 0,
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

  /** The model's `runOk`: live, its session current, every grant it was admitted with still granted. */
  runOk(run: Run): boolean {
    if (!run.live || (run.requester !== null && !this.current(run.requester))) return false;

    return run.caps.every((grant) => this.grant(grant) !== null);
  }

  private liveRun(id: number): Effect.Effect<Run, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const run = this.runs.get(id) ?? (yield* refused('missing', `No run ${id}`));

      if (!this.runOk(run)) return yield* refused('denied', 'This call was revoked');

      return run;
    });
  }

  /**
   * `toolStep`: a run calls one tool through one of its grants, now. The grant must be one it holds, the tool one it
   * reaches, the arguments within its root, and everyone who observes the call (its holder, and its sink) must be able
   * to see the run's label. An effect another person's call asks for waits at this step for the holder; so does the
   * holder's own data on its way to more people than may see it, which is the holder's to send. Its caller dispatches a
   * `go` at once, with nothing awaited in between, so no revoke lands between this check and the call.
   */
  toolStep(runId: number, grantId: number, tool: string, args: JsonValue): ToolVerdict {
    return settleSync(Effect.gen({ self: this }, function* () {
      const run = yield* this.liveRun(runId);
      const grant = this.grant(grantId) ?? (yield* refused('denied', 'This grant was taken back'));

      if (!run.caps.includes(grant.id)) return yield* refused('denied', 'This call holds no such grant');

      if (!grant.tools.includes(tool)) return yield* refused('denied', `${tool} is not one of the tools this grant reaches`);

      if (!keepsRoot(grant.root, args)) return yield* refused('denied', `${tool} must keep to ${grant.root}`);

      if (grant.personal && run.requester?.email !== grant.holder) return yield* refused('denied', 'A person\'s own connection acts only in their own requests');
      const step = run.steps;

      if (!audienceFlows(this.facts(), run.label, observers(grant.holder, grant.sink))) {
        const own = run.requester?.email === grant.holder && run.label.every((elem) => elem.holder === grant.holder);

        if (!own) return yield* refused('denied', 'This call would send data to someone who cannot see it');

        // Their own data, in their own request, through code wholly theirs: the request is their consent. Code anyone
        // else wrote waits for them to see where it sends their data (`Attacks.lean`, the sink audience).
        if (!this.ownCode(grant.holder)) return { kind: 'wait', pending: this.wait(run, grant, step, { tool, args, kind: 'outflow' }) };
      }

      if (grant.effect && run.requester?.email !== grant.holder) return { kind: 'wait', pending: this.wait(run, grant, step, { tool, args, kind: 'effect' }) };

      // A step that goes ahead is a read: an approval names the step it is for by the count of them.
      run.steps += 1;

      if (grant.effect) run.effects += 1;

      return { kind: 'go' };
    }));
  }

  private wait(run: Run, grant: Grant, step: number, call: Pick<PendingEffect, 'tool' | 'args' | 'kind'>): PendingEffect {
    const pending: PendingEffect = { id: `${run.id}:${crypto.randomUUID()}`, run: run.id, grant: grant.id, step, ...call, decided: null };

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

  /** Whether a step still waits for a decision that can count: undecided, its run current, its grant still granted. */
  stillWaiting(pendingId: string): boolean {
    const pending = this.pending.get(pendingId);
    const run = pending === undefined ? undefined : this.runs.get(pending.run);

    return pending !== undefined && pending.decided === null && run !== undefined && this.runOk(run) && this.grant(pending.grant) !== null;
  }

  /** Whether a step was decided, and the room's waiter for it may stop waiting. */
  decided(pendingId: string): boolean {
    return this.pending.get(pendingId)?.decided !== null;
  }

  /**
   * After the wait: the step goes ahead only if it was approved, the run is still current and the grant still granted;
   * an outflow passes the sink check again with the holder's show in place. Its caller dispatches at once after it.
   */
  resume(pendingId: string): void {
    return settleSync(Effect.gen({ self: this }, function* () {
      const pending = this.pending.get(pendingId) ?? (yield* refused('denied', 'This step was dropped'));

      this.pending.delete(pendingId);

      if (pending.decided !== 'approved') return yield* refused('denied', 'Its holder declined this step');
      const run = yield* this.liveRun(pending.run);
      const grant = this.grant(pending.grant) ?? (yield* refused('denied', 'This grant changed while the step waited'));

      if (!audienceFlows(this.facts(), run.label, observers(grant.holder, grant.sink))) {
        return yield* refused('denied', 'This call would send data to someone who cannot see it');
      }

      run.steps += 1;

      if (grant.effect) run.effects += 1;
    }));
  }

  /** `observe`: a run reads state whose label lies inside its own. */
  observe(runId: number, key: string): JsonValue {
    return settleSync(Effect.gen({ self: this }, function* () {
      const run = yield* this.liveRun(runId);
      const cell = this.cell(key);

      if (cell === null) return null;

      if (!within(cell.label, run.label)) return yield* refused('denied', 'This call cannot read that');
      run.steps += 1;

      return cell.value;
    }));
  }

  /** `write`: a run writes its own output, and only that. */
  write(runId: number, value: JsonValue): void {
    return settleSync(Effect.gen({ self: this }, function* () {
      const run = yield* this.liveRun(runId);

      if (run.requester !== null && run.requester.email === null) return yield* refused('denied', 'Sign in to change this slate');

      if (run.out === null) return yield* refused('denied', 'This call keeps no output');
      this.db.exec('UPDATE room_outputs SET value = ?, written = 1 WHERE run = ?', JSON.stringify(value), run.id);
    }));
  }

  /**
   * `post`: a current run with an empty label, for someone signed in or for the slate itself, adds or replaces public
   * state, or removes it (`value` null). Nothing reaches public state outside a run.
   */
  post(runId: number, key: string, value: JsonValue | null): boolean {
    return settleSync(Effect.gen({ self: this }, function* () {
      const run = yield* this.liveRun(runId);

      if (run.label.length > 0) return yield* refused('denied', 'A part that read private data can only return its result');

      if (run.requester !== null && run.requester.email === null) return yield* refused('denied', 'Sign in to change this slate');
      run.effects += 1;

      if (value === null) return this.db.exec('DELETE FROM room_cells WHERE key = ? RETURNING key', key).toArray().length > 0;
      this.db.exec('INSERT INTO room_cells (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));

      return true;
    }));
  }

  /** Whether a run may change public state now: what a slate's own SQL is held to, by its runner, statement by statement. */
  mayPost(runId: number): boolean {
    const run = this.runs.get(runId);

    return run !== undefined && this.runOk(run) && run.label.length === 0 && (run.requester === null || run.requester.email !== null);
  }

  /** `release`: what a run returns reaches a current session only if every element of its label may reach its person. */
  release(runId: number, to: Session): boolean {
    return settleSync(Effect.gen({ self: this }, function* () {
      const run = yield* this.liveRun(runId);

      if (!this.current(to)) return yield* refused('denied', 'This session has ended');

      return flows(this.facts(), run.label, to.email);
    }));
  }

  /**
   * What a run returns, as the slate's page code receives it: page code is whoever wrote the slate's, so it gets a value
   * only when its label is empty or every element's holder showed it to anyone; anything else is a sealed part.
   */
  releaseToPage(runId: number, to: Session | null): boolean {
    return settleSync(Effect.gen({ self: this }, function* () {
      const run = yield* this.liveRun(runId);

      if (to !== null && !this.current(to)) return yield* refused('denied', 'This session has ended');

      return audienceFlows(this.facts(), run.label, 'anyone');
    }));
  }

  /** `finish`. */
  finish(runId: number): void {
    const run = this.runs.get(runId);

    if (run !== undefined) run.live = false;
    this.runs.delete(runId);

    for (const [id, pending] of this.pending) if (pending.run === runId) this.pending.delete(id);
  }

  // ── State ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /** State by key: public state, or else a part's newest written output (its newest admitted one while none is written). */
  cell(key: string): Cell | null {
    const shared = this.db.exec('SELECT key, value FROM room_cells WHERE key = ?', key).toArray()[0];

    return shared === undefined ? this.output(key) : publicCell(shared);
  }

  /** A part's output, as its view shows it: its newest run's that wrote one, else its newest admitted. */
  output(part: string): Output | null {
    const row = this.db.exec('SELECT * FROM room_outputs WHERE part = ? ORDER BY written DESC, run DESC LIMIT 1', part).toArray()[0];

    return row === undefined ? null : outputRow(row);
  }

  /** Public state, as the shared server lists it. */
  publicCells(prefix: string, limit: number): Cell[] {
    return this.db.exec('SELECT key, value FROM room_cells WHERE key >= ? ORDER BY key LIMIT ?', prefix, limit).toArray()
      .map(publicCell)
      .filter((cell) => cell.key.startsWith(prefix));
  }

  /**
   * `render`: state as a current session sees it: its value if every element may reach the person, else the elements
   * they may not read, whose holders a placeholder asks. Nothing of the value is read before the check.
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
}
