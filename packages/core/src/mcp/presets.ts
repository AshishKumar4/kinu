// One-click MCP server catalog, shared by the add surface, `preset_id` tagging, and preset validation.

export type McpPresetId = 'github' | 'cloudflare' | 'google';

export interface McpPreset {
  readonly id: McpPresetId;
  /** The server's name once added; claimed like any other name. */
  readonly title: string;
  /** Shown by surfaces instead of the endpoint. */
  readonly description: string;
  readonly serverUrl: string;
  readonly transport: 'sse' | 'streamable-http';
  /** 'oauth': dynamic client registration (verified 2026-09-15). 'oauth-app': pre-registered app via deployment
   *  secrets named by cf-backend `mcpAppEnvNames`, else `tokenFallback` or hidden. 'token': sealed bearer. */
  readonly auth: 'oauth' | 'oauth-app' | 'token';
  /** Asked for when an `oauth-app` deployment carries no app credentials. */
  readonly tokenFallback?: { label: string };
  readonly tokenLabel?: string;
  /** Sent as the provider's `clientMetadata.scope` on the vendor's authorize URL. */
  readonly scope?: string;
  readonly docsUrl: string;
}

export const MCP_PRESETS: readonly McpPreset[] = [
  {
    id: 'github',
    title: 'GitHub',
    description: 'Issues, pull requests and code',
    // Pre-registered OAuth app with callback `<deployment-origin>/api/user/mcp/callback`.
    serverUrl: 'https://api.githubcopilot.com/mcp/',
    transport: 'streamable-http',
    auth: 'oauth-app',
    scope: 'repo read:user',
    tokenFallback: { label: 'Personal access token' },
    docsUrl: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
  },
  {
    id: 'cloudflare',
    title: 'Cloudflare',
    description: 'Workers, DNS, logs and docs',
    serverUrl: 'https://mcp.cloudflare.com/mcp',
    transport: 'streamable-http',
    auth: 'oauth',
    docsUrl: 'https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/',
  },
  {
    id: 'google',
    title: 'Gmail',
    description: 'Read and search your mail',
    // Requires a user-created OAuth client with redirect `<deployment-origin>/api/user/mcp/callback`.
    serverUrl: 'https://gmailmcp.googleapis.com/mcp/v1',
    transport: 'streamable-http',
    auth: 'oauth-app',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    docsUrl: 'https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server',
  },
];

export function mcpPresetById(id: string): McpPreset | undefined {
  return MCP_PRESETS.find((preset) => preset.id === id);
}
