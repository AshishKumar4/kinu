import { exists, type VFS, writeText } from '@nimbus-sh/core/vfs/vfs.js';
/** Oversize event bodies are written to the receiver's file plane and the path rides the payload.
 *  Content-addressed, so a redelivered event renders a byte-identical brief. */

import { sha256Hex } from '../../safety/argument-digest';

import { EVENT_BRIEF_MAX_CHARS } from './visibility';
import { Effect } from 'effect';
import { diagnostics, renderCauseChain, settle, toKinuError } from '../../obs/index';
import { ensureDir } from '../../utils/vfs-helpers';

const EVENT_CONTENT_DIR = '.kinu/event-content';

export function eventContentPath(content: string): string {
  return `${EVENT_CONTENT_DIR}/${sha256Hex(content, 24)}.txt`;
}

export type SpilledContent =
  | { readonly path: string; readonly unsaved?: never }
  | { readonly unsaved: string; readonly path?: never };

/** Null when the content fits the brief. A failed write does not stop delivery; `unsaved` says why. */
export function spillEventContent(vfs: VFS, content: string): Promise<SpilledContent | null> {
  if (content.length <= EVENT_BRIEF_MAX_CHARS) return Promise.resolve(null);
  const path = eventContentPath(content);

  return settle(Effect.tryPromise({
    try: async (): Promise<SpilledContent> => {
      if (!(await exists(vfs, path))) {
        await ensureDir(vfs, EVENT_CONTENT_DIR);
        await writeText(vfs, path, content);
      }

      return { path };
    },
    catch: (cause) => toKinuError({ doing: 'spill oversized event content to the workspace', cause, otherwise: 'io' }),
  }).pipe(Effect.catch((failure) => {
    diagnostics.failure('event.content_spill_failed', failure, { path });

    return Effect.succeed<SpilledContent>({ unsaved: renderCauseChain(failure) });
  })));
}
