/**
 * `/api/gallery/*`: the Gallery, before the session gate. Anyone may read it; starring and reporting take a signed-in
 * person. A listing's picture is served only while it is listed, and only the digest it lists. Its index is the
 * control plane's (core slates/gallery.ts), asked with the Worker's own capability on each person's behalf.
 */
import { Hono, type Context } from 'hono';
import * as v from 'valibot';
import { Effect } from 'effect';
import { err, json, safeJson, GALLERY_CATEGORIES, GALLERY_LAST_PAGE, GALLERY_SORTS, type GallerySlate } from '@kinu.run/core';
import { attempt, diagnostics, settle } from '@kinu.run/core/obs';
import { workspaceOwner } from '../workspace-owner-rpc';
import { crossSiteRejection, requestIdentity } from '../auth/session';
import { rawParam, type FamilyEnv } from '../api/context';
import { readSlatePicture, sharePictureKey } from '../slates/pictures';
import { internalCaller } from '@kinu.run/core/control-plane';
import { controlPlaneStub } from '../control-plane/stub';
import type { ControlPlaneDO, GalleryMark } from '../control-plane/control-plane-do';

export const galleryRoutes = new Hono<FamilyEnv<Env, object>>();

// A star or a report is a signed-in person's: one sent with their cookie from another origin is refused, as the gate does.
galleryRoutes.use('/api/gallery/*', async (c, next) => crossSiteRejection(c.req.raw) ?? await next());

const NO_STORE = { 'cache-control': 'no-store' };

const Query = v.object({
  q: v.optional(v.pipe(v.string(), v.maxLength(200)), ''),
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

async function viewerOf(c: Context<FamilyEnv<Env, object>>): Promise<string | null> {
  return (await requestIdentity(c.req.raw, c.env))?.email.trim().toLowerCase() ?? null;
}

galleryRoutes.get('/api/gallery', async (c) => {
  const query = v.safeParse(Query, Object.fromEntries(new URL(c.req.url).searchParams));

  if (!query.success) return err(400, 'The Gallery is asked by sort, page, category and words');
  const { q, sort, category, page } = query.output;

  const { plane, caller } = await gallery(c.env);

  return json({ body: await plane.galleryPage(caller, { q, sort, category: category ?? null, page }, await viewerOf(c)) }, { headers: NO_STORE });
});

/** A signed-in person's mark on a listing: 204, or 404 when the slate is not listed. */
async function marked(c: Context<FamilyEnv<Env, object>>, mark: (body: v.InferOutput<typeof MarkBody>) => GalleryMark | null): Promise<Response> {
  const viewer = await viewerOf(c);

  if (viewer === null) return err(401, 'Sign in to star or report a slate');
  const body = await safeJson(c.req.raw, MarkBody);
  const made = body === null ? null : mark(body);

  if (made === null) return err(400, 'Body must name the slate, and say on, or the reason');

  const { plane, caller } = await gallery(c.env);

  return await plane.galleryMark(caller, viewer, made) ? new Response(null, { status: 204 }) : err(404, 'No such listing');
}

galleryRoutes.post('/api/gallery/star', async (c) => marked(c, (body) => (body.on === undefined ? null : { kind: 'star', workspace: body.workspace, slate: body.slate, on: body.on })));

galleryRoutes.post('/api/gallery/report', async (c) => marked(c, (body) => (body.reason === undefined ? null : { kind: 'report', workspace: body.workspace, slate: body.slate, reason: body.reason })));

galleryRoutes.get('/api/gallery/:workspace/:slate/picture/:digest', async (c) => {
  const workspace = decodeURIComponent(rawParam(c, 'workspace'));
  const slate = decodeURIComponent(rawParam(c, 'slate'));
  const digest = rawParam(c, 'digest');
  const { plane, caller } = await gallery(c.env);
  const listed = await plane.galleryListed(caller, workspace, slate);
  const bucket = c.env.SLATE_PICTURES;

  if (listed === null || listed.picture !== digest || bucket === undefined) return new Response('Not found', { status: 404, headers: NO_STORE });

  // Only the picture taken through the listed share itself: never one of its owner's private preview.
  return await readSlatePicture(bucket, sharePictureKey(workspace, slate, listed.share, digest), 'public') ?? new Response('Not found', { status: 404, headers: NO_STORE });
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
