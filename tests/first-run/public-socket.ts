/**
 * The browser's own socket, and the frames a first-run row sends over it.
 *
 * Two rows now open one: `agent-tab` drives the reads a freshly created tab
 * makes, and `agent-chats-persist` re-opens the same rooms after a navigation
 * to prove the conversations are still there. One copy, because the second
 * copy of a behaviour is the moment to name it (AGENTS.md Waste, 2026-09-21) —
 * and because a row that spelled its own frame codec could pass while the
 * browser spoke a different one.
 *
 * A case module is never the home for this: importing one resolves a live plan
 * at import time, so a shared helper living inside a case would drag a second
 * case's plan resolution into every run.
 */
import type { JsonValue } from '../../packages/core/src/index';
import {
  decodeFrame, encodeChatRequest, encodeRpcRequest, HEADER_WEBSOCKET, recordPublicTurn, webHeaders,
  type PublicSendResult, type PublicTurnRecorder, type PublicWebIdentity,
} from '../evals/public-session';

/** One RPC in flight on a public socket. */
interface PendingRpc {
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (error: Error) => void;
}

/** One chat send in flight on a public socket. */
interface PendingTurn {
  readonly recorder: PublicTurnRecorder;
  readonly resolve: (value: PublicSendResult) => void;
  readonly reject: (error: Error) => void;
}

/** One public socket, and the two frame kinds a browser sends over it. */
export interface PublicSocket {
  readonly path: string;
  /** True when the upgrade succeeded; false when the deployment refused it. */
  readonly opened: Promise<boolean>;
  rpc(method: string, args: readonly JsonValue[]): Promise<JsonValue>;
  chat(text: string): Promise<PublicSendResult>;
  close(reason: string): void;
}

/**
 * Open one of the browser's own sockets and speak its frames.
 *
 * `budget` is the case's: every wait here is settled by the product or by that
 * abort, so a read the deployment never answers becomes a verdict rather than
 * a hang, and nothing in this row reads a clock.
 */
export function openPublicSocket(
  origin: string, identity: PublicWebIdentity, path: string, budget: AbortSignal,
): PublicSocket {
  const url = new URL(path, origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  const socket = new HEADER_WEBSOCKET(url.toString(), { headers: webHeaders(identity) });
  const rpcs = new Map<string, PendingRpc>();
  const turns = new Map<string, PendingTurn>();
  let nextId = 0;

  const failInFlight = (reason: string): void => {
    const waiting = [...rpcs.values()];
    const sending = [...turns.values()];
    rpcs.clear();
    turns.clear();

    for (const pending of waiting) pending.reject(new Error(reason));

    for (const turn of sending) turn.reject(new Error(reason));
  };

  budget.addEventListener('abort', () => {
    failInFlight(`the case budget was spent with ${url.pathname} still owing an answer`);
  });

  // `MessageEvent.data` is `any` on the DOM lib; the agents-SDK transport
  // sends only text or binary payloads, which are exactly the three shapes the
  // codec takes, and it answers null for anything else.
  socket.addEventListener('message', (event: MessageEvent<string | ArrayBuffer | Uint8Array>) => {
    const frame = decodeFrame(event.data);

    if (frame === null) return;

    if (frame.kind === 'rpc') {
      const pending = rpcs.get(frame.id);

      if (pending === undefined) return;
      rpcs.delete(frame.id);

      if (frame.error === null) pending.resolve(frame.result);
      else pending.reject(new Error(frame.error));

      return;
    }

    if (frame.kind !== 'response') return;
    const turn = turns.get(frame.frame.id);

    if (turn === undefined) return;
    turn.recorder.apply(frame.frame);
    const settled = turn.recorder.settled();

    // The turn is over on the DO's `done` frame, sent once its answer is
    // durable (`closeTurn`, packages/cf-backend/src/chat-transport.ts). An error
    // frame can come first — the relay to this socket broke, the turn did not —
    // and a row that moved on at it would act on a turn still writing.
    if (settled === null || frame.frame.done !== true) return;
    turns.delete(frame.frame.id);
    // A mid-turn landing carries no absorbing run id here: this row sends one
    // message per socket, so there is no second send whose close would name one.
    turn.resolve(settled.landed === 'mid-turn' ? { landed: 'mid-turn', absorbedBy: null } : settled);
  });

  socket.addEventListener('close', () => failInFlight(`${url.pathname} closed`));

  const opened = new Promise<boolean>((resolve) => {
    socket.addEventListener('open', () => resolve(true), { once: true });
    socket.addEventListener('error', () => resolve(false), { once: true });
    socket.addEventListener('close', () => resolve(false), { once: true });
    budget.addEventListener('abort', () => resolve(false));
  });

  const mint = (kind: string): string => {
    nextId += 1;

    return `${kind}-${String(nextId)}-${Math.random().toString(36).slice(2, 8)}`;
  };

  return {
    path: url.pathname,
    opened,
    rpc(method, args) {
      return new Promise<JsonValue>((resolve, reject) => {
        const requestId = mint('rpc');
        rpcs.set(requestId, { resolve, reject });
        socket.send(encodeRpcRequest({ requestId, method, args }));
      });
    },
    chat(text) {
      return new Promise<PublicSendResult>((resolve, reject) => {
        const requestId = mint('turn');
        turns.set(requestId, { recorder: recordPublicTurn(), resolve, reject });
        socket.send(encodeChatRequest({ requestId, text }));
      });
    },
    close(reason) {
      failInFlight(reason);
      socket.close();
    },
  };
}

/** One read a row makes, as the answer it got or the reason it got none. */
export type Answer =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly failure: string };

export async function ask(socket: PublicSocket, method: string, args: readonly JsonValue[]): Promise<Answer> {
  try {
    return { ok: true, value: await socket.rpc(method, args) };
  } catch (error) {
    return { ok: false, failure: error instanceof Error ? error.message : String(error) };
  }
}

export function excerpt(value: JsonValue, length = 240): string {
  return JSON.stringify(value).slice(0, length);
}

/** One RPC row's `detail`: how the call failed, what a parsed answer said, or
 *  the bytes that did not parse. */
export interface RpcDetail {
  readonly rpc: string;
  readonly answer: Answer;
  /** How this row names a call that never came back. */
  readonly refusal: string;
  /** The sentence a parsed answer earns, or null when it did not parse. */
  readonly said: string | null;
}

export function rpcDetail({ rpc, answer, refusal, said }: RpcDetail): string {
  if (!answer.ok) return `${rpc} ${refusal}: ${answer.failure.slice(0, 300)}`;

  if (said !== null) return said;

  return `${rpc} answered foreign bytes: ${excerpt(answer.value)}`;
}
