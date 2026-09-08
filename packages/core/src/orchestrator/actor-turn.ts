import { runChat, type ChatEvent, type ChatOptions } from '../chat';
import { KinuError } from '../obs/error';
import { runWorkModeInvocation } from '../execution/work-mode';
import type { WorkMode } from '../prompting/surface';
import type { AgentRuntime } from '../types/agent-runtime';
import type { ModelCallSpend } from '../events/model-call';
import { scaffoldChatTransform } from '../scaffold/chat-transform';
import { readVersionedScaffoldSource } from '../scaffold/shadow';
import { sha256Hex } from '../safety/argument-digest';
import { createScaffoldCallTool, createScaffoldHistory, createScaffoldLLMStream, type ScaffoldBridgeOpts } from './scaffold-host';

/** Selected entry source, not a snapshot of imports or environment data.
 * A scaffold digest is full SHA-256 of source; builtin identity needs the
 * host's real installed-build provenance rather than fabricated source bytes. */
export type ActorTurnProgram =
  | { readonly kind: 'builtin'; readonly version: 0 }
  | { readonly kind: 'scaffold'; readonly version: number; readonly source: string; readonly digest: string };
const BUILTIN_PROGRAM: ActorTurnProgram = Object.freeze({ kind: 'builtin', version: 0 });

/** Inputs selected by the bound host. Durable program admission is a separate boundary. */
export interface ActorTurnInput {
  readonly runtime: AgentRuntime;
  readonly mode: WorkMode;
  readonly task: string;
  readonly loopVersion: number;
  readonly chat: ChatOptions;
  readonly scaffoldSpend?: ModelCallSpend;
  readonly scaffoldStreamOptions?: ScaffoldBridgeOpts['streamOptions'];
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
  input.chat.signal?.throwIfAborted();
  let program: ActorTurnProgram = BUILTIN_PROGRAM;
  if (input.mode !== 'plan' && input.loopVersion > 0) {
    const source = await readVersionedScaffoldSource(input.runtime, input.loopVersion);
    input.chat.signal?.throwIfAborted();
    if (source === null) throw new KinuError('missing', 'scaffold version ' + input.loopVersion + ' has no source');
    program = Object.freeze({ kind: 'scaffold', version: input.loopVersion, source, digest: sha256Hex(source) });
  }
  const { chat } = input;
  const defaultTurn = runChat(chat);
  const events = runWorkModeInvocation(input.mode, () => program.kind === 'builtin' ? defaultTurn : scaffoldChatTransform({
    currentVersion: program.version,
    chat: defaultTurn,
    run: {
      rt: input.runtime,
      workMode: input.mode,
      task: input.task,
      scaffoldCodeOverride: program.source,
      llmStream: createScaffoldLLMStream({
        model: chat.model, tools: () => chat.tools,
        streamOptions: { providerOptions: chat.providerOptions, ...input.scaffoldStreamOptions },
        signal: chat.signal, spend: input.scaffoldSpend,
      }),
      callTool: createScaffoldCallTool(() => chat.tools, undefined, chat.signal),
      history: createScaffoldHistory(() => chat.history),
    },
  }));
  return { program, events: inActorMode(events, input.mode) };
}

/** Enter the actor's immutable mode for each generator continuation, including
 * cleanup. Creating an async generator inside an AsyncLocalStorage.run alone
 * does not bind the work that its later next() calls start. */
async function* inActorMode(events: AsyncIterable<ChatEvent>, mode: WorkMode): AsyncGenerator<ChatEvent> {
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
