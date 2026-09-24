/**
 * Devbox on its own (DBX-9): a machine that stays, on Cloudflare Containers, with no Kinu code. A
 * consumer writes one class and a router, and this file is that consumer. It imports only the
 * package's public entry, which a consumer outside this repository names `@kinu.run/devbox`.
 * `scripts/bench-devbox-standalone.ts` deploys it and runs its acceptance.
 */
import * as v from 'valibot';
import { Devbox, devboxSyncHandlers, type DevboxStore } from '../src/index';

export { ContainerProxy } from '@cloudflare/sandbox';

interface Env {
  readonly Box: DurableObjectNamespace<ExampleBox>;
  readonly WORKSPACES: R2Bucket;
  /** Supplied per deploy with `--var`; while it is absent every request is refused. */
  readonly EXAMPLE_TOKEN?: string;
}

export class ExampleBox extends Devbox<Env> {
  protected override get store(): DevboxStore {
    return { binding: 'WORKSPACES', bucket: this.env.WORKSPACES };
  }
}

// The container's own sync reaches its box through this handler (D30); the registry is keyed by
// class name, so each concrete class registers its own.
ExampleBox.outboundHandlers = devboxSyncHandlers((env: Env) => env.Box);

const BodySchema = v.object({
  command: v.optional(v.string()),
  path: v.optional(v.string()),
  content: v.optional(v.string()),
});

function required(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`${name} is required`);

  return value;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (env.EXAMPLE_TOKEN === undefined || request.headers.get('authorization') !== `Bearer ${env.EXAMPLE_TOKEN}`) {
      return new Response('unauthorized', { status: 401 });
    }

    const url = new URL(request.url);

    if (url.pathname === '/health') return Response.json({ ok: true });
    const box = env.Box.get(env.Box.idFromName(url.searchParams.get('box') ?? 'example'));
    const body = request.method === 'POST' ? v.parse(BodySchema, await request.json()) : {};

    switch (`${request.method} ${url.pathname}`) {
      case 'POST /start':
        await box.kickStartup();

        return Response.json({ ok: true });
      case 'GET /state':
        return Response.json(await box.devboxState());
      case 'POST /exec':
        return Response.json(await box.exec(required(body.command, 'command')));
      case 'POST /write':
        await box.writeFile(required(body.path, 'path'), body.content ?? '');

        return Response.json({ ok: true });
      case 'POST /read':
        return Response.json(await box.readFile(required(body.path, 'path')));
      case 'POST /supervise':
        return Response.json(await box.startSupervised(required(body.command, 'command')));
      case 'GET /supervised':
        return Response.json(await box.listSupervised());
      case 'POST /stop':
        return Response.json(await box.quiesce());
      case 'POST /delete':
        await box.discardState();
        await box.destroy();

        return Response.json({ ok: true });
      default:
        return new Response(`no route for ${request.method} ${url.pathname}`, { status: 404 });
    }
  },
} satisfies ExportedHandler<Env>;
