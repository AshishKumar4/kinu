import { Effect } from 'effect';
import { DevboxError, settle, settleSync } from './errors';

/** The container of a box on a server that runs none, as a local dev server never does (vite.config.ts): it is never
 *  running, and everything asked of it is refused in `reason`'s words, once, rather than retried. */
export class AbsentContainer implements Container {
  readonly #words: string;

  constructor(reason: string) {
    this.#words = reason;
  }

  get running(): boolean { return false; }

  get images(): Record<string, string> { return {}; }

  start(): void { return settleSync(Effect.fail(this.#refusal())); }

  signal(): void { return settleSync(Effect.fail(this.#refusal())); }

  getTcpPort(): Fetcher { return settleSync(Effect.fail(this.#refusal())); }

  monitor(): Promise<void> { return settle(Effect.fail(this.#refusal())); }

  destroy(): Promise<void> { return settle(Effect.fail(this.#refusal())); }

  setInactivityTimeout(): Promise<void> { return settle(Effect.fail(this.#refusal())); }

  interceptOutboundHttp(): Promise<void> { return settle(Effect.fail(this.#refusal())); }

  interceptAllOutboundHttp(): Promise<void> { return settle(Effect.fail(this.#refusal())); }

  interceptOutboundHttps(): Promise<void> { return settle(Effect.fail(this.#refusal())); }

  snapshotContainer(): Promise<ContainerSnapshot> { return settle(Effect.fail(this.#refusal())); }

  exec(): Promise<ExecProcess> { return settle(Effect.fail(this.#refusal())); }

  inspect(): Promise<ContainerInfo | null> { return settle(Effect.fail(this.#refusal())); }

  #refusal(): DevboxError {
    return new DevboxError('configuration', this.#words);
  }
}
