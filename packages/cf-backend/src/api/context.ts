import type { Context, Env as HonoEnv, MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import {
  err, OwnerCapabilityUnavailableError, ownerCaller, PUBLIC_MESSAGE, publicError, type OwnerCapabilityEnv, type UserCaller,
} from '@kinu.run/core';
import { diagnostics, KinuError, toKinuError } from '@kinu.run/core/obs';
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
export function noHead<E extends HonoEnv>(handler: MiddlewareHandler<E>): MiddlewareHandler<E> {
  return async (c, next) => (c.req.method === 'HEAD' ? next() : handler(c, next));
}

/** A segment as spelled; routes decode it with `decodeURIComponent`, which throws on a bad escape, as before. */
export function rawParam(c: Context, name: string): string {
  const at = patternSegments(routePath(c)).findIndex((part) => part === `:${name}` || part.startsWith(`:${name}{`));
  const segment = at < 0 ? undefined : c.req.path.split('/')[at];

  if (segment === undefined) throw new Error(`route ${routePath(c)} has no :${name} segment`);

  return segment;
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
  return async (c, next) => {
    let owner: UserCaller;

    try { owner = await ownerCaller(c.env); }
    catch (cause) {
      if (cause instanceof OwnerCapabilityUnavailableError) return err(503, cause.message);
      throw cause;
    }

    c.set('owner', owner);
    await next();
  };
}

/** Every router's `onError`: the chain goes to `http.request_failed` by route pattern; the client gets its class. */
export function routeError(cause: Error, c: Context): Response {
  const error = cause instanceof KinuError ? cause : toKinuError({ doing: 'answering an HTTP request', cause, otherwise: 'io' });
  diagnostics.failure('http.request_failed', error, { route: routePath(c) });

  return publicError(cause instanceof KinuError ? cause : new KinuError(error.code, PUBLIC_MESSAGE[error.code]));
}

/** A Durable Object router's `onError`: the caller sees the throw. */
export function rethrow(error: Error): never {
  throw error;
}
