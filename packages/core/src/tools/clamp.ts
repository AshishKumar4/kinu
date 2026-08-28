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
import * as v from 'valibot';
import type { VFS } from '../types/primitives';
import { nanoid } from '../utils/nanoid';
import { SPILL_DIRS, type BulkProducer, type TurnContextBudget } from '../context-budget';
import { assertJsonValue, parseJsonValue, type JsonValue } from '../utils/json';
import { diagnostics, renderThrownChain } from '../obs/index';

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
      // The path as written, not rooted: relative paths resolve at the
      // workspace root for every surface that reads them, and a leading slash
      // would name the filesystem's real root instead.
      savedPath = path;
    } catch (error) {
      diagnostics.event('clamp.offload_failed', { error: renderThrownChain({ cause: error }) });
      savedPath = null;
    }
  }

  const headLen = Math.floor(maxChars * HEAD_FRACTION);
  const tailLen = maxChars - headLen;
  const omitted = text.length - headLen - tailLen;
  // Why this result came back shorter than the last one. The system prompt
  // used to explain the turn-cumulative cap in its Delegation section, ~3,000
  // tokens before anything could trip it; the fact is only actionable at the
  // trip, and it costs nothing on the turns that never get here.
  const tightened = maxChars < configured;
  const reason = tightened
    ? ' This turn has already admitted enough tool output that the cap tightened for the rest of it — hand the bulk to a search or a subordinate rather than pulling more of it in here.'
    : '';
  // The marker promises workspace.readFile, which reads the same filesystem
  // the run tool's `workspace` shell runs over on every backend — so the
  // model can also grep the file it names.
  const marker = savedPath
    ? `[output truncated: ${omitted} chars omitted; full output saved to ${savedPath} — ` +
      'read or filter it with workspace.readFile inside execute_tools ' +
      `(oversize: hand the path to a temporary agent as \`context_ref\` on an agents ask, or range-read it), or rerun with a filter]${reason}`
    : `[output truncated: ${omitted} chars omitted; rerun with a filter (grep/head/tail) to see the rest]${reason}`;
  const clamped = `${text.slice(0, headLen)}\n\n${marker}\n\n${text.slice(-tailLen)}`;
  if (opts.budget) {
    opts.budget.admit(clamped.length);
    opts.budget.recordSpill({
      producer: opts.producer ?? 'execute_tools',
      omitted,
      referenced: savedPath !== null,
      tightened,
    });
  }
  return clamped;
}

/** Serialize-and-clamp for tools whose results are structured (execute_tools).
 *  Within budget the original value passes through untouched; oversize values
 *  are offloaded as JSON and replaced by the clamped serialization. */
export async function clampSerializedToolResult(
  input: { output: unknown },
  opts: ClampToolResultOptions = {},
): Promise<JsonValue | undefined> {
  const output = normalizeToolOutput(input);
  if (output == null) return output;
  const text = v.safeParse(v.string(), output);
  if (text.success) return clampToolResult(text.output, opts);
  const serialized = JSON.stringify(output);
  const configured = opts.maxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS;
  if (serialized.length <= (opts.budget?.capFor(configured) ?? configured)) {
    opts.budget?.admit(serialized.length);
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
  const execute = toolEntry?.execute;
  if (!execute) return toolEntry;
  return {
    ...toolEntry,
    execute: async (input, options) => clampSerializedToolResult(
      { output: await execute(input, options) },
      opts,
    ),
  };
}

/** Wrap every entry of an externally supplied ToolSet (MCP servers) so its
 *  results ride the same budget as the builtins. Without this an MCP tool is
 *  the one bulk producer with no cap at all. */
export function withClampedToolResults(
  tools: ToolSet,
  opts: ClampToolResultOptions,
): ToolSet {
  // SAFETY: The ToolSet contract guarantees every source value and every
  // wrapper result is a ToolSet entry; Object.fromEntries preserves those values.
  return Object.fromEntries(
    Object.entries(tools).map(([name, entry]) => [name, withClampedToolResult(entry, opts)]),
  ) as ToolSet;
}

function normalizeToolOutput(input: { output: unknown }): JsonValue | undefined {
  if (input.output === undefined) return undefined;
  const value = { value: input.output };
  try {
    assertJsonValue(value);
    return value.value;
  } catch (error) {
    // Not already a JsonValue, so re-serialize. A cycle or a BigInt makes even
    // that impossible, and `String()` on those is "[object Object]" — the one
    // string that carries nothing at all — so the reason takes its place.
    try {
      const serialized = JSON.stringify(input.output);
      if (serialized !== undefined) return parseJsonValue(serialized);
    } catch (error) {
      return `unserializable tool output: ${renderThrownChain({ cause: error })}`;
    }
    return `unserializable tool output: ${renderThrownChain({ cause: error })}`;
  }
}
