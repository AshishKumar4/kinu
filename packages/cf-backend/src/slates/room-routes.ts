/**
 * The app's routes to a slate room, before the session gate: a visitor who has not signed in may hold the link's key.
 * A signed-in person is named to the room by the session this route verified; any person or key header the request
 * carried is dropped first. The room decides everything else.
 */
import { Hono, type Context } from 'hono';
import { Result } from 'effect';
import * as v from 'valibot';
import { hostTokenHolds, parseSlateShareLabel, previewHostSuffix, RoomEntrySchema, safeJson, type Forked, type RoomEntry } from '@kinu.run/core';
import { requestIdentity, type AuthIdentity } from '../auth/session';
import { claimOwnedWorkspace } from '../user/workspace-ownership';
import { workspaceOwner } from '../workspace-owner-rpc';
import { rawParam, type FamilyEnv } from '../api/context';
import {
  cookieForTicket, frameCookieHeader, frameCookieOf, readPass, roomHandle, roomObjectName, ROOM_ENTER_PATH,
} from '@kinu.run/core/slates';
import { ROOM_HOST_HEADER, ROOM_KEY_HEADER, ROOM_PERSON_HEADER, type RoomVisitor, type SlateRoom } from './room';

export const roomRoutes = new Hono<FamilyEnv<Env, object>>();

/** The session's person, or null for a request with no session or an expired one: a room treats both as signed out. */
async function visitorOf(request: Request, env: Env): Promise<{ identity: AuthIdentity; visitor: RoomVisitor } | null> {
  const identity = await requestIdentity(request, env);

  if (identity === null) return null;
  const email = identity.email.trim().toLowerCase();

  return { identity, visitor: { email, name: identity.displayName ?? email.slice(0, email.indexOf('@')) } };
}

function roomOf(env: Env, workspace: string, slate: string): DurableObjectStub<SlateRoom> {
  return env.SLATE_ROOM.get(env.SLATE_ROOM.idFromName(roomObjectName(workspace, roomHandle(workspace, slate))));
}

/**
 * The room, made on its first need when its owner asks: only the workspace names its owner, and only after the session
 * proves it owns that workspace; anyone else gets no room.
 */
async function openedRoom(env: Env, address: { workspace: string; slate: string }, signedIn: { identity: AuthIdentity } | null): Promise<DurableObjectStub<SlateRoom> | null> {
  const room = roomOf(env, address.workspace, address.slate);

  if (await room.exists()) return room;

  if (signedIn === null) return null;
  const owned = await claimOwnedWorkspace(env, signedIn.identity.userId, address.workspace);

  if (Result.isFailure(owned)) return null;
  const made = await workspaceOwner(env, address.workspace).ensureSlateRoom(address.slate);

  return made.ok ? room : null;
}

function addressOf(c: Context) {
  return { workspace: decodeURIComponent(rawParam(c, 'workspace')), slate: decodeURIComponent(rawParam(c, 'slate')) };
}

const NO_STORE = { 'cache-control': 'no-store' };

const ForkBody = v.object({ workspace: v.string() });

roomRoutes.get('/api/rooms/:workspace/:slate/entry', async (c) => {
  const signedIn = await visitorOf(c.req.raw, c.env);
  const room = await openedRoom(c.env, addressOf(c), signedIn);

  if (room === null) return new Response('No such slate', { status: 404, headers: NO_STORE });
  const answer = await room.entry(signedIn?.visitor ?? null, new URL(c.req.url).searchParams.get('k'));

  if (answer.status !== 200) return new Response(null, { status: answer.status, headers: NO_STORE });
  const entry: RoomEntry = v.parse(RoomEntrySchema, { title: answer.title, owner: answer.owner, access: answer.access });

  return Response.json(entry, { headers: NO_STORE });
});

roomRoutes.get('/api/rooms/:workspace/:slate', async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
  const signedIn = await visitorOf(c.req.raw, c.env);
  const room = await openedRoom(c.env, addressOf(c), signedIn);

  if (room === null) return new Response('No such slate', { status: 404, headers: NO_STORE });
  const headers = new Headers(c.req.raw.headers);

  headers.delete(ROOM_PERSON_HEADER);
  headers.delete(ROOM_KEY_HEADER);
  headers.delete(ROOM_HOST_HEADER);

  if (signedIn !== null) headers.set(ROOM_PERSON_HEADER, JSON.stringify(signedIn.visitor));
  const key = new URL(c.req.url).searchParams.get('k');

  if (key !== null) headers.set(ROOM_KEY_HEADER, key);

  return await room.fetch(new Request(c.req.raw, { headers }));
});

/** What forking the slate brings this signed-in visitor. */
roomRoutes.get('/api/rooms/:workspace/:slate/fork', async (c) => {
  const { workspace, slate } = addressOf(c);
  const signed = await visitorOf(c.req.raw, c.env);

  if (signed === null) return new Response('Sign in to fork this slate.', { status: 401, headers: NO_STORE });
  const preview = await roomOf(c.env, workspace, slate).forkPreview(signed.visitor, new URL(c.req.url).searchParams.get('k'));

  return preview === null ? new Response('This slate is not yours to fork.', { status: 403, headers: NO_STORE }) : Response.json(preview, { headers: NO_STORE });
});

/** Forks the slate into one of the visitor's own workspaces: its code alone, with every requirement theirs to meet. */
roomRoutes.post('/api/rooms/:workspace/:slate/fork', async (c) => {
  const { workspace, slate } = addressOf(c);
  const signed = await visitorOf(c.req.raw, c.env);

  if (signed === null) return new Response('Sign in to fork this slate.', { status: 401, headers: NO_STORE });
  const body = await safeJson(c.req.raw, ForkBody);

  if (!body) return new Response('Body must be { workspace }', { status: 400, headers: NO_STORE });
  const into = await claimOwnedWorkspace(c.env, signed.identity.userId, body.workspace);

  if (Result.isFailure(into)) return new Response('That workspace is not yours.', { status: 403, headers: NO_STORE });
  const bundle = await roomOf(c.env, workspace, slate).forkBundle(signed.visitor, new URL(c.req.url).searchParams.get('k'));

  if (bundle === null) return new Response('This slate is not yours to fork.', { status: 403, headers: NO_STORE });

  if (!bundle.ok) return new Response(bundle.error, { status: 409, headers: NO_STORE });
  const forked = await into.success.admitBlueprint(bundle.value, `${workspace}/${slate}`);

  return forked.ok
    ? Response.json({ workspace: forked.value.workspace, slate: forked.value.slate } satisfies Forked, { headers: NO_STORE })
    : new Response(forked.error, { status: 409, headers: NO_STORE });
});

/** The slate's page in a frame: the visitor, as the app knows them, sent on to the slate's own host with a ticket. */
roomRoutes.get('/api/rooms/:workspace/:slate/frame', async (c) => {
  const { workspace, slate } = addressOf(c);
  const signed = await visitorOf(c.req.raw, c.env);
  const entered = await roomOf(c.env, workspace, slate).ticketFor(signed?.visitor ?? null, new URL(c.req.url).searchParams.get('k'));

  if (entered === null) return new Response(signed === null ? 'Sign in to open this slate.' : 'This slate is not shared with you.', { status: signed === null ? 401 : 403, headers: NO_STORE });

  return new Response(null, { status: 303, headers: { ...NO_STORE, location: entered } });
});

/** A part's sealed content: the room renders what this ticket's session may see, with no script and nothing to reach. */
roomRoutes.get('/api/rooms/:workspace/:slate/parts/:part/content', async (c) => {
  const { workspace, slate } = addressOf(c);
  const handle = roomHandle(workspace, slate);
  const ticket = new URL(c.req.url).searchParams.get('t') ?? '';
  const claim = await readPass(c.env, { workspace, handle }, ticket, 'ticket');

  if (claim === null) return new Response('Not found', { status: 404, headers: NO_STORE });

  return await roomOf(c.env, workspace, slate).partContent(claim, decodeURIComponent(rawParam(c, 'part')));
});

/**
 * The slate's own host, `<handle>-<token>-<workspace>.<suffix>`: its token is checked before the room is woken. The
 * entry exchanges a session's ticket for its host-only cookie; every other request goes to the room with the session
 * that cookie names, or none, and the room admits it again.
 */
export async function handleSlateRoomHostRequest(request: Request, env: Env): Promise<Response | null> {
  const suffix = previewHostSuffix(env);

  if (suffix === null) return null;
  const url = new URL(request.url);
  const suffixWithDot = `.${suffix}`;

  if (!url.hostname.endsWith(suffixWithDot)) return null;
  const label = parseSlateShareLabel(url.hostname.slice(0, -suffixWithDot.length));

  if (label === null) return null;
  const { workspace, handle, token } = label;

  if (!await hostTokenHolds(env, workspace, handle, token)) return new Response('Not found', { status: 404, headers: NO_STORE });
  const room = { workspace, handle };

  if (url.pathname === ROOM_ENTER_PATH) {
    const cookie = await cookieForTicket(env, room, url.searchParams.get('t') ?? '');

    if (cookie === null) return new Response('Open this slate from its page in Kinu.', { status: 403, headers: NO_STORE });

    return new Response(null, { status: 303, headers: { ...NO_STORE, location: '/', 'set-cookie': frameCookieHeader(cookie) } });
  }

  const pass = frameCookieOf(request.headers.get('cookie'));
  const claim = pass === null ? null : await readPass(env, room, pass, 'cookie');
  const headers = new Headers(request.headers);

  headers.delete('cookie');
  headers.set(ROOM_HOST_HEADER, JSON.stringify(claim === null ? null : { email: claim.email, access: claim.access }));

  return await env.SLATE_ROOM.get(env.SLATE_ROOM.idFromName(roomObjectName(workspace, handle))).fetch(new Request(request, { headers }));
}
