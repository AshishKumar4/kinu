/**
 * The CLI's bearer: a session or scoped access token, verified against its owner's account. It lives beside
 * the API context so a router that needs only the bearer imports none of the CLI's routes.
 */
import type { MiddlewareHandler } from 'hono';
import { Cause, Effect, Result } from 'effect';
import { err, OwnerCapabilityUnavailableError, type ObjectNamespace, type OwnerCapabilityEnv } from '@kinu.run/core';
import { settle } from '@kinu.run/core/obs';
import { authenticateCliToken, tokenAllows, type CliAuthAuthority, type CliTokenIdentity } from '../cli/auth-store';
import type { ApiVariables, FamilyEnv } from './context';

/** What verifying a bearer reads. */
export interface CliBearerEnv<Authority extends CliAuthAuthority> extends OwnerCapabilityEnv {
  UserDO: ObjectNamespace<unknown, Authority>;
}

export interface CliBearerVariables<Authority> extends ApiVariables {
  cli: CliTokenIdentity<Authority>;
}

/** The verified bearer, or the response refusing it. */
export function authenticateCli<Authority extends CliAuthAuthority>(
  request: Request, env: CliBearerEnv<Authority>,
): Effect.Effect<CliTokenIdentity<Authority> | Response> {
  return Effect.catchCause(
    Effect.map(Effect.promise(() => authenticateCliToken(request, env)), (result) => (Result.isSuccess(result) ? result.success : err(401, result.failure))),
    (failed) => {
      const e = Cause.squash(failed);

      // No root secret: say so rather than surfacing an unexplained 500.
      return e instanceof OwnerCapabilityUnavailableError ? Effect.succeed(err(503, e.message)) : Effect.failCause(failed);
    },
  );
}

/** Inference through Kinu: a session token, or an access token holding `ai.proxy`. */
export function inferenceProxyGate<Authority extends CliAuthAuthority>(): MiddlewareHandler<FamilyEnv<CliBearerEnv<Authority>, CliBearerVariables<Authority>>> {
  return (c, next) => settle(Effect.gen(function* () {
    const cli = yield* authenticateCli(c.req.raw, c.env);

    if (cli instanceof Response) return cli;

    if (cli.kind === 'access' && !tokenAllows(cli, 'ai.proxy')) {
      return err(403, 'This access token does not have the ai.proxy scope.');
    }

    c.set('cli', cli);
    yield* Effect.promise(() => next());
  }));
}
