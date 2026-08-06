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
 * Content-addressed, beside the other spill dirs (`/local/.proteus/compaction`,
 * `.proteus/tool-output`): identical content always lands on the same path, so
 * a redelivered event renders a byte-identical brief.
 */

import { sha256Hex } from '../../safety/argument-digest.js';
import type { VFS } from '../../types/primitives.js';
import { EVENT_BRIEF_MAX_CHARS } from './visibility.js';

/** Workspace VFS directory spilled event content is offloaded to. */
export const EVENT_CONTENT_DIR = '/local/.proteus/event-content';

/** The content-addressed path for one spilled body. Pure. */
export function eventContentPath(content: string): string {
  return `${EVENT_CONTENT_DIR}/${sha256Hex(content, 24)}.txt`;
}

/**
 * Offload `content` when it exceeds what a brief can carry, returning the
 * readable path. Returns null when the content fits the brief (nothing was
 * truncated, so a reference would be noise) or when the write failed — the
 * brief stays honest either way, exactly as the tool-result clamp does.
 */
export async function spillEventContent(vfs: VFS, content: string): Promise<string | null> {
  if (content.length <= EVENT_BRIEF_MAX_CHARS) return null;
  const path = eventContentPath(content);
  try {
    if (!(await vfs.exists(path))) {
      try {
        await vfs.mkdir(EVENT_CONTENT_DIR, { recursive: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message.toLowerCase() : '';
        if (!msg.includes('exist')) throw err;
      }
      await vfs.writeFile(path, content);
    }
    return path;
  } catch (err) {
    console.warn('[proteus] event content spill failed:', (err as Error).message);
    return null;
  }
}
