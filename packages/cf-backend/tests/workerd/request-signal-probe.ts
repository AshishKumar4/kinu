/**
 * An incoming request whose client goes away, on the Worker's own compatibility date and flags: the entry forwards it
 * to its Durable Object with its signal, as the terminal route forwards a desktop or terminal socket to the box, and
 * the object records whether that signal aborted (2026-10-17: without `enable_request_signal` it never did).
 */
import { DurableObject } from 'cloudflare:workers';

interface Env { readonly REQUEST_SIGNAL_PROBE: DurableObjectNamespace<RequestSignalProbeDO> }

export class RequestSignalProbeDO extends DurableObject<Env> {
  readonly #started = Promise.withResolvers<void>();
  readonly #aborted = Promise.withResolvers<void>();

  /** Resolves once a request reached the object. */
  async started(): Promise<void> { await this.#started.promise; }

  /** Resolves once that request's signal aborted. */
  async aborted(): Promise<void> { await this.#aborted.promise; }

  override async fetch(request: Request): Promise<Response> {
    request.signal.addEventListener('abort', () => { this.#aborted.resolve(); }, { once: true });
    this.#started.resolve();
    // Never answered, as a desktop check that never ends holds its caller.
    await new Promise<never>(() => {});

    return new Response(null, { status: 204 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const name = new URL(request.url).searchParams.get('name') ?? 'none';

    return await env.REQUEST_SIGNAL_PROBE.getByName(name).fetch(new Request(request));
  },
};
