/**
 * What the owner sees of a model call, read off the one reader the chat loop keeps. The SDK's `toUIMessageStream` is a
 * second branch of the call's stream, a tee and four stages more for every part; on the heap gate's 150-step turn that
 * branch cost the agent's isolate 11.5-16 MB of its 228 MB, 9 MB of it native. Each part the loop reads is turned into
 * its chunk here with the SDK's own `toUIMessageChunk`, and the observer pulls the chunks from a queue only it drains.
 */
import { toUIMessageChunk, type TextStreamPart, type ToolSet, type UIMessageChunk } from 'ai';
import { isServerCompaction } from './providers/server-compaction';

export class ChatRelay {
  readonly stream: ReadableStream<UIMessageChunk>;

  readonly #queue: UIMessageChunk[] = [];

  /** Open while undefined; null once the call's stream ended, or the failure it ended with. */
  #end: { readonly error: unknown } | null | undefined;

  #wake: (() => void) | null = null;

  /** The observer let go: nothing more is queued for it. */
  #cancelled = false;

  /** The provider's compaction summaries are for the model: the stream the owner sees leaves them out. */
  readonly #summaries = new Set<string>();

  /** `describe`: the words a failure the stream carried shows the owner. */
  constructor(private readonly options: { readonly tools: ToolSet | undefined; readonly describe: (failure: { readonly cause: unknown }) => string }) {
    this.stream = new ReadableStream<UIMessageChunk>({
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
    const chunk = toUIMessageChunk(part, { tools: this.options.tools, onError: (cause) => this.options.describe({ cause }) });

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
