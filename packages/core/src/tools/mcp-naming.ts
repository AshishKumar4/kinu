/** MCP tool key for both backends: `<server>/<tool>`, keyed on the user-chosen server name (unique per agent), never the registration id. */

/** Characters outside `[A-Za-z0-9_-]` (accepted by every target provider) become `_`. */
function sanitizeSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9_-]/g, '_');
}

const TOOL_NAME_MAX = 64;

export function mcpToolKey(serverName: string, toolName: string): string {
  const key = `mcp_${sanitizeSegment(serverName)}_${sanitizeSegment(toolName)}`;

  return key.length <= TOOL_NAME_MAX ? key : suffixedMcpToolKey(serverName, toolName);
}

export function suffixedMcpToolKey(serverName: string, toolName: string): string {
  const key = `mcp_${sanitizeSegment(serverName)}_${sanitizeSegment(toolName)}`;
  let hash = 0x811C9DC5;

  for (const byte of new TextEncoder().encode(`${serverName}\u0000${toolName}`)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  const suffix = hash.toString(16).padStart(8, '0');

  return `${key.slice(0, TOOL_NAME_MAX - suffix.length - 1)}_${suffix}`;
}

/** True for keys minted by `mcpToolKey`. */
export function isMcpToolKey(key: string): boolean {
  return key.startsWith('mcp_');
}
