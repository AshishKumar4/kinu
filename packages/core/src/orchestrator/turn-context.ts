/**
 * Turn-context assembly — the ONE ordering both backends run to turn a durable
 * history into the model-visible message array:
 *
 *   attachment sanitize → extension onTurnStart → awaited transformContext
 *   (compaction) → ephemeral ledger weave → turn-local tail.
 *
 * `runChat` (the CLI's turn engine) and the cf backend's `beforeTurn` both call
 * this, so the ordering — and its invariants — cannot drift per backend:
 * sanitization is per-part in-place replacement (message COUNT never changes,
 * so downstream indices hold), the transform sees ONLY the durable history
 * (never a ledger block or the turn-local tail), and the weave freezes over
 * sanitized, transformed messages.
 */

import type { ModelMessage } from 'ai';
import { sanitizeAttachmentsForModel, type AttachmentPolicy } from '../prompting/attachment-sanitizer.js';
import type { EphemeralContextLedger, SystemStateContext } from '../prompting/volatile-context.js';
import type { ExtensionHost } from '../extension.js';

export interface TurnContextInput {
  system: string;
  /** The durable conversation history. Never mutated. */
  history: readonly ModelMessage[];
  /** Model-capability attachment policy; omitted = no sanitization pass. */
  attachments?: AttachmentPolicy;
  extensions?: ExtensionHost;
  /** Per-activation ephemeral system-state ledger + this turn's snapshot. */
  systemState?: { ledger: EphemeralContextLedger; context: SystemStateContext };
  /** Turn-local context for THIS turn only — spliced after the weave. */
  turnLocal?: readonly ModelMessage[];
  /** Session key handed to transformContext (compaction plan identity). */
  sessionKey: string;
  contextWindow: number;
  /** The previous turn's provider-priced prompt size — the measured trigger. */
  providerReportedTokens?: number;
  trigger: 'auto' | 'force';
}

export async function assembleTurnMessages(input: TurnContextInput): Promise<ModelMessage[]> {
  const history = input.attachments
    ? await sanitizeAttachmentsForModel(input.history, input.attachments)
    : input.history;

  await input.extensions?.emitTurnStart({ system: input.system, history });

  const transformed = await input.extensions?.runTransformContext({
    sessionKey: input.sessionKey,
    messages: history,
    system: input.system,
    contextWindow: input.contextWindow,
    ...(input.providerReportedTokens !== undefined
      ? { providerReportedTokens: input.providerReportedTokens }
      : {}),
    trigger: input.trigger,
  });
  const durable = transformed ?? history;

  const woven = input.systemState
    ? input.systemState.ledger.weave(durable, input.systemState.context)
    : durable;
  return [...woven, ...(input.turnLocal ?? [])];
}
