import * as v from 'valibot';
import { parseProtocolMessage } from 'agents/chat';
import { JsonObjectSchema, type ActorClaimStore } from '@kinu.run/core';

const Body = v.looseObject({
  messages: v.array(v.looseObject({ id: v.pipe(v.string(), v.nonEmpty()), role: v.string() })),
  trigger: v.optional(v.string()),
});

/** Think removes messages from customBody before queuing. Persist their IDs
 * first, and pass a server-owned token through the custom body it retains. */
export function bindChatInput(message: string, claims: ActorClaimStore, hasMessage: (id: string) => boolean): string {
  const event = parseProtocolMessage(message);

  if (event?.type !== 'chat-request' || event.init?.method !== 'POST' || !event.init.body) return message;
  const decoded = v.safeParse(v.pipe(v.string(), v.parseJson(), JsonObjectSchema), event.init.body);

  if (!decoded.success) return message;
  const body = decoded.output;
  // Never accept a client's claim that it owns a different request's input.
  delete body.kinuRequestId;
  const parsed = v.safeParse(Body, body);

  const userIds = parsed.success ? parsed.output.messages
    .filter((input) => input.role === 'user').map((input) => input.id) : [];

  const ids = userIds.filter((id) => !hasMessage(id) && claims.requestForInput(id) === null);

  if (body.trigger !== 'regenerate-message') {
    if (ids.length > 0) {
      const requestId = crypto.randomUUID();
      claims.recordInput(requestId, ids);
      body.kinuRequestId = requestId;
    } else {
      // A reconnect can replay an intake already persisted before eviction.
      // Resolve its own last input ID, never the workspace's newest user row.
      const lastInput = userIds.at(-1);
      const pending = lastInput === undefined ? null : claims.requestForInput(lastInput);

      if (pending !== null) body.kinuRequestId = pending;
    }
  }

  return JSON.stringify({
    ...v.parse(v.pipe(v.string(), v.parseJson(), JsonObjectSchema), message),
    init: { ...event.init, body: JSON.stringify(body) },
  });
}
