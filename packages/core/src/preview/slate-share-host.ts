// One DNS label `<handle>-<token>-<workspace>`, parsed positionally; fixed-width fields leave room for
// `WORKSPACE_ADDRESS_MAX`, so no workspace address is ever truncated.

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

/** Null when the workspace name does not fit (reported as "no URL"); malformed handle or token throws. */
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
