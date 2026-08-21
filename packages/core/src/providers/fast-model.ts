// Which model runs the agent's MECHANICAL work.
//
// Most of what the evolution engine spends tokens on is not thinking. Grading
// a turn from the user's follow-up, naming a cluster of failures, writing one
// sentence about what to do differently, turning a tool trace into a JSON tool
// definition, compressing memory in the background — these are short,
// schema-constrained jobs with a right answer that a small model reaches as
// well as a flagship. Running them on the chat model was never a decision; it
// was the absence of one, and it is why the orchestrator could describe the
// outcome classifier as "one cheap LLM classification" while it ran on
// whatever the user chats with.
//
// This is a cheaper TIER, not another provider: the pick stays inside the chat
// model's own vendor, on the same credential and the same registry path, so
// nothing new has to be connected, authorized, or paid for separately. Where a
// vendor exposes no smaller tier — or where naming one would be arbitrary,
// like an OpenRouter catalog or a user-supplied OpenAI-compatible endpoint —
// the chat model is used, exactly as before.
//
// Deliberately NOT the judge selection's problem: `selectJudgeModel` picks a
// DIFFERENT vendor family on purpose, because judging your own output has a
// bias the smaller sibling shares. This picks the SAME family on purpose,
// because cost is the only thing being optimized and a cross-vendor hop would
// need credentials the workspace may not have.

import type { ModelProvider } from './types';
import { parseModelSpec } from './types';
import { diagnostics, renderThrownChain } from '../obs/index';

export interface FastModelSelection {
  /** `<provider>/<modelId>` the mechanical calls should run on. */
  spec: string;
  /** How it was chosen. `chat-model` is reported rather than hidden: it is the
   *  honest name for "this vendor has nothing smaller", not a preference. */
  source: 'configured' | 'provider-small' | 'chat-model';
}

export interface SelectFastModelOpts {
  /** The operator's explicit `fast_model`, if any. */
  fastSpec: string | null | undefined;
  /** The resolved `<provider>/<modelId>` the agent chats with. */
  chatSpec: string;
  /** The statically-registered providers, for the chat provider's declared
   *  small tier. */
  providers: ReadonlyArray<Pick<ModelProvider, 'id' | 'fastModel'>>;
}

/**
 * Pick the model the mechanical calls run on.
 *
 *   1. An explicitly configured `fast_model` wins outright.
 *   2. Otherwise the chat model's OWN provider's declared small tier — unless
 *      the chat model already IS it, in which case there is nothing to switch.
 *   3. Otherwise the chat model. No downgrade is better than a guessed one.
 */
export function selectFastModel(opts: SelectFastModelOpts): FastModelSelection {
  const configured = opts.fastSpec?.trim();
  if (configured) return { spec: configured, source: 'configured' };

  let chat: { provider: string; modelId: string };
  try {
    chat = parseModelSpec(opts.chatSpec);
  } catch (error) {
    // parseModelSpec throws only for a malformed spec, and degrading to the raw
    // chat spec then is the pinned contract (unit-fast-model.test.ts) — say so.
    diagnostics.event('providers.fast_spec_unparseable', { error: renderThrownChain({ cause: error }) });
    return { spec: opts.chatSpec, source: 'chat-model' };
  }
  const small = opts.providers.find((p) => p.id === chat.provider)?.fastModel;
  if (!small || small === chat.modelId) return { spec: opts.chatSpec, source: 'chat-model' };
  return { spec: `${chat.provider}/${small}`, source: 'provider-small' };
}
