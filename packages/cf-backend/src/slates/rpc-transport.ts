import { RpcSession, type RpcTransport } from 'capnweb';
import type { ResidentSlateProcess } from './resident';

/** Mirrors capnweb's `BatchClientTransport` over the facet's `/__rpc`; `x-slate-call` carries the invocation lineage. */
class FacetBatchTransport implements RpcTransport {
  readonly #promise: Promise<void>;
  #aborted: unknown;
  #batchToSend: string[] | null = [];
  #batchToReceive: string[] | null = null;

  constructor(
    process: Pick<ResidentSlateProcess, 'request'>,
    invocation: string,
  ) {
    this.#promise = this.#scheduleBatch(async (batch: string[]) => {
      const response = await process.request(new Request('https://slate.invalid/__rpc', {
        method: 'POST',
        headers: { 'x-slate-call': invocation, 'content-type': 'text/plain' },
        body: batch.join('\n'),
      }));

      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Slate RPC request failed: ${response.status} ${await response.text()}`);
      }

      const body = await response.text();

      return body === '' ? [] : body.split('\n');
    });
  }

  async send(message: string): Promise<void> {
    if (this.#batchToSend !== null) this.#batchToSend.push(message);
  }

  receive(): Promise<string> {
    // After draining, wait forever: an ended receive makes capnweb re-reject every import unobserved.
    if (this.#batchToReceive === null) return this.#promise.then(() => this.receive());
    const message = this.#batchToReceive.shift();

    return message === undefined ? new Promise(() => {}) : Promise.resolve(message);
  }

  abort(reason: Error): void {
    this.#aborted = reason;
  }

  async #scheduleBatch(sendBatch: (batch: string[]) => Promise<string[]>): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    if (this.#aborted !== undefined) throw this.#aborted;
    const batch = this.#batchToSend ?? [];
    this.#batchToSend = null;
    this.#batchToReceive = await sendBatch(batch);
  }
}

export function slateBatchStub<T>(process: Pick<ResidentSlateProcess, 'request'>, invocation: string) {
  return new RpcSession<T>(new FacetBatchTransport(process, invocation)).getRemoteMain();
}
