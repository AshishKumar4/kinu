/**
 * appendMemoryNote — the single canonical "save a note to long-term memory"
 * primitive. Three callers converge here:
 *
 *   1. workspace.saveNote(content)        — codemode inline executor
 *   2. memory({action:'save'}) builtin    — Vercel AI SDK ToolSet
 *   3. saveNoteFromMcp(content) RPC       — MCP server bridge
 *
 * All three previously inlined the same three lines:
 *   memory.append('memory/MEMORY.md', `\n### Note (${date})\n${content}\n`)
 *   memory.index('memory/MEMORY.md')
 *
 * Centralized here so the format stays consistent.
 */

import type { Memory } from '../types/primitives.js';

const MEMORY_PATH = 'memory/MEMORY.md';

/** Default bound on the MEMORY.md tail woven into a turn — enough for the
 *  newest lessons/reflections without unbounding the prompt as the append-only
 *  file grows. */
export const MEMORY_TAIL_MAX_CHARS = 2000;

/**
 * The newest bytes of the append-only MEMORY.md — the live lessons/reflections
 * tail both backends weave into the dynamic-context block (never
 * the byte-stable prefix, where every append would bust the cache). Bounded to
 * the file's END because that is where the newest entries land. Undefined when
 * memory is empty. Single source of truth for the path + bound so the cf and
 * CLI weaves cannot drift.
 */
export async function readMemoryTail(memory: Memory, maxChars = MEMORY_TAIL_MAX_CHARS): Promise<string | undefined> {
  const tail = (await memory.read(MEMORY_PATH))?.slice(-maxChars);
  return tail && tail.length > 0 ? tail : undefined;
}

export async function appendMemoryNote(
  memory: Memory,
  content: string,
  options?: { heading?: string; date?: string },
): Promise<string> {
  const date = options?.date ?? new Date().toISOString().split('T')[0];
  const heading = options?.heading ?? 'Note';
  await memory.append(MEMORY_PATH, `\n### ${heading} (${date})\n${content}\n`);
  await memory.index(MEMORY_PATH);
  return 'Note saved to memory.';
}
