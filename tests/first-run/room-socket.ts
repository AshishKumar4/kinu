/** A slate room's socket as a first-run row drives it: the person's session cookie names them, `k` admits a link visitor. */
import * as v from 'valibot';
import { RoomServerFrameSchema, type RoomCall, type RoomServerFrame, type RoomView } from '@kinu.run/core';
import { HEADER_WEBSOCKET } from '../../evals/src/session-protocol';

/** A room socket: calls answered by id, and every view the room pushed. */
export interface RoomSocket {
  call(call: RoomCall): Promise<RoomServerFrame>;
  /** The first view the room pushed that `holds`; the case's own deadline bounds the wait. */
  view(holds: (view: RoomView) => boolean): Promise<RoomView>;
  close(): void;
}

export function openRoom(origin: string, headers: Readonly<Record<string, string>>, path: string): Promise<RoomSocket> {
  const url = new URL(path, origin);

  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new HEADER_WEBSOCKET(url.toString(), { headers: { ...headers } });
  const views: RoomView[] = [];
  const answers = new Map<number, { resolve: (frame: RoomServerFrame) => void; reject: (error: Error) => void }>();
  let ended: Error | null = null;
  const waiting = new Set<() => void>();
  let next = 0;

  socket.addEventListener('message', (event: MessageEvent) => {
    const frame = v.parse(RoomServerFrameSchema, JSON.parse(String(event.data)));

    if ('view' in frame) views.push(frame.view);
    else answers.get(frame.id)?.resolve(frame);

    for (const wake of waiting) wake();
  });

  const opened = Promise.withResolvers<RoomSocket>();

  // A socket that ends answers every call still waiting with its end, so no caller's cleanup waits forever.
  const end = (error: Error): void => {
    ended = error;
    opened.reject(error);

    for (const answer of answers.values()) answer.reject(error);
    answers.clear();

    for (const wake of waiting) wake();
  };

  socket.addEventListener('error', () => { end(new Error(`The room socket at ${path} failed`)); });
  socket.addEventListener('close', () => { end(new Error(`The room socket at ${path} closed`)); });
  socket.addEventListener('open', () => {
    opened.resolve({
      call: async (call) => {
        const answered = Promise.withResolvers<RoomServerFrame>();
        const id = next++;

        if (ended !== null) throw ended;
        answers.set(id, answered);
        socket.send(JSON.stringify({ id, call }));

        return await answered.promise;
      },
      view: async (holds) => {
        for (;;) {
          const found = views.find(holds);

          if (found !== undefined) return found;

          if (ended !== null) throw ended;
          // The next frame the room pushes.
          const woken = Promise.withResolvers<void>();
          const done = () => { waiting.delete(done); woken.resolve(); };

          waiting.add(done);
          await woken.promise;
        }
      },
      close: () => { socket.close(); },
    });
  });

  return opened.promise;
}
