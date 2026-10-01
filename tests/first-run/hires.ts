/**
 * A hire returns at once (cafab2bfc, SUBAGENTS.md s4): its helper's answer reaches the hirer as a message, in a turn
 * the product opens for it or in one already running. The delegation cases follow it with two reads: the hirer's
 * room, closing turn by turn until the answer is in the hirer's history, and each helper's own ledger, read where the
 * inspector reaches it (`evals/src/helper-address.ts`).
 */
import * as v from 'valibot';
import { RunEventSchema, type JsonObject, type JsonValue, type RunEvent } from '../../packages/core/src/index';
import { helperAddress, type HelperAddress } from '../../evals/src/helper-address';
import { ask, type PublicSocket } from './public-socket';

/**
 * Wait on each turn the hirer's room closes until `arrived` holds; false when the room or the case budget ends first.
 * `closed` is the room's wait registered before the hiring turn was sent, so no close goes unseen.
 */
export async function hirerHeard(room: PublicSocket, closed: Promise<boolean>, arrived: () => Promise<boolean>): Promise<boolean> {
  let next = closed;

  for (;;) {
    if (await arrived()) return true;

    if (!(await next)) return false;
    next = room.turnClosed();
  }
}

const ChildrenPageSchema = v.object({
  page: v.object({ items: v.array(v.looseObject({ name: v.string(), status: v.string(), actorReference: v.nullable(v.object({ actorId: v.string() })) })) }),
});

const RunsPageSchema = v.object({ page: v.object({ items: v.array(v.object({ runId: v.string() })) }) });

const EventsPageSchema = v.object({
  page: v.variant('status', [
    v.object({ status: v.literal('more'), items: v.array(RunEventSchema), next: v.number() }),
    v.object({ status: v.literal('end'), items: v.array(RunEventSchema) }),
  ]),
});

/** One inspection answer, parsed, or the refusal it carried. */
async function inspect<T>(socket: PublicSocket, request: JsonValue, schema: v.GenericSchema<unknown, T>): Promise<T> {
  const answer = await ask(socket, 'inspectSubordinate', [request]);

  if (!answer.ok) throw new Error(`inspectSubordinate ${JSON.stringify(request)} refused: ${answer.failure}`);
  const parsed = v.safeParse(schema, answer.value);

  if (!parsed.success) throw new Error(`inspectSubordinate ${JSON.stringify(request)} answered ${JSON.stringify(answer.value).slice(0, 300)}`);

  return parsed.output;
}

/** `request` for the actor at `address`. */
function at(address: HelperAddress, request: JsonObject): JsonValue {
  return address.actor === undefined
    ? { path: [...address.path], ...request }
    : { path: [...address.path], actor: address.actor, ...request };
}

/** A hire's place for the inspector and its own ledger, by the name the roster of its hirer at `hirer` gives it. */
export async function helperRecord(
  socket: PublicSocket, hirer: HelperAddress, agent: string,
): Promise<{ readonly address: HelperAddress; readonly events: RunEvent[] }> {
  const roster = await inspect(socket, at(hirer, { view: 'children', page: { limit: 200 } }), ChildrenPageSchema);
  const row = roster.page.items.find((item) => item.name === agent);

  if (row === undefined) throw new Error(`the roster at ${JSON.stringify(hirer)} has no hire ${agent}`);
  const address = helperAddress(hirer, row);
  const runs = await inspect(socket, at(address, { view: 'runs', page: { limit: 200 } }), RunsPageSchema);
  const events: RunEvent[] = [];

  for (const { runId } of runs.page.items) {
    for (let since: number | undefined = 0; since !== undefined;) {
      const { page }: v.InferOutput<typeof EventsPageSchema> = await inspect(socket, at(address, { view: 'events', runId, query: { since } }), EventsPageSchema);
      events.push(...page.items);
      since = page.status === 'more' ? page.next : undefined;
    }
  }

  return { address, events };
}
