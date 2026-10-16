/**
 * The only things a slate's code holds in a room: one stub per binding, sealed with the room's name and, inside a
 * confined run, that run's id. Only the room mints these props (`room.ts`); a slate holds the stub, never the authority
 * to mint one, so a run reaches only the grants its admission gave it (`Confinement.lean`).
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { isJsonAnswer, ownedStream, relayedAnswer, type JsonValue, type ObjectNamespace, type SlateSurfaceResult } from '@kinu.run/core';

/**
 * `workspace` (what the code calls), `__storage` (the room's cells), `__host` (releasing a socket's invocation), or
 * `__browser` (a confined run's dial of its requester's own browser, which only the room connects).
 */
export type RoomBindingName = 'workspace' | '__storage' | '__host' | '__browser';

/** The header a `__browser` dial reaches its room with: the run, its seal, and the call it was made in. */
export const ROOM_BROWSER_HEADER = 'x-kinu-room-browser';

export interface RoomBindingProps {
  /** The room's object name. */
  readonly room: string;
  readonly binding: RoomBindingName;
  /** The confined run this stub belongs to; null in the slate's shared server, which holds no grant. */
  readonly run: number | null;
  /**
   * `__browser`'s proof to its room that the dial is this run's: a random value the room keeps for the run alone. The
   * room's `fetch` is reached by people's requests too, so a dial carries what no request can know.
   */
  readonly seal?: string;
}

/** The one room method a binding reaches, as the room answers it. */
interface RoomBindingTarget {
  bindingCall(props: RoomBindingProps, request: { readonly path: string[]; readonly args: JsonValue[]; readonly invocation: string | null; readonly authorize?: true }): Promise<SlateSurfaceResult>;
  fetch(request: Request): Promise<Response>;
}

interface RoomBindingEnv {
  SLATE_ROOM: ObjectNamespace<DurableObjectId, RoomBindingTarget>;
}

/** Every call a slate's code makes returns through its room, as the stub's sealed props say. */
export class RoomBinding extends WorkerEntrypoint<RoomBindingEnv, RoomBindingProps> {
  /** `authorize`: the class runs the member itself (a browser drive), once the room says it may; nothing runs here. */
  call(path: string[], args: JsonValue[], invocation: string | null, authorize?: boolean): Promise<SlateSurfaceResult> {
    const props = this.ctx.props;

    return relayedAnswer(this.env.SLATE_ROOM.get(this.env.SLATE_ROOM.idFromName(props.room)).bindingCall(props, { path, args, invocation, ...(authorize === true && { authorize: true }) }))
      .then(withOwnedStreams);
  }

  /** A `__browser` stub's dial: to its room, sealed, which connects it or refuses. Any other stub dials nothing. */
  override async fetch(request: Request): Promise<Response> {
    const props = this.ctx.props;

    if (props.binding !== '__browser' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Not found', { status: 404 });

    return await this.env.SLATE_ROOM.get(this.env.SLATE_ROOM.idFromName(props.room)).fetch(new Request(request.url, {
      headers: { upgrade: 'websocket', [ROOM_BROWSER_HEADER]: JSON.stringify({ run: props.run, seal: props.seal ?? null, invocation: request.headers.get('x-slate-call') }) },
    }));
  }
}

/** `ai.stream`'s text and `agent.ask`'s reply leave as this isolate's own streams, never as the ones received. */
function withOwnedStreams(result: SlateSurfaceResult): SlateSurfaceResult {
  if (!result.ok || isJsonAnswer(result.value)) return result;
  const { value } = result;

  return { ...result, value: value instanceof ReadableStream ? ownedStream(value) : { ...value, reply: ownedStream(value.reply) } };
}
