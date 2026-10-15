/** A slate room's HTTP routes (room-api.ts): whether a session may open it, and forking it. The socket is use-room's. */
import { Effect } from "effect";
import * as v from "valibot";
import { ForkedSchema, ForkPreviewSchema, roomEntryPath, roomForkPath, RoomEntrySchema, type Forked, type ForkPreview, type RoomEntry } from "@kinu.run/core";
import { settle } from "@kinu.run/core/obs";
import { refusal, request, respond } from "./http";

/** A shared slate, by where its room is; `key` is the link's, for someone who came by the link, which admits them. */
export interface RoomSlate {
  readonly workspace: string;
  readonly slate: string;
  readonly key: string | null;
}

/** The link's key in a room's URL (`/s/<ws>/<slate>?k=<key>`), or null for a member's. */
export function linkKeyOf(url: string): string | null {
  return new URL(url, window.location.origin).searchParams.get("k");
}

/** A room route as this session reaches it: through the link, its key rides along. */
const admitted = (path: string, key: string | null) => (key === null ? path : `${path}?k=${encodeURIComponent(key)}`);

/** Why the room will not open for this session, by what its entry answered. */
export type RoomClosed = "sign-in" | "not-shared" | "missing" | "stopped";

const CLOSED_BY_STATUS = new Map<number, RoomClosed>([[401, "sign-in"], [403, "not-shared"], [404, "missing"], [410, "stopped"]]);

export type RoomEntryAnswer = { readonly open: RoomEntry } | { readonly closed: RoomClosed };

/** Before the socket: the room's entry for this session, or why it stays closed to them. */
export function readRoomEntry(room: RoomSlate): Promise<RoomEntryAnswer> {
  const path = admitted(roomEntryPath(room.workspace, room.slate), room.key);

  return settle(Effect.gen(function* () {
    const answer = yield* respond(path);
    const closed = CLOSED_BY_STATUS.get(answer.status);

    if (closed !== undefined) return { closed };

    if (!answer.ok) return yield* Effect.die(yield* refusal(answer, "GET", path));

    return { open: v.parse(RoomEntrySchema, yield* Effect.promise(async () => answer.json())) };
  }));
}

/** What a fork of the slate brings: its code, and which parts ran with someone's lend, which the fork does not keep. */
export function readForkPreview(room: RoomSlate): Promise<ForkPreview> {
  return settle(request(ForkPreviewSchema, admitted(roomForkPath(room.workspace, room.slate), room.key)));
}

/** Forks the slate into a workspace of the caller's. */
export function forkRoom(room: RoomSlate, into: string): Promise<Forked> {
  return settle(request(ForkedSchema, admitted(roomForkPath(room.workspace, room.slate), room.key), { method: "POST", json: { workspace: into } }));
}
