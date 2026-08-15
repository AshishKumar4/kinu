import { JsonValueSchema, parseJsonValue, type JsonValue } from '@proteus/core';
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
