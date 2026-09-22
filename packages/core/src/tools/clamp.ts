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
 * The budget is what the MODEL receives, not what the clamp kept: the marker
 * is priced inside the cap, because a result that arrives at cap + marker is
 * over budget by exactly the length of its own excuse. A producer that frames
 * its output (a shell steer, a page header) composes the whole string first
 * and clamps that, so one call owns the cap, the spill and the accounting.
 *
 * Applied inside `buildBuiltinTools` (run + eval), so both backends
 * share one budget policy.
 */

import type { ToolSet } from 'ai';
import * as v from 'valibot';
import type { VFS } from '../types/primitives';
import { nanoid } from '../utils/nanoid';
import { admissionBytes } from '../llm';
import { headEnd, tailStart } from '../utils/text';
import { SPILL_DIRS, type BulkProducer, type TurnContextBudget } from '../context-budget';
import { assertJsonValue, parseJsonValue, type JsonValue } from '../utils/json';
import { diagnostics, renderThrownChain, toKinuError, type KinuError } from '../obs/index';
import { successfulToolOutcome } from './outcome';

/** Workspace VFS directory full outputs are offloaded to. */
export const TOOL_OUTPUT_DIR = SPILL_DIRS.toolOutput;

/** What one tool result may cost the model, in ESTIMATED tokens: `estimateTokens`'
 *  blunt chars-per-token, not a tokenizer and not any provider's count. */
const DEFAULT_TOOL_RESULT_MAX_TOKENS = 2_000;

/** The same budget in characters, which is the unit the clamp measures in.
 *  Derived through `admissionBytes` — the one inverse of `estimateTokens` — so
 *  the token budget and the char cap cannot drift apart. */
export const DEFAULT_TOOL_RESULT_MAX_CHARS = admissionBytes(DEFAULT_TOOL_RESULT_MAX_TOKENS);

/** Head/tail split of the kept budget — the start of an output (command echo,
 *  headers) and its end (errors, summaries) carry the most signal. */
const HEAD_FRACTION = 0.7;

/** The two blank lines that fence the marker between head and tail. */
const MARKER_FENCE_CHARS = 4;

export interface ClampToolResultOptions {
  /** Workspace VFS the full output is saved to. Without it the marker still
   *  reports the omission but cannot offer a restore path. */
  vfs?: VFS;
  /** The turn's ledger: every result's admitted chars and every spill trip. */
  budget?: TurnContextBudget;
  /** Which producer this result came from — the counter's breakdown key. */
  producer?: BulkProducer;
}

/** Where the full text landed, or why it did not. A failed offload is a
 *  classified value the marker reads, never a path that reads back empty. */
type Offload = { readonly path: string } | { readonly failure: KinuError };

/** Save the full text where the marker can promise it — a promise is only
 *  made after the write resolves. */
async function offload(vfs: VFS, text: string): Promise<Offload> {
  const path = `${TOOL_OUTPUT_DIR}/${nanoid(10)}.log`;

  try {
    await vfs.mkdir(TOOL_OUTPUT_DIR, { recursive: true });
    await vfs.writeFile(path, text);
  } catch (cause) {
    const failure = toKinuError({ doing: 'saving the full tool result to the workspace', cause, otherwise: 'io' });
    diagnostics.failure('clamp.offload_failed', failure);

    return { failure };
  }

  // The path as written, not rooted: relative paths resolve at the workspace
  // root for every surface that reads them, and a leading slash would name the
  // filesystem's real root instead.
  return { path };
}

/** What a clamped result says about itself. Short on purpose — it is charged
 *  against the same cap as the output it replaces, and the only thing it has
 *  to carry is where the rest is. */
function truncationMarker(saved: Offload | null): string {
  return saved === null || 'failure' in saved
    ? '[truncated; the full result was not saved — rerun with a filter (grep/head/tail)]'
    : `[truncated; use ranged reads to read the full result at ${saved.path}]`;
}

/** Clamp one oversize tool result, offloading the full text to the VFS. */
export async function clampToolResult(
  text: string,
  opts: ClampToolResultOptions = {},
): Promise<string> {
  if (text.length <= DEFAULT_TOOL_RESULT_MAX_CHARS) {
    opts.budget?.admit(text.length);

    return text;
  }

  // The marker promises a path only once the bytes are at it, and its own
  // length is known before the head and tail are cut, because they are what
  // it leaves behind.
  const saved = opts.vfs ? await offload(opts.vfs, text) : null;
  const marker = truncationMarker(saved);
  const room = DEFAULT_TOOL_RESULT_MAX_CHARS - marker.length - MARKER_FENCE_CHARS;
  const headLen = Math.floor(room * HEAD_FRACTION);
  const head = text.slice(0, headEnd(text, headLen));
  const tail = text.slice(tailStart(text, room - headLen));
  const clamped = `${head}\n\n${marker}\n\n${tail}`;
  // What the root never sees, counted off what was actually kept: refusing to
  // split a character can drop a unit the nominal split had allowed for.
  const omitted = text.length - head.length - tail.length;

  if (opts.budget) {
    opts.budget.admit(clamped.length);
    opts.budget.recordSpill({
      producer: opts.producer ?? 'eval',
      omitted,
      referenced: saved !== null && 'path' in saved,
    });
  }

  return clamped;
}

/** Serialize-and-clamp for tools whose results are structured (eval).
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

  if (serialized.length <= DEFAULT_TOOL_RESULT_MAX_CHARS) {
    // The model pays for the serialization, not for the object graph.
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
    execute: async (input, options) => {
      const output = await execute(input, options);
      const clamped = await clampSerializedToolResult({ output }, opts);
      const outcome = successfulToolOutcome(opts.producer ?? '', { output });
      const text = v.safeParse(v.string(), clamped);

      return text.success && outcome.failures !== undefined
        ? { result: text.output, failures: outcome.failures }
        : clamped;
    },
  };
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
  );
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
    } catch (serializeFailure) {
      return `unserializable tool output: ${renderThrownChain({ cause: serializeFailure })}`;
    }

    return `unserializable tool output: ${renderThrownChain({ cause: error })}`;
  }
}
