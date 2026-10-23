/**
 * `/api/explore/*` and `/api/gallery/*`: Explore's apps and workspaces, and a listed app's own page, before the session
 * gate. Anyone may read them; starring and reporting take a signed-in person. A listing's picture is served only while
 * it is listed, and only the digest it lists. Their index is the control plane's (core slates/gallery.ts), asked with
 * the Worker's own capability on each person's behalf.
 */
import { Hono, type Context } from 'hono';
import * as v from 'valibot';
import { Effect } from 'effect';
import {
  blueprintPage, err, json, kinuBlueprint, safeJson, EXPLORE_KINDS, GALLERY_CATEGORIES, GALLERY_LAST_PAGE, GALLERY_SORTS, type GallerySlate,
} from '@kinu.run/core';
import { KINU_LISTINGS } from '@kinu.run/core/control-plane';
import { attempt, diagnostics, settle } from '@kinu.run/core/obs';
import { workspaceOwner } from '../workspace-owner-rpc';
import { crossSiteRejection, requestIdentity } from '../auth/session';
import { rawParam, type FamilyEnv } from '../api/context';
import { pictureVersion, readPictureInMode, sharePictureKey } from '../slates/pictures';
import { internalCaller } from '@kinu.run/core/control-plane';
import { controlPlaneStub } from '../control-plane/stub';
import type { ControlPlaneDO, GalleryMark } from '../control-plane/control-plane-do';

export const galleryRoutes = new Hono<FamilyEnv<Env, object>>();

// A star or a report is a signed-in person's: one sent with their cookie from another origin is refused, as the gate does.
galleryRoutes.use('/api/gallery/*', async (c, next) => crossSiteRejection(c.req.raw) ?? await next());

galleryRoutes.use('/api/explore/*', async (c, next) => crossSiteRejection(c.req.raw) ?? await next());

const NO_STORE = { 'cache-control': 'no-store' };

const ExploreQuery = v.object({
  q: v.optional(v.pipe(v.string(), v.maxLength(200)), ''),
  kind: v.optional(v.picklist(EXPLORE_KINDS)),
  sort: v.optional(v.picklist(GALLERY_SORTS), 'trending'),
  category: v.optional(v.picklist(GALLERY_CATEGORIES)),
  page: v.optional(v.pipe(v.string(), v.transform(Number), v.safeInteger(), v.minValue(0), v.maxValue(GALLERY_LAST_PAGE)), '0'),
});

/** A star's body says `on`; a report's says its `reason`. */
const MarkBody = v.object({
  workspace: v.string(), slate: v.string(), on: v.optional(v.boolean()), reason: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(2000))),
});

/** The control plane's Gallery, and the capability it is asked with. */
async function gallery(env: Env): Promise<{ readonly plane: DurableObjectStub<ControlPlaneDO>; readonly caller: Awaited<ReturnType<typeof internalCaller>> }> {
  return { plane: controlPlaneStub(env), caller: await internalCaller(env) };
}

/** The signed-in person, by the email the Gallery keys them by and their account. */
async function personOf(c: Context<FamilyEnv<Env, object>>): Promise<{ readonly email: string; readonly userId: string } | null> {
  const identity = await requestIdentity(c.req.raw, c.env);

  return identity === null ? null : { email: identity.email.trim().toLowerCase(), userId: identity.userId };
}

async function viewerOf(c: Context<FamilyEnv<Env, object>>): Promise<string | null> {
  return (await personOf(c))?.email ?? null;
}

galleryRoutes.get('/api/explore', async (c) => {
  const query = v.safeParse(ExploreQuery, Object.fromEntries(new URL(c.req.url).searchParams));

  if (!query.success) return err(400, 'Explore is asked by kind, sort, page, category and words');
  const { q, sort, category, page, kind } = query.output;

  const { plane, caller } = await gallery(c.env);

  return json({ body: await plane.explorePage(caller, { q, sort, category: category ?? null, page, kind: kind ?? null }, await viewerOf(c)) }, { headers: NO_STORE });
});

/** A workspace blueprint Kinu keeps: its page, its listing's numbers read from the index. */
galleryRoutes.get('/api/explore/workspaces/:id', async (c) => {
  const id = decodeURIComponent(rawParam(c, 'id'));
  const blueprint = kinuBlueprint(id);

  if (blueprint === undefined) return err(404, 'No such workspace blueprint');

  const { plane, caller } = await gallery(c.env);
  const card = await plane.exploreWorkspace(caller, KINU_LISTINGS, id, await viewerOf(c));

  if (card === null) return err(404, 'No such workspace blueprint');

  return json({ body: blueprintPage(blueprint, card) }, { headers: NO_STORE });
});

/** A signed-in person's mark on a listing: 204, or 404 when the slate is not listed. */
async function marked(c: Context<FamilyEnv<Env, object>>, mark: (body: v.InferOutput<typeof MarkBody>) => GalleryMark | null): Promise<Response> {
  const viewer = await personOf(c);

  if (viewer === null) return err(401, 'Sign in to star or report a slate');
  const body = await safeJson(c.req.raw, MarkBody);
  const made = body === null ? null : mark(body);

  if (made === null) return err(400, 'Body must name the slate, and say on, or the reason');

  const { plane, caller } = await gallery(c.env);

  return await plane.galleryMark(caller, viewer, made) ? new Response(null, { status: 204 }) : err(404, 'No such listing');
}

galleryRoutes.post('/api/gallery/star', async (c) => marked(c, (body) => (body.on === undefined ? null : { kind: 'star', workspace: body.workspace, slate: body.slate, on: body.on })));

/** A signed-in person's star on one of Kinu's workspace blueprints: 204, or 404 when it is not listed. */
galleryRoutes.post('/api/explore/workspaces/:id/star', async (c) => {
  const viewer = await personOf(c);

  if (viewer === null) return err(401, 'Sign in to star a workspace');
  const body = await safeJson(c.req.raw, v.object({ on: v.boolean() }));

  if (body === null) return err(400, 'Body must say on');
  const { plane, caller } = await gallery(c.env);
  const mark = { kind: 'star', listing: 'workspace', workspace: KINU_LISTINGS, slate: decodeURIComponent(rawParam(c, 'id')), on: body.on } as const;

  return await plane.galleryMark(caller, viewer, mark) ? new Response(null, { status: 204 }) : err(404, 'No such workspace blueprint');
});

galleryRoutes.post('/api/gallery/report', async (c) => marked(c, (body) => (body.reason === undefined ? null : { kind: 'report', workspace: body.workspace, slate: body.slate, reason: body.reason })));

galleryRoutes.get('/api/gallery/:workspace/:slate/picture/:digest', async (c) => {
  const workspace = decodeURIComponent(rawParam(c, 'workspace'));
  const slate = decodeURIComponent(rawParam(c, 'slate'));
  const digest = rawParam(c, 'digest');
  const { plane, caller } = await gallery(c.env);
  const listed = await plane.galleryListed(caller, workspace, slate);
  const bucket = c.env.SLATE_PICTURES;

  if (listed === null || listed.picture !== pictureVersion(digest) || bucket === undefined) return new Response('Not found', { status: 404, headers: NO_STORE });

  // Only the picture taken through the listed share itself: never one of its owner's private preview. Its dark capture
  // where the slate drew one, else its light one.
  return await readPictureInMode(bucket, (version) => sharePictureKey(workspace, slate, listed.share, version), digest, 'public')
    ?? new Response('Not found', { status: 404, headers: NO_STORE });
});

galleryRoutes.get('/api/gallery/:workspace/:slate', (c) => settle(Effect.gen(function* () {
  const { plane, caller } = yield* Effect.promise(async () => gallery(c.env));
  const workspace = decodeURIComponent(rawParam(c, 'workspace'));
  const viewer = yield* Effect.promise(async () => viewerOf(c));
  const listed = yield* Effect.promise(async () => plane.gallerySlate(caller, workspace, decodeURIComponent(rawParam(c, 'slate')), viewer));

  if (listed === null) return err(404, 'No such listing');

  // What only its share knows, read from the share the index names: absent when its workspace cannot say.
  const needs = yield* attempt({ doing: 'reading what a listed slate needs of its visitors', otherwise: 'unavailable' },
    async () => workspaceOwner(c.env, workspace).galleryNeeds(listed.listing.share)).pipe(
    Effect.map((answered) => (answered.ok ? answered.value : null)),
    Effect.catch((failure) => Effect.sync(() => {
      diagnostics.failure('gallery.needs_unread', failure, { workspace });

      return null;
    })),
  );

  return json({ body: (needs === null ? listed : { ...listed, needs }) satisfies GallerySlate }, { headers: NO_STORE });
})));
