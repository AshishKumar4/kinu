/**
 * What the owner sees of a model call, read off the one reader the chat loop keeps. The SDK's `toUIMessageStream` is a
 * second branch of the call's stream, a tee and four stages more for every part; on the heap gate's 150-step turn that
 * branch cost the agent's isolate 11.5-16 MB of its 228 MB, 9 MB of it native. Each part the loop reads is turned into
 * its chunk here with the SDK's own `toUIMessageChunk`, and the observer pulls the chunks from a queue only it drains.
 */
import { toUIMessageChunk, type TextStreamPart, type ToolSet, type UIMessageChunk } from 'ai';
import { isServerCompaction } from './providers/server-compaction';
import { redactSecrets } from './safety/secret-patterns';
import { toolErrorText } from './tools/outcome';

export class ChatRelay {
  /** Settles once its observer has read to the end; at once where nothing observes the call. */
  readonly observed: Promise<void>;

  readonly #queue: UIMessageChunk[] = [];

  /** Open while undefined; null once the call's stream ended, or the failure it ended with. */
  #end: { readonly error: unknown } | null | undefined;

  #wake: (() => void) | null = null;

  /** No observer, or one that let go: nothing more is queued for it. */
  #cancelled: boolean;

  /** The provider's compaction summaries are for the model: the stream the owner sees leaves them out. */
  readonly #summaries = new Set<string>();

  /** `observe` reads the chunks, if anything observes the call; `describe`: the words a failure the stream carried shows
   *  the owner. */
  constructor(
    observe: ((chunks: ReadableStream<UIMessageChunk>) => Promise<void>) | undefined,
    private readonly options: { readonly tools: ToolSet | undefined; readonly describe: (failure: { readonly cause: unknown }) => string },
  ) {
    this.#cancelled = observe === undefined;
    this.observed = observe === undefined ? Promise.resolve() : observe(this.#chunks());
  }

  /** What the observer reads: the queue as it fills, then the end. */
  #chunks(): ReadableStream<UIMessageChunk> {
    return new ReadableStream<UIMessageChunk>({
      pull: async (controller) => {
        while (this.#queue.length === 0 && this.#end === undefined) await new Promise<void>((resolve) => { this.#wake = resolve; });
        this.#wake = null;
        const next = this.#queue.shift();

        if (next !== undefined) controller.enqueue(next);
        else if (this.#end === null) controller.close();
        else controller.error(this.#end?.error);
      },
      cancel: () => {
        this.#cancelled = true;
        this.#queue.length = 0;
      },
    }, { highWaterMark: 0 });
  }

  /** A part the loop read, as the owner sees it. */
  push(part: TextStreamPart<ToolSet>): void {
    if (this.#cancelled || this.#end !== undefined) return;

    // A tool's failure as it is stored and sent to the model (`toolErrorOutput`), so a reload shows what was shown live;
    // the owner never sees a secret it echoes. Any other failure is described.
    const chunk = toUIMessageChunk(part, {
      tools: this.options.tools,
      onError: part.type === 'tool-error' ? (cause) => redactSecrets(toolErrorText({ cause })) : (cause) => this.options.describe({ cause }),
    });

    if (chunk === undefined) return;

    if (chunk.type === 'text-start' && isServerCompaction(chunk.providerMetadata)) this.#summaries.add(chunk.id);

    if ((chunk.type === 'text-start' || chunk.type === 'text-delta' || chunk.type === 'text-end') && this.#summaries.has(chunk.id)) return;

    if (chunk.type === 'custom' && isServerCompaction(chunk.providerMetadata)) return;
    this.#queue.push(chunk);
    this.#wake?.();
  }

  /** The call's stream ended, or failed with `failure`: the observer reads what is queued, then the end. The first end
   *  stands. */
  end(failure: { readonly error: unknown } | null = null): void {
    this.#end ??= failure;
    this.#wake?.();
  }
}
