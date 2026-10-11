/** Browser account authority and roster lifecycle, independent of the CLI turn transport. */
import * as v from 'valibot';
import { DEV_IDENTITY_ACCOUNT_HEADER, DEV_IDENTITY_HEADER, parseJsonValue, type EvalAccount, type JsonValue } from '@kinu.run/core';
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

const RosterRowSchema = v.object({ name: v.string(), lastVisited: v.number() });

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

/** Every workspace on the identity's account, page by page, as the sidebar's roster lists them. */
export async function listWorkspaces(origin: string, identity: PublicWebIdentity): Promise<RosterRow[]> {
  const rows: RosterRow[] = [];
  let cursor: string | null = null;

  do {
    const url = `${origin}/api/user/workspaces${cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`}`;

    // Annotated because the loop reads its own result: `page.nextCursor` feeds the next iteration.
    const page: v.InferOutput<typeof RosterPageSchema> = v.parse(RosterPageSchema, await infraBoundary(`GET ${url}`, async () =>
      readJson(await fetch(url, { headers: webHeaders(identity) }), 'list the workspaces')));

    rows.push(...page.entries);
    cursor = page.nextCursor;
  } while (cursor !== null);

  return rows;
}

/** Delete a workspace, the DELETE the sidebar's Remove issues. */
export async function deleteWorkspace(origin: string, identity: PublicWebIdentity, name: string): Promise<void> {
  await infraBoundary(`DELETE ${origin}/api/user/workspaces/${name}`, async () => {
    const response = await fetch(`${origin}/api/user/workspaces/${encodeURIComponent(name)}`, { method: 'DELETE', headers: webHeaders(identity) });

    await readJson(response, `delete the workspace ${name}`);
  });
}

export function webHeaders(identity: PublicWebIdentity): Record<string, string> {
  const headers: Record<string, string> = identity.kind === 'secret' ? { [DEV_IDENTITY_HEADER]: identity.secret } : {};

  if (identity.account !== undefined) headers[DEV_IDENTITY_ACCOUNT_HEADER] = identity.account;

  return headers;
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
