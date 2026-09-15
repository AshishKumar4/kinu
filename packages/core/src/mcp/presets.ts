/**
 * The MCP servers every account can add in one click — ONE catalog, read by
 * the add surface, the row that tags a stored server (`preset_id`) and the
 * validation that accepts a preset by id.
 *
 * `auth` is what the add flow may offer:
 *   'oauth' — the server's authorization server supports dynamic client
 *             registration, so the SDK's DurableObjectOAuthClientProvider can
 *             run the flow with no pre-registered client. Verified by probing
 *             each server's protected-resource metadata and authorization-
 *             server metadata on 2026-09-15.
 *   'token' — the user supplies a bearer credential, stored sealed and spent
 *             as the `Authorization` header. Both GitHub (no AS metadata
 *             advertising a registration endpoint; OAuth requires a
 *             pre-registered app) and Google Workspace MCP (the doc below
 *             requires a user-created OAuth client; accounts.google.com
 *             publishes no registration endpoint) fall here — a card that
 *             promised sign-in would dead-end at registration.
 */

export type McpPresetId = 'github' | 'cloudflare' | 'google';

export interface McpPreset {
  readonly id: McpPresetId;
  /** The server's name once added — the row claims it like any other name. */
  readonly title: string;
  readonly serverUrl: string;
  readonly transport: 'sse' | 'streamable-http';
  /**
   *   'oauth' — the server supports dynamic client registration, so the
   *     DurableObjectOAuthClientProvider flow works with no pre-registered
   *     app. Verified against each server's authorization-server metadata
   *     on 2026-09-15.
   *   'oauth-app' — the vendor's OAuth supports authorization with a
   *     pre-registered app only (no dynamic client registration). The flow
   *     runs with `clientIdEnv`/`clientSecretEnv`, the deployment secrets
   *     the owner sets once; when they are absent the card falls back to
   *     `tokenFallback` if the preset declares one, or is not rendered.
   *   'token' — a user-supplied bearer credential, stored sealed and spent
   *     as the `Authorization` header. (Kept for presets where the vendor
   *     offers no remote OAuth at all.)
   */
  readonly auth: 'oauth' | 'oauth-app' | 'token';
  /** The env names carrying the registered OAuth app for `oauth-app`
   *  presets. The owner creates the app at the vendor, points its callback
   *  at `<deployment-origin>/api/user/mcp/callback`, and puts the values in
   *  these names; the row reports whether BOTH are set so the card can show
   *  sign-in vs. its fallback. */
  readonly clientIdEnv?: string;
  readonly clientSecretEnv?: string;
  /** What an `oauth-app` preset asks for when the deployment carries no app
   *  credentials: a user-supplied token, same sealed `Authorization` spend as
   *  a `token` preset. */
  readonly tokenFallback?: { label: string };
  /** The single field a `token` preset asks for. */
  readonly tokenLabel?: string;
  /** The scope an `oauth-app` preset asks for on the vendor's authorize URL;
   *  the SDK puts the provider's `clientMetadata.scope` there when set. */
  readonly scope?: string;
  readonly docsUrl: string;
}

export const MCP_PRESETS: readonly McpPreset[] = [
  {
    id: 'github',
    title: 'GitHub',
    // github/github-mcp-server README + docs/remote-server.md — the remote
    // server authorizes through a pre-registered OAuth app: register the app
    // with callback `<deployment-origin>/api/user/mcp/callback`, then set
    // MCP_GITHUB_CLIENT_ID / MCP_GITHUB_CLIENT_SECRET on the deployment.
    serverUrl: 'https://api.githubcopilot.com/mcp/',
    transport: 'streamable-http',
    auth: 'oauth-app',
    clientIdEnv: 'MCP_GITHUB_CLIENT_ID',
    clientSecretEnv: 'MCP_GITHUB_CLIENT_SECRET',
    scope: 'repo read:user',
    tokenFallback: { label: 'Personal access token' },
    docsUrl: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
  },
  {
    id: 'cloudflare',
    title: 'Cloudflare',
    // developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare — the general-purpose API server
    serverUrl: 'https://mcp.cloudflare.com/mcp',
    transport: 'streamable-http',
    auth: 'oauth',
    docsUrl: 'https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/',
  },
  {
    id: 'google',
    title: 'Gmail',
    // developers.google.com/workspace/gmail/api/guides/configure-mcp-server —
    // Google Workspace MCP (Developer Preview) requires a user-created OAuth
    // client: register `<deployment-origin>/api/user/mcp/callback` under
    // authorized redirect URIs, then set MCP_GOOGLE_CLIENT_ID /
    // MCP_GOOGLE_CLIENT_SECRET on the deployment.
    serverUrl: 'https://gmailmcp.googleapis.com/mcp/v1',
    transport: 'streamable-http',
    auth: 'oauth-app',
    clientIdEnv: 'MCP_GOOGLE_CLIENT_ID',
    clientSecretEnv: 'MCP_GOOGLE_CLIENT_SECRET',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    docsUrl: 'https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server',
  },
];

export function mcpPresetById(id: string): McpPreset | undefined {
  return MCP_PRESETS.find((preset) => preset.id === id);
}
