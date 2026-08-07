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
import { SPILL_DIRS, type BulkProducer, type TurnContextBudget } from '../context-budget.js';

/** Workspace VFS directory full outputs are offloaded to. */
export const TOOL_OUTPUT_DIR = SPILL_DIRS.toolOutput;

export const DEFAULT_TOOL_RESULT_MAX_CHARS = 40_000;

/** Head/tail split of the kept budget — the start of an output (command echo,
 *  headers) and its end (errors, summaries) carry the most signal. */
const HEAD_FRACTION = 0.7;

export interface ClampToolResultOptions {
  maxChars?: number;
  /** Workspace VFS the full output is saved to. Without it the marker still
   *  reports the omission but cannot offer a restore path. */
  vfs?: VFS;
  /** The turn's cumulative budget. Present: the per-result cap tightens once
   *  the turn has admitted its budget, and every trip is counted. Absent: the
   *  per-result cap is the whole policy (heads, tests, one-off calls). */
  budget?: TurnContextBudget;
  /** Which producer this result came from — the counter's breakdown key. */
  producer?: BulkProducer;
}

/** Clamp one oversize tool result, offloading the full text to the VFS. */
export async function clampToolResult(
  text: string,
  opts: ClampToolResultOptions = {},
): Promise<string> {
  const configured = opts.maxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS;
  const maxChars = opts.budget?.capFor(configured) ?? configured;
  if (text.length <= maxChars) {
    opts.budget?.admit(text.length);
    return text;
  }

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
  // The advertised remedy must hold on every backend: the run tool's
  // "workspace" runtime is the VFS shell on CF but the HOST shell locally
  // (where this offload file does not exist), so the marker only promises
  // workspace.readFile — execute_tools reads it over the same VFS on both
  // backends, and the model can filter inside the sandbox arrow.
  const marker = savedPath
    ? `[output truncated: ${omitted} chars omitted; full output saved to ${savedPath} — ` +
      'read or filter it with workspace.readFile inside execute_tools ' +
      '(oversize: slice + llm.query each slice, aggregate), or rerun with a filter]'
    : `[output truncated: ${omitted} chars omitted; rerun with a filter (grep/head/tail) to see the rest]`;
  const clamped = `${text.slice(0, headLen)}\n\n${marker}\n\n${text.slice(-tailLen)}`;
  if (opts.budget) {
    opts.budget.admit(clamped.length);
    opts.budget.recordSpill({
      producer: opts.producer ?? 'execute_tools',
      omitted,
      referenced: savedPath !== null,
      tightened: maxChars < configured,
    });
  }
  return clamped;
}

/** Serialize-and-clamp for tools whose results are structured (execute_tools).
 *  Within budget the original value passes through untouched; oversize values
 *  are offloaded as JSON and replaced by the clamped serialization. */
export async function clampSerializedToolResult(
  output: unknown,
  opts: ClampToolResultOptions = {},
): Promise<unknown> {
  if (output == null) return output;
  if (typeof output === 'string') return clampToolResult(output, opts);
  let serialized: string;
  try {
    serialized = JSON.stringify(output);
  } catch {
    serialized = String(output);
  }
  const configured = opts.maxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS;
  if (serialized == null || serialized.length <= (opts.budget?.capFor(configured) ?? configured)) {
    opts.budget?.admit(serialized?.length ?? 0);
    return output;
  }
  return clampToolResult(serialized, opts);
}

/** Wrap one ToolSet entry so its results pass through the serialize-clamp.
 *  Shallow-clones — schema and description are untouched. */
export function withClampedToolResult(
  toolEntry: ToolSet[string],
  opts: ClampToolResultOptions,
): ToolSet[string] {
  const execute = (toolEntry as { execute?: (...args: never[]) => unknown }).execute;
  if (typeof execute !== 'function') return toolEntry;
  return {
    ...toolEntry,
    execute: async (...args: never[]) => clampSerializedToolResult(await execute(...args), opts),
  } as ToolSet[string];
}

/** Wrap every entry of an externally supplied ToolSet (MCP servers) so its
 *  results ride the same budget as the builtins. Without this an MCP tool is
 *  the one bulk producer with no cap at all. */
export function withClampedToolResults(
  tools: ToolSet,
  opts: ClampToolResultOptions,
): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, entry]) => [name, withClampedToolResult(entry, opts)]),
  ) as ToolSet;
}
