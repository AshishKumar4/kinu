/**
 * The only things a slate's code holds in a room: one stub per binding, sealed with the room's name and, inside a
 * confined run, that run's id. Only the room mints these props (`room.ts`); a slate holds the stub, never the authority
 * to mint one, so a run reaches only the grants its admission gave it (`Confinement.lean`).
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { JsonValue, SlateSurfaceResult } from '@kinu.run/core';
import type { SlateRoom } from './room';

/** `workspace` (what the code calls), `__storage` (the room's cells) or `__host` (releasing a socket's invocation). */
export type RoomBindingName = 'workspace' | '__storage' | '__host';

export interface RoomBindingProps {
  /** The room's object name. */
  readonly room: string;
  readonly binding: RoomBindingName;
  /** The confined run this stub belongs to; null in the slate's shared server, which holds no grant. */
  readonly run: number | null;
}

interface RoomBindingEnv {
  SLATE_ROOM: DurableObjectNamespace<SlateRoom>;
}

/** Every call a slate's code makes returns through its room, as the stub's sealed props say. */
export class RoomBinding extends WorkerEntrypoint<RoomBindingEnv, RoomBindingProps> {
  call(path: string[], args: JsonValue[], invocation: string | null): Promise<SlateSurfaceResult> {
    const props = this.ctx.props;

    return this.env.SLATE_ROOM.get(this.env.SLATE_ROOM.idFromName(props.room)).bindingCall(props, { path, args, invocation });
  }
}
