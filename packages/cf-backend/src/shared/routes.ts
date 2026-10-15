/**
 * `/api/shared/*`: the Drive's library of slates. A slate's own sharing goes through its room (`slates/room-routes.ts`);
 * these routes list what a person owns and what reaches them, and let them leave a slate shared with them.
 */
import { Hono } from 'hono';
import * as v from 'valibot';
import { err, json, safeJson, type DriveLibrary, type DriveRoomCard, type DriveSlate, type UserCaller } from '@kinu.run/core';
import { GALLERY_OBJECT } from '../gallery/gallery-do';
import { roomHandle, roomObjectName } from '@kinu.run/core/slates';
import type { AuthIdentity } from '../auth/session';
import { ownerGate, type ApiVariables, type FamilyEnv } from '../api/context';

const LeaveBody = v.object({ workspace: v.string(), slate: v.string() });

interface SharedVariables extends ApiVariables {
  owner: UserCaller;
}

export const sharedRoutes = new Hono<FamilyEnv<Env, SharedVariables>>();

sharedRoutes.use('/api/shared/*', ownerGate());

sharedRoutes.get('/api/shared', async (c) => json({ body: await library(c.env, c.get('identity'), c.get('owner')) }));

/** Shared was opened: what it holds now is seen, on every device. */
sharedRoutes.post('/api/shared/seen', async (c) => {
  const identity = c.get('identity');

  await c.env.UserDO.get(c.env.UserDO.idFromName(identity.userId)).sharesSeen(c.get('owner'), Date.now());

  return json({ body: { seen: true } });
});

/** Leaves a slate shared with this person: their membership ends, and every session they hold on it with it. */
sharedRoutes.post('/api/shared/leave', async (c) => {
  const body = await safeJson(c.req.raw, LeaveBody);

  if (!body) return err(400, 'Body must be { workspace, slate }');
  const room = c.env.SLATE_ROOM.get(c.env.SLATE_ROOM.idFromName(roomObjectName(body.workspace, roomHandle(body.workspace, body.slate))));

  if (!await room.exists()) return err(404, 'No such slate');
  await room.leave(c.get('identity').email.trim().toLowerCase());

  return new Response(null, { status: 204 });
});

async function library(env: Env, identity: AuthIdentity, owner: UserCaller): Promise<DriveLibrary> {
  const userDO = env.UserDO.get(env.UserDO.idFromName(identity.userId));
  const slates: DriveSlate[] = [];

  for (const { workspace, overview } of await userDO.libraryTiles(owner)) {
    for (const slate of overview.slates) slates.push({ id: slate.id, title: slate.title, workspace, ...(slate.picture !== null && { picture: slate.picture }) });
  }

  // What rooms wrote to this account: a slate shared with this person carries the role it was shared with; one used
  // through its link carries none, and its link.
  const seenAt = await userDO.sharesSeenAt(owner) ?? 0;

  const cards: DriveRoomCard[] = (await userDO.sharesReceived_list(owner)).flatMap((held) => held.card.url === undefined ? [] : [{
    workspace: held.workspace, slate: held.shareId, title: held.card.title, owner: { email: held.card.owner, name: null },
    relation: held.card.role === undefined ? 'used' as const : 'shared' as const, ...(held.card.role !== undefined && { role: held.card.role }),
    at: held.receivedAt, ...(held.receivedAt > seenAt && { unseen: true as const }), url: held.card.url,
  }]);

  const starred = await env.GALLERY.get(env.GALLERY.idFromName(GALLERY_OBJECT)).starred(identity.email.trim().toLowerCase());

  return { slates, shared: cards.filter((card) => card.relation === 'shared'), used: cards.filter((card) => card.relation === 'used'), starred };
}
