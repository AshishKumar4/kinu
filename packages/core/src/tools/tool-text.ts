/**
 * An agent's evolved tool text (docs/EVOLUTION-REDESIGN.md §3): a built-in tool's description, or the descriptions of
 * its input fields. Only words move: types, required fields, enum values and the validator stay the bundled schema's.
 */
import { asSchema, jsonSchema, type ToolSet } from 'ai';
import * as v from 'valibot';
import { JsonObjectSchema, type JsonObject } from '../utils/json';

export interface ToolTextOverrides {
  readonly descriptions: Readonly<Record<string, string>>;
  readonly fields: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const PropertiesSchema = v.record(v.string(), JsonObjectSchema);

function properties(schema: JsonObject): Record<string, JsonObject> {
  const parsed = v.safeParse(PropertiesSchema, schema.properties);

  return parsed.success ? parsed.output : {};
}

/** The top-level input fields' descriptions, as the model is sent them. */
export function fieldDescriptions(inputSchema: ToolSet[string]['inputSchema']): Record<string, string> {
  const schema = v.parse(JsonObjectSchema, asSchema(inputSchema).jsonSchema);

  return Object.fromEntries(Object.entries(properties(schema)).flatMap(([name, field]) => {
    const described = v.safeParse(v.string(), field.description);

    return described.success ? [[name, described.output]] : [];
  }));
}

function reworded(entry: ToolSet[string], fields: Readonly<Record<string, string>>): ToolSet[string] {
  const declared = asSchema(entry.inputSchema);
  const schema = v.parse(JsonObjectSchema, declared.jsonSchema);
  const own = properties(schema);

  const sent = Object.fromEntries(Object.entries(own).map(([name, field]) =>
    [name, fields[name] === undefined ? field : { ...field, description: fields[name] }]));

  const validate = declared.validate?.bind(declared);
  const text = { ...schema, properties: sent };

  return { ...entry, inputSchema: validate === undefined ? jsonSchema<JsonObject>(text) : jsonSchema(text, { validate }) };
}

/** Untouched tools keep their identity, so an agent with no evolved text sends the bundled bytes. */
export function withToolText(tools: ToolSet, text: ToolTextOverrides): ToolSet {
  return Object.fromEntries(Object.entries(tools).map(([name, entry]) => {
    const description = text.descriptions[name];
    const fields = text.fields[name];
    // A provider's own tool carries its provider's description, never one of ours.
    const described = description === undefined || 'id' in entry ? entry : { ...entry, description };

    return [name, fields === undefined ? described : reworded(described, fields)];
  }));
}
