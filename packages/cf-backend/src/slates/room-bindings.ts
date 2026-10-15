/**
 * The only things a slate's code holds in a room: one stub per binding, sealed with the room's name and, inside a
 * confined run, that run's id. Only the room mints these props (`room.ts`); a slate holds the stub, never the authority
 * to mint one, so a run reaches only the grants its admission gave it (`Confinement.lean`).
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { isJsonAnswer, ownedStream, relayedAnswer, type JsonValue, type ObjectNamespace, type SlateSurfaceResult } from '@kinu.run/core';

/** `workspace` (what the code calls), `__storage` (the room's cells) or `__host` (releasing a socket's invocation). */
export type RoomBindingName = 'workspace' | '__storage' | '__host';

export interface RoomBindingProps {
  /** The room's object name. */
  readonly room: string;
  readonly binding: RoomBindingName;
  /** The confined run this stub belongs to; null in the slate's shared server, which holds no grant. */
  readonly run: number | null;
}

/** The one room method a binding reaches, as the room answers it. */
interface RoomBindingTarget {
  bindingCall(props: RoomBindingProps, request: { readonly path: string[]; readonly args: JsonValue[]; readonly invocation: string | null }): Promise<SlateSurfaceResult>;
}

interface RoomBindingEnv {
  SLATE_ROOM: ObjectNamespace<DurableObjectId, RoomBindingTarget>;
}

/** Every call a slate's code makes returns through its room, as the stub's sealed props say. */
export class RoomBinding extends WorkerEntrypoint<RoomBindingEnv, RoomBindingProps> {
  call(path: string[], args: JsonValue[], invocation: string | null): Promise<SlateSurfaceResult> {
    const props = this.ctx.props;

    return relayedAnswer(this.env.SLATE_ROOM.get(this.env.SLATE_ROOM.idFromName(props.room)).bindingCall(props, { path, args, invocation }))
      .then(withOwnedStreams);
  }
}

/** `ai.stream`'s text and `agent.ask`'s reply leave as this isolate's own streams, never as the ones received. */
function withOwnedStreams(result: SlateSurfaceResult): SlateSurfaceResult {
  if (!result.ok || isJsonAnswer(result.value)) return result;
  const { value } = result;

  return { ...result, value: value instanceof ReadableStream ? ownedStream(value) : { ...value, reply: ownedStream(value.reply) } };
}
