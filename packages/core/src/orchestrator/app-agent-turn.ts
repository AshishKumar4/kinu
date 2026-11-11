/**
 * One turn of a slate's app agent (slates/app-agent.ts), through the chat loop every agent's turn runs (`runChat`):
 * admission against its model's window, and compaction where its host lends the extension; the provider stack, its
 * payer's effort and fallbacks. Its one tool is the app's functions. Each step is admitted by the ask's session first,
 * and its messages are kept, and its spend told, as it ends.
 */
import { isStepCount, type ModelMessage } from 'ai';
import { runChat, type ChatOptions } from '../chat';
import type { ModelCallReport } from '../events/model-call';
import { normalizeUsage } from '../usage';
import { APP_AGENT_TOOL, appAgentTool, type AppAgentSession } from '../slates/app-agent';

/** What of the loop's options the host decides: the payer's model and its chain, the window, and its stores' extensions. */
export type AppAgentChat = Pick<ChatOptions,
  'model' | 'modelSpec' | 'modelContext' | 'fallbacks' | 'retries' | 'attemptOf' | 'countInputTokens' | 'reasoning' | 'extensions' | 'conversationKey' | 'signal'>;

export interface AppAgentTurn {
  readonly chat: AppAgentChat;
  readonly system: string;
  /** The conversation so far, and the person's message this turn answers. */
  readonly history: readonly ModelMessage[];
  readonly asked: ModelMessage;
  readonly session: AppAgentSession;
  /** Messages the turn adds to the conversation: the person's, then each step's whole, its calls with their results. */
  readonly keep: (messages: readonly ModelMessage[]) => void;
  /** The reply's text, as the model writes it. */
  readonly write: (text: string) => void;
  /** Each step's call, as its payer's account files it. */
  readonly report: (report: ModelCallReport) => void;
}

/** The most steps one ask may take: its calls are the app's functions, and whoever pays for them is not watching each. */
const APP_AGENT_STEPS = 16;

export async function runAppAgentTurn(turn: AppAgentTurn): Promise<void> {
  const { chat, session } = turn;
  let wrote = false;
  let stepped = false;
  let kept = false;

  for await (const event of runChat({
    ...chat,
    system: turn.system,
    history: [...turn.history, turn.asked],
    tools: { [APP_AGENT_TOOL]: appAgentTool(session) },
    stopWhen: isStepCount(APP_AGENT_STEPS),
    // The share it was asked on admits each step as it stands then: a revoke, a mode change or a paused day stops it.
    paceStep: async () => {
      await session.admit();

      // Kept once the share first admits it: an ask it refused leaves nothing in the conversation.
      if (!kept) turn.keep([turn.asked]);
      kept = true;

      return () => {};
    },
    onStep: async (step, messages) => {
      turn.keep(messages);
      await session.spent(normalizeUsage(step.usage));
    },
  })) {
    if (event.type === 'text-delta') {
      // A step that writes after an earlier one's words starts a paragraph of its own.
      if (stepped && wrote) turn.write('\n\n');
      stepped = false;
      wrote = true;
      turn.write(event.delta);
    }

    if (event.type === 'step-finish') {
      stepped = true;
      turn.report({
        source: 'slate', usage: event.usage ?? {}, spec: event.fallback ?? chat.modelSpec,
        ...(event.modelId !== undefined && { modelId: event.modelId }), ...(event.account !== undefined && { account: event.account }),
      });
    }
  }
}
