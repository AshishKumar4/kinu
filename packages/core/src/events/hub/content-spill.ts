import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
/** Oversize event bodies are written to the receiver's file plane and the path rides the payload.
 *  Content-addressed, so a redelivered event renders a byte-identical brief. */

import { sha256Hex } from '../../safety/argument-digest';

import { EVENT_BRIEF_MAX_CHARS } from './visibility';
import { Effect } from 'effect';
import { diagnostics, renderCauseChain, settle, toKinuError } from '../../obs/index';
import { publishContent } from '../../utils/vfs-helpers';
import { SPILL_DIRS } from '../../context-budget';

export function eventContentPath(content: string): string {
  return `${SPILL_DIRS.eventContent}/${sha256Hex(content, 24)}.txt`;
}

export type SpilledContent =
  | { readonly path: string; readonly unsaved?: never }
  | { readonly unsaved: string; readonly path?: never };

/** Null when the content fits the brief. A failed write does not stop delivery; `unsaved` says why. */
export function spillEventContent(vfs: VFS, content: string): Promise<SpilledContent | null> {
  if (content.length <= EVENT_BRIEF_MAX_CHARS) return Promise.resolve(null);
  const path = eventContentPath(content);

  return settle(Effect.tryPromise({
    // The brief promises the whole body at this path, so other bytes there are written over with it.
    try: async (): Promise<SpilledContent> => {
      await publishContent(vfs, { directory: SPILL_DIRS.eventContent, path, bytes: new TextEncoder().encode(content), otherBytes: 'rewrite' });

      return { path };
    },
    catch: (cause) => toKinuError({ doing: 'spill oversized event content to the workspace', cause, otherwise: 'io' }),
  }).pipe(Effect.catch((failure) => {
    diagnostics.failure('event.content_spill_failed', failure, { path });

    return Effect.succeed<SpilledContent>({ unsaved: renderCauseChain(failure) });
  })));
}
