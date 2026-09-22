import { runChat, type ChatEvent, type ChatOptions } from '../chat';
import { runWorkModeInvocation } from '../execution/work-mode';
import type { WorkMode } from '../types/turn';
import type { AgentRuntime } from '../types/agent-runtime';
import type { ModelCallSpend } from '../events/model-call';
import { scaffoldChatTransform } from '../scaffold/chat-transform';
import { assertScaffoldActive, type ScaffoldRunControl } from '../scaffold/executor';
import type { ActorTurnProgram } from './actor-program';
import { createScaffoldCallTool, createScaffoldHistory, createScaffoldLLMStream, type ScaffoldBridgeOpts } from './scaffold-host';

export interface ActorTurnInput {
  readonly runtime: AgentRuntime;
  readonly mode: WorkMode;
  readonly task: string;
  readonly loopVersion: number;
  /** Already prepared (`prepareActorProgram`) and, for a claimed turn, persisted. */
  readonly program: ActorTurnProgram;
  readonly chat: ChatOptions;
  readonly scaffoldSpend?: ModelCallSpend;
  readonly scaffoldStreamOptions?: ScaffoldBridgeOpts['streamOptions'];
  readonly assertActive?: () => void;
}

/**
 * Phase two: phase one (`prepareActorProgram`) pins the program's bytes so the claim owner can
 * persist them before anything runs. Lazy: nothing executes until the caller's first `next()`.
 */
export function startActorTurn(input: ActorTurnInput): AsyncIterable<ChatEvent> {
  const control = { signal: input.chat.signal, assertActive: input.assertActive };
  const { chat, program } = input;
  const defaultTurn = runChat(chat);

  const events = runWorkModeInvocation(input.mode, () => program.kind === 'builtin' ? defaultTurn : scaffoldChatTransform({
    program,
    chat: defaultTurn,
    run: {
      rt: input.runtime,
      workMode: input.mode,
      task: input.task,
      ...control,
      llmStream: createScaffoldLLMStream({
        model: chat.model, tools: () => chat.tools,
        streamOptions: { providerOptions: chat.providerOptions, ...input.scaffoldStreamOptions },
        ...control, spend: input.scaffoldSpend,
      }),
      callTool: createScaffoldCallTool(() => chat.tools, undefined, chat.signal, input.assertActive),
      history: createScaffoldHistory(async () => chat.history),
    },
  }));

  return inActorMode(events, input.mode, control);
}

/** AsyncLocalStorage.run around generator creation does not bind later next() calls; re-enter each one. */
async function* inActorMode(events: AsyncIterable<ChatEvent>, mode: WorkMode, control: ScaffoldRunControl): AsyncGenerator<ChatEvent> {
  assertScaffoldActive(control);
  const iterator = runWorkModeInvocation(mode, () => events[Symbol.asyncIterator]());
  const resume = () => iterator.next();

  try {
    for (;;) {
      const next = await runWorkModeInvocation(mode, resume);

      if (next.done) return;
      yield next.value;
    }
  } finally {
    await runWorkModeInvocation(mode, async () => { await iterator.return?.(); });
  }
}
