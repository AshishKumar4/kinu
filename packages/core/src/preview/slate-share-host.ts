/**
 * The live-share hostname, encoded and decoded.
 *
 * One DNS label, three fields, fixed widths for the first two so the third
 * can be a workspace name that contains hyphens:
 *
 *   `<handle 10 hex>-<token 15 base32>-<workspace>`
 *
 * Parsing is positional for the same reason `nimbus-preview-host` is: with a
 * variable-length tail there is exactly one correct split, and arithmetic
 * finds it without a regex engine being free to find a different one.
 *
 * THE BUDGET. A DNS label holds 63 characters. Handle 10, token 15, two
 * separators: 27, leaving 36 — and the workspace grammar admits at most
 * `WORKSPACE_ADDRESS_MAX` (31), so every address fits inside 58 and none is
 * truncated: a truncated one would address a different workspace.
 */

import { workspaceAddressRefusal } from '../identity/naming';

const HANDLE_RE = /^[a-f0-9]{10}$/;

const TOKEN_RE = /^[a-z2-7]{15}$/;

const HANDLE_LENGTH = 10;

const TOKEN_LENGTH = 15;

export interface SlateShareLabel {
  handle: string;
  token: string;
  workspace: string;
}

export function parseSlateShareLabel(label: string): SlateShareLabel | null {
  const lower = label.toLowerCase();
  const tokenStart = HANDLE_LENGTH + 1;
  const tokenEnd = tokenStart + TOKEN_LENGTH;

  if (lower[HANDLE_LENGTH] !== '-' || lower[tokenEnd] !== '-') return null;

  const handle = lower.slice(0, HANDLE_LENGTH);
  const token = lower.slice(tokenStart, tokenEnd);
  const workspace = lower.slice(tokenEnd + 1);

  if (!HANDLE_RE.test(handle) || !TOKEN_RE.test(token)) return null;

  if (workspaceAddressRefusal(workspace) !== null) return null;

  return { handle, token, workspace };
}

/**
 * The hostname for one live share, or null when the pieces cannot make a
 * legal one — a workspace whose name is too long for a DNS label is a
 * workspace whose shares cannot be addressed, the same "no URL" an
 * unconfigured share host reports. The handle and token are derived here and
 * a malformed one is a fault.
 */
export function buildSlateShareHost(parts: {
  handle: string;
  token: string;
  workspace: string;
  suffix: string;
}): string | null {
  const { handle, token, workspace, suffix } = parts;

  if (!HANDLE_RE.test(handle)) throw new Error('Invalid slate share handle');

  if (!TOKEN_RE.test(token)) throw new Error('Invalid slate share token');

  if (workspaceAddressRefusal(workspace) !== null) return null;
  const label = `${handle}-${token}-${workspace}`;

  return label.length > 63 ? null : `${label}.${suffix}`;
}
