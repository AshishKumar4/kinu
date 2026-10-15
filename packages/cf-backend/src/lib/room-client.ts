/** A slate room's HTTP routes (room-api.ts): whether a session may open it, and forking it. The socket is use-room's. */
import { Effect } from "effect";
import * as v from "valibot";
import { ForkedSchema, ForkPreviewSchema, roomEntryPath, roomForkPath, RoomEntrySchema, type Forked, type ForkPreview, type RoomEntry } from "@kinu.run/core";
import { settle } from "@kinu.run/core/obs";
import { refusal, request, respond } from "./http";

/** Why the room will not open for this session, by what its entry answered. */
export type RoomClosed = "sign-in" | "not-shared" | "missing" | "stopped";

const CLOSED_BY_STATUS = new Map<number, RoomClosed>([[401, "sign-in"], [403, "not-shared"], [404, "missing"], [410, "stopped"]]);

export type RoomEntryAnswer = { readonly open: RoomEntry } | { readonly closed: RoomClosed };

/** Before the socket: the room's entry for this session, or why it stays closed to them. */
export function readRoomEntry(workspace: string, slate: string, linkKey: string | null): Promise<RoomEntryAnswer> {
  const path = `${roomEntryPath(workspace, slate)}${linkKey === null ? "" : `?k=${encodeURIComponent(linkKey)}`}`;

  return settle(Effect.gen(function* () {
    const answer = yield* respond(path);
    const closed = CLOSED_BY_STATUS.get(answer.status);

    if (closed !== undefined) return { closed };

    if (!answer.ok) return yield* Effect.die(yield* refusal(answer, "GET", path));

    return { open: v.parse(RoomEntrySchema, yield* Effect.promise(async () => answer.json())) };
  }));
}

/** What a fork of the slate brings: its code, and which parts ran with someone's lend, which the fork does not keep. */
export function readForkPreview(workspace: string, slate: string): Promise<ForkPreview> {
  return settle(request(ForkPreviewSchema, roomForkPath(workspace, slate)));
}

/** Forks the slate into a workspace of the caller's. */
export function forkRoom(workspace: string, slate: string, into: string): Promise<Forked> {
  return settle(request(ForkedSchema, roomForkPath(workspace, slate), { method: "POST", json: { workspace: into } }));
}
