import { runChat, type ChatEvent, type ChatOptions } from '../chat';
import { runWorkModeInvocation } from '../execution/work-mode';
import type { WorkMode } from '../types/turn';
import type { AgentRuntime } from '../types/agent-runtime';
import type { ModelCallSpend } from '../events/model-call';
import { scaffoldChatTransform } from '../scaffold/chat-transform';
import { assertScaffoldActive, type ScaffoldRunControl } from '../scaffold/executor';
import type { ActorTurnProgram } from './actor-program';
import { createScaffoldCallTool, createScaffoldHistory, createScaffoldLLMStream, type ScaffoldBridgeOpts } from './scaffold-host';

/** Inputs selected by the bound host. Durable program admission is a separate
 *  boundary, and `program` is what crossed it. */
export interface ActorTurnInput {
  readonly runtime: AgentRuntime;
  readonly mode: WorkMode;
  readonly task: string;
  readonly loopVersion: number;
  /** The program this turn runs, already selected and — for a claimed turn —
   *  already persisted with its source identity. Preparing it is phase one
   *  (`prepareActorProgram`); this is phase two. */
  readonly program: ActorTurnProgram;
  readonly chat: ChatOptions;
  readonly scaffoldSpend?: ModelCallSpend;
  readonly scaffoldStreamOptions?: ScaffoldBridgeOpts['streamOptions'];
  readonly assertActive?: () => void;
}

/**
 * Start the turn on an already-selected program.
 *
 * PHASE TWO of a two-phase lifecycle, and the split is the point: phase one
 * (`prepareActorProgram`) pins the selected version's immutable bytes and their
 * digest, the claim owner persists that identity, and only then does anything
 * run. Returning a prepared program and its event stream together would leave
 * the claim owner no seam to write at, and an in-memory program record is not
 * durable provenance.
 *
 * Nothing here executes yet either: `runChat` and the transform below are async
 * generators, so the turn's first effect happens on the caller's first `next()`.
 * Queueing, durable admission and terminal settlement belong to the host.
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
      history: createScaffoldHistory(() => chat.history),
    },
  }));
  return inActorMode(events, input.mode, control);
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
