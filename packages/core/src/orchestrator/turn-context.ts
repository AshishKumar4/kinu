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
 * When the caller supplies a provider counter ({@link TurnAdmission}), the
 * assembled request is counted by the PROVIDER, and a request that does not fit
 * the input allocation is compacted once — the same transform, run again with
 * trigger:'force' — and counted again. What leaves here has therefore been
 * measured, not estimated; what cannot fit after its one compaction is refused
 * here, before any provider is called. Without a counter the function returns
 * exactly what it built, which is what every provider that publishes no
 * pre-request count endpoint gets.
 */

import type { ModelMessage, ToolSet } from 'ai';
import { sanitizeAttachmentsForModel, type AttachmentPolicy } from '../prompting/attachment-sanitizer';
import { settleUnpairedToolCalls } from '../prompting/interrupted-tool-calls';
import { stepContextLimit, type ModelWindow } from '../prompting/step-prune';
import type { CountableRequest, InputTokenCount } from '../providers/input-tokens';
import type { ExtensionHost } from '../extension';
import { KinuError, diagnostics } from '../obs/index';

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
  /** Exact pre-submission admission, when the resolved provider can answer
   *  what a request costs. Omitted = no provider counter, and the assembly
   *  returns what it built, exactly as it did before admission existed. */
  admission?: TurnAdmission;
}

/**
 * The exact admission a turn's assembly runs before anything is submitted.
 *
 * `count` is the provider's own answer for the request it is handed
 * (providers/input-tokens.ts) — never a character estimate, and never
 * `contextWindow` read back as though metadata about the model measured the
 * request. `limits` names the two catalog numbers this decision divides:
 * `contextWindow` is the whole window, `modelOutputLimit` is the answer's share
 * of it, and `stepContextLimit` is the input allocation the two produce. They
 * are three distinct things and this module never substitutes one for another.
 */
export interface TurnAdmission {
  count(request: CountableRequest): Promise<InputTokenCount>;
  /** Tool definitions that ride every request of the turn — part of what the
   *  provider prices, so part of what is counted. */
  tools?: ToolSet | undefined;
  limits: ModelWindow;
}

/**
 * The refusal a turn's assembly raises when the request it built does not fit,
 * with the compaction it was entitled to already spent.
 *
 * Deliberately NOT worded as a context-length provider failure. The shared
 * turn-failure policy (turn-failure.ts) reads provider error TEXT and answers a
 * context-class failure by arming force-compaction and enqueuing one retry
 * turn — which is the right answer to a REMOTE refusal, and the wrong answer
 * here: this request was already compacted and re-counted, so a retry turn
 * would be a second forced compaction of history that just proved it cannot
 * shrink enough. The turn fails honestly instead, and
 * `unit-turn-admission.test.ts` pins the classification so the wording cannot
 * drift into the pattern list.
 */
function refuseOversizedRequest(tokens: number, limit: number): KinuError {
  return new KinuError(
    'bad_input',
    `Request refused before submission: the assembled request measures ${tokens.toLocaleString('en-US')} input tokens, ` +
    `above the ${limit.toLocaleString('en-US')}-token allocation this model's window leaves for input after its answer reserve. ` +
    'The history was compacted and re-counted, and still does not fit — nothing was sent to the provider.',
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
 * Both backends derived this by hand, in the same three steps, with the same
 * twelve lines of comment explaining why — which is the shape a policy takes
 * just before the two copies stop agreeing. Three things it owns:
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
    });
    const assembled = [...(transformed ?? history), ...(input.turnLocal ?? [])];
    return settleUnpairedToolCalls(assembled) ?? assembled;
  };

  const assembled = await assemble(input.trigger);
  const admission = input.admission;
  if (!admission) return assembled;

  const limit = stepContextLimit(admission.limits);
  const measure = async (messages: ModelMessage[]): Promise<number | null> => {
    const counted = await admission.count({
      system: input.system,
      messages,
      tools: admission.tools,
    });
    if (counted.kind === 'counted') return counted.tokens;
    // No exact count exists for this provider or this request. Reported once,
    // never approximated: a gate run on a number nobody measured would refuse
    // requests that fit and admit ones that do not.
    diagnostics.event('admission.uncounted', {
      provider: counted.provider, reason: counted.reason, sessionKey: input.sessionKey,
    });
    return null;
  };

  const tokens = await measure(assembled);
  if (tokens === null || tokens <= limit) return assembled;

  // The request does not fit. A turn assembled with trigger:'force' has already
  // spent its one forced compaction — the caller consumed an armed flag to get
  // here — so there is nothing left to try and nothing is submitted.
  if (input.trigger === 'force') throw refuseOversizedRequest(tokens, limit);

  const compacted = await assemble('force');
  const recounted = await measure(compacted);
  if (recounted !== null && recounted > limit) throw refuseOversizedRequest(recounted, limit);
  return compacted;
}
