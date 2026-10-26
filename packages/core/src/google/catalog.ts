// The Google APIs the connection reaches, from the pinned table (`methods.generated.json`): find a method by what it
// does, describe one as TypeScript, and build the request a call makes. No method has code of its own.
import { Effect } from 'effect';
import * as v from 'valibot';
import { GoogleApiSchema, type GoogleApi, type GoogleMethod, type GoogleProperty } from './table';
import { KinuError } from '../obs/index';
import type { JsonValue } from '../utils/json';

/** The whole table, half a megabyte most turns never ask for: imported on its first use, so no Worker's startup links
 *  it (L27). */
const importTable = async () => (await import('./methods.generated.json')).default;

type Table = Awaited<ReturnType<typeof importTable>>;

type ApiName = keyof Table;

let imported: Promise<Table> | undefined;

function pinnedTable(): Effect.Effect<Table> {
  return Effect.promise(() => (imported ??= importTable()));
}

function isApiName(table: Table, name: string): name is ApiName {
  return Object.hasOwn(table, name);
}

const read = new Map<string, GoogleApi>();

/** An API's table, checked on first use. */
function apiNamed(table: Table, name: string): GoogleApi | null {
  if (!isApiName(table, name)) return null;
  const held = read.get(name) ?? v.parse(GoogleApiSchema, table[name]);

  read.set(name, held);

  return held;
}

/** Where each pinned API answers: the only addresses the connection's token is sent to. */
export function googleBaseUrls(): Effect.Effect<string[]> {
  return Effect.map(pinnedTable(), (table) => Object.values(table).map((api) => api.baseUrl));
}

/** A method as the catalog holds it, with the API it belongs to. */
export interface GoogleMethodRef {
  readonly id: string;
  readonly api: GoogleApi;
  readonly method: GoogleMethod;
}

/** `gmail.users.messages.list` and the like; null for an id no reached API has. */
function googleMethod(table: Table, id: string): GoogleMethodRef | null {
  const api = apiNamed(table, id.split('.')[0] ?? '');
  const method = api?.methods[id];

  return api === null || method === undefined ? null : { id, api, method };
}

/** A read is a GET; anything else sends, changes or deletes something at Google. */
export function googleWrites(method: GoogleMethod): boolean {
  return method.verb !== 'GET';
}

export interface GoogleFound {
  readonly id: string;
  readonly kind: 'read' | 'write';
  readonly d: string;
}

/** Methods for what `query` asks, best first: each of its words found in a method's id counts twice its description. */
export function searchGoogle(query: string, limit: number): Effect.Effect<GoogleFound[]> {
  return Effect.map(pinnedTable(), (table) => ranked(table, query, limit));
}

function ranked(table: Table, query: string, limit: number): GoogleFound[] {
  const words = query.toLowerCase().split(/[^a-z0-9]+/u).filter((word) => word.length > 1);

  const scored = Object.keys(table).flatMap((name) => Object.entries(apiNamed(table, name)?.methods ?? {}).map(([id, method]) => {
    const said = (method.d ?? '').toLowerCase();
    const named = id.toLowerCase();

    return { id, method, score: words.reduce((sum, word) => sum + (named.includes(word) ? 2 : 0) + (said.includes(word) ? 1 : 0), 0) };
  }));

  return scored
    .filter((found) => found.score > 0)
    .sort((a, b) => b.score - a.score || a.id.length - b.id.length)
    .slice(0, limit)
    .map(({ id, method }) => ({ id, kind: googleWrites(method) ? 'write' : 'read', d: method.d ?? '' }));
}

/** How many of a method's types `describe` writes out; the rest are named, each its own `describe`. */
const DESCRIBED_TYPES = 12;

function typeOf(p: GoogleProperty): string {
  if (p.$ref !== undefined) return p.$ref;

  if (p.enum !== undefined) return p.enum.map((member) => JSON.stringify(member)).join(' | ');

  if (p.type === 'array') return `${p.items === undefined ? 'unknown' : wrapped(typeOf(p.items))}[]`;

  if (p.props !== undefined) return `{ ${Object.entries(p.props).map(([name, inner]) => `${name}?: ${typeOf(inner)}`).join('; ')} }`;

  if (p.additionalProperties !== undefined) return `Record<string, ${typeOf(p.additionalProperties)}>`;

  // 64-bit integers travel as strings.
  if (p.type === 'string' || p.format === 'int64' || p.format === 'uint64') return 'string';

  if (p.type === 'integer' || p.type === 'number') return 'number';

  return p.type === 'boolean' ? 'boolean' : 'unknown';
}

function wrapped(type: string): string {
  return type.includes(' | ') ? `(${type})` : type;
}

function refsOf(p: GoogleProperty): string[] {
  return [
    ...(p.$ref === undefined ? [] : [p.$ref]),
    ...(p.items === undefined ? [] : refsOf(p.items)),
    ...(p.additionalProperties === undefined ? [] : refsOf(p.additionalProperties)),
    ...Object.values(p.props ?? {}).flatMap(refsOf),
  ];
}

function docLine(said: string | undefined, indent: string): string[] {
  return said === undefined ? [] : [`${indent}/** ${said.replaceAll('*/', '* /')} */`];
}

function interfaceOf(api: GoogleApi, name: string): string[] {
  const schema = api.schemas[name];

  if (schema === undefined) return [`type ${name} = unknown;`];

  return [
    ...docLine(schema.d, ''),
    `interface ${name} {`,
    ...Object.entries(schema.props).flatMap(([prop, p]) => [...docLine(p.d, '  '), `  ${p.readOnly === true ? 'readonly ' : ''}${prop}?: ${typeOf(p)};`]),
    '}',
  ];
}

/** The types `roots` reach, nearest first, the first `DESCRIBED_TYPES` written out and the rest named. */
function typesFrom(table: Table, api: GoogleApi, roots: readonly string[]): string[] {
  const seen = [...new Set(roots)];

  for (let at = 0; at < seen.length && seen.length < DESCRIBED_TYPES * 4; at += 1) {
    for (const ref of Object.values(api.schemas[seen[at] ?? '']?.props ?? {}).flatMap(refsOf)) if (!seen.includes(ref)) seen.push(ref);
  }

  const apiName = Object.keys(table).find((name) => apiNamed(table, name) === api) ?? '';
  const named = seen.slice(DESCRIBED_TYPES);

  return [
    ...seen.slice(0, DESCRIBED_TYPES).flatMap((name) => ['', ...interfaceOf(api, name)]),
    ...(named.length === 0 ? [] : ['', `// Also: ${named.map((name) => `${apiName}.${name}`).join(', ')}. google.describe each.`]),
  ];
}

function methodDeclaration(table: Table, found: GoogleMethodRef): string {
  const { api, method } = found;
  const writes = googleWrites(method);
  // Required first, as a reader fills them in.
  const params = Object.entries(method.params).sort(([, a], [, b]) => Number(b.required === true) - Number(a.required === true));
  const required = params.some(([, p]) => p.required === true);
  const answer = `{ status: number; body: ${method.response ?? 'null'} }`;

  return [
    ...docLine(`${method.d ?? found.id} (${api.title}, ${method.verb})`, ''),
    `google.${writes ? 'write' : 'read'}(${JSON.stringify(found.id)}, {`,
    `  params${required ? '' : '?'}: {`,
    ...params.flatMap(([name, p]) => [
      ...docLine(p.d, '    '),
      `    ${JSON.stringify(name)}${p.required === true ? '' : '?'}: ${wrapped(typeOf({ type: p.type, ...(p.enum !== undefined && { enum: p.enum }), ...(p.format !== undefined && { format: p.format }) }))}${p.repeated === true ? '[]' : ''};`,
    ]),
    '  };',
    ...(method.request === undefined ? [] : ['  /** The request body. */', `  body: ${method.request};`]),
    writes
      ? `}): Promise<{ status: 'done'; answer: ${answer} } | { status: 'asked' | 'denied'; approval: string }>;`
      : `}): Promise<${answer}>;`,
    ...typesFrom(table, api, [method.request, method.response].filter((name) => name !== undefined)),
  ].join('\n');
}

/** A method as TypeScript, or one of an API's types named `api.Type` (`gmail.Message`); null for neither. */
export function describeGoogle(name: string): Effect.Effect<string | null> {
  return Effect.map(pinnedTable(), (table) => {
    const method = googleMethod(table, name);

    if (method !== null) return methodDeclaration(table, method);
    const [apiName = '', type = ''] = name.split('.', 2);
    const api = apiNamed(table, apiName);

    return api === null || api.schemas[type] === undefined ? null : typesFrom(table, api, [type]).join('\n').trim();
  });
}

/** A call as it goes to Google. */
export interface GoogleRequest {
  readonly method: GoogleMethod['verb'];
  readonly url: string;
  readonly body?: string;
}

function textOf(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** A path template as the routes it serves: `{name}` one segment, `{+name}` one or more. */
function routePattern(path: string): RegExp {
  const parts = path.split(/(\{\+?[^}]+\})/u).map((part) => {
    if (part.startsWith('{+')) return '.+';

    return part.startsWith('{') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  });

  return new RegExp(`^${parts.join('')}$`, 'u');
}

/** How many of a template's characters are its own, not a parameter's: the more, the more exactly it names a route. */
function literalLength(path: string): number {
  return path.replace(/\{[^}]+\}/gu, '').length;
}

/**
 * Another method an expanded path reaches at Google: one with this verb whose template matches it more exactly than the
 * called method's, so a value that spells another route (`files/trash`, `drive.files.emptyTrash`) is read as that route.
 * Templates alike (`v1/{+resourceName}` for a person and a contact group) are the called method's own.
 */
function otherRouteReached(found: GoogleMethodRef, path: string): string | null {
  const own = literalLength(found.method.path);

  const closer = Object.entries(found.api.methods)
    .find(([, method]) => method.verb === found.method.verb && literalLength(method.path) > own && routePattern(method.path).test(path));

  return closer?.[0] ?? null;
}

/** Expands `{name}` and `{+name}` (RFC 6570; reserved, so a resource name keeps its slashes). */
function expandedPath(path: string, values: ReadonlyMap<string, JsonValue>): string {
  return path.replace(/\{(\+?)([^}]+)\}/gu, (_whole, reserved: string, name: string) => {
    const value = textOf(values.get(name) ?? '');

    return reserved === '+' ? encodeURI(value) : encodeURIComponent(value);
  });
}

/**
 * The request a call of `id` makes with `params` and `body`: path parameters filled in, the rest as its query. A
 * parameter the method does not take, or a required one missing, is refused naming the method's own.
 */
export function googleRequest(
  id: string, params: Readonly<Record<string, JsonValue>>, body: JsonValue | undefined,
): Effect.Effect<{ readonly found: GoogleMethodRef; readonly request: GoogleRequest }, KinuError> {
  return Effect.gen(function* () {
    const found = googleMethod(yield* pinnedTable(), id);

    if (found === null) return yield* new KinuError('missing', `No Google method is named ${id}. Find one with google.search.`);
    const { method } = found;
    const unknown = Object.keys(params).filter((name) => method.params[name] === undefined);

    if (unknown.length > 0) {
      return yield* new KinuError('bad_input', `${id} takes no ${unknown.join(', ')}; it takes ${Object.keys(method.params).join(', ') || 'no parameters'}.`);
    }

    const missing = Object.entries(method.params).filter(([name, p]) => p.required === true && params[name] === undefined).map(([name]) => name);

    if (missing.length > 0) return yield* new KinuError('bad_input', `${id} needs ${missing.join(', ')}.`);

    if (method.request === undefined && body !== undefined) return yield* new KinuError('bad_input', `${id} takes no body.`);
    const dotted = Object.entries(method.params).find(([name, p]) => p.in === 'path' && /(^|\/)\.{1,2}(\/|$)/u.test(textOf(params[name] ?? '')));

    if (dotted !== undefined) return yield* new KinuError('bad_input', `${id}: ${dotted[0]} may not be . or .., which would name another path.`);
    const path = expandedPath(method.path, new Map(Object.entries(params)));
    const other = otherRouteReached(found, path);

    if (other !== null) return yield* new KinuError('bad_input', `${id} with these parameters is the route of ${other} at Google; call that method by its own name.`);
    const url = new URL(path, found.api.baseUrl);

    for (const [name, value] of Object.entries(params)) {
      if (method.params[name]?.in !== 'query') continue;

      for (const one of Array.isArray(value) ? value : [value]) url.searchParams.append(name, textOf(one));
    }

    return { found, request: { method: method.verb, url: url.toString(), ...(body !== undefined && { body: JSON.stringify(body) }) } };
  });
}
