/**
 * One page's connection to a slate's room (room-api.ts): one socket, the session's whole view pushed on every change,
 * and calls that answer only whether they were done. Reconnects after a drop, as the workspace roster does, and stops
 * once the room ends the session or refuses it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Effect } from "effect";
import * as v from "valibot";
import { roomSocketPath, RoomServerFrameSchema, type RoomCall, type RoomView } from "@kinu.run/core";
import { KinuError, tolerate, type ErrorCode } from "@kinu.run/core/obs";

/** What a room's socket must be: a browser WebSocket, or a fake one in the gallery. */
export interface RoomSocket extends EventTarget {
  send(data: string): void;
  close(): void;
}

/** Opens a room's socket by its path on the app's origin. */
export type RoomLive = (path: string) => RoomSocket;

function openRoomSocket(path: string): RoomSocket {
  return new WebSocket(`${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}${path}`);
}

/** A refusal's reason, as the app's errors name it. */
const CODES: Record<"denied" | "missing" | "bad_input" | "unavailable", ErrorCode> = {
  denied: "denied", missing: "missing", bad_input: "bad_input", unavailable: "unavailable",
};

export interface Room {
  /** Null until the room's first view. */
  readonly view: RoomView | null;
  /** False while the socket is down: before its first open, and between a drop and its reopening. */
  readonly connected: boolean;
  /** A call to the room: done, or refused in the room's words. Its effect arrives in the next view. */
  readonly call: (call: RoomCall) => Effect.Effect<void, KinuError>;
}

interface Pending {
  readonly resolve: () => void;
  readonly reject: (error: KinuError) => void;
}

export function useRoom({ workspace, slate, linkKey, live = openRoomSocket }: {
  workspace: string;
  slate: string;
  /** The link's key, which admits a link visitor while the link is on. */
  linkKey: string | null;
  live?: RoomLive;
}): Room {
  const [view, setView] = useState<RoomView | null>(null);
  const [connected, setConnected] = useState(false);
  const socket = useRef<RoomSocket | null>(null);
  const pending = useRef(new Map<number, Pending>());
  const next = useRef(0);

  useEffect(() => {
    const path = `${roomSocketPath(workspace, slate)}${linkKey === null ? "" : `?k=${encodeURIComponent(linkKey)}`}`;
    const calls = pending.current;
    let stopped = false;
    let attempts = 0;
    let timer: number | undefined;

    const dropped = () => {
      for (const call of calls.values()) call.reject(new KinuError("unavailable", "The slate's connection dropped before it answered."));
      calls.clear();
      setConnected(false);
    };

    const connect = (): void => {
      const opened = live(path);
      let open = false;

      socket.current = opened;
      opened.addEventListener("open", () => {
        open = true;
        attempts = 0;
        setConnected(true);
      });
      opened.addEventListener("message", (event: Event) => {
        const data: unknown = event instanceof MessageEvent ? event.data : null;
        const parsed: unknown = tolerate(() => JSON.parse(v.is(v.string(), data) ? data : ""), "malformed-input");
        const frame = v.safeParse(RoomServerFrameSchema, parsed);

        if (!frame.success) return;

        if ("view" in frame.output) {
          // Ended once is ended: the room closes the session, and nothing reconnects it.
          if (frame.output.view.ended !== null) stopped = true;
          setView(frame.output.view);

          return;
        }

        const call = calls.get(frame.output.id);

        if (call === undefined) return;
        calls.delete(frame.output.id);

        const { refusal } = frame.output;

        if (refusal === null) call.resolve();
        else call.reject(new KinuError(CODES[refusal.reason], refusal.message));
      });
      opened.addEventListener("close", () => {
        if (socket.current !== opened) return;
        dropped();

        // A socket refused before it opened is a session the room will not admit; reopening would loop.
        if (stopped || !open) return;
        timer = window.setTimeout(connect, Math.min(30_000, 1_000 * 2 ** attempts));
        attempts += 1;
      });
    };

    connect();

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      socket.current?.close();
      socket.current = null;
      dropped();
    };
  }, [workspace, slate, linkKey, live]);

  const call = useCallback((sent: RoomCall): Effect.Effect<void, KinuError> => Effect.callback<void, KinuError>((resume) => {
    const open = socket.current;

    if (open === null) {
      resume(Effect.fail(new KinuError("unavailable", "The slate isn't connected yet.")));

      return;
    }

    const id = next.current++;

    pending.current.set(id, { resolve: () => resume(Effect.void), reject: (error) => resume(Effect.fail(error)) });
    open.send(JSON.stringify({ id, call: sent }));
  }), []);

  return { view, connected, call };
}
