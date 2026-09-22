// One DNS label `<port base36>-<handle>-<token>-<workspace>`, parsed positionally; fixed-width fields
// leave `WORKSPACE_ADDRESS_MAX` for the name so no workspace address is ever truncated.

import { workspaceAddressRefusal } from '../identity/naming';

const PORT_RE = /^[0-9a-z]{1,4}$/;

const HANDLE_RE = /^[a-f0-9]{10}$/;

const TOKEN_RE = /^[a-z2-7]{15}$/;

const HANDLE_LENGTH = 10;

const TOKEN_LENGTH = 15;

export interface WorkspacePreviewHost {
  port: number;
  workspace: string;
  handle: string;
  token: string;
}

/** `unavailable` is shown on the Ports surface, so a listening port without a URL stays visible. */
export type WorkspacePreviewUrl =
  | { readonly url: string; readonly unavailable?: undefined }
  | { readonly url?: undefined; readonly unavailable: string };

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

  if (workspaceAddressRefusal(workspace) !== null) return null;
  const port = Number.parseInt(portText, 36);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;

  return { port, workspace, handle, token };
}

/** Null when the workspace name does not fit (reported as "no URL"); malformed derived parts throw. */
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

  if (workspaceAddressRefusal(workspace) !== null) return null;
  const label = `${port.toString(36)}-${handle}-${token}-${workspace}`;

  return label.length > 63 ? null : `${label}.${suffix}`;
}
