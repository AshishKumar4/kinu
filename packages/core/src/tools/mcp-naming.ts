/** MCP tool key for both backends: `<server>/<tool>`, keyed on the user-chosen server name (unique per agent), never the registration id. */

/** Characters outside `[A-Za-z0-9_-]` (accepted by every target provider) become `_`. */
function sanitizeSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function mcpToolKey(serverName: string, toolName: string): string {
  return `mcp_${sanitizeSegment(serverName)}_${sanitizeSegment(toolName)}`;
}

/** True for keys minted by `mcpToolKey`. */
export function isMcpToolKey(key: string): boolean {
  return key.startsWith('mcp_');
}
