import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * Restorable tool-result compression: oversize results are clamped to head + tail after the full output is saved to the VFS.
 * The marker is priced inside the cap; framing producers compose the whole string before clamping.
 */

import type { ToolSet } from 'ai';
import { Effect, Exit } from 'effect';
import * as v from 'valibot';

import { nanoid } from '../utils/nanoid';
import { admissionBytes } from '../token-estimate';
import { headEnd, lineCount, tailStart } from '../utils/text';
import { SPILL_DIRS, type BulkProducer, type TurnContextBudget } from '../context-budget';
import type { Storage } from '../types/primitives';
import { assertJsonValue, JsonObjectSchema, JsonValueSchema, parseJsonValue, type JsonObject, type JsonValue } from '../utils/json';
import { imageModelOutput, takeImages } from './image-results';
import { imageCarrier } from '../types/tool-images';
import { diagnostics, hold, renderThrownChain, settle, toKinuError, type KinuError } from '../obs/index';
import { successfulToolOutcome } from './outcome';


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
  /** Where the cut falls; by default what a model reads of one result. */
  maxChars?: number;
}

type Offload = { readonly path: string } | { readonly failure: KinuError };

/** The marker promises a path only after the write resolves. */
function offload(files: Pick<Storage, 'vfs' | 'home'>, text: string): Effect.Effect<Offload> {
  const directory = `${files.home}/${SPILL_DIRS.toolOutput}`;
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

/** What a cut kept of a result: its characters shown of all of them, and the lines of the saved whole it left out
 *  (`from` to `to` of `of`, as a ranged read counts them), the part of a line it cut through among them. */
interface Kept {
  readonly shown: number;
  readonly total: number;
  readonly from: number;
  readonly to: number;
  readonly of: number;
}

/** Lines counted as a ranged read counts them (`lineCount`): the first left out is the one the head cut into or the one
 *  after it, the last the one the tail starts in. */
function keptOf(text: string, head: string, tail: string): Kept {
  return {
    shown: head.length + tail.length, total: text.length,
    from: head.split('\n').length, to: lineCount(text.slice(0, text.length - tail.length)), of: lineCount(text),
  };
}

/** The widest marker `text` can have: every count at its whole, which no cut's exceeds. */
function widestKept(text: string): Kept {
  const of = lineCount(text);

  return { shown: text.length, total: text.length, from: of, to: of, of };
}

/**
 * Charged against the same cap as the output it replaces: the bounded format file list and search answer with (FEAT-11),
 * how much is shown of how much, and where the rest is. `compact` says it in fewer words, for a cut beside a record that
 * leaves little room (`recordedAnswer`).
 */
function truncationMarker(saved: Offload | null, kept: Kept, compact = false): string {
  const unsaved = saved === null || 'failure' in saved;

  if (compact) {
    return unsaved
      ? `[truncated; ${String(kept.shown)}/${String(kept.total)} chars; not saved]`
      : `[truncated; ${String(kept.shown)}/${String(kept.total)} chars; full result at ${saved.path}]`;
  }

  const shown = `showing ${String(kept.shown)} of ${String(kept.total)} characters`;

  return unsaved
    ? `[truncated; ${shown}; the full result was not saved: rerun with a filter (grep/head/tail)]`
    : `[truncated; ${shown}; lines ${String(kept.from)}-${String(kept.to)} of ${String(kept.of)} are left out: use ranged reads to read the full result at ${saved.path}]`;
}

/** The marker a cut to `maxChars` has room for: in full where its widest fits, else compact. */
function markerFits(text: string, saved: Offload | null, maxChars: number): boolean {
  return truncationMarker(saved, widestKept(text)).length + MARKER_FENCE_CHARS <= maxChars;
}

export function clampToolResult(
  text: string,
  opts: ClampToolResultOptions = {},
): Promise<string> {
  return settle(clampedText(text, opts));
}

function clampedText(text: string, opts: ClampToolResultOptions): Effect.Effect<string> {
  if (text.length <= (opts.maxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS)) {
    opts.budget?.admit(text.length);

    return Effect.succeed(text);
  }

  const files = opts.files;

  return Effect.map(files ? offload(files, text) : Effect.succeed(null), (saved) => clampedAround(text, saved, opts));
}

/** `text` cut around its middle to `maxChars`, the marker where it was cut; what it omitted, counted off what was kept.
 *  Room is left for the widest marker, so the one that counts what was kept fits. */
function cutAround(text: string, saved: Offload | null, maxChars: number) {
  const compact = !markerFits(text, saved, maxChars);
  // A bound smaller than the marker keeps the marker alone: a negative room would slice from the end and keep it all.
  const room = Math.max(0, maxChars - truncationMarker(saved, widestKept(text), compact).length - MARKER_FENCE_CHARS);
  const headLen = Math.floor(room * HEAD_FRACTION);
  const head = text.slice(0, headEnd(text, headLen));
  const tail = text.slice(tailStart(text, room - headLen));
  const marker = truncationMarker(saved, keptOf(text, head, tail), compact);

  // Counted off what was kept: refusing to split a character can drop a unit.
  return { clamped: `${head}\n\n${marker}\n\n${tail}`, omitted: text.length - head.length - tail.length };
}

/** A cut charged to the turn's budget: what it keeps, and the spill it left. */
function chargedCut(chars: number, omitted: number, saved: Offload | null, opts: ClampToolResultOptions): void {
  if (!opts.budget) return;
  opts.budget.admit(chars);
  opts.budget.recordSpill({ producer: opts.producer ?? 'eval', omitted, referenced: saved !== null && 'path' in saved });
}

function clampedAround(text: string, saved: Offload | null, opts: ClampToolResultOptions): string {
  const { clamped, omitted } = cutAround(text, saved, opts.maxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS);

  chargedCut(clamped.length, omitted, saved, opts);

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

    if (serialized.length <= (opts.maxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS)) {
      opts.budget?.admit(serialized.length);

      return Effect.succeed(output);
    }

    return clampedText(serialized, opts);
  }));
}

/** An eval's answer with its record of what it changed (`execution/call-effects.ts`) set aside, where it has one. */
function setAside(producer: string | undefined, output: JsonValue | undefined) {
  const answer = producer === 'eval' ? v.safeParse(v.looseObject({ effects: JsonValueSchema }), output) : null;

  if (answer?.success !== true) return null;
  const { effects, ...rest } = answer.output;

  return { rest: v.parse(JsonObjectSchema, rest), effects };
}

/**
 * A recorded answer within its bound: whole where it fits, else its rest cut to text beside its census and its record,
 * never cut. The cut is made again, narrower by what it overran, until the answer as returned, the text escaped inside
 * `result`, fits, down to the marker alone. A census and a record that overrun the bound with the marker alone are
 * returned so, never cut, and said. It is saved once, and charged as returned.
 */
async function recordedAnswer(
  recorded: { readonly rest: JsonObject; readonly effects: JsonValue }, failures: JsonValue | undefined, opts: ClampToolResultOptions,
): Promise<JsonObject> {
  const cap = opts.maxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS;
  const whole: JsonObject = { ...recorded.rest, effects: recorded.effects };
  const wholeChars = JSON.stringify(whole).length;

  if (wholeChars <= cap) {
    opts.budget?.admit(wholeChars);

    return whole;
  }

  const kept: JsonObject = failures === undefined ? { effects: recorded.effects } : { failures, effects: recorded.effects };
  const text = JSON.stringify(recorded.rest);
  // Saving never fails the answer: a failed save is the marker's to say (`offload`).
  const offloaded = opts.files === undefined ? null : await hold(offload(opts.files, text));
  const saved = offloaded !== null && Exit.isSuccess(offloaded) ? offloaded.value : null;
  const answered = (clamped: string): JsonObject => ({ result: clamped, ...kept });
  // The narrowest cut keeps the compact marker alone (`cutAround` with no room).
  const floor = truncationMarker(saved, widestKept(text), true).length + MARKER_FENCE_CHARS;
  let width = Math.max(floor, cap - JSON.stringify(answered('')).length);
  let cut = cutAround(text, saved, width);

  // Each pass narrows strictly, so it ends at a fit or at the marker alone.
  for (let over = JSON.stringify(answered(cut.clamped)).length - cap; over > 0 && width > floor; over = JSON.stringify(answered(cut.clamped)).length - cap) {
    width = Math.max(floor, width - over);
    cut = cutAround(text, saved, width);
  }

  const answer = answered(cut.clamped);
  const overrun = JSON.stringify(answer).length - cap;

  if (overrun > 0) diagnostics.event('clamp.record_over_bound', { producer: opts.producer ?? 'eval', cap, overrun });

  chargedCut(JSON.stringify(answer).length, cut.omitted, saved, opts);

  return answer;
}

/** An answer within its bound; one cut to text keeps a program's census at the top level, where it is read. */
async function clampedAnswer(input: Parameters<typeof clampSerializedToolResult>[0], failures: JsonValue | undefined, opts: ClampToolResultOptions) {
  const clamped = await clampSerializedToolResult(input, opts);
  const text = v.safeParse(v.string(), clamped);

  return text.success && failures !== undefined ? { result: text.output, failures } : clamped;
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
      const outcome = successfulToolOutcome(opts.producer ?? '', { output });
      const answered = v.safeParse(JsonValueSchema, output);
      const recorded = answered.success ? setAside(opts.producer, answered.output) : null;
      const failures = outcome.failures === undefined ? undefined : v.parse(JsonValueSchema, outcome.failures);

      const result = recorded === null ? await clampedAnswer({ output }, failures, opts) : await recordedAnswer(recorded, failures, opts);

      if (taken === null || taken.images.length === 0) return result;
      const carrier = imageCarrier(result ?? null, taken.images);

      return outcome.failures === undefined ? carrier : { ...carrier, failures: outcome.failures };
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
