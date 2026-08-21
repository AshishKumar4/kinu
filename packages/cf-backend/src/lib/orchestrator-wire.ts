import { JsonValueSchema, parseJsonValue, type JsonValue } from '@kinu.run/core';
import * as v from 'valibot';

const RpcEventSchema = v.objectWithRest({
  type: v.string(),
}, JsonValueSchema);

const RunEventWireSchema = v.array(v.objectWithRest({
  eventIndex: v.number(),
  runId: v.string(),
  type: v.string(),
  timestamp: v.string(),
}, JsonValueSchema));

const ScaffoldRunWireSchema = v.object({
  ok: v.boolean(),
  doneEmitted: v.boolean(),
  emitCount: v.number(),
  events: v.array(RpcEventSchema),
  durationMs: v.number(),
  error: v.optional(v.string()),
  finalResult: v.optional(JsonValueSchema),
});

export type RunEventWire = v.InferOutput<typeof RunEventWireSchema>[number];
export type ScaffoldRunWire = v.InferOutput<typeof ScaffoldRunWireSchema>;

export function decodeJsonWire(wire: string): JsonValue {
  return parseJsonValue(wire);
}

export function decodeRunEventWire(wire: string): RunEventWire[] {
  return v.parse(RunEventWireSchema, parseJsonValue(wire));
}

export function decodeScaffoldRunWire(wire: string): ScaffoldRunWire {
  return v.parse(ScaffoldRunWireSchema, parseJsonValue(wire));
}

/**
 * The event index an SSE reconnect resumes AFTER, from its `Last-Event-ID`.
 *
 * Lives beside the wire it is a cursor over, and not inside the route, because
 * the route reaches `agents` and therefore `cloudflare:*`: a subject nothing can
 * import is a subject a suite ends up re-implementing, and the copy this replaced
 * asserted nothing about the shipped rule.
 *
 * `-1` is both the replay-from-the-start sentinel and the floor. Any other
 * negative, any fraction, and anything unparseable replays from the start rather
 * than seeking to a position no event can occupy — a NaN cursor compares false
 * against every index, so it would re-deliver the whole run on each reconnect.
 *
 * A BLANK header is absent, not zero. `Number('')` is 0, so the previous rule
 * read `Last-Event-ID:` with no value — what a client sends when its last-event
 * buffer is empty — as "I have seen event 0" and resumed AFTER it, silently
 * dropping the first event of the run. The copy of this rule that used to live in
 * a test never exercised the empty string, which is how it survived.
 */
export function resumeIndexFromLastEventId(lastEventId: string | null): number {
  if (lastEventId === null || lastEventId.trim() === '') return -1;
  const index = Number(lastEventId);
  return Number.isInteger(index) && index >= -1 ? index : -1;
}
