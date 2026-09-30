import { WorkerEntrypoint } from 'cloudflare:workers';
import { createHash } from 'node:crypto';
import { SandboxFileError, S3Mounts, type Files, type S3MountRequest, type S3GatewayBinding } from '@cloudflare/sandbox';
import * as v from 'valibot';
import { Effect, Result } from 'effect';
import { DevboxError, attempt, attemptSync, settle } from './errors';
import { CHAIN_STORE_MOUNT, STORE_PUBLISH_ROUTE, storeRouteHost } from './snapshot-chain';
import type { Devbox } from './devbox';
import type { GatewayBindings } from './contracts';
import type { DevboxStore } from './storage';
import { createResourceLane } from './lifecycle';
import { DEVBOX_SYNC_HOST } from './sync';
import { storeSource } from './store-gateway';

export interface SyncGatewayProps {
  readonly binding: string;
  readonly id: string;
}

/** Native outbound routing keeps checkpoint bytes off the owner object; only this control
 *  endpoint reaches the DO. Its props are set by the DO, never by a guest request. */
export class DevboxSyncGateway extends WorkerEntrypoint<Record<string, DurableObjectNamespace<Devbox>>, SyncGatewayProps> {
  override fetch(request: Request): Promise<Response> {
    return settle(Effect.gen({ self: this }, function* () {
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/sync') return new Response('POST /v1/sync only', { status: 405 });
      const namespace = this.env[this.ctx.props.binding];

      if (namespace === undefined) return yield* Effect.fail(new DevboxError('configuration', `devbox namespace ${this.ctx.props.binding} is not configured`));
      const body = yield* attempt('invalid-input', () => request.text());
      const reply = yield* attempt('io', () => namespace.get(namespace.idFromString(this.ctx.props.id)).devboxSync(body));

      return new Response(reply.body, { status: reply.status, headers: { 'content-type': 'application/json' } });
    }));
  }
}

export interface OutboundPolicy {
  readonly routes: Record<string, Fetcher>;
  readonly fallback?: Fetcher;
}

export interface OutboundProps extends OutboundPolicy { readonly internet: boolean; }

/** Exact routes precede the host policy. Native interception registration order cannot express
 *  that when S3Mounts adds or replaces a route after the catch-all (D38). */
export class DevboxOutbound extends WorkerEntrypoint<{}, OutboundProps> {
  override fetch(request: Request): Promise<Response> {
    return settle(Effect.gen({ self: this }, function* () {
      const route = this.ctx.props.routes[new URL(request.url).hostname] ?? this.ctx.props.fallback;

      if (route !== undefined) return yield* attempt('io', () => route.fetch(request));

      return this.ctx.props.internet ? yield* attempt('io', () => fetch(request)) : new Response("container egress is not configured", { status: 403 });
    }));
  }
}

// @cloudflare/sandbox 1.0.0-rc.1, sandbox-tools/s3_mount/marker_store.rs:100-112.
// This reads the SDK's authoritative file, never a mirrored registration. D40 and the upstream
// ask record this internal-format coupling; replace this read when the SDK exposes registrations.
const SDK_STORE_MARKER = '/run/sandbox/s3-mounts/markers/'
  + createHash('sha256').update(CHAIN_STORE_MOUNT).digest('hex') + '.json';

const Marker = v.object({
  protocolVersion: v.literal(1),
  routeId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,58}[A-Za-z0-9])?$/)),
  mountPath: v.literal(CHAIN_STORE_MOUNT),
  configuration: v.object({
    source: v.object({ type: v.literal('s3'), endpoint: v.string(), region: v.string(), bucket: v.string() }),
    keyPrefix: v.string(), access: v.literal('read-write'),
  }),
});

function restoredStoreRoute(files: Pick<Files, 'readFile'>, source: S3MountRequest['source'], prefix: string, gateway: S3GatewayBinding): Effect.Effect<Readonly<{ hostname: string; handler: Fetcher }>, DevboxError> {
  return Effect.gen(function* () {
    const read = yield* Effect.result(attempt('mount-marker', () => files.readFile(SDK_STORE_MARKER)));

    if (Result.isFailure(read)) {
      const cause = read.failure.cause;
      const detail = SandboxFileError.is(cause) && cause.code === 'ENOENT' ? 'missing' : 'could not be read';

      return yield* Effect.fail(new DevboxError('mount-marker', 'S3Mounts marker ' + detail + ' for ' + CHAIN_STORE_MOUNT + '; routing cannot be rebuilt', { cause }));
    }

    const value = yield* attempt('mount-marker', () => read.success.json(), 'S3Mounts marker JSON not understood');
    const version = v.safeParse(v.object({ protocolVersion: v.unknown() }), value);

    if (!version.success || version.output.protocolVersion !== 1) {
      return yield* Effect.fail(new DevboxError('mount-marker', 'S3Mounts marker protocol ' + String(version.success ? version.output.protocolVersion : 'missing') + ' not understood'));
    }

    const marker = v.safeParse(Marker, value);

    if (!marker.success) return yield* Effect.fail(new DevboxError('mount-marker', 'S3Mounts marker registration not understood for ' + CHAIN_STORE_MOUNT));
    const registered = marker.output.configuration;
    const sameEndpoint = yield* attemptSync('mount-marker', () => new URL(registered.source.endpoint).href === new URL(source.endpoint).href, 'S3Mounts marker endpoint not understood');

    if (!sameEndpoint || registered.source.region !== source.region || registered.source.bucket !== source.bucket || registered.keyPrefix !== prefix) {
      return yield* Effect.fail(new DevboxError('mount-marker', 'S3Mounts marker registration does not match this devbox store'));
    }

    return {
      hostname: storeRouteHost(marker.output.routeId),
      handler: gateway({ props: { protocolVersion: 1, mode: 'active', routeId: marker.output.routeId, source, keyPrefix: prefix, access: registered.access } }),
    };
  });
}

const ROUTE_SCOPE = [{ path: 'gateway:outbound', subtree: false }] as const;

/** One box's container and what its routes are built from. */
export interface RouteHost {
  readonly container: Container;
  readonly bindings: GatewayBindings;
  readonly files: Pick<Files, 'readFile'>;
  readonly prefix: string;
  readonly owner: SyncGatewayProps;
  readonly internet: boolean;
}

/** Owns the complete routing table; SDK mount callbacks serialize with host-policy changes. */
export class ContainerRoutes {
  readonly #writes = createResourceLane();
  #routes: Record<string, Fetcher> = {};
  #fallback: Fetcher | undefined;
  #source: S3MountRequest['source'] | undefined;
  #mountClient: S3Mounts | undefined;

  constructor(readonly host: RouteHost) {}

  configure(policy: OutboundPolicy, store: Pick<DevboxStore, 'binding'> | undefined, reused: boolean): Promise<void> {
    return this.#writes.run(ROUTE_SCOPE, () => settle(Effect.gen({ self: this }, function* () {
      const routes = { ...policy.routes };
      const source = store === undefined ? undefined : storeSource(store.binding);

      if (source !== undefined) {
        const gateway = yield* this.#gateway();
        const sync = this.host.bindings.DevboxSyncGateway;

        if (sync === undefined) return yield* Effect.fail(new DevboxError('configuration', 'export DevboxSyncGateway from the Worker'));

        if (reused) {
          const mount = yield* restoredStoreRoute(this.host.files, source, this.host.prefix, gateway);
          routes[mount.hostname] = mount.handler;
        }

        routes[DEVBOX_SYNC_HOST] = sync({ props: this.host.owner });
        routes[storeRouteHost(STORE_PUBLISH_ROUTE)] = gateway({ props: {
          protocolVersion: 1, mode: 'active', routeId: STORE_PUBLISH_ROUTE, source, keyPrefix: this.host.prefix, access: 'read-write',
        } });
      }

      this.#routes = routes;
      this.#fallback = policy.fallback;
      this.#source = source;
      yield* this.#install();
    })));
  }

  register(host: string, handler: Fetcher): Promise<void> {
    return this.#writes.run(ROUTE_SCOPE, () => settle(Effect.gen({ self: this }, function* () {
      this.#routes[host] = handler;
      yield* this.#install();
    })));
  }

  mount(path: string): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      const source = this.#source;

      if (source === undefined) return yield* Effect.fail(new DevboxError('configuration', 'this devbox has no store to mount'));
      const mounts = yield* this.#mounts();
      yield* attempt('io', () => mounts.mount({ mountPath: path, source, keyPrefix: this.host.prefix, access: 'read-write',
        s3fsOptions: { connect_timeout: 10, readwrite_timeout: 30, retries: 3 } }));
    }));
  }

  unmount(path: string): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      const mounts = yield* this.#mounts();
      yield* attempt('io', () => mounts.unmount(path));
    }));
  }

  #gateway(): Effect.Effect<S3GatewayBinding, DevboxError> {
    const gateway = this.host.bindings.DevboxStoreGateway;

    return gateway === undefined ? Effect.fail(new DevboxError('configuration', 'export DevboxStoreGateway from the Worker')) : Effect.succeed(gateway);
  }

  #mounts(): Effect.Effect<S3Mounts, DevboxError> {
    return this.#gateway().pipe(Effect.map((gateway) => this.#mountClient ??= new S3Mounts({
      exec: (args, options) => this.host.container.exec(args, options),
      interceptOutboundHttp: (host, handler) => this.register(host, handler),
    }, gateway)));
  }

  #install(): Effect.Effect<void, DevboxError> {
    return Effect.gen({ self: this }, function* () {
      const binding = this.host.bindings.DevboxOutbound;

      if (binding === undefined) return yield* Effect.fail(new DevboxError('configuration', 'export DevboxOutbound from the Worker'));
      const router = binding({ props: { routes: { ...this.#routes }, fallback: this.#fallback, internet: this.host.internet } });
      yield* attempt('io', () => this.host.container.interceptAllOutboundHttp(router));
      yield* attempt('io', () => this.host.container.interceptOutboundHttps('*', router));
    });
  }
}

