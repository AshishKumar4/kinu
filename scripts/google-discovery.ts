// Pins the Google APIs the Google connection reaches: fetches each one's Discovery document and writes the compact
// method table `packages/core/src/google/methods.generated.json` that `google.search`, `describe`, `read` and `write`
// are served from. Each API records the document's revision and sha256, so a refresh shows as a diff of that file.
//
//   bun scripts/google-discovery.ts
//
// Only methods the connection's scopes reach are kept (`GOOGLE_CONNECTION_SCOPES`); a method needing another scope
// would only ever answer 403. Of the API-wide parameters each method takes, `fields` is kept (some methods answer
// nothing without it, Drive's `about.get`); the rest are transport's (`alt`, `key`, `callback`). Descriptions are cut
// to their opening.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import * as v from 'valibot';
import { GOOGLE_CONNECTION_SCOPES } from '../packages/core/src/providers/google-connection';
import { GoogleApiSchema, type GoogleApi, type GoogleMethod, type GoogleProperty } from '../packages/core/src/google/table';

const OUT = new URL('../packages/core/src/google/methods.generated.json', import.meta.url);

/** The APIs, by the name a method id begins with, and the version pinned. */
const APIS = [
  ['gmail', 'v1', 'Gmail'],
  ['calendar', 'v3', 'Google Calendar'],
  ['drive', 'v3', 'Google Drive'],
  ['docs', 'v1', 'Google Docs'],
  ['sheets', 'v4', 'Google Sheets'],
  ['slides', 'v1', 'Google Slides'],
  ['people', 'v1', 'Google People (contacts)'],
] as const;

interface DiscoveryProperty {
  readonly type?: string;
  readonly $ref?: string;
  readonly format?: string;
  readonly enum?: string[];
  readonly readOnly?: boolean;
  readonly description?: string;
  readonly items?: DiscoveryProperty;
  readonly additionalProperties?: DiscoveryProperty | boolean;
  readonly properties?: Record<string, DiscoveryProperty>;
}

const DiscoveryPropertySchema: v.GenericSchema<DiscoveryProperty> = v.object({
  type: v.optional(v.string()), $ref: v.optional(v.string()), format: v.optional(v.string()), enum: v.optional(v.array(v.string())),
  readOnly: v.optional(v.boolean()), description: v.optional(v.string()),
  items: v.optional(v.lazy(() => DiscoveryPropertySchema)),
  additionalProperties: v.optional(v.union([v.boolean(), v.lazy(() => DiscoveryPropertySchema)])),
  properties: v.optional(v.record(v.string(), v.lazy(() => DiscoveryPropertySchema))),
});

const DiscoveryParameterSchema = v.object({
  type: v.optional(v.string()), location: v.optional(v.picklist(['path', 'query'])), required: v.optional(v.boolean()), repeated: v.optional(v.boolean()),
  enum: v.optional(v.array(v.string())), format: v.optional(v.string()), description: v.optional(v.string()),
});

const DiscoveryMethodSchema = v.object({
  id: v.string(), httpMethod: v.picklist(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']), path: v.string(), description: v.optional(v.string()),
  parameters: v.optional(v.record(v.string(), DiscoveryParameterSchema)),
  request: v.optional(v.object({ $ref: v.string() })), response: v.optional(v.object({ $ref: v.string() })),
  scopes: v.optional(v.array(v.string())), supportsMediaDownload: v.optional(v.boolean()),
});

type DiscoveryMethod = v.InferOutput<typeof DiscoveryMethodSchema>;

interface DiscoveryResource {
  readonly methods?: Record<string, DiscoveryMethod>;
  readonly resources?: Record<string, DiscoveryResource>;
}

const DiscoveryResourceSchema: v.GenericSchema<DiscoveryResource> = v.object({
  methods: v.optional(v.record(v.string(), DiscoveryMethodSchema)),
  resources: v.optional(v.record(v.string(), v.lazy(() => DiscoveryResourceSchema))),
});

/** The API-wide parameters a call may name; every other one is the transport's own. */
const SHARED_PARAMETERS = ['fields'] as const;

const DiscoveryDocumentSchema = v.object({
  revision: v.string(), rootUrl: v.string(), servicePath: v.string(),
  parameters: v.optional(v.record(v.string(), DiscoveryParameterSchema)),
  methods: v.optional(v.record(v.string(), DiscoveryMethodSchema)),
  resources: v.optional(v.record(v.string(), DiscoveryResourceSchema)),
  schemas: v.optional(v.record(v.string(), v.object({ description: v.optional(v.string()), properties: v.optional(v.record(v.string(), DiscoveryPropertySchema)) }))),
});

const granted = new Set(GOOGLE_CONNECTION_SCOPES.split(' '));

/** The opening of `text`: whole sentences until one says something ("Required." alone does not), within `cap`. */
function opening(text: string | undefined, cap: number): { readonly d?: string } {
  let said = '';

  for (const sentence of (text ?? '').replace(/\s+/gu, ' ').trim().split(/(?<=[.!?])\s+/u)) {
    said = `${said} ${sentence}`.trim();

    if (said.length >= 30) break;
  }

  return said === '' ? {} : { d: said.slice(0, cap) };
}

function methodsOf(resource: DiscoveryResource): DiscoveryMethod[] {
  return [...Object.values(resource.methods ?? {}), ...Object.values(resource.resources ?? {}).flatMap(methodsOf)];
}

function property(p: DiscoveryProperty): GoogleProperty {
  const nested = typeof p.additionalProperties === 'object' ? p.additionalProperties : undefined;

  return {
    ...(p.type !== undefined && { type: p.type }), ...(p.$ref !== undefined && { $ref: p.$ref }), ...(p.format !== undefined && { format: p.format }),
    ...(p.enum !== undefined && { enum: p.enum }), ...(p.readOnly === true && { readOnly: true }),
    ...(p.items !== undefined && { items: property(p.items) }), ...(nested !== undefined && { additionalProperties: property(nested) }),
    ...(p.properties !== undefined && { props: Object.fromEntries(Object.entries(p.properties).map(([name, inner]) => [name, property(inner)])) }),
    ...opening(p.description, 100),
  };
}

function method(m: DiscoveryMethod, shared: DiscoveryMethod['parameters']): GoogleMethod {
  return {
    verb: m.httpMethod,
    path: m.path,
    ...opening(m.description, 200),
    params: Object.fromEntries(Object.entries({ ...shared, ...m.parameters }).map(([name, p]) => [name, {
      type: p.type ?? 'string', in: p.location ?? 'query',
      ...(p.required === true && { required: true as const }), ...(p.repeated === true && { repeated: true as const }),
      ...(p.enum !== undefined && { enum: p.enum }), ...(p.format !== undefined && { format: p.format }), ...opening(p.description, 120),
    }])),
    ...(m.request !== undefined && { request: m.request.$ref }),
    ...(m.response !== undefined && { response: m.response.$ref }),
    ...(m.supportsMediaDownload === true && { download: true as const }),
  };
}

async function api([name, version, title]: (typeof APIS)[number]): Promise<[string, GoogleApi]> {
  const response = await fetch(`https://www.googleapis.com/discovery/v1/apis/${name}/${version}/rest`);

  if (!response.ok) throw new Error(`${name} ${version}: Discovery answered ${response.status}`);
  const text = await response.text();
  const document = v.parse(DiscoveryDocumentSchema, JSON.parse(text));
  const reached = methodsOf(document).filter((m) => (m.scopes ?? []).some((scope) => granted.has(scope)));

  console.log(`${name} ${version} r${document.revision}: ${reached.length} methods the connection reaches`);

  return [name, {
    title, version, revision: document.revision, sha256: createHash('sha256').update(text).digest('hex'),
    baseUrl: `${document.rootUrl}${document.servicePath}`,
    methods: Object.fromEntries(reached.map((m) => [m.id, method(m, Object.fromEntries(SHARED_PARAMETERS.flatMap((param) => {
      const shared = document.parameters?.[param];

      return shared === undefined ? [] : [[param, shared]];
    })))])),
    schemas: Object.fromEntries(Object.entries(document.schemas ?? {}).map(([schema, s]) => [schema, {
      ...opening(s.description, 120),
      props: Object.fromEntries(Object.entries(s.properties ?? {}).map(([prop, p]) => [prop, property(p)])),
    }])),
  }];
}

const table = v.parse(v.record(v.string(), GoogleApiSchema), Object.fromEntries(await Promise.all(APIS.map(api))));

writeFileSync(OUT, `${JSON.stringify(table)}\n`);

console.log(`wrote ${OUT.pathname}`);
