/**
 * The one turn-assembly ordering both backends run: sanitize → onTurnStart → transformContext
 * → pairing invariant → admission. Sanitization never changes message count; the transform sees
 * only durable history. Dynamic context stays out: the step pipeline weaves it (prompting/prepare-step.ts), and
 * admission measures the unapproved instructions with the request.
 */

import { Effect } from 'effect';
import { settle } from '../obs/effect';
import type { ModelMessage, ToolSet } from 'ai';
import { sanitizeAttachmentsForModel, type AttachmentPolicy } from '../prompting/attachment-sanitizer';
import { settleUnpairedToolCalls } from '../prompting/interrupted-tool-calls';
import type { LostToolCall } from '../tools/effect-claim';
import type { LostCallQuery } from '../prompting/interrupted-tool-calls';
import { stepContextLimit, type ModelWindow } from '../context-window';
import { turnInputStart } from '../prompting/volatile-context';
import type { CountableRequest, InputTokenCount } from '../providers/input-tokens';
import type { CompactionTrigger, ExtensionHost } from '../extension';
import { KinuError, diagnostics } from '../obs/index';
import { ADMISSION_REFUSAL_MARK } from '../turn-failure';
import { estimateTokens } from '../token-estimate';
import { messageTokens } from '../prompting/media-tokens';

export interface TurnContextInput {
  system: string;
  /** Never mutated. */
  history: readonly ModelMessage[];
  /** The turn's input in `history`, when its identity is known. */
  turnStart?: number | undefined;
  /** Omitted = no sanitization pass. */
  attachments?: AttachmentPolicy;
  extensions?: ExtensionHost;
  sessionKey: string;
  /** Null when unknown: nothing compacts by size. */
  contextWindow: number | null;
  /** The model the request is built for. */
  model: string;
  providerReportedTokens?: number;
  trigger: CompactionTrigger;
  abortSignal?: AbortSignal | undefined;
  admission?: TurnAdmission;
  lostToolCall?: ((call: LostCallQuery) => LostToolCall | null) | undefined;
}

export interface AssembledTurn {
  readonly messages: ModelMessage[];
  readonly turnStart: number;
  readonly admittedTokens?: number;
}

/**
 * Without `count` (or on `unsupported`) the gate still applies via the estimate, its media priced ({@link messageTokens}).
 * An unknown window leaves the limit unbounded, so only a known one refuses.
 */
export interface TurnAdmission {
  count?(request: CountableRequest): Promise<InputTokenCount>;
  /** Part of what the provider prices, so part of what is measured. */
  tools?: ToolSet | undefined;
  /** The unapproved instructions message the step pipeline weaves in. */
  instructions?: string | null | undefined;
  /** The turn's `/name` skill bodies the step pipeline splices before the input. */
  activated?: string | null | undefined;
  limits: ModelWindow;
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
    'The history was compacted and re-measured, and still does not fit: nothing was sent to the provider. ' +
    'Start a new conversation, or remove what this one is carrying, to continue.',
  );
}

/** Structural: the concrete store lives in @kinu.run/compaction, which depends on core. */
export interface CompactionTriggerReader {
  loadPromptTokens(sessionKey: string, historyLength: number): number | null;
  takeArmedCompaction(sessionKey: string): boolean;
}

export interface MeasuredCompactionTrigger {
  providerReportedTokens?: number;
  trigger: CompactionTrigger;
}

/** `durableLength` is measured without runtime context. `takeArmedCompaction` consumes the arm, so it runs
 *  exactly once per assembly. */
export function measureCompactionTrigger(
  state: CompactionTriggerReader,
  sessionKey: string,
  durableLength: number,
): MeasuredCompactionTrigger {
  const lastPromptTokens = state.loadPromptTokens(sessionKey, durableLength);

  const measured: MeasuredCompactionTrigger = {
    trigger: state.takeArmedCompaction(sessionKey) ? 'force' : 'auto',
  };

  if (lastPromptTokens !== null) measured.providerReportedTokens = lastPromptTokens;

  return measured;
}

export function assembleTurnMessages(input: TurnContextInput): Promise<AssembledTurn> {
  return settle(Effect.gen(function* () {
    const attachments = input.attachments;

    const history = attachments
      ? (yield* Effect.promise(() => sanitizeAttachmentsForModel(input.history, attachments)))
      : input.history;

    // Sanitizing keeps indices and a transform keeps untouched messages, so the input is found by reference.
    const opening = input.turnStart === undefined ? undefined : history[input.turnStart];

    const located = (messages: ModelMessage[]): AssembledTurn => {
      const at = opening === undefined ? -1 : messages.indexOf(opening);

      return { messages, turnStart: at < 0 ? turnInputStart(messages) : at };
    };

    yield* Effect.promise(async () => input.extensions?.emitTurnStart({ system: input.system, history }));

    // One closure: admission may re-run it with trigger:'force' and the ordering must match.
    const assemble = async (trigger: CompactionTrigger): Promise<AssembledTurn> => {
      const transformed = await input.extensions?.runTransformContext({
        sessionKey: input.sessionKey,
        messages: history,
        system: input.system,
        contextWindow: input.contextWindow,
        model: input.model,
        providerReportedTokens: input.providerReportedTokens,
        trigger,
        abortSignal: input.abortSignal,
      });

      const assembled = [...(transformed ?? history)];

      return located(settleUnpairedToolCalls(assembled, input.lostToolCall) ?? assembled);
    };

    const assembled = yield* Effect.promise(() => assemble(input.trigger));
    const admission = input.admission;

    if (!admission) return assembled;

    const limit = stepContextLimit(admission.limits);

    const measure = async (turn: AssembledTurn): Promise<number> => {
      const extra = [admission.instructions, admission.activated].flatMap((content) => content === null || content === undefined ? [] : [{ role: 'user' as const, content }]);
      const messages = [...turn.messages, ...extra];

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

      // Priced for the model it is built for, as the compaction ladder prices it: an image by its size, not its base64.
      return estimateTokens(JSON.stringify({ system: input.system, tools: admission.tools }).length) + messageTokens(input.model, messages);
    };

    const tokens = yield* Effect.promise(() => measure(assembled));

    if (tokens <= limit) return { ...assembled, admittedTokens: tokens };

    // An armed compaction already rewrote this assembly.
    if (input.trigger !== 'auto') return yield* Effect.die(refuseOversizedRequest(tokens, limit));

    const compacted = yield* Effect.promise(() => assemble('force'));
    const recounted = yield* Effect.promise(() => measure(compacted));

    if (recounted > limit) return yield* Effect.die(refuseOversizedRequest(recounted, limit));

    return { ...compacted, admittedTokens: recounted };
  }));
}
