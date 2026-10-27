// The deploy page's Connectors: the apps of its own a Kinu needs for GitHub and Google, whose OAuth client the Worker
// keeps as secrets (`CONNECTOR_SECRETS`). GitHub's is made from a manifest (GitHub's manifest flow, read 2026-10-27):
// the page posts it to GitHub, which makes the app on one click and hands back a code worth its client for an hour;
// the app's private key and webhook secret are dropped, since nothing here acts as the app. Google's is the person's
// own client, made by the steps the page shows and pasted in. Every other plugin connects inside the Kinu alone.
import { Effect } from 'effect';
import * as v from 'valibot';
import { attempt, KinuError } from '../obs/index';
import { APP_ROUTES } from '../read-models/app-routes';
import { MCP_OAUTH_CALLBACK_PATH } from '../mcp/presets';
import type { JsonObject } from '../utils/json';
import { cloudflareResult, type CloudflareTransport } from './cloudflare';
import { scriptBindings, varsOf } from './account';
import { CONNECTOR_SECRETS, type Connector } from './inputs';

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
    callback_urls: [`${origin}${MCP_OAUTH_CALLBACK_PATH}`],
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

export interface GithubApp extends OAuthClient {
  readonly slug: string;
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

/** The APIs the Google connection calls (`google/methods.generated.json`), by the service names Google's console enables. */
const GOOGLE_APIS = ['gmail', 'calendar-json', 'drive', 'docs', 'sheets', 'slides', 'people'];

/** The Google Cloud console's pages a person makes a Kinu's own Google client on (Google Auth Platform, 2026-10-27). */
export const GOOGLE_SETUP = {
  apis: `https://console.cloud.google.com/flows/enableapi?apiid=${GOOGLE_APIS.map((api) => `${api}.googleapis.com`).join(',')}`,
  audience: 'https://console.cloud.google.com/auth/audience',
  clients: 'https://console.cloud.google.com/auth/clients',
} as const;

/** What the client must return to: the Kinu's own plugin sign-in. */
export function googleRedirect(origin: string): string {
  return `${origin}${MCP_OAUTH_CALLBACK_PATH}`;
}

/** An OAuth client as Google's console shows it once made. */
export const GoogleClientSchema = v.object({
  clientId: v.pipe(v.string(), v.trim(), v.regex(/^[\w-]+\.apps\.googleusercontent\.com$/u, 'That is not a Google client ID: it ends in .apps.googleusercontent.com.')),
  clientSecret: v.pipe(v.string(), v.trim(), v.minLength(1, 'Paste the client secret too.')),
});

export type OAuthClient = v.InferOutput<typeof GoogleClientSchema>;

/** A Kinu the deploy flow made: its account, and its Worker's name there. */
export interface KinuWorker {
  readonly account: string;
  readonly name: string;
}

/**
 * Gives `kinu` its own app for `connector`, or with `client` null takes it away, so the connector goes back to its
 * default (GitHub's token, Google through Composio). Cloudflare deploys each secret as a version of its own.
 */
export function setConnector(transport: CloudflareTransport, kinu: KinuWorker, connector: Connector, client: OAuthClient | null): Effect.Effect<void> {
  const path = `/accounts/${kinu.account}/workers/scripts/${kinu.name}/secrets`;
  const { id, secret } = CONNECTOR_SECRETS[connector];
  const answered = v.object({ name: v.optional(v.string()) });

  if (client === null) {
    return Effect.forEach([id, secret], (each) => Effect.promise(async () => cloudflareResult(transport, { method: 'DELETE', path: `${path}/${each}` }, v.unknown())), { discard: true });
  }

  return Effect.forEach([[id, client.clientId], [secret, client.clientSecret]] as const, ([each, text]) => Effect.promise(async () => cloudflareResult(
    transport, { method: 'PUT', path, body: { name: each, text, type: 'secret_text' } }, answered,
  )), { discard: true });
}
