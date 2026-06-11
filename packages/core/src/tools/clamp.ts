/**
 * Restorable tool-result compression — the at-source budget for tool outputs.
 *
 * Without a cap, one `cat` of a big log rots the session until the
 * compaction cliff: the full output persists into durable history and is
 * re-sent every turn. Oversize results are clamped to head + tail with the
 * FULL output saved to the workspace VFS first, so nothing is irrecoverable
 * — the marker tells the model exactly where to read the rest (the Claude
 * Code / Manus drop-content-keep-the-path pattern).
 *
 * Applied inside `buildBuiltinTools` (run + execute_tools), so both backends
 * share one budget policy.
 */

import type { ToolSet } from 'ai';
import type { VFS } from '../types/primitives.js';
import { nanoid } from '../utils/nanoid.js';

/** Workspace VFS directory full outputs are offloaded to. */
export const TOOL_OUTPUT_DIR = '.proteus/tool-output';

export const DEFAULT_TOOL_RESULT_MAX_CHARS = 40_000;

/** Head/tail split of the kept budget — the start of an output (command echo,
 *  headers) and its end (errors, summaries) carry the most signal. */
const HEAD_FRACTION = 0.7;

export interface ClampToolResultOptions {
  maxChars?: number;
  /** Workspace VFS the full output is saved to. Without it the marker still
   *  reports the omission but cannot offer a restore path. */
  vfs?: VFS;
}

/** Clamp one oversize tool result, offloading the full text to the VFS. */
export async function clampToolResult(
  text: string,
  opts: ClampToolResultOptions = {},
): Promise<string> {
  const maxChars = opts.maxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS;
  if (text.length <= maxChars) return text;

  let savedPath: string | null = null;
  if (opts.vfs) {
    const path = `${TOOL_OUTPUT_DIR}/${nanoid(10)}.log`;
    try {
      await opts.vfs.mkdir(TOOL_OUTPUT_DIR, { recursive: true });
      await opts.vfs.writeFile(path, text);
      savedPath = `/${path}`;
    } catch {
      savedPath = null; // offload failed — still clamp, marker stays honest
    }
  }

  const headLen = Math.floor(maxChars * HEAD_FRACTION);
  const tailLen = maxChars - headLen;
  const omitted = text.length - headLen - tailLen;
  const marker = savedPath
    ? `[output truncated: ${omitted} chars omitted; full output saved to ${savedPath} — ` +
      'read it with workspace file tools (e.g. run `grep`/`sed -n` on it with runtime "workspace", or workspace.readFile) or rerun with a filter]'
    : `[output truncated: ${omitted} chars omitted; rerun with a filter (grep/head/tail) to see the rest]`;
  return `${text.slice(0, headLen)}\n\n${marker}\n\n${text.slice(-tailLen)}`;
}

/** Serialize-and-clamp for tools whose results are structured (execute_tools).
 *  Within budget the original value passes through untouched; oversize values
 *  are offloaded as JSON and replaced by the clamped serialization. */
export async function clampSerializedToolResult(
  output: unknown,
  opts: ClampToolResultOptions = {},
): Promise<unknown> {
  if (output == null) return output;
  const maxChars = opts.maxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS;
  if (typeof output === 'string') {
    return output.length <= maxChars ? output : clampToolResult(output, opts);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(output);
  } catch {
    serialized = String(output);
  }
  if (serialized == null || serialized.length <= maxChars) return output;
  return clampToolResult(serialized, opts);
}

/** Wrap one ToolSet entry so its results pass through the serialize-clamp.
 *  Shallow-clones — schema and description are untouched. */
export function withClampedToolResult(
  toolEntry: ToolSet[string],
  vfs: VFS | undefined,
  maxChars?: number,
): ToolSet[string] {
  const execute = (toolEntry as { execute?: (...args: never[]) => unknown }).execute;
  if (typeof execute !== 'function') return toolEntry;
  return {
    ...toolEntry,
    execute: async (...args: never[]) =>
      clampSerializedToolResult(await execute(...args), { vfs, ...(maxChars !== undefined ? { maxChars } : {}) }),
  } as ToolSet[string];
}
