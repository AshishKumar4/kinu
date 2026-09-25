import { DurableObject } from 'cloudflare:workers';
import { Container } from '@cloudflare/containers';
import { codexEgressAllowed, EgressCalls } from '@kinu.run/core';
import { KinuError } from '@kinu.run/core/obs';

const TARGET_HEADER = 'x-kinu-target';

const HOP_HEADERS = ['host', 'content-length', 'connection', 'transfer-encoding'];

class EgressBox extends Container<Env> {
  defaultPort = 8080;

  sleepAfter = '5m';

  enableInternet = true;
}

// RPC: forward, cancel, alarm.
export class CodexEgress extends DurableObject<Env> {
  readonly #box: EgressBox;

  readonly #calls = new EgressCalls();

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.#box = new EgressBox(ctx, env);
  }

  async forward(ownerUserId: string, callId: string, request: Request): Promise<Response> {
    if (!this.env.CodexEgress.idFromName(ownerUserId).equals(this.ctx.id)) {
      throw new KinuError('denied', 'a Codex egress container serves only the user it is named for');
    }

    if (!codexEgressAllowed({ method: request.method, url: request.url })) {
      throw new KinuError('denied', `the Codex egress route does not carry ${request.method} ${new URL(request.url).pathname}`);
    }

    const headers = new Headers(request.headers);

    for (const name of HOP_HEADERS) headers.delete(name);
    headers.set(TARGET_HEADER, request.url);
    const box = this.#box;

    return this.#calls.run(callId, {
      start: async (signal) => { await box.startAndWaitForPorts(box.defaultPort, { abort: signal }); },
      fetch: async (signal) => box.containerFetch(new Request('http://codex-egress/forward', {
        method: request.method,
        headers,
        body: request.body,
        signal,
      })),
    });
  }

  cancel(callId: string): void {
    this.#calls.cancel(callId);
  }

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    await this.#box.alarm(alarmInfo);
  }
}
