/**
 * `/api/shared/*` — the shared library and blueprints on the app host.
 *
 * Routes:
 *   GET  /api/shared/blueprint/:id   — one blueprint's read-only page data. PUBLIC by
 *                                      link: the id carries a signature checked here,
 *                                      before any object is touched, and the owner's
 *                                      object re-reads the row on every call (S6).
 *   GET  /api/shared                 — my shared, shared with me
 *   POST /api/shared/publish         — publish a committed version of my slate as a
 *                                      blueprint and name users on it
 *   POST /api/shared/fork            — admit a blueprint into one of my workspaces
 *
 * A blueprint carries no credential (S8): what crosses between the two
 * workspace objects is the bundle — tree, bytes, requirements — and nothing
 * of the owner's user object. The forker's bindings resolve as the forker.
 */
import * as v from 'valibot';
import {
  err, json, safeJson, ownerCaller, OwnerCapabilityUnavailableError, retryTransientDO,
  formatBlueprintId, parseBlueprintId, PublishedBlueprintSchema, LiveShareRecordSchema, labelSigner,
  type BlueprintView, type SharedLibrary, type SharedRow, type BlueprintFork, type UserCaller,
  LiveShareCreatedSchema,
} from '@kinu.run/core';
import { slateShareUrl, viewerEntryUrl } from '../slate-share-route';
import { forgetPublicShare, indexPublicShare, listPublicShares } from './public-index';
import type { AuthIdentity } from '../auth/session';
import type { PublicShareRow } from '@kinu.run/core/control-plane';
import { deriveUserId } from '../auth/store';
import { claimOwnedWorkspace } from '../user/workspace-ownership';
import { sharesGiven } from '../user/shares-given';
import type { SharedBlueprintReceipt } from '../user/user-do';
import { workspaceOwner } from '../workspace-owner-rpc';
import { ROOT_SLATE_CALLER } from '../slates/bindings';

/** The blueprint signer: its own salt and info, so a preview token and a
 *  blueprint token never verify each other. */
const blueprintSigner = labelSigner('kinu.blueprint.salt', 'kinu.blueprint.v1');

function blueprintMessage(workspace: string, share: string): string {
  return `kinu:blueprint:v1:${workspace}:${share}`;
}

/** The public id for one share row, or null on a deployment with no signing secret. */
async function mintBlueprintId(env: Env, workspace: string, share: string): Promise<string | null> {
  const secret = blueprintSigner.secrets(env)[0];

  if (secret === undefined) return null;

  return formatBlueprintId({ workspace, share, token: await blueprintSigner.token(secret, blueprintMessage(workspace, share)) });
}

/** The address an id names, once its signature verifies; null for anything else. */
async function verifiedBlueprintAddress(env: Env, id: string): Promise<{ workspace: string; share: string } | null> {
  const address = parseBlueprintId(id);

  if (address === null) return null;

  if (!await blueprintSigner.verify(env, blueprintMessage(address.workspace, address.share), address.token)) return null;

  return { workspace: address.workspace, share: address.share };
}

const NOT_FOUND = 'No such blueprint';

/** The public half: before the auth gate, and answering nothing but the page data. */
export async function handleSharedPublicRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const match = /^\/api\/shared\/blueprint\/([^/]+)$/.exec(url.pathname);

  if (match === null || request.method !== 'GET') return null;
  const id = decodeURIComponent(match[1]);
  const address = await verifiedBlueprintAddress(env, id);

  // Unminted, forged and malformed ids are one answer, given without waking an object.
  if (address === null) return err(404, NOT_FOUND);
  const answer = await workspaceOwner(env, address.workspace).readBlueprint(address.share);

  // A revoked blueprint is not distinguishable from one that never existed.
  if (!answer.ok) return err(404, NOT_FOUND);
  const view: BlueprintView = { id, ...answer.value.view };

  return json(view, { headers: { 'cache-control': 'no-store' } });
}

const PublishBody = v.object({
  workspace: v.string(),
  slate: v.string(),
  version: v.string(),
  include: v.optional(v.array(v.string())),
  emails: v.optional(v.array(v.pipe(v.string(), v.trim(), v.email()))),
  public: v.optional(v.boolean()),
});

const ForkBody = v.union([
  v.strictObject({ blueprint: v.string(), workspace: v.string() }),
  /** A live share fork names the share row and the owner's workspace: the
   *  bundle it carries is the running slate's skeleton, asked of the owner's
   *  object under the forker's account. */
  v.strictObject({ live: v.string(), ownerWorkspace: v.string(), workspace: v.string() }),
]);

/** The signed-in half. */
export async function handleSharedRequest(request: Request, env: Env, identity: AuthIdentity): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname !== '/api/shared' && !url.pathname.startsWith('/api/shared/')) return null;
  const path = url.pathname.slice('/api/shared'.length);
  let owner: UserCaller;

  try { owner = await ownerCaller(env); }
  catch (cause) {
    // Same answer the user plane gives: no root secret, nothing to authorize with.
    if (cause instanceof OwnerCapabilityUnavailableError) return err(503, cause.message);
    throw cause;
  }

  if (path === '' && request.method === 'GET') return json(await library(env, identity, owner));

  if (path === '/publish' && request.method === 'POST') return publish(request, env, identity, owner);

  if (path === '/fork' && request.method === 'POST') return fork(request, env, identity);

  if (path === '/live' && request.method === 'POST') return shareLive(request, env, identity, owner);

  if (path === '/live/revoke' && request.method === 'POST') return revokeLive(request, env, identity);

  if (path === '/live/open' && request.method === 'POST') return openLive(request, env, identity);

  return null;
}

async function library(env: Env, identity: AuthIdentity, owner: UserCaller): Promise<SharedLibrary> {
  const userDO = env.UserDO.get(env.UserDO.idFromName(identity.userId));
  const mine: SharedRow[] = [];
  const named: string[] = [];

  // Every share row lives in the workspace that holds the slate, so "my shared"
  // is each of my workspaces asked in turn; a row's id is minted here.
  for (const { workspace, shares } of await sharesGiven(env, owner, identity.userId)) {
    const owned = workspaceOwner(env, workspace);

    for (const share of shares) {
      if (share.revokedAt !== null) continue;
      const reading = await owned.readBlueprint(share.id);

      if (!reading.ok) continue;
      const id = await mintBlueprintId(env, workspace, share.id);

      if (id === null) continue;

      mine.push({
        id, kind: 'blueprint', share: share.id, title: reading.value.view.title, description: reading.value.view.description,
        createdAt: share.createdAt, bindings: reading.value.view.bindings.length, workspace, users: share.users,
      });
      named.push(...share.users);
    }

    const live = await owned.slateAs(ROOT_SLATE_CALLER, { op: 'liveShares' });

    if (!live.ok) throw new Error(`listing live shares of ${workspace}: ${live.reason}: ${live.error}`);

    for (const share of v.parse(v.array(LiveShareRecordSchema), live.value)) {
      if (share.revokedAt !== null) continue;
      const reading = await owned.readLiveShare(share.id);

      if (!reading.ok) continue;

      mine.push({
        id: share.id, kind: 'live', share: share.id, title: reading.value.title, description: reading.value.description,
        createdAt: share.createdAt, bindings: share.grant.members.length, visibility: share.visibility,
        workspace, users: share.users,
      });
      named.push(...share.users);
    }
  }

  const received: SharedRow[] = [];

  // Each received row is a projection; the owner's object is asked again and a
  // refusal drops the row, so a revoked blueprint is not offered for forking.
  const receipts = await userDO.sharesReceived_list(owner);

  for (const receipt of receipts) {
    const object = workspaceOwner(env, receipt.workspace);
    // A receipt names one share row on the owner's object, whichever table
    // holds it: a live share reads as itself, a blueprint as its view, and a
    // row neither table answers is dropped — a revoked share is not offered.
    const live = await object.readLiveShare(receipt.shareId);

    if (live.ok) {
      received.push({
        id: receipt.shareId, kind: 'live', share: receipt.shareId,
        title: live.value.title, description: live.value.description, createdAt: live.value.record.createdAt,
        bindings: live.value.record.grant.members.length, visibility: live.value.record.visibility,
        workspace: receipt.workspace, owner: receipt.ownerEmail,
      });
      continue;
    }

    const reading = await object.readBlueprint(receipt.shareId);

    if (!reading.ok) continue;
    const id = await mintBlueprintId(env, receipt.workspace, receipt.shareId);

    if (id === null) continue;

    received.push({
      id, kind: 'blueprint', share: receipt.shareId, title: reading.value.view.title,
      description: reading.value.view.description, createdAt: reading.value.view.createdAt,
      bindings: reading.value.view.bindings.length, workspace: receipt.workspace, owner: receipt.ownerEmail,
    });
  }

  // The index is a projection: each row is asked of its owner's object and a
  // refusal drops it, so a stale row can list a share that then refuses and
  // never one that admits. "Known" is derived on the way past — the owners who
  // named me, plus everyone I ever named — and stored nowhere.
  const known = new Set<string>(receipts.map((receipt) => receipt.ownerUserId));

  for (const email of named) known.add(await deriveUserId(email));
  const publicRows: SharedRow[] = [];
  const knownRows: SharedRow[] = [];

  for (const entry of await listPublicShares(env)) {
    if (entry.ownerUserId === identity.userId) continue;
    const row = await publicRow(env, entry);

    if (row === null) continue;
    publicRows.push(row);

    if (known.has(entry.ownerUserId)) knownRows.push(row);
  }

  return { mine, received, public: publicRows, known: knownRows };
}

/** One index entry verified against its owner's object, as a Shared row. */
async function publicRow(env: Env, entry: PublicShareRow): Promise<SharedRow | null> {
  const object = workspaceOwner(env, entry.workspace);

  if (entry.kind === 'live') {
    const live = await object.readLiveShare(entry.shareId);

    if (!live.ok || live.value.record.visibility !== 'public' || live.value.record.grant.fork === false) return null;

    return {
      id: entry.shareId, kind: 'live', share: entry.shareId, title: live.value.title, description: live.value.description,
      createdAt: live.value.record.createdAt, bindings: live.value.record.grant.members.length, visibility: 'public',
      workspace: entry.workspace, owner: entry.ownerEmail,
    };
  }

  const reading = await object.readBlueprint(entry.shareId);

  if (!reading.ok) return null;
  const id = await mintBlueprintId(env, entry.workspace, entry.shareId);

  if (id === null) return null;

  return {
    id, kind: 'blueprint', share: entry.shareId, title: reading.value.view.title, description: reading.value.view.description,
    createdAt: reading.value.view.createdAt, bindings: reading.value.view.bindings.length, workspace: entry.workspace, owner: entry.ownerEmail,
  };
}

async function publish(request: Request, env: Env, identity: AuthIdentity, owner: UserCaller): Promise<Response> {
  const body = await safeJson(request, PublishBody);

  if (!body) return err(400, 'Body must be { workspace, slate, version, include?, emails? }');
  const claim = await claimOwnedWorkspace(env, identity.userId, body.workspace);

  if (!claim.ok) return err(claim.status, claim.error);
  const owned = workspaceOwner(env, body.workspace);
  const published = await owned.slateAs(ROOT_SLATE_CALLER, { op: 'publish', id: body.slate, version: body.version, include: body.include });

  if (!published.ok) return err(published.reason === 'bad_input' ? 400 : published.reason === 'missing' ? 404 : 409, published.error);

  const { share, inspection } = v.parse(PublishedBlueprintSchema, published.value);

  const id = await mintBlueprintId(env, body.workspace, share.id);

  if (id === null) return err(503, 'This deployment cannot sign blueprint links: CREDENTIAL_ENCRYPTION_KEY is not set.');
  const emails = [...new Set((body.emails ?? []).map((email) => email.toLowerCase()).filter((email) => email !== identity.email.toLowerCase()))];
  let users: readonly string[] = share.users;

  if (emails.length > 0) {
    const named = await Promise.all(emails.map(async (email) => ({ userId: await deriveUserId(email), email })));
    const recorded = await owned.shareBlueprintWith(share.id, named);

    if (!recorded.ok) return err(409, recorded.error);
    users = v.parse(v.object({ users: v.array(v.string()) }), recorded.value).users;

    const receipt: SharedBlueprintReceipt = {
      ownerUserId: identity.userId, ownerEmail: identity.email, workspace: body.workspace, shareId: share.id, title: inspection.title,
    };

    for (const user of named) {
      const recipient = env.UserDO.get(env.UserDO.idFromName(user.userId));
      await retryTransientDO('sharesReceived_add', () => recipient.sharesReceived_add(owner, receipt));
    }
  }

  if (body.public === true) {
    await indexPublicShare(env, {
      ownerUserId: identity.userId, ownerEmail: identity.email, workspace: body.workspace, shareId: share.id,
      kind: 'blueprint', title: inspection.title, createdAt: share.createdAt,
    });
  }

  return json({ id, share: share.id, users, published: published.value }, { status: 201 });
}

async function fork(request: Request, env: Env, identity: AuthIdentity): Promise<Response> {
  const body = await safeJson(request, ForkBody);

  if (!body) return err(400, 'Body must be { blueprint, workspace } or { live, ownerWorkspace, workspace }');

  // The target is proven mine before the owner's object is asked for bytes.
  const claim = await claimOwnedWorkspace(env, identity.userId, body.workspace);

  if (!claim.ok) return err(claim.status, claim.error);

  const bundle = 'blueprint' in body
    ? await blueprintBundle(env, body.blueprint)
    : await workspaceOwner(env, body.ownerWorkspace).liveShareBundle(body.live, identity.userId);

  if (!bundle.ok) return err(404, NOT_FOUND);
  const admitted = await workspaceOwner(env, body.workspace).admitBlueprint(bundle.value);

  if (!admitted.ok) return err(admitted.reason === 'bad_input' ? 400 : 409, admitted.error);
  const result: BlueprintFork = admitted.value;

  return json(result, { status: 201 });
}

/** A blueprint's bundle, or the absent answer a bad address and a revoked row share. */
async function blueprintBundle(env: Env, id: string) {
  const address = await verifiedBlueprintAddress(env, id);

  if (address === null) return { ok: false as const, reason: 'missing' as const, error: NOT_FOUND };

  return workspaceOwner(env, address.workspace).blueprintBundle(address.share);
}

const LiveShareBody = v.object({
  workspace: v.string(),
  slate: v.string(),
  visibility: v.picklist(['users', 'public']),
  emails: v.optional(v.array(v.pipe(v.string(), v.trim(), v.email()))),
  approved: v.optional(v.array(v.strictObject({ slate: v.string(), binding: v.string(), member: v.string() }))),
  /** Whether viewers may copy the slate's skeleton into a workspace of theirs. */
  fork: v.optional(v.boolean()),
});

const LiveIdBody = v.object({ workspace: v.string(), share: v.string() });

/** Mint or return the live share over one of my slates. `emails` names users
 *  on a `users` share; `approved` is the mutating grant the dialog checked. */
async function shareLive(request: Request, env: Env, identity: AuthIdentity, owner: UserCaller): Promise<Response> {
  const body = await safeJson(request, LiveShareBody);

  if (!body) return err(400, 'Body must be { workspace, slate, visibility, emails?, approved?, fork? }');
  const claim = await claimOwnedWorkspace(env, identity.userId, body.workspace);

  if (!claim.ok) return err(claim.status, claim.error);

  const owned = workspaceOwner(env, body.workspace);

  const created = await owned.slateAs(ROOT_SLATE_CALLER, {
    op: 'share', id: body.slate, visibility: body.visibility, approved: body.approved ?? [], fork: body.fork,
  });

  if (!created.ok) return err(created.reason === 'bad_input' ? 400 : created.reason === 'missing' ? 404 : 409, created.error);

  const { share, url } = v.parse(LiveShareCreatedSchema, created.value);
  const emails = [...new Set((body.emails ?? []).map((email) => email.toLowerCase()).filter((email) => email !== identity.email.toLowerCase()))];

  if (share.visibility === 'users' && emails.length > 0) {
    const named = await Promise.all(emails.map(async (email) => ({ userId: await deriveUserId(email), email })));
    const recorded = await owned.shareLiveWith(share.id, named);

    if (!recorded.ok) return err(409, recorded.error);

    const reading = await owned.readLiveShare(share.id);

    const receipt: SharedBlueprintReceipt = {
      ownerUserId: identity.userId, ownerEmail: identity.email, workspace: body.workspace, shareId: share.id,
      title: reading.ok ? reading.value.title : share.slate,
    };

    for (const user of named) {
      const recipient = env.UserDO.get(env.UserDO.idFromName(user.userId));
      await retryTransientDO('sharesReceived_add', () => recipient.sharesReceived_add(owner, receipt));
    }
  }

  if (share.visibility === 'public') {
    const reading = await owned.readLiveShare(share.id);
    await indexPublicShare(env, {
      ownerUserId: identity.userId, ownerEmail: identity.email, workspace: body.workspace, shareId: share.id,
      kind: 'live', title: reading.ok ? reading.value.title : share.slate, createdAt: share.createdAt,
    });
  }

  return json({ share, url }, { status: 201 });
}

async function revokeLive(request: Request, env: Env, identity: AuthIdentity): Promise<Response> {
  const body = await safeJson(request, LiveIdBody);

  if (!body) return err(400, 'Body must be { workspace, share }');
  const claim = await claimOwnedWorkspace(env, identity.userId, body.workspace);

  if (!claim.ok) return err(claim.status, claim.error);
  const revoked = await workspaceOwner(env, body.workspace).slateAs(ROOT_SLATE_CALLER, { op: 'unshare', share: body.share });

  if (!revoked.ok) return err(revoked.reason === 'missing' ? 404 : 409, revoked.error);
  await forgetPublicShare(env, { ownerUserId: identity.userId, workspace: body.workspace, shareId: body.share });

  return json(revoked.value);
}

/** The URL the signed-in user opens a live share at: the share's own origin,
 *  or the ticket-bearing entry that names this account on a `users` share. */
async function openLive(request: Request, env: Env, identity: AuthIdentity): Promise<Response> {
  const body = await safeJson(request, LiveIdBody);

  if (!body) return err(400, 'Body must be { workspace, share }');
  const reading = await workspaceOwner(env, body.workspace).readLiveShare(body.share);

  if (!reading.ok) return err(404, NOT_FOUND);

  const { handle, visibility } = reading.value.record;

  const url = visibility === 'public'
    ? await slateShareUrl(env, body.workspace, handle)
    : await viewerEntryUrl(env, body.workspace, handle, identity.userId);

  if (url === null) return err(503, 'This deployment cannot sign live-share links: CREDENTIAL_ENCRYPTION_KEY or the share suffix is not set.');

  return json({ url });
}
