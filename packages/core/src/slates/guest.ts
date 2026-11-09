/**
 * A shared app's guest: the agent a share's visitor talks to, a hire of the workspace's own agent that answers one
 * visitor of one share. It runs no program: its one tool calls the app's surface as that visitor does, so it reaches no
 * network, no secret and no tool of the owner's but through the calls decided here. One table classifies the call it
 * makes and every member that call reaches inside itself.
 */
import * as v from 'valibot';
import { Effect } from 'effect';
import { KinuError } from '../obs/error';
import { settleSync } from '../obs/effect';
import type { SqlExec } from '../types/primitives';
import { shareMemberRefusal } from './members';
import type { SlateAddress, SlateRoute } from './surface';

/** Which share and visitor an agent answers, as the workspace's `slate_share_guests` row records it. */
export interface GuestPrincipal {
  readonly actorId: string;
  readonly share: string;
  readonly slate: string;
  /** The visitor's subject on the share: `viewer:<key>` signed in, `anon:<id>` anonymous. */
  readonly subject: string;
}

/**
 * `in-scope`: the app's own data and code, which the guest reaches as its visitor would. `ask-exact`: anything else of the
 * owner's, which runs only on the owner's approval of that exact call. `forbidden`: what no guest reaches at all.
 */
export type GuestAuthorization = 'in-scope' | 'ask-exact' | 'forbidden';

/** What only the owner reaches, or what would let a guest drive an agent or a machine: never a guest's. */
const FORBIDDEN_NAMESPACES: ReadonlySet<string> = new Set(['agent', 'agents', 'computer', 'device']);

/**
 * How a guest of `slate`'s share may make `route` (named `address`), `slates` the slates the share's grant reaches: the
 * app's code and its model calls. Its files are not: a file there may link anywhere of the owner's, so reading one, like
 * anything else of theirs, is theirs to approve.
 */
export function guestAuthorization(input: {
  readonly slates: readonly string[];
  readonly address: SlateAddress;
  readonly route: SlateRoute;
}): GuestAuthorization {
  const { slates, address, route } = input;

  if (FORBIDDEN_NAMESPACES.has(address.namespace) || shareMemberRefusal(address) !== null) return 'forbidden';

  switch (route.kind) {
    case 'app': return slates.includes(route.id) ? 'in-scope' : 'ask-exact';
    case 'ai': return route.stream === true ? 'forbidden' : 'in-scope';
    case 'agent': return 'forbidden';
    case 'namespace':
    case 'mcp':
    case 'rpc':
    case 'tool': return 'ask-exact';
  }
}

/**
 * A member a guest's in-scope call reaches inside itself, named only by its address: it is in scope only where its
 * address alone says so (the app's own slates, its model calls); anything that would need its arguments read, or the
 * owner's approval, is refused there, since a nested member cannot wait on a card. The guest can ask for it itself.
 */
function guestNestedAuthorization(slates: readonly string[], address: SlateAddress): 'in-scope' | 'forbidden' {
  if (FORBIDDEN_NAMESPACES.has(address.namespace) || shareMemberRefusal(address) !== null) return 'forbidden';

  if (address.namespace === 'ai') return 'in-scope';

  return address.namespace.startsWith('slates.') && slates.includes(address.namespace.slice('slates.'.length)) ? 'in-scope' : 'forbidden';
}

/** A member reached on a guest's way, refused where the guest's scope does not name it by its address alone. */
export function admitGuestNested(guest: GuestPrincipal | undefined, slates: readonly string[], address: SlateAddress): void {
  if (guest === undefined || guestNestedAuthorization(slates, address) === 'in-scope') return;

  return settleSync(Effect.fail(new KinuError('denied', `${address.namespace}.${address.member} is beyond what a shared app's guest reaches inside a call; the guest can ask for it on its own`)));
}

/** The anonymous visitor's subject: a random id the share's cookie carries, stable for that browser. */
export const ANONYMOUS_SUBJECT_PREFIX = 'anon:';

/** Whether a share's visitor is known only by where they came from: no account and no anonymous id. */
export function identifiedOnlyBySource(subject: string): boolean {
  return subject.startsWith('source:');
}

const GUEST_SELECT = `SELECT g.actor_id AS actorId, g.share_id AS share, g.slate, g.viewer_subject AS subject
  FROM slate_share_guests AS g JOIN workspace_actors AS a ON a.actor_id = g.actor_id`;

const GuestRow = v.object({ actorId: v.string(), share: v.string(), slate: v.string(), subject: v.string() });

/**
 * The workspace's guests, over `slate_share_guests` joined to the actors they are: a guest whose actor was retired is
 * no one's guest any more, so a share's visitor is answered by at most one live guest.
 */
export class SlateShareGuests {
  constructor(private readonly db: SqlExec, private readonly now: () => number = () => Date.now()) {}

  /**
   * `actorId` answers `subject` on `share` from now on; written once, as the guest is hired. A second writer of the same
   * hire (two first messages at once, whose hire's creation is one) finds it written.
   */
  record(principal: GuestPrincipal): void {
    this.db.exec('INSERT INTO slate_share_guests (actor_id, share_id, slate, viewer_subject, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (actor_id) DO NOTHING',
      principal.actorId, principal.share, principal.slate, principal.subject, this.now());
  }

  /**
   * The creation key of `subject`'s guest on `share`: one per guest of theirs, so every first message of theirs while one
   * stands, however they interleave with its hire, names the same hire, and a retired guest's successor a new one.
   */
  creationOf(share: string, subject: string): string {
    const [row] = this.db.exec(`SELECT COUNT(*) AS n FROM slate_share_guests AS g JOIN workspace_actors AS a ON a.actor_id = g.actor_id
      WHERE g.share_id = ? AND g.viewer_subject = ? AND (a.retiring_at IS NOT NULL OR a.deleted_at IS NOT NULL)`, share, subject).toArray();

    return `guest:${share}:${subject}:${String(v.parse(v.object({ n: v.number() }), row).n)}`;
  }

  /** The live guest answering `subject` on `share`, or null. */
  of(share: string, subject: string): GuestPrincipal | null {
    const [row] = this.db.exec(`${GUEST_SELECT} WHERE g.share_id = ? AND g.viewer_subject = ? AND a.retiring_at IS NULL AND a.deleted_at IS NULL`, share, subject).toArray();

    return row === undefined ? null : v.parse(GuestRow, row);
  }

  /** Which share and visitor `actorId` answers, retired or not; null for an agent that is no guest. */
  principalOf(actorId: string): GuestPrincipal | null {
    const [row] = this.db.exec(`${GUEST_SELECT} WHERE g.actor_id = ?`, actorId).toArray();

    return row === undefined ? null : v.parse(GuestRow, row);
  }

  /** The live guests of `share`. */
  live(share: string): GuestPrincipal[] {
    return this.db.exec(`${GUEST_SELECT} WHERE g.share_id = ? AND a.retiring_at IS NULL AND a.deleted_at IS NULL`, share).toArray().map((row) => v.parse(GuestRow, row));
  }
}
