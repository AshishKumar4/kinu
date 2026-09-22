/**
 * Restorable tool-result compression: oversize results are clamped to head + tail after the full output is saved to the VFS.
 * The marker is priced inside the cap; framing producers compose the whole string before clamping.
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

export const TOOL_OUTPUT_DIR = SPILL_DIRS.toolOutput;

/** Estimated tokens (`estimateTokens` chars-per-token), not a tokenizer count. */
const DEFAULT_TOOL_RESULT_MAX_TOKENS = 2_000;

/** Derived via `admissionBytes` so the token budget and char cap cannot drift. */
export const DEFAULT_TOOL_RESULT_MAX_CHARS = admissionBytes(DEFAULT_TOOL_RESULT_MAX_TOKENS);

const HEAD_FRACTION = 0.7;

const MARKER_FENCE_CHARS = 4;

export interface ClampToolResultOptions {
  /** Without it the marker reports the omission but offers no restore path. */
  vfs?: VFS;
  budget?: TurnContextBudget;
  producer?: BulkProducer;
}

type Offload = { readonly path: string } | { readonly failure: KinuError };

/** The marker promises a path only after the write resolves. */
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

  // Relative on purpose: a leading slash would name the filesystem root.
  return { path };
}

/** Charged against the same cap as the output it replaces. */
function truncationMarker(saved: Offload | null): string {
  return saved === null || 'failure' in saved
    ? '[truncated; the full result was not saved — rerun with a filter (grep/head/tail)]'
    : `[truncated; use ranged reads to read the full result at ${saved.path}]`;
}

export async function clampToolResult(
  text: string,
  opts: ClampToolResultOptions = {},
): Promise<string> {
  if (text.length <= DEFAULT_TOOL_RESULT_MAX_CHARS) {
    opts.budget?.admit(text.length);

    return text;
  }

  const saved = opts.vfs ? await offload(opts.vfs, text) : null;
  const marker = truncationMarker(saved);
  const room = DEFAULT_TOOL_RESULT_MAX_CHARS - marker.length - MARKER_FENCE_CHARS;
  const headLen = Math.floor(room * HEAD_FRACTION);
  const head = text.slice(0, headEnd(text, headLen));
  const tail = text.slice(tailStart(text, room - headLen));
  const clamped = `${head}\n\n${marker}\n\n${tail}`;
  // Counted off what was kept: refusing to split a character can drop a unit.
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

/** Within budget the original value passes through untouched. */
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
    opts.budget?.admit(serialized.length);

    return output;
  }

  return clampToolResult(serialized, opts);
}

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

/** Puts MCP tool results under the same budget as builtins. */
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
    // Cycles/BigInt defeat re-serialization; `String()` would yield "[object Object]", so the reason replaces it.
    try {
      const serialized = JSON.stringify(input.output);

      if (serialized !== undefined) return parseJsonValue(serialized);
    } catch (serializeFailure) {
      return `unserializable tool output: ${renderThrownChain({ cause: serializeFailure })}`;
    }

    return `unserializable tool output: ${renderThrownChain({ cause: error })}`;
  }
}
