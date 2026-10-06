import { WorkerEntrypoint } from 'cloudflare:workers';
import { createHash } from 'node:crypto';
import { SandboxFileError, S3Mount, type Files, type S3MountRequest, type S3GatewayBinding } from '@cloudflare/sandbox';
import * as v from 'valibot';
import { Effect, Result } from 'effect';
import { DevboxError, attempt, attemptSync, settle } from './errors';
import { TRUST } from './processes';
import type { GatewayBindings } from './contracts';
import type { DevboxStore } from './storage';
import { createResourceLane } from './operation-lanes';
import { STORE_MOUNT as CHAIN_STORE_MOUNT, STORE_PUBLISH_ROUTE, storeRouteHost, storeSource } from './store-gateway';

export interface OutboundPolicy {
  readonly routes: Record<string, Fetcher>;
  readonly fallback?: Fetcher;
}

export interface OutboundProps extends OutboundPolicy { readonly internet: boolean; }

/** Exact routes precede the host policy. Native interception registration order cannot express
 *  that when S3Mount adds or replaces a route after the catch-all (D38). */
export class DevboxOutbound extends WorkerEntrypoint<{}, OutboundProps> {
  override fetch(request: Request): Promise<Response> {
    return settle(Effect.gen({ self: this }, function* () {
      const route = this.ctx.props.routes[new URL(request.url).hostname] ?? this.ctx.props.fallback;

      if (route !== undefined) return yield* attempt('io', () => route.fetch(request));

      return this.ctx.props.internet ? yield* attempt('io', () => fetch(request)) : new Response("container egress is not configured", { status: 403 });
    }));
  }
}

// @cloudflare/sandbox 1.0.0, sandbox-tools/s3_mount/marker_store.rs:100-104.
// D40 and the upstream ask record this internal-format coupling; replace this read when the SDK
// exposes registrations.
const SDK_STORE_MARKER = '/run/sandbox/s3-mounts/markers/'
  + createHash('sha256').update(CHAIN_STORE_MOUNT).digest('hex') + '.json';

const Marker = v.object({
  protocolVersion: v.literal(1),
  routeId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,58}[A-Za-z0-9])?$/)),
  mountPath: v.literal(CHAIN_STORE_MOUNT),
  configuration: v.object({
    source: v.object({ type: v.literal('s3'), endpoint: v.string(), region: v.string(), bucket: v.string() }),
    // The shim omits an absent prefix (`model.rs:45`); only a mount made before D46 names one.
    keyPrefix: v.optional(v.string()), access: v.literal('read-write'),
  }),
});

/** The SDK's two views of what the container holds at the store path. */
interface StorePath {
  readonly files: Pick<Files, 'readFile'>;
  readonly mounts: Pick<S3Mount, 'inspect'>;
}

/** `undefined`: nothing is mounted, so the next mount registers its own route. `mount-marker` is
 *  terminal (D47), so only the container's answer about the marker carries it. */
function restoredStoreRoute(at: StorePath, source: S3MountRequest['source'], prefix: string, gateway: S3GatewayBinding): Effect.Effect<Readonly<{ hostname: string; handler: Fetcher }> | undefined, DevboxError> {
  return Effect.gen(function* () {
    const read = yield* Effect.result(attempt('io', () => at.files.readFile(SDK_STORE_MARKER)));

    if (Result.isFailure(read)) {
      const cause = read.failure.cause;

      if (!SandboxFileError.is(cause)) return yield* Effect.fail(read.failure);

      if (cause.code !== 'ENOENT') {
        return yield* Effect.fail(new DevboxError('mount-marker', 'S3Mount marker could not be read for ' + CHAIN_STORE_MOUNT + '; routing cannot be rebuilt', { cause }));
      }

      // Without a marker the SDK's own inspection says whether anything is mounted there.
      const inspected = yield* attempt('io', () => at.mounts.inspect(CHAIN_STORE_MOUNT), 'S3Mount could not inspect ' + CHAIN_STORE_MOUNT);

      if (inspected.attachment.status === 'absent') return undefined;

      return yield* Effect.fail(new DevboxError('mount-marker', 'S3Mount marker missing for ' + CHAIN_STORE_MOUNT + ', which is ' + inspected.attachment.status + '; routing cannot be rebuilt', { cause }));
    }

    const text = yield* attempt('io', () => read.success.text(), 'S3Mount marker could not be read');
    const json = v.safeParse(v.pipe(v.string(), v.parseJson()), text);

    if (!json.success) return yield* Effect.fail(new DevboxError('mount-marker', 'S3Mount marker JSON not understood'));
    const value = json.output;
    const version = v.safeParse(v.object({ protocolVersion: v.unknown() }), value);

    if (!version.success || version.output.protocolVersion !== 1) {
      return yield* Effect.fail(new DevboxError('mount-marker', 'S3Mount marker protocol ' + String(version.success ? version.output.protocolVersion : 'missing') + ' not understood'));
    }

    const marker = v.safeParse(Marker, value);

    if (!marker.success) return yield* Effect.fail(new DevboxError('mount-marker', 'S3Mount marker registration not understood for ' + CHAIN_STORE_MOUNT));
    const registered = marker.output.configuration;
    const sameEndpoint = yield* attemptSync('mount-marker', () => new URL(registered.source.endpoint).href === new URL(source.endpoint).href, 'S3Mount marker endpoint not understood');

    // A mount made at a key prefix (before D46) sends full keys, which a rooted route would prefix twice.
    if (!sameEndpoint || registered.source.region !== source.region || registered.source.bucket !== source.bucket || registered.keyPrefix !== undefined) {
      return yield* Effect.fail(new DevboxError('mount-marker', 'S3Mount marker registration does not match this devbox store'));
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
  readonly internet: boolean;
}

/** Owns the complete routing table; SDK mount callbacks serialize with host-policy changes. */
export class ContainerRoutes {
  readonly #writes = createResourceLane();
  #routes: Record<string, Fetcher> = {};
  #fallback: Fetcher | undefined;
  #source: S3MountRequest['source'] | undefined;
  #mountClient: S3Mount | undefined;
  /** The container was started by this object and no mount has been tried in it since, so it holds
   *  no S3Mount marker for an unmount to clear (D45). */
  #unmarked = false;

  constructor(readonly host: RouteHost) {}

  configure(policy: OutboundPolicy, store: Pick<DevboxStore, 'binding'> | undefined, reused: boolean): Promise<void> {
    return this.#writes.run(ROUTE_SCOPE, () => settle(Effect.gen({ self: this }, function* () {
      const routes = { ...policy.routes };
      const source = store === undefined ? undefined : storeSource(store.binding);

      if (source !== undefined) {
        const gateway = yield* this.#gateway();

        if (reused) {
          const mount = yield* restoredStoreRoute({ files: this.host.files, mounts: yield* this.#mounts() }, source, this.host.prefix, gateway);

          if (mount !== undefined) routes[mount.hostname] = mount.handler;
        }

        routes[storeRouteHost(STORE_PUBLISH_ROUTE)] = gateway({ props: {
          protocolVersion: 1, mode: 'active', routeId: STORE_PUBLISH_ROUTE, source, keyPrefix: this.host.prefix, access: 'read-write',
        } });
      }

      this.#routes = routes;
      this.#fallback = policy.fallback;
      this.#source = source;
      yield* this.#install();
      // Its CA appears with the HTTPS intercept.
      const trust = yield* attempt('io', () => this.host.container.exec([...TRUST]));
      const trusted = yield* attempt('io', () => trust.output());

      if (trusted.exitCode !== 0) return yield* Effect.fail(new DevboxError('io', `the container did not trust the intercept CA: ${new TextDecoder().decode(trusted.stderr)}`));
    })));
  }

  register(host: string, handler: Fetcher): Promise<void> {
    return this.#writes.run(ROUTE_SCOPE, () => settle(Effect.gen({ self: this }, function* () {
      this.#routes[host] = handler;
      yield* this.#install();
    })));
  }

  /** Called when this object has just started the container: its `/run` is new. */
  started(): void {
    this.#unmarked = true;
  }

  mount(path: string): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      const source = this.#source;

      if (source === undefined) return yield* Effect.fail(new DevboxError('configuration', 'this devbox has no store to mount'));
      const mounts = yield* this.#mounts();
      // A failed attempt can leave a marker behind, so the next unmount must run.
      this.#unmarked = false;
      // No key prefix: s3fs mounts the bucket root and skips checking a prefix it would mount (D46);
      // the route `#gateway` builds roots every key at this box's prefix instead.
      yield* attempt('io', () => mounts.mount({ mountPath: path, source, access: 'read-write',
        s3fsOptions: { connect_timeout: 10, readwrite_timeout: 30, retries: 3 } }));
    }));
  }

  unmount(path: string): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      if (this.#unmarked) return;
      const mounts = yield* this.#mounts();
      yield* attempt('io', () => mounts.unmount(path));
    }));
  }

  /** Every store route this box builds, S3Mount's included, is rooted at the box's prefix, which
   *  comes from here and never from what the guest wrote (D46). */
  #gateway(): Effect.Effect<S3GatewayBinding, DevboxError> {
    const gateway = this.host.bindings.DevboxStoreGateway;

    if (gateway === undefined) return Effect.fail(new DevboxError('configuration', 'export DevboxStoreGateway from the Worker'));
    const root = this.host.prefix;

    return Effect.succeed(({ props }) => gateway({ props: props.mode === 'deny' ? props : { ...props, keyPrefix: root } }));
  }

  #mounts(): Effect.Effect<S3Mount, DevboxError> {
    return this.#gateway().pipe(Effect.map((gateway) => this.#mountClient ??= new S3Mount({
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

