/**
 * What a client's socket and requests pass before an actor's handlers see them: its authority, re-checked per frame;
 * a terminal's frames, sent to its shell; an RPC a window may not make; an actor no longer hosted; and a store its
 * repair could not bring to this build. Each actor installs it over its Agent base's handlers.
 */
import { idempotent } from '@nimbus-sh/fabric/do-calls.js';
import type { Connection, ConnectionContext, WSMessage } from 'agents';
import { MessageType, parseProtocolMessage, sendIfOpen } from 'agents/chat';
import type { UIMessage } from 'ai';
import { Hono, type Context } from 'hono';
import * as v from 'valibot';
import {
  actorFromConnectionTags, ERROR_STATUS, hostedActorRoute, HOSTED_ACTOR_ID_HEADER, hostedWindowMay, JsonValueSchema, requiredRpcAccess,
  rpcMovesOverview, WorkspaceTerminalInputSchema, type AgentRpcMethod, type StoragePredatesReleaseError, type UserCaller,
} from '@kinu.run/core';
import { Effect } from 'effect';
import { attempt, diagnostics, refusalOf, settle, tolerate, type KinuError, type Refusal } from '@kinu.run/core/obs';
import {
  CLI_AUTHORITY_REVOKED, cliBearerFromTags, rejectOutOfScopeRpc, rpcFrameOf, SESSION_AUTHORITY_REVOKED, sessionBearerFromTags,
  WEBSOCKET_POLICY_CLOSE, type CliSocketBearer, type RpcFrame,
} from './cli/rpc-gate';
import { framePlacing, type ChatWireTransport } from './chat-transport';
import type { UserHubClient } from './account-reads';
import type { WorkspaceTerminal } from './workspace-host';
import { logDoCallRetry } from './obs/do-call-retry';
import { rawPath, rethrow } from './api/context';

/** The handlers the gate stands in front of: the Agent base's, as the actor was constructed with them. */
export interface ClientHandlers {
  readonly onMessage: (connection: Connection, message: WSMessage) => void | Promise<void>;
  readonly onConnect: (connection: Connection, ctx: ConnectionContext) => void | Promise<void>;
  readonly onClose: (connection: Connection, code: number, reason: string, wasClean: boolean) => void | Promise<void>;
  readonly onRequest: (request: Request) => Response | Promise<Response>;
}

export interface ClientSocketGateHost {
  /** Set once the store's repair refused: nothing past the gate reads it then. */
  storageRefusal(): StoragePredatesReleaseError | undefined;
  /** Why this actor cannot be acted on now, or null; inspections pass it. */
  runtimeRefusal(): Refusal | null;
  terminalFor(connection: Pick<Connection, 'tags'>): Promise<WorkspaceTerminal | null>;
  /** The name of the window a hosted actor's socket addresses, or null for one this workspace no longer holds. */
  hostedWindowName(actorId: string): string | null;
  chatRoomFor(connection: Connection): ChatWireTransport | null;
  /** A pane's seed: the actor its path addresses, its rows; undefined for one not hosted here. */
  history(hostedActor: string | null): Promise<UIMessage[] | undefined>;
  overviewChanged(): void;
  connectionOpened(): void;
  lastConnectionClosed(): void;
  turnClaimFrame(): string;
  connections(): Iterable<Connection>;
  /** The owner's user object, which confirms a socket's authority: a fresh stub per attempt, as a retry needs. */
  ownerHub(): UserHubClient;
  /** The caller this workspace asks it as. */
  caller(): Promise<UserCaller>;
  workspace(): string;
}

/**
 * Every frame the gate answers with: a socket no longer open, closed by its tab or by a refusal of a frame beside this
 * one, is sent nothing (staging rc20, 2026-10-19: two frames of a deleted workspace's tab were refused together, and the
 * second's answer threw out of `webSocketMessage`).
 */
function answer(connection: Pick<Connection, 'id' | 'readyState' | 'send'>, frame: string): void {
  if (connection.readyState === WebSocket.OPEN) sendIfOpen(connection, frame);
}

/** A socket the gate refuses for good, closed once, by policy: a refusal beside it may have closed it already. */
function shut(connection: Pick<Connection, 'readyState' | 'close'>, reason: string): void {
  if (connection.readyState === WebSocket.OPEN) connection.close(WEBSOCKET_POLICY_CLOSE, reason);
}

/** The base's handlers behind the gate. */
export function gatedClientHandlers(host: ClientSocketGateHost, base: ClientHandlers): ClientHandlers {
  const gate = new ClientSocketGate(host);

  return {
    onMessage: async (connection, message) => { await gate.message(connection, message, base); },
    onConnect: async (connection, ctx) => { await gate.connect(connection, ctx, base); },
    onClose: async (connection, code, reason, wasClean) => { await gate.close(connection, { code, reason, wasClean }, base); },
    onRequest: gate.requests(base),
  };
}

/** The Stop's RPC, which reaches its chat room's order a few steps into the Agent base's dispatch. */
const STOP_RPC: AgentRpcMethod = 'cancelCurrentWork';

class ClientSocketGate {
  constructor(private readonly host: ClientSocketGateHost) {}

  /** Per socket, its newest frame's place: settled once that frame has taken it, so the frame after it may go on. */
  private readonly lines = new Map<string, Promise<void>>();

  /**
   * A frame from a socket whose authority still holds goes on; one whose authority ended is refused and closed. Its
   * authority is asked at once, but it goes on only after the socket's frame before it has taken its place: those
   * answers come back in any order, and a Continue let in ahead of the Stop RPC sent before it was handed back by that
   * Stop (staging rc12). A frame takes its place as it goes on, since chat frames reach the room's order by one path.
   * The Stop's RPC takes it once the room has its step, or once its handling ends without one. A wait on anything else
   * (a timer turn, or a frame's whole handling) holds the socket's every later frame behind it.
   */
  message(connection: Connection, message: WSMessage, base: ClientHandlers): Promise<void> {
    const before = this.lines.get(connection.id) ?? Promise.resolve();
    const { promise: placed, resolve: place } = Promise.withResolvers<void>();
    const stop = rpcFrameOf(message)?.method === STOP_RPC;

    this.lines.set(connection.id, placed);

    const checked = Effect.all([this.refuseRevokedAuthority(connection, message), Effect.promise(() => before)], { concurrency: 'unbounded' });

    const goneOn = Effect.flatMap(checked, ([refused]) => (refused
      ? Effect.sync(place)
      : Effect.promise(async () => {
        if (!stop) place();
        await framePlacing.run(place, () => this.admittedMessage(connection, message, base)).finally(place);
      })));

    return settle(Effect.ensuring(goneOn, Effect.sync(() => {
      if (this.lines.get(connection.id) === placed) this.lines.delete(connection.id);
    })));
  }

  private async admittedMessage(connection: Connection, message: WSMessage, base: ClientHandlers): Promise<void> {
    const terminal = await this.host.terminalFor(connection);

    if (terminal) {
      await forwardTerminalFrame(terminal, connection, message);

      return;
    }

    const rejection = rejectOutOfScopeRpc(connection.tags, message);

    if (rejection) {
      answer(connection, rejection);

      return;
    }

    const rpc = rpcFrameOf(message);
    const refusal = rpc === null ? null : this.rpcRefusal(connection, rpc);

    if (rpc && refusal !== null) {
      answer(connection, JSON.stringify({ type: 'rpc', id: rpc.id, success: false, error: refusal }));

      return;
    }

    if (this.refusedUnavailable(connection, message, rpc)) return;

    // Chat frames go to the room; other frames (RPC, state sync) are the Agent base's.
    // A frame for an actor no longer hosted here is refused.
    if (v.is(v.string(), message)) {
      const room = this.host.chatRoomFor(connection);

      if (room === null) {
        answer(connection, JSON.stringify({ type: 'error', error: 'The actor this connection addressed is no longer hosted here.' }));

        return;
      }

      if (await room.onMessage(connection, message)) return;
    }

    await base.onMessage(connection, message);

    if (rpc !== null && rpcMovesOverview(rpc.method)) this.host.overviewChanged();
  }

  /** An actor that cannot be acted on now refuses each frame in its frame's own shape; an inspection still reads it. */
  private refusedUnavailable(connection: Connection, message: WSMessage, rpc: RpcFrame | null): boolean {
    const unavailable = this.host.runtimeRefusal();
    const inspection = rpc && (requiredRpcAccess(rpc.method) === 'workspace.read' || rpc.method === 'inspectSubordinate' || rpc.method === 'exportWorkspaceArchive');

    if (!unavailable || inspection) return false;
    const event = v.is(v.string(), message) ? parseProtocolMessage(message) : null;

    if (rpc) answer(connection, JSON.stringify({ ...unavailable, type: 'rpc', id: rpc.id, success: false }));
    else if (event?.type === 'chat-request' || event?.type === 'stream-resume-ack') {
      answer(connection, JSON.stringify({ reason: unavailable.reason, type: MessageType.CF_AGENT_USE_CHAT_RESPONSE, id: event.id, body: unavailable.error, done: true, error: true }));
    } else answer(connection, JSON.stringify({ ...unavailable, type: 'error' }));

    return true;
  }

  connect(connection: Connection, ctx: ConnectionContext, base: ClientHandlers): Promise<void> {
    return settle(Effect.flatMap(this.refuseRevokedAuthority(connection, ''),
      (refused) => (refused ? Effect.void : Effect.promise(async () => { await this.admittedConnect(connection, ctx, base); }))));
  }

  private async admittedConnect(connection: Connection, ctx: ConnectionContext, base: ClientHandlers): Promise<void> {
    const storage = this.host.storageRefusal();

    // Before anything reads the store.
    if (storage !== undefined) {
      answer(connection, JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE, id: 'storage-refused', reason: storage.code, body: storage.message, done: true, error: true,
      }));

      return;
    }

    this.host.connectionOpened();

    await base.onConnect(connection, ctx);

    const terminal = await this.host.terminalFor(connection);

    if (terminal) {
      await terminal.attachTerminal(connection);

      return;
    }

    // Claim frames reach only tabs connected at a change: a root tab away at the settle hears the claim here (#30).
    if (actorFromConnectionTags(connection.tags) === null) sendIfOpen(connection, this.host.turnClaimFrame());
    await this.host.chatRoomFor(connection)?.onConnect(connection);
  }

  async close(connection: Connection, closed: { code: number; reason: string; wasClean: boolean }, base: ClientHandlers): Promise<void> {
    const { code, reason, wasClean } = closed;

    this.lines.delete(connection.id);

    if (this.host.storageRefusal() !== undefined) {
      await base.onClose(connection, code, reason, wasClean);

      return;
    }

    const terminal = await this.host.terminalFor(connection);

    if (terminal) terminal.terminalClose(connection);
    else this.host.chatRoomFor(connection)?.onClose(connection);

    await base.onClose(connection, code, reason, wasClean);

    // Exclude the closing socket's id explicitly; the platform's state for it is not guaranteed.
    for (const other of this.host.connections()) if (other.id !== connection.id) return;

    this.host.lastConnectionClosed();
  }

  requests(base: ClientHandlers): (request: Request) => Promise<Response> {
    const requests = new Hono({ getPath: rawPath });

    requests.use('*', async (_c, next) => {
      const storage = this.host.storageRefusal();

      return storage === undefined ? next() : Response.json(refusalOf(storage), { status: ERROR_STATUS[storage.code] });
    });

    // The seed is fetched on the same path the pane's socket opens, so each pane gets its own actor's rows.
    const seed = async (c: Context): Promise<Response> => {
      const hosted = hostedActorRoute(c.req.path) === null ? null : c.req.header(HOSTED_ACTOR_ID_HEADER) ?? '';
      const history = await this.host.history(hosted);

      if (history === undefined) return Response.json({ reason: 'missing', error: 'The actor is not hosted here.' }, { status: 404 });

      return Response.json(history);
    };

    requests.all('/get-messages', seed);
    requests.all('/:prefix{.*}/get-messages', seed);
    requests.notFound(async (c) => base.onRequest(c.req.raw));
    requests.onError(rethrow);

    return async (request) => requests.fetch(request);
  }

  /** A hosted actor's window may act only on its own agent, with JSON arguments. */
  private rpcRefusal(connection: Connection, rpc: RpcFrame): string | null {
    const id = actorFromConnectionTags(connection.tags);

    if (id === null) return null;
    const name = this.host.hostedWindowName(id);
    // The SDK runs any array of arguments; a window's must be JSON values.
    const args = v.safeParse(v.array(JsonValueSchema), rpc.args);

    if (name === null) return `${rpc.method} from a window whose agent this workspace no longer holds.`;

    if (!args.success) return `${rpc.method} from ${name}'s window carries arguments that are not JSON values.`;

    return hostedWindowMay(rpc.method, args.output, { name, id }) ? null : `${rpc.method} from ${name}'s window may act only on ${name}.`;
  }

  /**
   * Upgrade checks authority once and hibernated sockets resume without it, so re-check per frame.
   * Asks the owning UserDO (no cached verdict); an unreachable UserDO refuses the frame.
   */
  private refuseRevokedAuthority(connection: Connection, message: WSMessage): Effect.Effect<boolean> {
    return Effect.map(this.authorityDenial(connection), (denial) => {
      if (denial === null) return false;
      const rpc = rpcFrameOf(message);

      // The rpc reply carries the authority's reason so a pending call fails instead of hanging;
      // the close reason is the user-facing instruction for the token kind.
      if (rpc) answer(connection, JSON.stringify({ type: 'rpc', id: rpc.id, success: false, error: denial.why }));
      shut(connection, denial.close);
      diagnostics.event('auth.socket_frame_denied', { outcome: 'denied', reason: 'authority_not_live' });

      return true;
    });
  }

  /** Denial reason plus client instruction, or null when the connection may act.
   *  Bearer and session each fail closed; a connection carrying both is refused by whichever died. */
  private authorityDenial(connection: Connection): Effect.Effect<{ why: string; close: string } | null> {
    return Effect.gen({ self: this }, function* () {
      const bearer = cliBearerFromTags(connection.tags);
      const cli = bearer === null ? null : yield* this.cliBearerDenial(bearer);

      if (cli !== null) return { why: cli, close: CLI_AUTHORITY_REVOKED };
      const session = sessionBearerFromTags(connection.tags);
      const denial = session === null ? null : yield* this.sessionBearerDenial(session);

      // A session denial is already an instruction, so it doubles as the close reason.
      return denial === null ? null : { why: denial, close: denial };
    });
  }

  /** Unreadable tag or unreachable UserDO both refuse: authority must be confirmable. */
  private sessionBearerDenial(session: { tokenHash: string } | { unreadable: true }): Effect.Effect<string | null> {
    if ('unreadable' in session) {
      return Effect.succeed('This connection carries no readable session. Reload the page to sign in again.');
    }

    const verified = this.askOwner('verifySocketSession', (stub, caller) => stub.verifySocketSession(caller, session.tokenHash));

    return Effect.matchEffect(verified, {
      onSuccess: ({ live }) => Effect.succeed(live ? null : SESSION_AUTHORITY_REVOKED),
      onFailure: (failure) => this.unconfirmed('session', failure),
    });
  }

  /** Denial reason for the CLI bearer, or null. A generation newer than the account's is refused. */
  private cliBearerDenial(bearer: CliSocketBearer): Effect.Effect<string | null> {
    if (!bearer.readable) return Effect.succeed('This connection carries no readable authorization. Reconnect with: kinu auth');

    const verified = this.askOwner('verifyCliSocketBearer', (stub, caller) => stub.verifyCliSocketBearer(caller, bearer.tokenHash));

    return Effect.matchEffect(verified, {
      onSuccess: ({ live, generation, error }) => Effect.succeed(live && generation <= bearer.generation ? null : error ?? CLI_AUTHORITY_REVOKED),
      onFailure: (failure) => this.unconfirmed('cli', failure),
    });
  }

  /** Authority that cannot be confirmed refuses, with what the client should do. */
  private unconfirmed(bearer: keyof typeof UNCONFIRMED, failure: KinuError): Effect.Effect<string> {
    return Effect.sync(() => {
      diagnostics.failure(UNCONFIRMED[bearer].event, failure, { workspace: this.host.workspace() });

      return `This connection's authorization could not be confirmed. ${UNCONFIRMED[bearer].instruction}`;
    });
  }

  /** Whether a socket's authority is still live, asked of the owner's user object: retried, never cached. */
  private askOwner<A>(check: 'verifySocketSession' | 'verifyCliSocketBearer', ask: (stub: UserHubClient, caller: UserCaller) => Promise<A>): Effect.Effect<A, KinuError> {
    return attempt({ doing: `checking whether a websocket's authority is still live (${check})`, otherwise: 'unavailable' }, async () => {
      const caller = await this.host.caller();

      return await idempotent(check, () => this.host.ownerHub(), (stub) => ask(stub, caller), { onRetry: logDoCallRetry });
    });
  }
}

/** A bearer whose authority could not be confirmed: what is logged, and what its client is told to do. */
const UNCONFIRMED = {
  session: { event: 'auth.session_bearer_check_failed', instruction: 'Reload the page to sign in again.' },
  cli: { event: 'auth.cli_bearer_check_failed', instruction: 'Reconnect with: kinu auth' },
} as const;

/** Validates the frame at the client boundary; a socket sending any other shape is closed with the reason. */
async function forwardTerminalFrame(terminal: WorkspaceTerminal, connection: Pick<Connection, 'readyState' | 'send' | 'close'>, message: WSMessage): Promise<void> {
  const frame = v.is(v.string(), message)
    ? v.safeParse(WorkspaceTerminalInputSchema, tolerate(() => JSON.parse(message), 'malformed-input'))
    : null;

  if (frame === null || !frame.success) {
    shut(connection, 'terminal frame refused: not an input or resize frame');

    return;
  }

  await terminal.terminalFrame(connection, JSON.stringify(frame.output));
}
