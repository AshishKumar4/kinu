/**
 * Scaffold-as-inference-loop on the LIVE inference seam.
 *
 * Think's `_runInferenceLoop` is private and always calls the AI SDK's
 * `streamText` itself (the old `runStreamText` subclass override this
 * replaces had ZERO callers on 0.8.2 — the mutable scaffold was silently
 * dead). The seam Think does expose is the protected
 * `_transformInferenceResult(result)`: it receives the just-created
 * StreamableResult for every turn entry path and may replace the stream the
 * client consumes. This module owns the backend-agnostic routing decision so
 * the DO override stays a thin adapter and the behavior is testable off-DO.
 *
 * Semantics:
 * - Un-evolved agent (current scaffold version <= 0): the default result is
 *   returned UNTOUCHED — same object, zero overhead.
 * - Evolved scaffold: `runScaffold` becomes the turn's inference loop.
 *   `host.defaultInference()` hands the scaffold THE stream Think already
 *   prepared (full context, tools, hooks applied), so a delegating scaffold
 *   is byte-faithful to the default inference by construction. Under the old
 *   override each `defaultInference()` call re-ran `streamText`; on this
 *   seam the ONE prepared stream is consumed, so only the first delegation
 *   streams — a second call surfaces as a `defaultInference failed` event
 *   (no scaffold has ever needed two).
 * - The AI SDK's `streamText` fires its first model request eagerly (at
 *   construction), so a custom scaffold that finishes without delegating
 *   leaves an orphaned in-flight default stream: it is cancelled when the
 *   scaffold settles, stopping generation instead of letting it run to
 *   completion unconsumed.
 */

import { runScaffold, type ScaffoldRunOptions } from './executor.js';
import { scaffoldEventsToUIStream } from './ui-stream.js';

/** Structural mirror of Think's StreamableResult — core cannot import the
 *  backend SDK (layering), and the seam only needs this shape. */
export interface InferenceStreamResult {
  toUIMessageStream(options?: { sendReasoning?: boolean }): AsyncIterable<unknown>;
  output?: PromiseLike<unknown>;
}

async function cancelStream(stream: AsyncIterable<unknown>): Promise<void> {
  try {
    await stream[Symbol.asyncIterator]().return?.();
  } catch {
    /* already closed / locked — nothing left to stop */
  }
}

/**
 * Route a prepared default-inference result through the agent's evolved
 * scaffold. `run` carries everything `runScaffold` needs except `emit` and
 * `defaultInference`, which this seam owns.
 */
export function scaffoldInferenceTransform(opts: {
  /** The agent's current scaffold version; <= 0 means un-evolved (bootstrap). */
  currentVersion: number;
  /** The default inference result Think prepared (streamText already fired). */
  result: InferenceStreamResult;
  run: Omit<ScaffoldRunOptions, 'emit' | 'defaultInference'>;
}): InferenceStreamResult {
  const { currentVersion, result, run } = opts;
  if (currentVersion <= 0) return result;

  let delegated = false;
  return {
    toUIMessageStream: () =>
      scaffoldEventsToUIStream((emit) =>
        runScaffold({
          ...run,
          emit,
          defaultInference: () => {
            delegated = true;
            return result.toUIMessageStream();
          },
        }).finally(() => {
          if (!delegated) void cancelStream(result.toUIMessageStream());
        }),
      ),
    // Structured output (workflow turns) resolves only if the scaffold
    // delegated (the promise belongs to the default stream).
    ...(result.output ? { output: result.output } : {}),
  };
}
