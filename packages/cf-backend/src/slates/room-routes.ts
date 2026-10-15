/**
 * The app's routes to a slate room, before the session gate: a visitor who has not signed in may hold the link's key.
 * A signed-in person is named to the room by the session this route verified; any person or key header the request
 * carried is dropped first. The room decides everything else.
 */
import { Hono, type Context } from 'hono';
import { Result } from 'effect';
import * as v from 'valibot';
import { RoomEntrySchema, type RoomEntry } from '@kinu.run/core';
import { requestIdentity, type AuthIdentity } from '../auth/session';
import { claimOwnedWorkspace } from '../user/workspace-ownership';
import { workspaceOwner } from '../workspace-owner-rpc';
import { rawParam, type FamilyEnv } from '../api/context';
import { roomHandle, roomObjectName } from '@kinu.run/core/slates';
import { ROOM_KEY_HEADER, ROOM_PERSON_HEADER, type RoomVisitor, type SlateRoom } from './room';

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

  if (signedIn !== null) headers.set(ROOM_PERSON_HEADER, JSON.stringify(signedIn.visitor));
  const key = new URL(c.req.url).searchParams.get('k');

  if (key !== null) headers.set(ROOM_KEY_HEADER, key);

  return await room.fetch(new Request(c.req.raw, { headers }));
});
