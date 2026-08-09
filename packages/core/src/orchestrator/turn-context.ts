/**
 * Turn-context assembly — the ONE ordering both backends run to turn a durable
 * history into the turn's initial model message array:
 *
 *   attachment sanitize → extension onTurnStart → awaited transformContext
 *   (compaction) → turn-local tail.
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
 */

import type { ModelMessage } from 'ai';
import { sanitizeAttachmentsForModel, type AttachmentPolicy } from '../prompting/attachment-sanitizer.js';
import type { ExtensionHost } from '../extension.js';

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

  return [...(transformed ?? history), ...(input.turnLocal ?? [])];
}
