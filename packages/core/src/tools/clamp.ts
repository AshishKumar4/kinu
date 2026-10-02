import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * Restorable tool-result compression: oversize results are clamped to head + tail after the full output is saved to the VFS.
 * The marker is priced inside the cap; framing producers compose the whole string before clamping.
 */

import type { ToolSet } from 'ai';
import { Effect } from 'effect';
import * as v from 'valibot';

import { nanoid } from '../utils/nanoid';
import { admissionBytes } from '../llm';
import { headEnd, tailStart } from '../utils/text';
import { SPILL_DIRS, type BulkProducer, type TurnContextBudget } from '../context-budget';
import type { Storage } from '../types/primitives';
import { assertJsonValue, JsonValueSchema, parseJsonValue, type JsonValue } from '../utils/json';
import { imageModelOutput, takeImages } from './image-results';
import { diagnostics, renderThrownChain, settle, toKinuError, type KinuError } from '../obs/index';
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
  files?: Pick<Storage, 'vfs' | 'home'>;
  budget?: TurnContextBudget;
  producer?: BulkProducer;
  /** Image data URLs in the output reach the model as images, outside the clamp (`image-results.ts`). */
  images?: true;
}

type Offload = { readonly path: string } | { readonly failure: KinuError };

/** The marker promises a path only after the write resolves. */
function offload(files: Pick<Storage, 'vfs' | 'home'>, text: string): Effect.Effect<Offload> {
  const directory = `${files.home}/${TOOL_OUTPUT_DIR}`;
  const path = `${directory}/${nanoid(10)}.log`;

  return Effect.tryPromise({
    try: async () => {
      await files.vfs.mkdir(directory, { recursive: true });
      await writeText(files.vfs, path, text);
    },
    catch: (cause) => toKinuError({ doing: 'saving the full tool result to the workspace', cause, otherwise: 'io' }),
  }).pipe(Effect.match({
    onFailure: (failure): Offload => {
      diagnostics.failure('clamp.offload_failed', failure);

      return { failure };
    },
    onSuccess: (): Offload => ({ path }),
  }));
}

/** Charged against the same cap as the output it replaces. */
function truncationMarker(saved: Offload | null): string {
  return saved === null || 'failure' in saved
    ? '[truncated; the full result was not saved: rerun with a filter (grep/head/tail)]'
    : `[truncated; use ranged reads to read the full result at ${saved.path}]`;
}

export function clampToolResult(
  text: string,
  opts: ClampToolResultOptions = {},
): Promise<string> {
  return settle(clampedText(text, opts));
}

function clampedText(text: string, opts: ClampToolResultOptions): Effect.Effect<string> {
  if (text.length <= DEFAULT_TOOL_RESULT_MAX_CHARS) {
    opts.budget?.admit(text.length);

    return Effect.succeed(text);
  }

  const files = opts.files;

  return Effect.map(files ? offload(files, text) : Effect.succeed(null), (saved) => clampedAround(text, saved, opts));
}

function clampedAround(text: string, saved: Offload | null, opts: ClampToolResultOptions): string {
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
export function clampSerializedToolResult(
  input: { output: unknown },
  opts: ClampToolResultOptions = {},
): Promise<JsonValue | undefined> {
  return settle(Effect.flatMap(normalizedToolOutput(input), (output): Effect.Effect<JsonValue | undefined> => {
    if (output == null) return Effect.succeed(output);
    const text = v.safeParse(v.string(), output);

    if (text.success) return clampedText(text.output, opts);
    const serialized = JSON.stringify(output);

    if (serialized.length <= DEFAULT_TOOL_RESULT_MAX_CHARS) {
      opts.budget?.admit(serialized.length);

      return Effect.succeed(output);
    }

    return clampedText(serialized, opts);
  }));
}

export function withClampedToolResult(
  toolEntry: ToolSet[string],
  opts: ClampToolResultOptions,
): ToolSet[string] {
  const execute = toolEntry?.execute;

  if (!execute) return toolEntry;

  const clamping: ToolSet[string] = {
    ...toolEntry,
    execute: async (input, options) => {
      const produced = await execute(input, options);
      const json = opts.images === true ? v.safeParse(JsonValueSchema, produced) : null;
      const taken = json?.success === true ? takeImages(json.output) : null;
      const output = taken?.value ?? produced;
      const clamped = await clampSerializedToolResult({ output }, opts);
      const outcome = successfulToolOutcome(opts.producer ?? '', { output });
      const text = v.safeParse(v.string(), clamped);

      const result = text.success && outcome.failures !== undefined
        ? { result: text.output, failures: outcome.failures }
        : clamped;

      if (taken === null || taken.images.length === 0) return result;

      // An eval's failures stay at the top level, where `successfulToolOutcome` reads the program's census.
      return outcome.failures === undefined
        ? { output: result ?? null, images: taken.images }
        : { output: result ?? null, images: taken.images, failures: outcome.failures };
    },
  };

  return opts.images === true ? { ...clamping, toModelOutput: imageModelOutput } : clamping;
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

function normalizedToolOutput(input: { output: unknown }): Effect.Effect<JsonValue | undefined> {
  if (input.output === undefined) return Effect.succeed(undefined);
  const value = { value: input.output };

  return Effect.try({
    try: (): JsonValue => {
      assertJsonValue(value);

      return value.value;
    },
    catch: (cause) => ({ cause }),
  }).pipe(Effect.catch((failed) => Effect.try({
    // Cycles/BigInt defeat re-serialization; `String()` would yield "[object Object]", so the reason replaces it.
    try: () => {
      const serialized = JSON.stringify(input.output);

      return serialized === undefined ? { reserialized: false as const } : { reserialized: true as const, json: parseJsonValue(serialized) };
    },
    catch: (cause) => ({ cause }),
  }).pipe(Effect.match({
    onSuccess: (again): JsonValue => (again.reserialized ? again.json : `unserializable tool output: ${renderThrownChain(failed)}`),
    onFailure: (serializeFailure): JsonValue => `unserializable tool output: ${renderThrownChain(serializeFailure)}`,
  }))));
}
