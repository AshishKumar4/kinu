/**
 * The one turn-assembly ordering both backends run: sanitize → onTurnStart → transformContext
 * → pairing invariant → admission. Sanitization never changes message count; the transform sees
 * only durable history. Dynamic context and the turn-local messages stay out: the step pipeline
 * places them (prompting/prepare-step.ts), and admission measures the turn-local ones with the request.
 */

import type { ModelMessage, ToolSet } from 'ai';
import { sanitizeAttachmentsForModel, type AttachmentPolicy } from '../prompting/attachment-sanitizer';
import { settleUnpairedToolCalls } from '../prompting/interrupted-tool-calls';
import { stepContextLimit, type ResolvedModelWindow } from '../prompting/step-prune';
import { placeTurnLocal, turnInputStart } from '../prompting/volatile-context';
import type { CountableRequest, InputTokenCount } from '../providers/input-tokens';
import type { ExtensionHost } from '../extension';
import { KinuError, diagnostics } from '../obs/index';
import { ADMISSION_REFUSAL_MARK } from '../turn-failure';
import { estimateTokens } from '../llm';

export interface TurnContextInput {
  system: string;
  /** Never mutated. */
  history: readonly ModelMessage[];
  /** Omitted = no sanitization pass. */
  attachments?: AttachmentPolicy;
  extensions?: ExtensionHost;
  sessionKey: string;
  contextWindow: number;
  providerReportedTokens?: number;
  trigger: 'auto' | 'force';
  abortSignal?: AbortSignal | undefined;
  admission?: TurnAdmission;
}

/**
 * Without `count` (or on `unsupported`) the gate still applies via `estimateTokens`.
 * Only a measured window (`limits.windowMeasured`) may refuse; a stand-in only sizes compaction.
 */
export interface TurnAdmission {
  count?(request: CountableRequest): Promise<InputTokenCount>;
  /** Part of what the provider prices, so part of what is measured. */
  tools?: ToolSet | undefined;
  /** Placed per step right before the turn's input, so measured there. */
  turnLocal?: readonly ModelMessage[] | undefined;
  limits: ResolvedModelWindow;
}

/**
 * Not worded as a provider context-length failure: turn-failure.ts would retry that, and this
 * request was already compacted. Leads with {@link ADMISSION_REFUSAL_MARK}; `unit-turn-admission.test.ts` pins it.
 */
function refuseOversizedRequest(tokens: number, limit: number): KinuError {
  return new KinuError(
    'bad_input',
    `${ADMISSION_REFUSAL_MARK}: the assembled request measures ${tokens.toLocaleString('en-US')} input tokens, ` +
    `above the ${limit.toLocaleString('en-US')}-token allocation this model's window leaves for input after its answer reserve. ` +
    'The history was compacted and re-measured, and still does not fit — nothing was sent to the provider. ' +
    'Start a new conversation, or remove what this one is carrying, to continue.',
  );
}

/** Structural: the concrete store lives in @kinu.run/compaction, which depends on core. */
export interface CompactionTriggerReader {
  loadPromptTokens(sessionKey: string, historyLength: number): number | null;
  takeForceCompaction(sessionKey: string): boolean;
}

export interface MeasuredCompactionTrigger {
  providerReportedTokens?: number;
  trigger: 'auto' | 'force';
}

/**
 * `durableLength` is measured without the turn-local messages. `takeForceCompaction` consumes the
 * flag, so it runs exactly once per assembly.
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

  // One closure: admission may re-run it with trigger:'force' and the ordering must match.
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

    const assembled = [...(transformed ?? history)];

    return settleUnpairedToolCalls(assembled) ?? assembled;
  };

  const assembled = await assemble(input.trigger);
  const admission = input.admission;

  if (!admission) return assembled;

  const limit = stepContextLimit(admission.limits);

  const measure = async (assembledMessages: ModelMessage[]): Promise<number> => {
    const messages = admission.turnLocal === undefined
      ? assembledMessages
      : placeTurnLocal(assembledMessages, { at: turnInputStart(assembledMessages), messages: admission.turnLocal });

    if (admission.count) {
      const counted = await admission.count({
        system: input.system,
        messages,
        tools: admission.tools,
      });

      if (counted.kind === 'counted') return counted.tokens;
      // Uncounted requests are gated on the estimate, never ungated.
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

  // An unmeasured window neither refuses nor spends the forced compaction; the provider answers.
  if (!admission.limits.windowMeasured) {
    diagnostics.event('admission.unmeasured_window', {
      sessionKey: input.sessionKey, tokens, limit, contextWindow: admission.limits.contextWindow,
    });

    return assembled;
  }

  // trigger:'force' already spent the one forced compaction.
  if (input.trigger === 'force') throw refuseOversizedRequest(tokens, limit);

  const compacted = await assemble('force');
  const recounted = await measure(compacted);

  if (recounted > limit) throw refuseOversizedRequest(recounted, limit);

  return compacted;
}
