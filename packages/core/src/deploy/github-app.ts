// A Kinu's own GitHub App, made from a manifest (GitHub's manifest flow, read 2026-10-27): the deploy page posts the
// manifest to GitHub, which shows the person the app it would make and makes it on one click, then hands the deploy
// service a code worth the app's OAuth client for an hour. The Worker keeps that client as the GitHub plugin's own
// (`MCP_GITHUB_CLIENT_*`); the app's private key and webhook secret are dropped, since nothing here acts as the app.
import { Effect } from 'effect';
import * as v from 'valibot';
import { attempt, KinuError } from '../obs/index';
import { APP_ROUTES } from '../read-models/app-routes';
import type { JsonObject } from '../utils/json';
import { cloudflareResult, type CloudflareTransport } from './cloudflare';
import { scriptBindings, varsOf } from './account';
import { GITHUB_APP_SECRETS } from './inputs';

/** Where a person's own account makes an app from a manifest. */
export const GITHUB_APP_NEW = 'https://github.com/settings/apps/new';

/**
 * What the plugin's default toolsets act on (context, repos, issues, pull requests, users; github-mcp-server README):
 * code, issues and pull requests, and an organization's members for its teams. An app's user token reaches only the
 * repositories it is installed on, and only as far as its person may.
 */
const PERMISSIONS = { metadata: 'read', contents: 'write', issues: 'write', pull_requests: 'write', members: 'read' };

/** GitHub's longest app name. */
const NAME_MAX = 34;

/**
 * The app for the Kinu at `origin`. Public, so it can be installed on the person's organizations too; its user tokens
 * return to the plugin's callback, and an installation lands on the Kinu's Plugins page, where GitHub is connected.
 */
export function githubAppManifest(origin: string, redirect: string): JsonObject {
  const host = new URL(origin).hostname;

  return {
    name: `Kinu ${host}`.slice(0, NAME_MAX),
    url: origin,
    description: `Lets the agents of the Kinu at ${host} work in the repositories you install it on.`,
    public: true,
    redirect_url: redirect,
    callback_urls: [`${origin}/api/user/mcp/callback`],
    setup_url: `${origin}${APP_ROUTES.plugins}`,
    hook_attributes: { url: origin, active: false },
    default_permissions: PERMISSIONS,
    default_events: [],
  };
}

/** The address of the Kinu `name` a run made in `account`; refused for a Worker no run made. */
export function kinuOrigin(transport: CloudflareTransport, account: string, name: string): Effect.Effect<string, KinuError> {
  return Effect.gen(function* () {
    const origin = varsOf(yield* scriptBindings(transport, account, name)).get('CLI_PUBLIC_ORIGIN') ?? '';

    return URL.canParse(origin) ? origin : yield* new KinuError('missing', `This account runs no Kinu named ${name} that the deploy flow made.`);
  });
}

export interface GithubApp {
  readonly slug: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

const ConversionSchema = v.object({ slug: v.string(), client_id: v.string(), client_secret: v.string() });

/** The app a manifest `code` made, from GitHub's conversion, which answers once and within the hour. */
export function convertedGithubApp(code: string, fetchImpl: typeof fetch = fetch): Effect.Effect<GithubApp, KinuError> {
  return Effect.gen(function* () {
    const doing = { doing: 'taking the GitHub App GitHub made', otherwise: 'unavailable' } as const;

    const response = yield* attempt(doing, (signal) => fetchImpl(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST', headers: { accept: 'application/vnd.github+json', 'user-agent': 'kinu', 'x-github-api-version': '2022-11-28' }, signal,
    }));

    const body: unknown = yield* attempt(doing, async () => response.json());
    const made = v.safeParse(ConversionSchema, body);

    if (response.ok && made.success) return { slug: made.output.slug, clientId: made.output.client_id, clientSecret: made.output.client_secret };
    const said = v.safeParse(v.object({ message: v.string() }), body);

    return yield* new KinuError(response.status === 404 ? 'missing' : 'unavailable', `GitHub did not hand over the app (HTTP ${String(response.status)}${said.success ? `: ${said.output.message}` : ''}).`);
  });
}

/** Binds `app` as the GitHub plugin's client on the Worker `name`; Cloudflare deploys it as a version of its own. */
export function bindGithubApp(transport: CloudflareTransport, account: string, name: string, app: GithubApp): Effect.Effect<void> {
  const path = `/accounts/${account}/workers/scripts/${name}/secrets`;

  const put = (secret: string, text: string) => Effect.promise(async () => cloudflareResult(
    transport, { method: 'PUT', path, body: { name: secret, text, type: 'secret_text' } }, v.object({ name: v.optional(v.string()) }),
  ));

  return Effect.andThen(put(GITHUB_APP_SECRETS.id, app.clientId), put(GITHUB_APP_SECRETS.secret, app.clientSecret));
}
