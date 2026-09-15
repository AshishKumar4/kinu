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
  readonly auth: 'oauth' | 'token';
  /** The single field a token preset asks for. */
  readonly tokenLabel?: string;
  readonly docsUrl: string;
}

export const MCP_PRESETS: readonly McpPreset[] = [
  {
    id: 'github',
    title: 'GitHub',
    // github/github-mcp-server README + docs/remote-server.md (remote server, PAT auth)
    serverUrl: 'https://api.githubcopilot.com/mcp/',
    transport: 'streamable-http',
    auth: 'token',
    tokenLabel: 'Personal access token',
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
    // developers.google.com/workspace/gmail/api/guides/configure-mcp-server (Google Workspace MCP, Developer Preview)
    serverUrl: 'https://gmailmcp.googleapis.com/mcp/v1',
    transport: 'streamable-http',
    auth: 'token',
    tokenLabel: 'Access token',
    docsUrl: 'https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server',
  },
];

export function mcpPresetById(id: string): McpPreset | undefined {
  return MCP_PRESETS.find((preset) => preset.id === id);
}
