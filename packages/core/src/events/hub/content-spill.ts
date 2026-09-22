/** Oversize event bodies are written to the receiver's file plane and the path rides the payload.
 *  Content-addressed, so a redelivered event renders a byte-identical brief. */

import { sha256Hex } from '../../safety/argument-digest';
import type { VFS } from '../../types/primitives';
import { EVENT_BRIEF_MAX_CHARS } from './visibility';
import { diagnostics, renderCauseChain, toKinuError } from '../../obs/index';
import { ensureDir } from '../../utils/vfs-helpers';

export const EVENT_CONTENT_DIR = '.kinu/event-content';

export function eventContentPath(content: string): string {
  return `${EVENT_CONTENT_DIR}/${sha256Hex(content, 24)}.txt`;
}

export type SpilledContent =
  | { readonly path: string; readonly unsaved?: never }
  | { readonly unsaved: string; readonly path?: never };

/** Null when the content fits the brief. A failed write does not stop delivery; `unsaved` says why. */
export async function spillEventContent(vfs: VFS, content: string): Promise<SpilledContent | null> {
  if (content.length <= EVENT_BRIEF_MAX_CHARS) return null;
  const path = eventContentPath(content);

  try {
    if (!(await vfs.exists(path))) {
      await ensureDir(vfs, EVENT_CONTENT_DIR);
      await vfs.writeFile(path, content);
    }

    return { path };
  } catch (err) {
    const failure = toKinuError({ doing: 'spill oversized event content to the workspace', cause: err, otherwise: 'io' });
    diagnostics.failure('event.content_spill_failed', failure, { path });

    return { unsaved: renderCauseChain(failure) };
  }
}
