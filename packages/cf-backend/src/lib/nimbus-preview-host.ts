/**
 * The workspace-preview hostname, encoded and decoded.
 *
 * One DNS label, four fields, fixed widths for the first three so the fourth can
 * be a workspace name that contains hyphens:
 *
 *   `<port base36>-<capability handle>-<token>-<workspace>`
 *
 * Parsing is positional rather than a backtracking regex: with a variable-length
 * tail there is exactly one correct split, and arithmetic finds it without a
 * regex engine being free to find a different one.
 *
 * THE BUDGET. A DNS label holds 63 characters. Port ≤ 4, handle 10, token 15,
 * three separators: 32, leaving 31 for the name — comfortably above the longest
 * name `workspaceSlug` mints (adjective ≤ 11, noun ≤ 8, 8 hex digits, two
 * hyphens = 29) and above the 24 `slugifyName` caps an operator-chosen one at. A
 * longer name is refused rather than truncated: a truncated one would address a
 * different workspace.
 */

const PORT_RE = /^[0-9a-z]{1,4}$/;
const HANDLE_RE = /^[a-f0-9]{10}$/;
const TOKEN_RE = /^[a-z2-7]{15}$/;
/** Every name `workspaceSlug`/`slugifyName` can produce, and nothing that could
 *  be read as another label's field or escape the label at all. */
const WORKSPACE_RE = /^[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?$/;

const HANDLE_LENGTH = 10;
const TOKEN_LENGTH = 15;

export interface WorkspacePreviewHost {
  port: number;
  workspace: string;
  handle: string;
  token: string;
}

export function parseWorkspacePreviewLabel(label: string): WorkspacePreviewHost | null {
  const lower = label.toLowerCase();
  const portEnd = lower.indexOf('-');
  if (portEnd < 1) return null;
  const handleStart = portEnd + 1;
  const handleEnd = handleStart + HANDLE_LENGTH;
  const tokenStart = handleEnd + 1;
  const tokenEnd = tokenStart + TOKEN_LENGTH;
  if (lower[handleEnd] !== '-' || lower[tokenEnd] !== '-') return null;

  const portText = lower.slice(0, portEnd);
  const handle = lower.slice(handleStart, handleEnd);
  const token = lower.slice(tokenStart, tokenEnd);
  const workspace = lower.slice(tokenEnd + 1);
  if (!PORT_RE.test(portText) || !HANDLE_RE.test(handle) || !TOKEN_RE.test(token)) return null;
  if (!WORKSPACE_RE.test(workspace)) return null;
  const port = Number.parseInt(portText, 36);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { port, workspace, handle, token };
}

/**
 * The hostname for one exposed port, or null when the pieces cannot make a
 * legal one.
 *
 * Null rather than a throw for the name: a workspace whose name is too long for
 * a DNS label is a workspace whose ports cannot be previewed, which the port
 * surface reports as "no URL" — the same answer an unconfigured preview host
 * gets. The other three are derived here and a malformed one is a fault.
 */
export function buildWorkspacePreviewHost(parts: {
  port: number;
  workspace: string;
  handle: string;
  token: string;
  suffix: string;
}): string | null {
  const { port, workspace, handle, token, suffix } = parts;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid workspace preview port: ${port}`);
  }
  if (!HANDLE_RE.test(handle)) throw new Error('Invalid workspace preview capability handle');
  if (!TOKEN_RE.test(token)) throw new Error('Invalid workspace preview token');
  if (!WORKSPACE_RE.test(workspace)) return null;
  const label = `${port.toString(36)}-${handle}-${token}-${workspace}`;
  return label.length > 63 ? null : `${label}.${suffix}`;
}
