/**
 * What a slate room shows each person: a part's state, the asks a holder has to decide, and the owner's sheet. Decided
 * here from the caretaker's rows alone; the room object adds only what it must fetch (addresses, a connection's tools).
 * A part's content is read only after the render check has passed for that person (docs/SLATE-SHARING-SECURITY.md §2.4).
 */
import * as v from 'valibot';
import type { RoomAsk, RoomAudience, RoomPerson, RoomReach, RoomService, RoomSource, SheetView } from '../room-api';
import { slateAddressImpact } from '../members';
import { codecIsFree } from './codec';
import { partFn, type Need } from './calls';
import type { RoomCaretaker, Session } from './caretaker';
import type { Elem, Tag } from './labels';
import type { Grant, RoomMember } from './schema';

export function serviceOf(server: string): RoomService {
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

export function personOf(members: readonly RoomMember[], email: string): RoomPerson {
  return { email, name: members.find((member) => member.email === email)?.name ?? null };
}

function sourceOf(members: readonly RoomMember[], tag: Tag): RoomSource {
  const scope = scopeText(tag.root);
  const service = serviceOf(tag.server);

  return { holder: personOf(members, tag.holder), service, scope, label: scope ?? service.title, checkable: service.kind === 'github' && scope !== null };
}

/** What a grant reaches, as a person deciding on it reads it: its tools, each read-only by what the tool is. */
export function reachOf(grant: Pick<Grant, 'server' | 'tools' | 'root' | 'effect'>): RoomReach {
  // An MCP grant's tools share the read-only mark the grant was made with; the workspace's own say what they do.
  const readOnly = (tool: string): boolean => (grant.server.startsWith('mcp.') || grant.server === 'ai'
    ? !grant.effect
    : slateAddressImpact({ namespace: grant.server, member: tool }) === 'observe');

  return {
    service: serviceOf(grant.server), scope: scopeText(grant.root), effect: grant.effect,
    tools: grant.tools.map((name) => ({ name, title: name, readOnly: readOnly(name) })),
  };
}

/** What a part shows one session, decided before any of its content is read. */
export type PartDecision =
  | { readonly kind: 'needs-sign-in' }
  | { readonly kind: 'needs-connection'; readonly need: Need }
  | { readonly kind: 'running' }
  | { readonly kind: 'edited'; readonly grant: Grant; readonly editor: RoomPerson }
  | { readonly kind: 'waiting'; readonly holder: RoomPerson }
  | { readonly kind: 'placeholder'; readonly sources: RoomSource[]; readonly asked: boolean }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'mine'; readonly source: RoomSource; readonly shownTo: 'anyone' | 'members' | 'me' }
  | { readonly kind: 'shown'; readonly from: RoomSource[] };

const Failed = v.object({ failed: v.string() });

/**
 * A part as `session` sees it now. Its newest output is shown only once its every element may reach the person; until
 * then they see a placeholder naming whose sources it hides, and nothing of what it holds, its failure included.
 */
export function partDecision(caretaker: RoomCaretaker, key: string, session: Session, live: {
  readonly need: Need | undefined; readonly computing: boolean;
  /** Why the part's call must be asked again, told only to the person who asked it. */
  readonly again: { readonly requester: string | null; readonly message: string } | undefined;
}): PartDecision {
  const { need, again } = live;
  const fn = partFn(key);

  if (need !== undefined && need.requester === session.email) return session.email === null ? { kind: 'needs-sign-in' } : { kind: 'needs-connection', need };

  if (again !== undefined && again.requester === session.email) return { kind: 'failed', message: again.message };
  const cell = caretaker.cell(key);

  if (live.computing || cell === null) return { kind: 'running' };
  const room = caretaker.room();
  const members = caretaker.members();
  const suspended = caretaker.grants().find((grant) => grant.fn === fn && grant.image !== room.image);

  if (suspended !== undefined && room.imageAuthor !== null && room.imageAuthor !== suspended.holder) {
    const editor = personOf(members, room.imageAuthor);

    if (suspended.personal && suspended.holder === session.email) return { kind: 'edited', grant: suspended, editor };

    if (!suspended.personal) return { kind: 'waiting', holder: personOf(members, suspended.holder) };
  }

  const seen = caretaker.render(key, session);

  if (!seen.shown) {
    const asked = session.email !== null && seen.hidden.every((elem) => caretaker.asks(elem.holder).some((ask) => ask.asker === session.email));

    return { kind: 'placeholder', sources: seen.hidden.map((elem) => sourceOf(members, elem)), asked };
  }

  const failed = v.safeParse(Failed, seen.value);

  if (failed.success) return { kind: 'failed', message: failed.output.failed };
  const mine = cell.label.filter((elem) => elem.holder === session.email);
  const [first] = mine;

  if (first !== undefined && mine.length === cell.label.length) {
    const shows = caretaker.shows().filter((show) => show.holder === session.email && mine.some((elem) => elem.server === show.server && elem.root === show.root));
    let shownTo: 'anyone' | 'members' | 'me' = 'me';

    if (shows.some((show) => show.audience === 'anyone')) shownTo = 'anyone';
    else if (shows.length > 0) shownTo = 'members';

    return { kind: 'mine', source: sourceOf(members, first), shownTo };
  }

  return { kind: 'shown', from: cell.label.filter((elem) => elem.holder !== session.email).map((elem) => sourceOf(members, elem)) };
}

/** What a holder is asked to decide: who asks to see a part of theirs, and each step that waits for them. */
export function roomAsks(caretaker: RoomCaretaker, holder: string): RoomAsk[] {
  const members = caretaker.members();

  const shows: RoomAsk[] = caretaker.asks(holder).map((ask) => ({
    kind: 'show', id: JSON.stringify([ask.asker, ask.tag.server, ask.tag.root, ask.fn]), from: personOf(members, ask.asker),
    part: { key: ask.fn, fn: ask.fn }, source: sourceOf(members, ask.tag),
  }));

  const waiting: RoomAsk[] = caretaker.waiting(holder).flatMap((pending): RoomAsk[] => {
    const run = caretaker.run(pending.run);
    const grant = caretaker.grant(pending.grant);

    if (run === null || grant === null) return [];
    const tool = { name: pending.tool, title: pending.tool, readOnly: !grant.effect };

    if (pending.kind === 'outflow') {
      const [own = grant] = run.label.filter((elem: Elem) => elem.holder === holder);

      return [{ kind: 'outflow', id: pending.id, fn: run.fn, source: sourceOf(members, own), service: serviceOf(grant.server), tool, argument: JSON.stringify(pending.args) }];
    }

    return [{
      kind: 'effect', id: pending.id, from: personOf(members, run.requester?.email ?? ''), fn: run.fn, service: serviceOf(grant.server), tool,
      scope: scopeText(grant.root), argument: JSON.stringify(pending.args),
    }];
  });

  return [...shows, ...waiting];
}

/** The owner's sheet: who may open the slate and how, what is lent, and who used it. `url` is the link while it is on. */
export function sheetView(caretaker: RoomCaretaker, url: string | null, listing: SheetView['listing']): SheetView {
  const room = caretaker.room();
  const owner = caretaker.owner();
  const members = caretaker.members();
  const people = members.filter((member) => member.role === 'edit' || member.role === 'use');
  let audience: RoomAudience = 'only-you';

  if (room.link) audience = 'anyone';
  else if (people.length > 0) audience = 'people';
  const grants = caretaker.grants();
  const personal = new Set(grants.filter((grant) => grant.personal).map((grant) => grant.holder));
  const ownFns = [...new Set(grants.filter((grant) => grant.holder === owner).map((grant) => grant.fn))];
  const shows = caretaker.shows();

  return {
    audience, url, listing, secret: room.secret,
    people: people.map((member) => ({ person: personOf(members, member.email), role: member.role === 'edit' ? 'edit' : 'use' })),
    privateOf: members.filter((member) => member.email !== owner && personal.has(member.email)).map((member) => personOf(members, member.email)),
    lends: ownFns.flatMap((fn) => {
      const own = grants.find((grant) => grant.holder === owner && grant.fn === fn && grant.personal);
      const lend = grants.find((grant) => grant.holder === owner && grant.fn === fn && !grant.personal);
      const terms = lend ?? own;

      if (terms === undefined) return [];
      const suspended = lend !== undefined && lend.image !== room.image && room.imageAuthor !== null && room.imageAuthor !== owner;

      return [{
        fn, reach: reachOf(terms), free: codecIsFree(terms.domain),
        shown: shows.some((show) => show.holder === owner && show.fn === fn && show.audience === 'anyone') ? 'everyone' as const : 'holder' as const,
        on: lend !== undefined && !suspended,
        suspendedBy: suspended ? personOf(members, room.imageAuthor ?? '') : null,
      }];
    }),
    uses: caretaker.lendUses().map((use) => ({ fn: use.fn, calls: use.calls, lastAt: use.lastAt, person: personOf(members, use.email) })),
  };
}

/** The room's access, as the room's client names it: owner, edit, use, or link. */
export function accessName(caretaker: RoomCaretaker, session: Session): 'owner' | 'edit' | 'use' | 'link' {
  if (session.access.kind === 'owner') return 'owner';

  if (session.access.kind === 'link') return 'link';

  return caretaker.members().find((member) => member.email === session.email)?.role === 'edit' ? 'edit' : 'use';
}
