import { runChat, type ChatEvent, type ChatOptions } from '../chat';
import { runWorkModeInvocation } from '../execution/work-mode';
import type { WorkMode } from '../prompting/surface';
import type { AgentRuntime } from '../types/agent-runtime';
import type { ModelCallSpend } from '../events/model-call';
import { scaffoldChatTransform } from '../scaffold/chat-transform';
import { assertScaffoldActive, type ScaffoldRunControl } from '../scaffold/executor';
import { prepareActorProgram, type ActorTurnProgram } from './actor-program';
import { createScaffoldCallTool, createScaffoldHistory, createScaffoldLLMStream, type ScaffoldBridgeOpts } from './scaffold-host';

/** Inputs selected by the bound host. Durable program admission is a separate boundary. */
export interface ActorTurnInput {
  readonly runtime: AgentRuntime;
  readonly mode: WorkMode;
  readonly task: string;
  readonly loopVersion: number;
  readonly chat: ChatOptions;
  readonly scaffoldSpend?: ModelCallSpend;
  readonly scaffoldStreamOptions?: ScaffoldBridgeOpts['streamOptions'];
  readonly assertActive?: () => void;
}

/** The claim owner must persist the program identity and retain its source
 * before consuming events. Preparing or returning this value is not durable admission. */
export interface PreparedActorTurn {
  readonly program: ActorTurnProgram;
  readonly events: AsyncIterable<ChatEvent>;
}

/** Capture the selected version's bytes before any code executes. The builtin
 * turn stays lazy, so a promoted loop that never delegates makes no default
 * model call. Queueing, durable admission and terminal settlement belong to the host. */
export async function prepareActorTurn(input: ActorTurnInput): Promise<PreparedActorTurn> {
  const control = { signal: input.chat.signal, assertActive: input.assertActive };
  const program = await prepareActorProgram({ ...control, runtime: input.runtime, mode: input.mode, version: input.loopVersion });
  const { chat } = input;
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
      history: createScaffoldHistory(() => chat.history),
    },
  }));
  return { program, events: inActorMode(events, input.mode, control) };
}

/** Enter the actor's immutable mode for each generator continuation, including
 * cleanup. Creating an async generator inside an AsyncLocalStorage.run alone
 * does not bind the work that its later next() calls start. */
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
