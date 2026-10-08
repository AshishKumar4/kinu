import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import * as v from 'valibot';
import { READS_CHANGED_EVENT, type JsonValue } from '@kinu.run/core';

export const HireRosterSchema = v.array(v.looseObject({ name: v.string(), status: v.picklist(['idle', 'working', 'awaiting_input', 'dismissed']), lifetime: v.string() }));

const FrameSchema = v.looseObject({
  type: v.string(), id: v.optional(v.string()), body: v.optional(v.string()), done: v.optional(v.boolean()),
  error: v.optional(v.unknown()), success: v.optional(v.boolean()), result: v.optional(v.unknown()),
  reads: v.optional(v.array(v.string())),
});

export async function hireSocket(app: Fetcher, path: string, reply: string) {
  const upgraded = await app.fetch(new Request(`http://localhost${path}`, { headers: { Upgrade: 'websocket' } }));
  const socket = upgraded.webSocket;

  if (upgraded.status !== 101 || socket === null) throw new Error(`Workspace socket refused: ${upgraded.status}`);
  const requests = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>();
  const completion = Promise.withResolvers<void>();
  const replyStreams = new Set<string>();
  const finished = new Set<string>();
  let roster: v.InferOutput<typeof HireRosterSchema> = [];
  const awaitingAnswer: (() => void)[] = [];
  // A window that never asked for completion, as an agent's pane, has no reader its close could fail.
  let completionAsked = false;
  let nextId = 0;

  const rpc = async <T>(method: string, args: JsonValue[], schema: v.GenericSchema<T>): Promise<T> => {
    const id = `client-rpc-${nextId++}`;
    const response = Promise.withResolvers<unknown>();

    requests.set(id, response);
    socket.send(JSON.stringify({ type: 'rpc', id, method, args }));

    return v.parse(schema, await response.promise);
  };

  // What the page does: the reply streamed to its end, and a durable child the roster no longer shows working.
  const settled = (): void => {
    if ([...replyStreams].some((id) => finished.has(id)) && roster.some((child) => child.lifetime === 'durable' && child.status !== 'working')) completion.resolve();
  };

  socket.addEventListener('message', (event) => {
    const raw = v.parse(v.string(), event.data);

    if (!raw.startsWith('{')) return;
    const parsed = v.safeParse(FrameSchema, JSON.parse(raw));

    if (!parsed.success) return;
    const frame = parsed.output;

    if (frame.type === 'rpc' && frame.id !== undefined) {
      const pending = requests.get(frame.id);

      if (frame.success === false) pending?.reject(new Error(JSON.stringify(frame.error)));
      else if (frame.success === true) pending?.resolve(frame.result);
    }

    if (frame.type === READS_CHANGED_EVENT && frame.reads?.includes('listSubordinates') === true) {
      void rpc('listSubordinates', [], HireRosterSchema).then((read) => { roster = read; settled(); }, completion.reject);
    }

    if (frame.type === CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE && frame.id !== undefined) {
      if (frame.error === true) completion.reject(new Error(frame.body ?? 'The product chat turn failed'));

      if (frame.body?.includes(reply)) replyStreams.add(frame.id);

      if (frame.done === true) finished.add(frame.id);

      if (frame.done === true && replyStreams.has(frame.id)) for (const answered of awaitingAnswer.splice(0)) answered();
    }

    settled();
  });
  socket.addEventListener('close', () => {
    if (completionAsked) completion.reject(new Error('Workspace socket closed before its reply and roster completion'));

    for (const request of requests.values()) request.reject(new Error('Workspace socket closed before its RPC reply'));
  });
  socket.accept();

  return {
    rpc,
    send(prompt: string) {
      socket.send(JSON.stringify({ type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST, id: 'hire-msg-client', init: {
        method: 'POST', body: JSON.stringify({ messages: [{ id: 'hire-msg-input', role: 'user', parts: [{ type: 'text', text: prompt }] }], trigger: 'submit-message' }),
      } }));
    },
    completed: () => {
      completionAsked = true;

      return completion.promise;
    },
    /** The next streamed answer carrying the reply, from a turn that ends after this is asked. */
    nextAnswer: () => new Promise<void>((answered) => { awaitingAnswer.push(answered); }),
    close: () => { socket.close(); },
  };
}
