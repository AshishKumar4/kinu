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
  formatBlueprintId, parseBlueprintId, PublishedBlueprintSchema, labelSigner,
  type BlueprintView, type SharedLibrary, type SharedRow, type BlueprintFork, type UserCaller,
} from '@kinu.run/core';
import type { AuthIdentity } from '../auth/session';
import { deriveUserId } from '../auth/store';
import { claimOwnedWorkspace } from '../user/workspace-ownership';
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
});

const ForkBody = v.object({ blueprint: v.string(), workspace: v.string() });

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

  return null;
}

async function library(env: Env, identity: AuthIdentity, owner: UserCaller): Promise<SharedLibrary> {
  const userDO = env.UserDO.get(env.UserDO.idFromName(identity.userId));
  const mine: SharedRow[] = [];

  // Every share row lives in the workspace that holds the slate, so "my shared"
  // is each of my workspaces asked in turn; a row's id is minted here.
  for (const workspace of await userDO.listActiveWorkspaces(owner)) {
    const claim = await claimOwnedWorkspace(env, identity.userId, workspace.name);

    if (!claim.ok) continue;
    // Ownership proven above; the Worker now acts as that workspace's root.
    const owned = workspaceOwner(env, workspace.name);
    const answer = await owned.slateAs(ROOT_SLATE_CALLER, { op: 'shares' });

    if (!answer.ok) throw new Error(`listing blueprints of ${workspace.name}: ${answer.reason}: ${answer.error}`);

    for (const share of v.parse(v.array(v.object({
      id: v.string(), slate: v.string(), createdAt: v.number(), revokedAt: v.nullable(v.number()), users: v.array(v.string()),
    })), answer.value)) {
      if (share.revokedAt !== null) continue;
      const reading = await owned.readBlueprint(share.id);

      if (!reading.ok) continue;
      const id = await mintBlueprintId(env, workspace.name, share.id);

      if (id === null) continue;

      mine.push({
        id, title: reading.value.view.title, description: reading.value.view.description, createdAt: share.createdAt,
        bindings: reading.value.view.bindings.length, workspace: workspace.name, users: share.users,
      });
    }
  }

  const received: SharedRow[] = [];

  // Each received row is a projection; the owner's object is asked again and a
  // refusal drops the row, so a revoked blueprint is not offered for forking.
  for (const receipt of await userDO.sharesReceived_list(owner)) {
    const reading = await workspaceOwner(env, receipt.workspace).readBlueprint(receipt.shareId);

    if (!reading.ok) continue;
    const id = await mintBlueprintId(env, receipt.workspace, receipt.shareId);

    if (id === null) continue;

    received.push({
      id, title: reading.value.view.title, description: reading.value.view.description, createdAt: reading.value.view.createdAt,
      bindings: reading.value.view.bindings.length, owner: receipt.ownerEmail,
    });
  }

  return { mine, received };
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

  return json({ id, share: share.id, users, published: published.value }, { status: 201 });
}

async function fork(request: Request, env: Env, identity: AuthIdentity): Promise<Response> {
  const body = await safeJson(request, ForkBody);

  if (!body) return err(400, 'Body must be { blueprint, workspace }');
  const address = await verifiedBlueprintAddress(env, body.blueprint);

  if (address === null) return err(404, NOT_FOUND);
  // The target is proven mine before the owner's object is asked for bytes.
  const claim = await claimOwnedWorkspace(env, identity.userId, body.workspace);

  if (!claim.ok) return err(claim.status, claim.error);
  const bundle = await workspaceOwner(env, address.workspace).blueprintBundle(address.share);

  if (!bundle.ok) return err(404, NOT_FOUND);
  const admitted = await workspaceOwner(env, body.workspace).admitBlueprint(bundle.value);

  if (!admitted.ok) return err(admitted.reason === 'bad_input' ? 400 : 409, admitted.error);
  const result: BlueprintFork = admitted.value;

  return json(result, { status: 201 });
}
