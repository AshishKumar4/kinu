/**
 * `/api/shared/*`: shared library and blueprints. `GET /api/shared/blueprint/:id` is public by link: the signature is
 * checked before any object is touched, and the owner's object re-reads the row every call (S6). No credential crosses (S8).
 */
import { Hono } from 'hono';
import { Result } from 'effect';
import * as v from 'valibot';
import {
  objectNamed,
  err, ERROR_STATUS, json, safeJson,
  formatBlueprintId, parseBlueprintId, PublishedBlueprintSchema, labelSigner,
  type BlueprintView, type SharedLibrary, type SharedRow, type OwnedSlate, type BlueprintFork, type UserCaller,
  LiveShareBodySchema, LiveShareCreatedSchema, LIVE_SHARE_MODE_PATH, LiveShareModeBodySchema, LIVE_SHARE_LISTING_PATH, LiveShareListingBodySchema, LIVE_SHARE_OPEN_PATH, type LiveShareOpen, type LiveShareBody,
  type LiveShareRecord, type SlateAnswer,
} from '@kinu.run/core';
import { slateShareUrl, viewerEntryUrl } from '../slate-share-route';
import type { AuthIdentity } from '../auth/session';
import { accountIdFor } from '../auth/store';
import { claimOwnedWorkspace } from '../user/workspace-ownership';
import type { OrchestratorAgent } from '../orchestrator';
import { workspaceOwner } from '../workspace-owner-rpc';
import { ROOT_SLATE_CALLER } from '@kinu.run/core/slates';
import { ownerGate, rawParam, type ApiVariables, type FamilyEnv } from '../api/context';

/** The owner's workspace, once the app host proved it is theirs. */
type OwnedWorkspace = Pick<DurableObjectStub<OrchestratorAgent>, 'setLiveShareMode' | 'setLiveShareListing' | 'slateAs'>;

/** Its own salt and info, so preview and blueprint tokens never verify each other. */
const blueprintSigner = labelSigner('kinu.blueprint.salt', 'kinu.blueprint.v1');

function blueprintMessage(workspace: string, share: string): string {
  return `kinu:blueprint:v1:${workspace}:${share}`;
}

/** Null on a deployment with no signing secret. */
async function mintBlueprintId(env: Env, workspace: string, share: string): Promise<string | null> {
  const secret = blueprintSigner.secret(env);

  if (secret === undefined) return null;

  return formatBlueprintId({ workspace, share, token: await blueprintSigner.token(secret, blueprintMessage(workspace, share)) });
}

async function verifiedBlueprintAddress(env: Env, id: string): Promise<{ workspace: string; share: string } | null> {
  const address = parseBlueprintId(id);

  if (address === null) return null;

  if (!await blueprintSigner.verify(env, blueprintMessage(address.workspace, address.share), address.token)) return null;

  return { workspace: address.workspace, share: address.share };
}

const NOT_FOUND = 'No such blueprint';

/** Public half: before the session gate; answers nothing but page data. */
export const sharedPublicRoutes = new Hono<FamilyEnv<Env, object>>();

sharedPublicRoutes.get('/api/shared/blueprint/:id', async (c) => {
  const id = decodeURIComponent(rawParam(c, 'id'));
  const address = await verifiedBlueprintAddress(c.env, id);

  // Unminted, forged and malformed ids get one answer, without waking an object.
  if (address === null) return err(404, NOT_FOUND);
  const answer = await workspaceOwner(c.env, address.workspace).readBlueprint(address.share);

  // A revoked blueprint is indistinguishable from one that never existed.
  if (!answer.ok) return err(404, NOT_FOUND);
  const view: BlueprintView = { id, ...answer.value.view };

  return json({ body: view }, { headers: { 'cache-control': 'no-store' } });
});

const PublishBody = v.object({
  workspace: v.string(),
  slate: v.string(),
  version: v.string(),
  include: v.optional(v.array(v.string())),
  emails: v.optional(v.array(v.pipe(v.string(), v.trim(), v.email()))),
});

const ForkBody = v.union([
  v.strictObject({ blueprint: v.string(), workspace: v.string() }),
  v.strictObject({ live: v.string(), ownerWorkspace: v.string(), workspace: v.string() }),
]);

interface SharedVariables extends ApiVariables {
  owner: UserCaller;
}

export const sharedRoutes = new Hono<FamilyEnv<Env, SharedVariables>>();

sharedRoutes.use('/api/shared/*', ownerGate());

sharedRoutes.get('/api/shared', async (c) => json({ body: await library(c.env, c.get('identity'), c.get('owner')) }));

/** Shared was opened: what it holds now is seen, on every device. */
sharedRoutes.post('/api/shared/seen', async (c) => {
  const identity = c.get('identity');

  await objectNamed(c.env.UserDO, identity.userId).sharesSeen(c.get('owner'), Date.now());

  return json({ body: { seen: true } });
});

sharedRoutes.post('/api/shared/publish', async (c) => publish(c.req.raw, c.env, c.get('identity')));

sharedRoutes.post('/api/shared/fork', async (c) => fork(c.req.raw, c.env, c.get('identity')));

sharedRoutes.post('/api/shared/live', async (c) => shareLive(c.req.raw, c.env, c.get('identity')));

sharedRoutes.post('/api/shared/revoke', async (c) => revoke(c.req.raw, c.env, c.get('identity')));

// Its mode set, or its reach approved again at the slate's revision now.
sharedRoutes.post(LIVE_SHARE_MODE_PATH, async (c) => shareChange({
  request: c.req.raw, env: c.env, identity: c.get('identity'), schema: LiveShareModeBodySchema,
  usage: "{ workspace, share, mode: 'own' } or { workspace, share, mode: 'owner', approved, revision }",
}, async (owned, body) => owned.setLiveShareMode(body)));

// Listed in the Gallery with its card's words, or taken off it.
sharedRoutes.post(LIVE_SHARE_LISTING_PATH, async (c) => shareChange({
  request: c.req.raw, env: c.env, identity: c.get('identity'), schema: LiveShareListingBodySchema,
  usage: '{ workspace, share, listed: true, line, category } or { workspace, share, listed: false }',
}, async (owned, body) => owned.setLiveShareListing(body)));

sharedRoutes.post(LIVE_SHARE_OPEN_PATH, async (c) => openLive(c.req.raw, c.env, c.get('identity')));

async function library(env: Env, identity: AuthIdentity, owner: UserCaller): Promise<SharedLibrary> {
  const userDO = objectNamed(env.UserDO, identity.userId);
  const slates: OwnedSlate[] = [];
  const mine: SharedRow[] = [];

  for (const { workspace, overview } of await userDO.libraryTiles(owner)) {
    for (const slate of overview.slates) {
      slates.push({
        id: slate.id, title: slate.title, workspace, ...(slate.visibility !== null && { visibility: slate.visibility }),
        ...(slate.picture !== null && { picture: slate.picture }),
      });
    }

    for (const share of overview.shares) {
      const row = {
        share: share.share, title: share.title, description: share.description, createdAt: share.createdAt,
        workspace, users: share.users,
      };

      if (share.kind === 'live') {
        mine.push({
          ...row, id: share.share, kind: 'live', slate: share.slate,
          ...(share.visibility !== undefined && { visibility: share.visibility }), ...(share.fork !== undefined && { fork: share.fork }),
        });
        continue;
      }

      const id = await mintBlueprintId(env, workspace, share.share);

      if (id !== null) mine.push({ ...row, id, kind: 'blueprint' });
    }
  }

  const received: SharedRow[] = [];
  const seenAt = await userDO.sharesSeenAt(owner);

  // The cards their owners sent: listed without waking a single owner's workspace. A share revoked since is gone
  // once its removal lands; one opened before then refuses at its owner's object. One that reached this account
  // since Shared was last opened is unseen.
  for (const { workspace, shareId, card, receivedAt } of await userDO.sharesReceived_list(owner)) {
    const row = {
      share: shareId, title: card.title, description: card.description, createdAt: card.createdAt, workspace, owner: card.owner,
      ...((seenAt === null || receivedAt > seenAt) && { unseen: true as const }),
    };

    if (card.kind === 'live') {
      received.push({
        ...row, id: shareId, kind: 'live',
        ...(card.visibility !== undefined && { visibility: card.visibility }), ...(card.fork !== undefined && { fork: card.fork }),
      });
      continue;
    }

    const id = await mintBlueprintId(env, workspace, shareId);

    if (id !== null) received.push({ ...row, id, kind: 'blueprint' });
  }

  return { slates, mine, received };
}

/** Behind when any write behind the answer could not reach the owner's tile, which is what its cards are sent from. */
function listed(...writes: ReadonlyArray<{ readonly listing?: 'pending' }>): { listing?: 'pending' } {
  return writes.some((write) => write.listing === 'pending') ? { listing: 'pending' } : {};
}

async function publish(request: Request, env: Env, identity: AuthIdentity): Promise<Response> {
  const body = await safeJson(request, PublishBody);

  if (!body) return err(400, 'Body must be { workspace, slate, version, include?, emails? }');
  const claim = await claimOwnedWorkspace(env, identity.userId, body.workspace);

  if (Result.isFailure(claim)) return err(claim.failure.status, claim.failure.error);
  const owned = claim.success;
  const published = await owned.slateAs(ROOT_SLATE_CALLER, { op: 'publish', id: body.slate, version: body.version, include: body.include });

  if (!published.ok) return err(ERROR_STATUS[published.reason], published.error);

  const { share } = v.parse(PublishedBlueprintSchema, published.value);

  const id = await mintBlueprintId(env, body.workspace, share.id);

  if (id === null) return err(503, 'This deployment cannot sign blueprint links: CREDENTIAL_ENCRYPTION_KEY is not set.');
  const emails = [...new Set((body.emails ?? []).map((email) => email.toLowerCase()).filter((email) => email !== identity.email.toLowerCase()))];
  const writes: Array<{ readonly listing?: 'pending' }> = [published];
  let users: readonly string[] = share.users;

  if (emails.length > 0) {
    const named = await Promise.all(emails.map(async (email) => ({ userId: await accountIdFor(env, email), email })));
    const recorded = await owned.shareBlueprintWith(share.id, named);

    if (!recorded.ok) return err(409, recorded.error);
    writes.push(recorded);
    users = v.parse(v.object({ users: v.array(v.string()) }), recorded.value).users;
  }

  // Each person named gets their card from the owner's account, sent from the tile this write pushed.
  return json({ body: { id, share: share.id, users, published: published.value, ...listed(...writes) } }, { status: 201 });
}

async function fork(request: Request, env: Env, identity: AuthIdentity): Promise<Response> {
  const body = await safeJson(request, ForkBody);

  if (!body) return err(400, 'Body must be { blueprint, workspace } or { live, ownerWorkspace, workspace }');

  // The target is proven mine before the owner's object is asked for bytes.
  const claim = await claimOwnedWorkspace(env, identity.userId, body.workspace);

  if (Result.isFailure(claim)) return err(claim.failure.status, claim.failure.error);

  const bundle = 'blueprint' in body
    ? await blueprintBundle(env, body.blueprint)
    : await workspaceOwner(env, body.ownerWorkspace).liveShareBundle(body.live, identity.userId);

  if (!bundle.ok) return err(404, NOT_FOUND);
  const admitted = await claim.success.admitBlueprint(bundle.value);

  if (!admitted.ok) return err(ERROR_STATUS[admitted.reason], admitted.error);
  const result: BlueprintFork = admitted.value;

  return json({ body: result }, { status: 201 });
}

async function blueprintBundle(env: Env, id: string) {
  const address = await verifiedBlueprintAddress(env, id);

  if (address === null) return { ok: false as const, reason: 'missing' as const, error: NOT_FOUND };

  return workspaceOwner(env, address.workspace).blueprintBundle(address.share);
}

const LiveIdBody = v.object({ workspace: v.string(), share: v.string() });

/** `emails` names users on a `users` share; `approved` is the mutating grant the dialog checked. */
async function shareLive(request: Request, env: Env, identity: AuthIdentity): Promise<Response> {
  const body = await safeJson(request, LiveShareBodySchema);

  if (!body) return err(400, 'Body must be { workspace, slate, visibility, emails?, approved?, fork?, mode?, revision? }');

  if (body.mode === 'owner' && body.revision === undefined) return err(400, 'Sharing on your access names the revision whose reach you reviewed');
  const claim = await claimOwnedWorkspace(env, identity.userId, body.workspace);

  if (Result.isFailure(claim)) return err(claim.failure.status, claim.failure.error);

  const owned = claim.success;

  const created = await owned.slateAs(ROOT_SLATE_CALLER, {
    op: 'share', id: body.slate, visibility: body.visibility, approved: body.approved ?? [], fork: body.fork,
  });

  if (!created.ok) return err(ERROR_STATUS[created.reason], created.error);

  const { share, url } = v.parse(LiveShareCreatedSchema, created.value);
  const owning = await ownerMode(owned, { workspace: body.workspace, share, body });

  if (owning instanceof Response) return owning;
  const emails = [...new Set((body.emails ?? []).map((email) => email.toLowerCase()).filter((email) => email !== identity.email.toLowerCase()))];
  const writes: Array<{ readonly listing?: 'pending' }> = [created];
  // Answered as it stands once the people it names are recorded, so the answer names them.
  let answered = owning;

  if (share.visibility === 'users' && emails.length > 0) {
    const named = await Promise.all(emails.map(async (email) => ({ userId: await accountIdFor(env, email), email })));
    const recorded = await owned.shareLiveWith(share.id, named);

    if (!recorded.ok) return err(409, recorded.error);
    writes.push(recorded);
    answered = recorded.value;
  }

  return json({ body: { share: answered, url, ...listed(...writes) } }, { status: 201 });
}

/**
 * A share made on its owner's access: made in `own` mode, which grants nothing, then turned to `owner` over the reach the
 * owner reviewed (docs/SLATE-SHARING-NIMBUS.md §2). Where that refuses (the slate changed since), the share is revoked
 * again, so nothing is left shared other than as asked. The share as it stands, or the refusal.
 */
async function ownerMode(owned: OwnedWorkspace, made: { workspace: string; share: LiveShareRecord; body: LiveShareBody }): Promise<LiveShareRecord | Response> {
  const { body, share } = made;

  if (body.mode !== 'owner' || body.revision === undefined) return share;
  const set = await owned.setLiveShareMode({ workspace: made.workspace, share: share.id, mode: 'owner', revision: body.revision, approved: body.approved ?? [] });

  if (set.ok) return set.value;
  await owned.slateAs(ROOT_SLATE_CALLER, { op: 'unshare', share: share.id });

  return err(ERROR_STATUS[set.reason], set.error);
}

/** Its owner's word on one of their live shares, from their share sheet: answered with the share as it stands after. */
async function shareChange<Schema extends v.GenericSchema<unknown, { readonly workspace: string }>>(
  input: { readonly request: Request; readonly env: Env; readonly identity: AuthIdentity; readonly schema: Schema; readonly usage: string },
  change: (owned: OwnedWorkspace, body: v.InferOutput<Schema>) => Promise<SlateAnswer<LiveShareRecord>>,
): Promise<Response> {
  const body = await safeJson(input.request, input.schema);

  if (!body) return err(400, `Body must be ${input.usage}`);
  const claim = await claimOwnedWorkspace(input.env, input.identity.userId, body.workspace);

  if (Result.isFailure(claim)) return err(claim.failure.status, claim.failure.error);
  const set = await change(claim.success, body);

  return set.ok ? json({ body: set.value }) : err(ERROR_STATUS[set.reason], set.error);
}

/** A live share and a blueprint link revoke alike: the owner's object knows which it holds. */
async function revoke(request: Request, env: Env, identity: AuthIdentity): Promise<Response> {
  const body = await safeJson(request, LiveIdBody);

  if (!body) return err(400, 'Body must be { workspace, share }');
  const claim = await claimOwnedWorkspace(env, identity.userId, body.workspace);

  if (Result.isFailure(claim)) return err(claim.failure.status, claim.failure.error);
  const revoked = await claim.success.slateAs(ROOT_SLATE_CALLER, { op: 'unshare', share: body.share });

  if (!revoked.ok) return err(ERROR_STATUS[revoked.reason], revoked.error);

  return json({ body: { ...v.parse(v.record(v.string(), v.unknown()), revoked.value), ...listed(revoked) } });
}

async function openLive(request: Request, env: Env, identity: AuthIdentity): Promise<Response> {
  const body = await safeJson(request, LiveIdBody);

  if (!body) return err(400, 'Body must be { workspace, share }');
  const reading = await workspaceOwner(env, body.workspace).readLiveShare(body.share, identity.userId);

  // A share that names people says what it is to them and its owner only, as its address admits only them.
  if (!reading.ok || !reading.value.admits) return err(404, NOT_FOUND);

  const { handle, visibility, slate } = reading.value.record;

  const url = visibility === 'public'
    ? await slateShareUrl(env, body.workspace, handle)
    : await viewerEntryUrl(env, body.workspace, handle, identity.userId);

  if (url === null) return err(503, 'This deployment cannot sign live-share links: CREDENTIAL_ENCRYPTION_KEY or the share suffix is not set.');

  return json({ body: { url, slate, title: reading.value.title } satisfies LiveShareOpen });
}
