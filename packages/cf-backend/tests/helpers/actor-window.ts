import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import * as v from 'valibot';
import type { JsonValue } from '@kinu.run/core';

const FrameSchema = v.looseObject({
  type: v.string(), id: v.optional(v.string()), body: v.optional(v.string()), done: v.optional(v.boolean()),
  error: v.optional(v.unknown()), success: v.optional(v.boolean()), result: v.optional(v.unknown()),
});

/** An RPC's answer as the pane receives it: its result, or the refusal it was sent instead. */
export type WindowReply =
  | { readonly success: true; readonly result: unknown }
  | { readonly success: false; readonly error: string };

/** A pane's socket on one agent of a workspace: what its calls answer, and its turns' streams as each ends. */
export async function actorWindow(upgraded: Response) {
  const socket = upgraded.webSocket;

  if (upgraded.status !== 101 || socket === null) throw new Error(`The window's socket was refused: ${upgraded.status}`);
  const replies = new Map<string, ReturnType<typeof Promise.withResolvers<WindowReply>>>();
  const streams = new Map<string, string>();
  const ended: string[] = [];
  const ending: { readonly count: number; readonly settle: ReturnType<typeof Promise.withResolvers<string>> }[] = [];
  let nextId = 0;

  socket.addEventListener('message', (event) => {
    const raw = v.parse(v.string(), event.data);

    if (!raw.startsWith('{')) return;
    const parsed = v.safeParse(FrameSchema, JSON.parse(raw));

    if (!parsed.success || parsed.output.id === undefined) return;
    const frame = parsed.output;
    const id = frame.id ?? '';

    if (frame.type === 'rpc') {
      if (frame.success === false) replies.get(id)?.resolve({ success: false, error: JSON.stringify(frame.error) });
      else if (frame.success === true) replies.get(id)?.resolve({ success: true, result: frame.result });

      return;
    }

    if (frame.type !== CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE) return;
    const body = `${streams.get(id) ?? ''}${frame.body ?? ''}`;

    streams.set(id, body);

    if (frame.done !== true) return;
    ended.push(body);

    for (const waiter of ending.splice(0)) {
      if (ended.length >= waiter.count) waiter.settle.resolve(ended[waiter.count - 1] ?? body);
      else ending.push(waiter);
    }
  });
  socket.addEventListener('close', () => {
    const closed = new Error('The window closed before the product answered');

    for (const reply of replies.values()) reply.reject(closed);

    for (const waiter of ending.splice(0)) waiter.settle.reject(closed);
  });
  socket.accept();

  return {
    async call(method: string, args: JsonValue[]): Promise<WindowReply> {
      const id = `window-rpc-${nextId++}`;
      const reply = Promise.withResolvers<WindowReply>();

      replies.set(id, reply);
      socket.send(JSON.stringify({ type: 'rpc', id, method, args }));

      return await reply.promise;
    },
    /** The stream of the `count`th turn this window saw end since it opened. */
    turnEnded(count: number): Promise<string> {
      const settle = Promise.withResolvers<string>();

      if (ended.length >= count) settle.resolve(ended[count - 1] ?? '');
      else ending.push({ count, settle });

      return settle.promise;
    },
    close() { socket.close(); },
  };
}
