/**
 * appendMemoryNote — the single canonical "save a note to long-term memory"
 * primitive. Three callers converge here:
 *
 *   1. workspace.saveNote(content)       — codemode inline executor
 *   2. save_note(content) builtin tool   — Vercel AI SDK ToolSet
 *   3. saveNoteFromMcp(content) RPC      — MCP server bridge
 *
 * All three previously inlined the same three lines:
 *   memory.append('memory/MEMORY.md', `\n### Note (${date})\n${content}\n`)
 *   memory.index('memory/MEMORY.md')
 *
 * Centralized here so the format stays consistent.
 */

import type { Memory } from '../types/primitives.js';

const MEMORY_PATH = 'memory/MEMORY.md';

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
