import { DurableObject } from 'cloudflare:workers';
import { Effect } from 'effect';
import { codexEgressAllowed, EgressCalls } from '@kinu.run/core';
import { KinuError, attempt, settle } from '@kinu.run/core/obs';

const TARGET_HEADER = 'x-kinu-target';

const HOP_HEADERS = ['host', 'content-length', 'connection', 'transfer-encoding'];

const PORT_READY = `const net = require('node:net');
function probe() {
  const socket = net.connect(8080, '127.0.0.1');
  socket.once('connect', () => { socket.end(); process.exit(0); });
  socket.once('error', error => {
    socket.destroy();
    if (error.code !== 'ECONNREFUSED') throw error;
    setTimeout(probe, 100);
  });
}
probe();`;

// RPC: forward, cancel.
export class CodexEgress extends DurableObject<Env> {
  readonly #calls = new EgressCalls();


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
    const container = this.ctx.container;

    if (container === undefined) return settle(Effect.fail(new KinuError('unavailable', 'Codex has no container binding')));

    return this.#calls.run(callId, {
      start: (signal) => settle(Effect.gen(function* () {
        const output = yield* attempt({ doing: 'starting the native Codex egress server', otherwise: 'unavailable' }, async () => {
          if (!container.running) container.start({ enableInternet: true });
          await container.setInactivityTimeout(5 * 60_000);

          return await (await container.exec(['node', '-e', PORT_READY], { signal })).output();
        });

        if (output.exitCode !== 0) return yield* Effect.fail(new KinuError('unavailable', new TextDecoder().decode(output.stderr) || `Codex readiness exited ${output.exitCode}`));
      }), { signal }),
      fetch: async (signal) => container.getTcpPort(8080).fetch(new Request('http://codex-egress/forward', {
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

}
