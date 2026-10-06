// An MCP server registration and the rules an owner's input is held to; transport is each backend's.

import { Effect } from 'effect';
import * as v from 'valibot';
import { KinuError, settleSync, tolerate } from '../obs/index';
import { JsonArraySchema, JsonObjectSchema, type JsonObject, type JsonValue } from '../utils/json';
import { mcpPresetById, type McpPreset, type McpPresetId } from './presets';

export type McpTransport = 'auto' | 'sse' | 'streamable-http';

export interface McpServerInput {
  name: string;
  serverUrl: string;
  transport?: McpTransport;
  headers?: Record<string, string>;
  allowedTools?: string[];
  /** Absent on a custom server; when present, the preset's name, serverUrl and transport win. */
  presetId?: McpPresetId;
}

const McpTransportSchema = v.picklist(['auto', 'sse', 'streamable-http']);

function isJsonRecord<Value>(value: Value): value is Value & JsonObject {
  return !Array.isArray(value) && v.is(JsonObjectSchema, value);
}

const RawMcpServerInputSchema = v.custom<JsonObject>(isJsonRecord, 'Expected a JSON object.');

const HeaderRecordSchema = v.pipe(
  RawMcpServerInputSchema,
  v.record(v.string(), v.string()),
);

const StringArraySchema = v.array(v.string());

/** One spelling per endpoint: fragment dropped; path and query kept (`/mcp` and `/mcp/` differ). */
function canonicalMcpUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.hash = '';

  return url.href;
}

/** https, or http on loopback; `allowedTools: []` exposes nothing; a preset's catalog fields win. */
export function validateMcpServerInput(input: JsonValue): McpServerInput {
  return settleSync(Effect.gen(function* () {
    const parsedInput = v.safeParse(RawMcpServerInputSchema, input);

    if (!parsedInput.success) return yield* new KinuError('bad_input', 'Body must be a JSON object.');
    const obj = parsedInput.output;
    const preset = yield* presetOf(obj.presetId);
    const name = preset ? preset.title : yield* serverName(obj.name);
    const parsedServerUrl = v.safeParse(v.string(), obj.serverUrl);

    if (!preset && (!parsedServerUrl.success || !parsedServerUrl.output.trim())) {
      return yield* new KinuError('bad_input', '`serverUrl` is required.');
    }

    const serverUrl = preset ? preset.serverUrl : v.parse(v.string(), obj.serverUrl);

    if (!URL.canParse(serverUrl)) return yield* new KinuError('bad_input', '`serverUrl` is not a valid URL.');
    const parsed = new URL(serverUrl);
    const isHttps = parsed.protocol === 'https:';

    const isLocalDev = parsed.protocol === 'http:' && (
      parsed.hostname === 'localhost'
      || parsed.hostname === '127.0.0.1'
      || parsed.hostname === '[::1]'
      || parsed.hostname === '::1'
    );

    if (!isHttps && !isLocalDev) {
      return yield* new KinuError('bad_input', '`serverUrl` must use https:// (http:// allowed only for localhost).');
    }

    // Credentials belong in sealed `headers`: `serverUrl` is plaintext.
    if (parsed.username !== '' || parsed.password !== '') {
      return yield* new KinuError('bad_input', '`serverUrl` must not carry a username or password: put credentials in `headers`.');
    }

    const parsedTransport = v.safeParse(v.nullish(McpTransportSchema), obj.transport);

    if (!parsedTransport.success) {
      return yield* new KinuError('bad_input', "`transport` must be one of 'auto', 'sse', 'streamable-http'.");
    }

    const transport = preset ? preset.transport : (parsedTransport.output ?? 'auto');
    const headers = obj.headers === undefined || obj.headers === null ? undefined : yield* headerRecord(obj.headers);
    const allowedTools = obj.allowedTools === undefined || obj.allowedTools === null ? undefined : yield* toolAllowlist(obj.allowedTools);

    return {
      name, serverUrl: canonicalMcpUrl(serverUrl), transport, headers, allowedTools,
      presetId: preset?.id,
    };
  }));
}

function headerRecord(value: JsonValue): Effect.Effect<Record<string, string> | undefined, KinuError> {
  return Effect.gen(function* () {
    const parsedHeaderObject = v.safeParse(RawMcpServerInputSchema, value);

    if (!parsedHeaderObject.success) return yield* new KinuError('bad_input', '`headers` must be a flat object of string->string.');
    const collected: Record<string, string> = {};

    for (const [k, entry] of Object.entries(parsedHeaderObject.output)) {
      if (k.length === 0 || k.length > 128) return yield* new KinuError('bad_input', `headers.${k}: key length out of range.`);
      const parsedValue = v.safeParse(v.string(), entry);

      if (!parsedValue.success) return yield* new KinuError('bad_input', `headers.${k} must be a string.`);
      collected[k] = parsedValue.output;
    }

    return Object.keys(collected).length > 0 ? collected : undefined;
  });
}

function toolAllowlist(value: JsonValue): Effect.Effect<string[], KinuError> {
  return Effect.gen(function* () {
    const parsedAllowedTools = v.safeParse(JsonArraySchema, value);

    if (!parsedAllowedTools.success) {
      return yield* new KinuError('bad_input', '`allowedTools` must be a string[] (or omitted to allow all).');
    }

    const allowedTools: string[] = [];

    for (const toolName of parsedAllowedTools.output) {
      const parsedToolName = v.safeParse(v.pipe(v.string(), v.nonEmpty()), toolName);

      if (!parsedToolName.success) return yield* new KinuError('bad_input', '`allowedTools` entries must be non-empty strings.');
      allowedTools.push(parsedToolName.output);
    }

    return allowedTools;
  });
}

/** Absent: a custom server. */
function presetOf(presetId: JsonValue | undefined): Effect.Effect<McpPreset | undefined, KinuError> {
  if (presetId === undefined || presetId === null) return Effect.succeed(undefined);
  const parsedPresetId = v.safeParse(v.string(), presetId);

  if (!parsedPresetId.success) return Effect.fail(new KinuError('bad_input', '`presetId` must be a string.'));
  const preset = mcpPresetById(parsedPresetId.output);

  return preset ? Effect.succeed(preset) : Effect.fail(new KinuError('bad_input', `Unknown MCP preset '${parsedPresetId.output}'.`));
}

function serverName(name: JsonValue): Effect.Effect<string, KinuError> {
  const parsed = v.safeParse(v.string(), name);

  if (!parsed.success || !parsed.output.trim()) return Effect.fail(new KinuError('bad_input', '`name` is required.'));
  const trimmed = parsed.output.trim();

  return trimmed.length > 64 ? Effect.fail(new KinuError('bad_input', '`name` must be <= 64 characters.')) : Effect.succeed(trimmed);
}

export function validateMcpServerName(name: JsonValue): string {
  return settleSync(serverName(name));
}

/** Null when the column is unset or fails the schema. */
function jsonColumn<Schema extends v.GenericSchema>(raw: string | null | undefined, schema: Schema): v.InferOutput<Schema> | null {
  if (!raw) return null;
  const parsed = v.safeParse(schema, tolerate(() => JSON.parse(raw), 'malformed-input'));

  return parsed.success ? parsed.output : null;
}

/** Null means "allow all". */
export function parseAllowedTools(raw: string | null | undefined): string[] | null {
  return jsonColumn(raw, StringArraySchema);
}

/** Null means "no custom headers". */
export function parseMcpHeaders(raw: string | null | undefined): Record<string, string> | null {
  return jsonColumn(raw, HeaderRecordSchema);
}
