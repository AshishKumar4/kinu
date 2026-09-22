/**
 * Producer-side bulk spill for event payloads — the resolvable half of the
 * reference-plus-digest invariant.
 *
 * An event brief is a bounded slice ({@link EVENT_BRIEF_MAX_CHARS}). Without
 * an address for the rest, an oversize subordinate report or peer message is
 * unreachable from the receiving turn: the brief IS the whole delivery. So
 * producers write the full text into the receiving agent's own file plane
 * here and carry the path in the payload; `renderForLLM` appends it to the
 * brief, and the agent reads it back with its normal file tools (the same
 * drop-content-keep-the-path recipe the tool-result clamp teaches).
 *
 * Content-addressed, beside the other spill dirs (`.kinu/compaction`,
 * `.kinu/tool-output`): identical content always lands on the same path, so
 * a redelivered event renders a byte-identical brief.
 */

import { sha256Hex } from '../../safety/argument-digest';
import type { VFS } from '../../types/primitives';
import { EVENT_BRIEF_MAX_CHARS } from './visibility';
import { diagnostics, renderCauseChain, toKinuError } from '../../obs/index';
import { ensureDir } from '../../utils/vfs-helpers';

/** Workspace VFS directory spilled event content is offloaded to. */
export const EVENT_CONTENT_DIR = '.kinu/event-content';

/** The content-addressed path for one spilled body. Pure. */
export function eventContentPath(content: string): string {
  return `${EVENT_CONTENT_DIR}/${sha256Hex(content, 24)}.txt`;
}

/** Where an oversize body's full text went, or why it went nowhere. */
export type SpilledContent =
  | { readonly path: string; readonly unsaved?: never }
  | { readonly unsaved: string; readonly path?: never };

/**
 * Offload `content` when it exceeds what a brief can carry. Null when the
 * content fits the brief: nothing was truncated, so a reference would be
 * noise. A write that fails does not stop the delivery: `unsaved` carries why
 * the rest cannot be read back, and the brief states it.
 */
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
