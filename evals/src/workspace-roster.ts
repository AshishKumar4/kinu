/** Browser account authority and roster lifecycle, independent of the CLI turn transport. */
import * as v from 'valibot';
import {
  DEV_IDENTITY_ACCOUNT_HEADER, DEV_IDENTITY_HEADER, parseJsonValue, ProfileCatalogEnvelopeSchema, type EvalAccount, type JsonValue,
  type ProfileCatalog,
} from '@kinu.run/core';
import { tolerate } from '@kinu.run/core/obs';
import { DeploymentAnswer, evalAccount, evalWebIdentityEnv, infraBoundary } from '@kinu.run/test-utils';

/** Hosts that can only be a developer's own machine — where possession of the
 *  machine IS the authority and `authenticateRequest` needs no secret
 *  (auth/session.ts:128, :164). Spelled as the auth module spells it. */
const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'];

/** How this session proves it may act as the deployment's web identity, and as which of its eval accounts:
 *  `account` absent is the eval service's own. */
export type PublicWebIdentity =
  /** A loopback deployment: the machine is the boundary, no header needed. */
  | { readonly kind: 'loopback'; readonly account?: EvalAccount }
  /** A remote deployment: the synthetic identity's secret, sent per request. */
  | { readonly kind: 'secret'; readonly secret: string; readonly account?: EvalAccount };

/** A local dev server's identity: its loopback origin is the boundary, so no header is sent. */
export const LOOPBACK_IDENTITY: PublicWebIdentity = { kind: 'loopback' };

/** A workspace as its owner's browser reaches it. */
export type WorkspaceWeb = { readonly origin: string; readonly identity: PublicWebIdentity; readonly workspace: string };

export type PublicWebIdentityResolution =
  | { readonly kind: 'ready'; readonly identity: PublicWebIdentity }
  /** No authority for the browser plane. `remedy` names the command and the
   *  variable that would make the run happen — never "unavailable". */
  | { readonly kind: 'absent'; readonly remedy: string };

/**
 * The browser-plane identity for `origin`, or the remedy that would supply one.
 *
 * Pure over its inputs so the gating is testable credential-free: the wiring
 * suite drives it with the deployed origin and an empty environment and asserts the
 * remedy names both halves.
 */
export function resolveWebIdentity(
  origin: string,
  env: Record<string, string | undefined> = process.env,
): PublicWebIdentityResolution {
  const variable = evalWebIdentityEnv(origin);
  const secret = env[variable]?.trim();
  const account = evalAccount(env);
  const named = account === undefined ? {} : { account };

  if (secret) return { kind: 'ready', identity: { kind: 'secret', secret, ...named } };

  if (LOOPBACK_HOSTS.includes(new URL(origin).hostname)) {
    return { kind: 'ready', identity: { kind: 'loopback', ...named } };
  }

  return {
    kind: 'absent',
    remedy: `${origin} needs the browser plane's own authority and this run has none. The eval `
      + 'tier\'s KINU_EVAL_TOKEN is a CLI bearer, and `handleCliRequest` answers nothing outside '
      + '`/api/cli` (cli/routes.ts:87), so it cannot reach `/api/user/workspaces`, '
      + '`/api/workspaces/:name/runs` or the files route this session reads. Export the '
      + `deployment's synthetic-identity secret as ${variable} — the value installed on it `
      + 'with `wrangler secret put DEV_IDENTITY_SECRET`, which is what '
      + `\`authenticateRequest\` accepts in \`${DEV_IDENTITY_HEADER}\` (auth/session.ts). `
      + 'A loopback `wrangler dev` origin needs no secret at all.',
  };
}

export type EvalTarget = { readonly origin: string; readonly identity: PublicWebIdentity };

const RosterRowSchema = v.object({ name: v.string(), lastVisited: v.number(), displayName: v.optional(v.string()) });

const RosterPageSchema = v.object({ entries: v.array(RosterRowSchema), nextCursor: v.nullable(v.string()) });

/** A workspace as the account's roster lists it: `lastVisited` is the last mark any run or visit put on it. */
export type RosterRow = v.InferOutput<typeof RosterRowSchema>;

/**
 * How often a run marks its workspace live on the deployment, through `touch` (the roster's
 * `last_visited`, which every machine reads). The eval sweep deletes an `eval-` workspace whose mark
 * is older than its lease (`sweep.ts`), so a run on any machine keeps its workspaces by beating.
 */
export const WORKSPACE_BEAT_MS = 60_000;

/** Ten missed beats: long past any live run's last mark, and past any skew between two machines' clocks. */
export const WORKSPACE_LEASE_MS = 10 * WORKSPACE_BEAT_MS;

/**
 * Why a trial's own workspace answering 404 measured nothing of the build, or undefined when it may have: its last
 * mark is at least a lease old, so another run's sweep may have deleted it. A machine that sleeps past the lease
 * stops beating, and the trial wakes to a workspace that is gone.
 */
export function sweptAway(answer: DeploymentAnswer, lastMarked: number, now: number): string | undefined {
  if (answer.status !== 404 || now - lastMarked < WORKSPACE_LEASE_MS) return undefined;

  return `the workspace was swept: its last mark is ${String(Math.floor((now - lastMarked) / 60_000))} min old, past the `
    + `${String(WORKSPACE_LEASE_MS / 60_000)} min lease after which a run's sweep deletes it, so this 404 measured nothing of the build`;
}

/** The POST /api/user/workspaces body, the fields `handleCreateWorkspaceRequest` parses (user/workspace-access.ts):
 *  `name` is the URL name asked for, `displayName` the title the sidebar shows when it differs, `purpose` the mission
 *  (absent: the workspace is born with no genesis turn), `model` its model. */
export interface CreateWorkspaceBody {
  readonly name: string;
  readonly displayName?: string;
  readonly purpose?: string;
  readonly model?: string;
}

const CreatedSchema = v.object({ name: v.string() });

/**
 * The tooling's one client of the account's workspaces, the routes the sidebar uses. Every call opens a connection of
 * its own: a local dev server (Vite's Node server) retires an idle keep-alive socket after 5 s, and Bun reuses the
 * pooled one as it closes, so the next request died with ECONNRESET before its handler ran.
 */
function workspaces(account: { readonly origin: string; readonly identity: PublicWebIdentity }, path: string, init: RequestInit, doing: string): Promise<JsonValue> {
  const url = `${account.origin}/api/user/workspaces${path}`;
  const headers = webHeaders(account.identity);

  if (init.body !== undefined) headers['content-type'] = 'application/json';

  return infraBoundary(`${init.method ?? 'GET'} ${url}`, async () => readJson(await fetch(url, { ...init, keepalive: false, headers }), doing));
}

/** Create a workspace through the app's own route; the name it answers with is the one the URL takes, which is not
 *  always the one asked for. */
export async function createWorkspace(origin: string, identity: PublicWebIdentity, body: CreateWorkspaceBody): Promise<string> {
  return v.parse(CreatedSchema, await workspaces({ origin, identity }, '', { method: 'POST', body: JSON.stringify(body) }, 'create a workspace')).name;
}

/** Every workspace on the identity's account, page by page, as the sidebar's roster lists them. */
export async function listWorkspaces(origin: string, identity: PublicWebIdentity): Promise<RosterRow[]> {
  const rows: RosterRow[] = [];
  let cursor: string | null = null;

  do {
    // Annotated because the loop reads its own result: `page.nextCursor` feeds the next iteration.
    const page: v.InferOutput<typeof RosterPageSchema> = v.parse(RosterPageSchema, await workspaces(
      { origin, identity }, cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`, {}, 'list the workspaces',
    ));

    rows.push(...page.entries);
    cursor = page.nextCursor;
  } while (cursor !== null);

  return rows;
}

/** Delete a workspace, the DELETE the sidebar's Remove issues. */
export async function deleteWorkspace(origin: string, identity: PublicWebIdentity, name: string): Promise<void> {
  await workspaces({ origin, identity }, `/${encodeURIComponent(name)}`, { method: 'DELETE' }, `delete the workspace ${name}`);
}

/** Writers per account racing for its catalog, and a spare: each lost race means another writer landed (409, measured
 *  on staging 569bb6869d, 2026-09-27, when the tiers of one deploy set the same account up at once). */
const CATALOG_WRITE_ATTEMPTS = 4;

/** What a workspace needs of its account's catalog: the catalog with it, or null when the catalog already holds it. */
export type CatalogNeed = (catalog: ProfileCatalog) => ProfileCatalog | null;

/** Bring the account's catalog to what `needs` ask of it, the tooling's one writer of it. The cases of one run and the
 *  tiers of one deploy race to write it, so a lost version race reads again, until nothing is left to write. */
export async function settleCatalog(origin: string, headers: Record<string, string>, needs: readonly CatalogNeed[]): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const read = await fetch(`${origin}/api/user/profile-catalog`, { headers, keepalive: false });
    const { version, catalog } = v.parse(ProfileCatalogEnvelopeSchema, await readJson(read, 'read the profile catalog'));
    const wanted = needs.reduce<ProfileCatalog | null>((sofar, need) => need(sofar ?? catalog) ?? sofar, null);

    if (wanted === null) return;

    const answer = await fetch(`${origin}/api/user/profile-catalog`, {
      method: 'PUT',
      keepalive: false,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ catalog: wanted, expectedVersion: version }),
    });

    if (answer.ok || (answer.status === 409 && attempt < CATALOG_WRITE_ATTEMPTS)) continue;
    await readJson(answer, 'write the profile catalog');
  }
}

export function webHeaders(identity: PublicWebIdentity): Record<string, string> {
  const headers: Record<string, string> = identity.kind === 'secret' ? { [DEV_IDENTITY_HEADER]: identity.secret } : {};

  if (identity.account !== undefined) headers[DEV_IDENTITY_ACCOUNT_HEADER] = identity.account;

  return headers;
}

/** A preview's visit is three hops (the preview, the app's entry, the ticket's exchange) and the page's own redirects. */
const MAX_PREVIEW_REDIRECTS = 10;

/** Who opens a preview as its owner: the app's origin, the credential it knows them by, and where they enter it. */
export interface PreviewOwner {
  readonly origin: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The app's entry a non-browser client asks first (`CLI_PREVIEW_ENTRY_PATH`); absent, the visit starts at the preview, as a browser's does. */
  readonly entry?: string;
}

/** The web identity a session's browser opens its previews as. */
export function browserOwner(web: Pick<WorkspaceWeb, 'origin' | 'identity'>): PreviewOwner {
  return { origin: web.origin, headers: webHeaders(web.identity) };
}

/**
 * A preview opened the way its owner opens it, as a page load. A workspace's preview opens only for its owner, so the
 * visit goes as theirs does: the preview sends it to the app (or a CLI asks the app's entry first), which knows the
 * account by `owner.headers` and sends it back with a ticket, which the preview's host turns into its cookie. Each
 * origin keeps its own cookies, and the account's credential goes to the app alone. Answers the last response, its
 * body unread.
 */
export async function openPreviewAsOwner(owner: PreviewOwner, url: string | URL): Promise<Response> {
  const app = new URL(owner.origin).origin;
  const jar = new Map<string, string>();
  let at = owner.entry === undefined ? new URL(url) : new URL(`${owner.entry}?to=${encodeURIComponent(String(url))}`, app);

  for (let hop = 0; ; hop++) {
    // A page load from the address bar, as a browser says it: the preview admits its owner's cookie on a page load.
    const headers = new Headers({ accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', 'sec-fetch-dest': 'document' });
    const cookie = jar.get(at.origin);

    if (at.origin === app) for (const [name, value] of Object.entries(owner.headers)) headers.set(name, value);

    if (cookie !== undefined) headers.set('cookie', cookie);
    const response = await fetch(at, { redirect: 'manual', headers });
    const set = response.headers.get('set-cookie');

    if (set !== null) jar.set(at.origin, set.split(';')[0] ?? '');
    const location = response.headers.get('location');

    if (response.status < 300 || response.status >= 400 || location === null || hop === MAX_PREVIEW_REDIRECTS) return response;
    await response.body?.cancel();
    at = new URL(location, at);
  }
}

/** One response body, or the deployment's own words on a failure. The body is
 *  kept on the error path deliberately: a 409 naming an unserveable model and a
 *  503 naming a missing binding are different repairs. */
export async function readJson(response: Response, doing: string): Promise<JsonValue> {
  const text = await response.text();

  if (!response.ok) {
    throw new DeploymentAnswer(`could not ${doing}: ${String(response.status)} ${response.statusText} `
      + `— ${text.slice(0, 400)}`, response.status);
  }

  const parsed = tolerate(() => parseJsonValue(text), 'malformed-input');

  if (parsed === undefined) {
    throw new Error(`could not ${doing}: the response was not JSON — ${text.slice(0, 200)}`);
  }

  return parsed;
}
