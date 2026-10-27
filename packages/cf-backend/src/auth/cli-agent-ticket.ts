/** A CLI's agent socket: its connect ticket, its own credential in place of a browser session. */
import { Cause, Effect } from 'effect';
import { err, extractTicketOrchestratorAgentName, objectNamed, ownerCaller, type ObjectNamespace, type OwnerCapabilityEnv } from '@kinu.run/core';
import { toKinuError, type KinuError } from '@kinu.run/core/obs';
import type { AuthIdentity } from './session';
import type { UserDO } from '../user/user-do';

export function parseCliAgentConnectTicketUserId(ticket: string): string | null {
  const match = /^pat_([a-f0-9]{32})_[A-Za-z0-9_-]{24,}$/.exec(ticket);

  return match?.[1] ?? null;
}

interface CliAgentTicket {
  readonly userId: string;
  readonly agentName: string;
  readonly ticket: string;
}

/** Read with no secret: null when the request carries no ticket, a `Response` refusing one that cannot be a ticket, or
 *  the account it names, whose object verifies it. */
export function cliAgentTicketOf(request: Request): CliAgentTicket | Response | null {
  const url = new URL(request.url);
  const agentName = extractTicketOrchestratorAgentName(url.pathname);
  const ticket = url.searchParams.get('ticket');

  if (!agentName || !ticket) return null;

  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return err(400, 'CLI agent tickets are only valid for WebSocket connections.');
  }

  const userId = parseCliAgentConnectTicketUserId(ticket);

  return userId === null ? err(401, 'Invalid CLI agent connect ticket.') : { userId, agentName, ticket };
}

/** The request as routed on: the ticket is its credential, never the object's to read. */
export function withoutCliAgentTicket(request: Request): Request {
  const url = new URL(request.url);

  url.searchParams.delete('ticket');

  return new Request(url.toString(), request);
}

export interface CliAgentTicketEnv<Id> extends OwnerCapabilityEnv {
  readonly UserDO: ObjectNamespace<Id, Pick<UserDO, 'verifyCliAgentConnectTicket'>>;
}

/** Null when the request carries no ticket; a `Response` refuses it; otherwise who it is. */
export function authenticateCliAgentTicketRequest<Id>(
  request: Request,
  env: CliAgentTicketEnv<Id>,
): Effect.Effect<{ identity: AuthIdentity } | Response | null, KinuError> {
  const read = cliAgentTicketOf(request);

  if (read === null || read instanceof Response) return Effect.succeed(read);

  return Effect.catchCause(Effect.gen(function* () {
    const userDO = objectNamed(env.UserDO, read.userId);

    const verified = yield* Effect.promise(async () => userDO.verifyCliAgentConnectTicket(await ownerCaller(env), read.ticket, {
      userId: read.userId,
      agentName: read.agentName,
    }));

    if (!verified.ok || !verified.user) {
      return err(401, verified.error ?? 'Invalid CLI agent connect ticket.');
    }

    const identity: AuthIdentity = {
        userId: verified.user.id,
        email: verified.user.email,
        displayName: verified.user.displayName,
        sub: 'cli',
        provider: 'cli',
        authTime: Date.now(),
    };

    if (verified.scopes) identity.cliScopes = verified.scopes;

    // Persisted on the connection so revocation can name the socket.
    if (verified.tokenHash && verified.authGeneration !== undefined) {
      identity.cliBearer = { tokenHash: verified.tokenHash, generation: verified.authGeneration };
    }

    return { identity };
  }), (failed) => Effect.fail(
    // A failure here is infrastructure, not a bad ticket: the router's `onError` answers its class, not 401.
    toKinuError({ doing: 'verifying a CLI agent connect ticket', cause: Cause.squash(failed), otherwise: 'io' }),
  ));
}
