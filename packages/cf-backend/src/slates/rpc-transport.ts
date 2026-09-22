import { RpcSession, type RpcTransport } from 'capnweb';
import type { ResidentSlateProcess } from './resident';

/**
 * The transport for one HTTP-batch Cap'n Web session against a resident facet:
 * frames POST to the guest's `/__rpc` through the process handle's loopback
 * request, mirroring capnweb's own `BatchClientTransport` — one settled
 * request per batch — with the invocation id the host issued carried on
 * `x-slate-call` so the guest's bindings resolve to this call's lineage.
 */
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
    // Once the batch is drained the session's read-loop must wait forever, not
    // error out: an ended receive makes capnweb abort and re-reject every
    // import — a second, unobserved rejection for a call that already settled.
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

/** An HTTP-batch session stub for one resident process call. */
export function slateBatchStub<T>(process: Pick<ResidentSlateProcess, 'request'>, invocation: string) {
  return new RpcSession<T>(new FacetBatchTransport(process, invocation)).getRemoteMain();
}
