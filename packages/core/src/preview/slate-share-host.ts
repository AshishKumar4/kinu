// One DNS label `<handle>-<token>-<workspace>`, parsed positionally; fixed-width fields leave room for
// `WORKSPACE_ADDRESS_MAX`; a preview label puts its port before it.

import { Effect } from 'effect';
import { settleSync } from '../obs/effect';
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

/** The label's fields, lowercased; null where one is malformed. */
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

/** The label; null for an unusable workspace name, a throw for a malformed handle or token. */
export function slateShareLabel(parts: { handle: string; token: string; workspace: string }, what: string): string | null {
  return settleSync(Effect.gen(function* () {
    const { handle, token, workspace } = parts;

    if (!HANDLE_RE.test(handle)) return yield* Effect.die(new Error(`Invalid ${what} handle`));

    if (!TOKEN_RE.test(token)) return yield* Effect.die(new Error(`Invalid ${what} token`));

    return workspaceAddressRefusal(workspace) === null ? `${handle}-${token}-${workspace}` : null;
  }));
}

/** Null when the workspace name does not fit (reported as "no URL"); malformed handle or token throws. */
export function buildSlateShareHost(parts: {
  handle: string;
  token: string;
  workspace: string;
  suffix: string;
}): string | null {
  const label = slateShareLabel(parts, 'slate share');

  return label === null || label.length > 63 ? null : `${label}.${parts.suffix}`;
}
