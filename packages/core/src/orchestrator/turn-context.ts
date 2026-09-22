/**
 * Turn-context assembly — the ONE ordering both backends run to turn a durable
 * history into the turn's initial model message array:
 *
 *   attachment sanitize → extension onTurnStart → awaited transformContext
 *   (compaction) → turn-local tail → exact pre-submission admission.
 *
 * `runChat` (the CLI's turn engine) and the cf backend's `beforeTurn` both call
 * this, so the ordering — and its invariants — cannot drift per backend:
 * sanitization is per-part in-place replacement (message COUNT never changes,
 * so downstream indices hold), and the transform sees ONLY the durable history
 * (never the turn-local tail).
 *
 * Dynamic context is deliberately NOT assembled here. Its blocks are re-read
 * and re-woven at every model step by the shared step pipeline
 * (prompting/prepare-step.ts) — the array this function returns is what the
 * ledger's frozen positions are measured against, so it must stay free of
 * them.
 *
 * The last act is the pairing invariant (prompting/interrupted-tool-calls.ts):
 * whatever the history holds, the request that leaves here has a terminal
 * result for every tool call in it. Without that, one turn interrupted between
 * a call and its result makes every LATER turn throw
 * `AI_MissingToolResultsError` inside `streamText` — the session stops being
 * usable, and no retry can change it.
 *
 * ADMISSION IS THE LAST QUESTION ASKED, and it lives here rather than in either
 * backend's turn path because it is the only place that can answer it twice.
 * The assembled request is measured — by the provider's own counter when one
 * exists ({@link TurnAdmission.count}), else by the shared estimate — and a
 * request that does not fit the input allocation is compacted once — the same
 * transform, run again with trigger:'force' — and measured again. What leaves
 * here has therefore been checked against the window; what cannot fit after
 * its one compaction is refused here, before any provider is called.
 */

import type { ModelMessage, ToolSet } from 'ai';
import { sanitizeAttachmentsForModel, type AttachmentPolicy } from '../prompting/attachment-sanitizer';
import { settleUnpairedToolCalls } from '../prompting/interrupted-tool-calls';
import { stepContextLimit, type ResolvedModelWindow } from '../prompting/step-prune';
import type { CountableRequest, InputTokenCount } from '../providers/input-tokens';
import type { ExtensionHost } from '../extension';
import { KinuError, diagnostics } from '../obs/index';
import { estimateTokens } from '../llm';

export interface TurnContextInput {
  system: string;
  /** The durable conversation history. Never mutated. */
  history: readonly ModelMessage[];
  /** Model-capability attachment policy; omitted = no sanitization pass. */
  attachments?: AttachmentPolicy;
  extensions?: ExtensionHost;
  /** Turn-local context for THIS turn only — spliced at the tail. */
  turnLocal?: readonly ModelMessage[];
  /** Session key handed to transformContext (compaction plan identity). */
  sessionKey: string;
  contextWindow: number;
  /** The previous turn's provider-priced prompt size — the measured trigger. */
  providerReportedTokens?: number;
  trigger: 'auto' | 'force';
  /** The turn's cancellation, handed to every transformContext hook. */
  abortSignal?: AbortSignal | undefined;
  /** Pre-submission admission: the provider's own counter when one exists,
   *  else the shared estimate — the gate applies either way. */
  admission?: TurnAdmission;
}

/**
 * The admission a turn's assembly runs before anything is submitted.
 *
 * `count` is the provider's own answer for the request it is handed
 * (providers/input-tokens.ts). When no count exists — absent, or answered
 * `unsupported` — the assembled request is measured by `estimateTokens`
 * instead and the gate still applies: one forced compaction, then a
 * re-measure, then a refusal. `limits` names the two catalog numbers this
 * decision divides: `contextWindow` is the whole window, `modelOutputLimit`
 * is the answer's share of it, and `stepContextLimit` is the input allocation
 * the two produce. They are three distinct things and this module never
 * substitutes one for another.
 *
 * `limits.windowMeasured` decides whether this gate may REFUSE at all. A
 * stand-in window still sizes the compaction it triggers — shrinking a history
 * costs the turn nothing it cannot recover — but a request it cannot prove too
 * large leaves here unrefused, and the provider, which knows its own window,
 * answers.
 */
export interface TurnAdmission {
  count?(request: CountableRequest): Promise<InputTokenCount>;
  /** Tool definitions that ride every request of the turn — part of what the
   *  provider prices, so part of what is measured. */
  tools?: ToolSet | undefined;
  limits: ResolvedModelWindow;
}

/**
 * The refusal a turn's assembly raises when the request it built does not fit a
 * MEASURED window, with the compaction it was entitled to already spent.
 *
 * Deliberately NOT worded as a context-length provider failure. The shared
 * turn-failure policy (turn-failure.ts) reads provider error TEXT and answers a
 * context-class failure by arming force-compaction and enqueuing one retry
 * turn — which is the right answer to a REMOTE refusal, and the wrong answer
 * here: this request was already compacted and re-measured, so a retry turn
 * would be a second forced compaction of history that just proved it cannot
 * shrink enough. `ADMISSION_REFUSAL_MARK` is what that policy matches, so the
 * refusal carries its own class — `admission_refused`, neither retried nor
 * reported as a transient blip — and `unit-turn-admission.test.ts` pins it.
 *
 * The remedy sentence is part of the message because it is the only one that
 * exists: the history cannot shrink further, so the person has to start a new
 * conversation or drop what this one is carrying.
 */
export const ADMISSION_REFUSAL_MARK = 'Request refused before submission';

function refuseOversizedRequest(tokens: number, limit: number): KinuError {
  return new KinuError(
    'bad_input',
    `${ADMISSION_REFUSAL_MARK}: the assembled request measures ${tokens.toLocaleString('en-US')} input tokens, ` +
    `above the ${limit.toLocaleString('en-US')}-token allocation this model's window leaves for input after its answer reserve. ` +
    'The history was compacted and re-measured, and still does not fit — nothing was sent to the provider. ' +
    'Start a new conversation, or remove what this one is carrying, to continue.',
  );
}

/** The read half of the durable compaction state — structural, because the
 *  concrete store lives in @kinu.run/compaction, which depends on core. */
export interface CompactionTriggerReader {
  loadPromptTokens(sessionKey: string, historyLength: number): number | null;
  takeForceCompaction(sessionKey: string): boolean;
}

/** The two trigger fields of `TurnContextInput`, measured together. */
export interface MeasuredCompactionTrigger {
  /** Absent when no completed turn has reported a prompt size against a
   *  history at least this long. */
  providerReportedTokens?: number;
  trigger: 'auto' | 'force';
}

/**
 * Read the turn's compaction trigger out of the durable state.
 *
 * One derivation, not one per backend: three steps and twelve lines of reason
 * hand-copied into two places is the shape a policy takes just before the two
 * copies stop agreeing. Three things it owns:
 *
 *  • the measurement is bound to `durableLength`, the history length at
 *    assembly time and BEFORE the turn-local tail is spliced on. A shorter
 *    history than the one measured means a rewrite (undo, restore truncation)
 *    happened, so the store reports the signal as absent rather than handing
 *    over a phantom overhead this history can no longer produce.
 *  • `takeForceCompaction` CONSUMES: at most one forced rebuild per arm, never
 *    a loop. Calling it is therefore not a query, and it happens exactly once
 *    per assembly.
 *  • a null token signal becomes an ABSENT field rather than a null one, so
 *    the estimate-only path is a missing measurement and not a zero-token one.
 */
export function measureCompactionTrigger(
  state: CompactionTriggerReader,
  sessionKey: string,
  durableLength: number,
): MeasuredCompactionTrigger {
  const lastPromptTokens = state.loadPromptTokens(sessionKey, durableLength);

  const measured: MeasuredCompactionTrigger = {
    trigger: state.takeForceCompaction(sessionKey) ? 'force' : 'auto',
  };

  if (lastPromptTokens !== null) measured.providerReportedTokens = lastPromptTokens;

  return measured;
}

export async function assembleTurnMessages(input: TurnContextInput): Promise<ModelMessage[]> {
  const history = input.attachments
    ? await sanitizeAttachmentsForModel(input.history, input.attachments)
    : input.history;

  await input.extensions?.emitTurnStart({ system: input.system, history });

  // The transform, then the tail, then the pairing invariant — one closure
  // because admission may run it a SECOND time with trigger:'force', and the
  // ordering must be the same both times. `emitTurnStart` stays outside it: a
  // turn starts once, whatever admission then decides about its size.
  const assemble = async (trigger: 'auto' | 'force'): Promise<ModelMessage[]> => {
    const transformed = await input.extensions?.runTransformContext({
      sessionKey: input.sessionKey,
      messages: history,
      system: input.system,
      contextWindow: input.contextWindow,
      providerReportedTokens: input.providerReportedTokens,
      trigger,
      abortSignal: input.abortSignal,
    });

    const assembled = [...(transformed ?? history), ...(input.turnLocal ?? [])];

    return settleUnpairedToolCalls(assembled) ?? assembled;
  };

  const assembled = await assemble(input.trigger);
  const admission = input.admission;

  if (!admission) return assembled;

  const limit = stepContextLimit(admission.limits);

  const measure = async (messages: ModelMessage[]): Promise<number> => {
    if (admission.count) {
      const counted = await admission.count({
        system: input.system,
        messages,
        tools: admission.tools,
      });

      if (counted.kind === 'counted') return counted.tokens;
      // No exact count exists for this provider or this request: reported
      // once, then the shared estimate gates — an uncounted request is
      // submitted on the estimator's answer, never ungated.
      diagnostics.event('admission.uncounted', {
        provider: counted.provider, reason: counted.reason, sessionKey: input.sessionKey,
      });
    }

    return estimateTokens(JSON.stringify({
      system: input.system, messages, tools: admission.tools,
    }).length);
  };

  const tokens = await measure(assembled);

  if (tokens <= limit) return assembled;

  // The request is over the allocation THIS window produces — and a window
  // nobody measured produces an allocation nobody can stand behind. #20 is what
  // acting on one costs: a 1M-window model whose spec matched no catalog entry
  // was sized at 128k, refused at 64,000 tokens, and had no recovery left
  // because the history was already as small as it goes. So a stand-in neither
  // refuses nor spends the turn's forced compaction on a number it invented:
  // the request leaves here and the provider, which knows its own window,
  // answers. A remote context-length refusal then arms the real recovery
  // (turn-failure.ts) against a fact instead of a guess.
  if (!admission.limits.windowMeasured) {
    diagnostics.event('admission.unmeasured_window', {
      sessionKey: input.sessionKey, tokens, limit, contextWindow: admission.limits.contextWindow,
    });

    return assembled;
  }

  // A turn assembled with trigger:'force' has already spent its one forced
  // compaction — the caller consumed an armed flag to get here — so there is
  // nothing left to try and nothing is submitted.
  if (input.trigger === 'force') throw refuseOversizedRequest(tokens, limit);

  const compacted = await assemble('force');
  const recounted = await measure(compacted);

  if (recounted > limit) throw refuseOversizedRequest(recounted, limit);

  return compacted;
}
