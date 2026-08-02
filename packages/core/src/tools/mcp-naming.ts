/**
 * The tool key an MCP tool is exposed under — ONE rule for both backends.
 *
 * A prompt, a skill, or a saved craft that names an MCP tool has to resolve to
 * the same tool whether the agent runs in a Durable Object or a local process.
 * That only works if the key is derived from something the user actually chose:
 * the server's name. (cf used to key on the random `nanoid(8)` registration id,
 * so the same server produced a different tool name for every user — and a
 * different one again after a re-add.)
 *
 * Server names are unique per agent by construction on the CLI (the config is a
 * `mcpServers` object) and enforced unique on cf, so `<server>/<tool>` is an
 * unambiguous address on both.
 */

/** Everything a provider's tool-name grammar rejects becomes `_`. Letters,
 *  digits, `_` and `-` are accepted by every provider we target. */
function sanitizeSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function mcpToolKey(serverName: string, toolName: string): string {
  return `mcp_${sanitizeSegment(serverName)}_${sanitizeSegment(toolName)}`;
}

/** True for keys minted by `mcpToolKey` — used to tell MCP tools apart from
 *  builtins when rendering the turn's tool surface. */
export function isMcpToolKey(key: string): boolean {
  return key.startsWith('mcp_');
}
