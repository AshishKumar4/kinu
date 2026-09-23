import type { Context, Env as HonoEnv, MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import {
  err, ERROR_STATUS, OwnerCapabilityUnavailableError, ownerCaller, type OwnerCapabilityEnv, type UserCaller,
} from '@kinu.run/core';
import { diagnostics, renderCauseChain, toKinuError } from '@kinu.run/core/obs';
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

/** The raw path: Hono's default decodes first (`/api/user/%70rofile` would reach `profile`). Control collapses `//`, as its split did. */
export function apiPath(request: Request): string {
  const { pathname } = new URL(request.url);

  return pathname.startsWith('/api/control/') ? pathname.replace(/\/{2,}/g, '/') : pathname;
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

/** An uncaught throw: once the platform's error page, now JSON via `toKinuError`, logged by route pattern (the path is caller text). */
export function apiError(cause: Error, c: Context): Response {
  const error = toKinuError({ doing: 'answering an /api request', cause, otherwise: 'io' });
  diagnostics.failure('http.api_failed', error, { route: routePath(c) });

  return err(ERROR_STATUS[error.code], renderCauseChain(error));
}
