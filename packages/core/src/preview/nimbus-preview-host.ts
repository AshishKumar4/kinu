// One DNS label `<port base36>-<handle>-<token>-<workspace>`: a port before the share label's tail
// (slate-share-host.ts), so both grammars read handle, token and workspace one way.

import { Effect } from 'effect';
import { settleSync } from '../obs/effect';
import { parseSlateShareLabel, slateShareLabel } from './slate-share-host';

const PORT_RE = /^[0-9a-z]{1,4}$/;

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
  const portText = lower.slice(0, portEnd);
  const tail = parseSlateShareLabel(lower.slice(portEnd + 1));

  if (!PORT_RE.test(portText) || tail === null) return null;
  const port = Number.parseInt(portText, 36);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;

  return { port, ...tail };
}

/** Null when the workspace name does not fit (reported as "no URL"); malformed derived parts throw. */
export function buildWorkspacePreviewHost(parts: {
  port: number;
  workspace: string;
  handle: string;
  token: string;
  suffix: string;
}): string | null {
  return settleSync(Effect.gen(function* () {
    const { port, suffix } = parts;

    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return yield* Effect.die(new Error(`Invalid workspace preview port: ${port}`));
    }

    const tail = slateShareLabel(parts, 'workspace preview capability');

    if (tail === null) return null;
    const label = `${port.toString(36)}-${tail}`;

    return label.length > 63 ? null : `${label}.${suffix}`;
  }));
}
