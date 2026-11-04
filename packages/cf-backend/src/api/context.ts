import * as v from 'valibot';
import { Cause, Effect } from 'effect';
import type { Context, Env as HonoEnv, Hono, MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import {
  err, OwnerCapabilityUnavailableError, ownerCaller, PUBLIC_MESSAGE, publicError, type OwnerCapabilityEnv, type UserCaller,
} from '@kinu.run/core';
import { diagnostics, KinuError, toKinuError, settle, settleSync } from '@kinu.run/core/obs';
import type { AuthIdentity } from '../auth/session';
import type { AccessIdentity } from '../control-plane/access-gate';

/** `access`: Cloudflare Access (`/api/control*`); `identity`: the session gate. */
export interface ApiVariables {
  access: AccessIdentity;
  identity: AuthIdentity;
}

export interface FamilyEnv<Bindings extends object, Variables extends object = ApiVariables> {
  Bindings: Bindings;
  Variables: Variables;
}

/** Mounts each route family on `host` at its root, checking the bindings the family declares against the host's. */
export function familyMount<HostEnv extends HonoEnv>(host: Hono<HostEnv>) {
  return <Bindings extends object, Variables extends object>(family: Hono<FamilyEnv<Bindings, Variables>> & (HostEnv['Bindings'] extends Bindings ? unknown : never)): void => {
    host.route('/', family);
  };
}

/** The path as spelled: Hono's default decodes first (`/%6Cogin` would reach `/login`). */
export function rawPath(request: Request): string {
  return new URL(request.url).pathname;
}

/** {@link rawPath}; control collapses `//`, as its split did. */
export function apiPath(request: Request): string {
  const pathname = rawPath(request);

  return pathname.startsWith('/api/control/') ? pathname.replace(/\/{2,}/g, '/') : pathname;
}

/** Hono sends HEAD to GET routes; a GET-only route passes it on. */
export function noHead<E extends HonoEnv>(handler: (c: Context<E>) => Effect.Effect<Response, KinuError>): MiddlewareHandler<E> {
  return (c, next) => {
    if (c.req.method === 'HEAD') return next();

    return settle(handler(c));
  };
}

/** A segment as spelled; routes decode it with `decodeURIComponent`, which throws on a bad escape, as before. */
export function rawParam(c: Context, name: string): string {
  return settleSync(Effect.gen(function* () {
    const at = patternSegments(routePath(c)).findIndex((part) => part === `:${name}` || part.startsWith(`:${name}{`));
    const segment = at < 0 ? undefined : c.req.path.split('/')[at];

    if (segment === undefined) return yield* Effect.die(new Error(`route ${routePath(c)} has no :${name} segment`));

    return segment;
  }));
}

/** A `{regex}` may hold `/`. */
function patternSegments(pattern: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let current = '';

  for (const ch of pattern) {
    if (ch === '{') depth += 1;

    if (ch === '}') depth -= 1;

    if (ch === '/' && depth === 0) {
      segments.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  segments.push(current);

  return segments;
}

/** `/prefix/*` also matches `/prefix`; answer only beneath it. */
export function beneath<E extends HonoEnv>(prefix: string, handler: MiddlewareHandler<E>): MiddlewareHandler<E> {
  return async (c, next) => (c.req.path.startsWith(`${prefix}/`) ? handler(c, next) : next());
}

/** No root secret answers 503 naming it. */
export function ownerGate<E extends FamilyEnv<OwnerCapabilityEnv, { owner: UserCaller }>>(): MiddlewareHandler<E> {
  return (c, next) => settle(Effect.gen(function* () {
    const read = yield* Effect.catchCause(Effect.map(Effect.promise(() => ownerCaller(c.env)), (owner) => ({ owner })), (failed) => {
      const cause = Cause.squash(failed);

      return cause instanceof OwnerCapabilityUnavailableError ? Effect.succeed({ refused: err(503, cause.message) }) : Effect.failCause(failed);
    });

    if ('refused' in read) return read.refused;
    c.set('owner', read.owner);
    yield* Effect.promise(() => next());
  }));
}

/** Every router's `onError`: the chain goes to `http.request_failed` by route pattern; the client gets its class. */
export function routeError(cause: Error, c: Context): Response {
  const error = cause instanceof KinuError ? cause : toKinuError({ doing: 'answering an HTTP request', cause, otherwise: 'io' });

  // A call its own client left, cancelled by the request's signal (`enable_request_signal`), failed nothing: no one
  // reads the answer.
  if (error.code === 'cancelled' && c.req.raw.signal.aborted) return new Response(null, { status: 499 });
  diagnostics.failure('http.request_failed', error, { route: routePath(c), ...unreadRefusal(error) });

  return publicError(cause instanceof KinuError ? cause : new KinuError(error.code, PUBLIC_MESSAGE[error.code]));
}

/**
 * The own fields of a refusal another object threw that this route read as no refusal (`authoredRefusal`), which say
 * why: production's account object refused a fourth workspace with `budget`, read so at 18:46 (413) and as `io` at
 * 19:12 (500) on one build, 2026-11-02. Debug evidence, kept until that cause is fixed; only our own codes, never text.
 */
function unreadRefusal(error: KinuError) {
  const crossed = error.cause;

  if (error.code !== 'io' || !(crossed instanceof Error) || !crossed.name.startsWith('KinuError')) return {};
  const read = v.safeParse(CrossedRefusalSchema, crossed);
  const refusal = read.success ? read.output : {};

  return {
    crossedName: crossed.name,
    crossedRemote: String(refusal.remote ?? 'absent'), crossedTag: refusal._tag ?? 'absent', crossedCode: refusal.code ?? 'absent',
  };
}

/** What `authoredRefusal` reads off a refusal another object threw. */
const CrossedRefusalSchema = v.looseObject({ remote: v.optional(v.boolean()), _tag: v.optional(v.string()), code: v.optional(v.string()) });

/** A Durable Object router's `onError`: the caller sees the throw. */
export function rethrow(error: Error): never {
  return settleSync(Effect.die(error));
}
