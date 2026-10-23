// The shape of `methods.generated.json`: each Google API the connection reaches, as `scripts/google-discovery.ts` pins
// it from Google's Discovery document. The generator writes it through these schemas and the catalog reads it back
// through them.
import * as v from 'valibot';

/** A schema property's type, as `describe` renders it; an inline object keeps its own properties. */
export interface GoogleProperty {
  readonly type?: string;
  readonly $ref?: string;
  readonly format?: string;
  readonly enum?: readonly string[];
  readonly readOnly?: boolean;
  readonly items?: GoogleProperty;
  readonly additionalProperties?: GoogleProperty;
  readonly props?: Readonly<Record<string, GoogleProperty>>;
  /** What it is, its first sentence. */
  readonly d?: string;
}

const GooglePropertySchema: v.GenericSchema<GoogleProperty> = v.object({
  type: v.optional(v.string()),
  $ref: v.optional(v.string()),
  format: v.optional(v.string()),
  enum: v.optional(v.array(v.string())),
  readOnly: v.optional(v.boolean()),
  items: v.optional(v.lazy(() => GooglePropertySchema)),
  additionalProperties: v.optional(v.lazy(() => GooglePropertySchema)),
  props: v.optional(v.record(v.string(), v.lazy(() => GooglePropertySchema))),
  d: v.optional(v.string()),
});

const GoogleSchemaSchema = v.object({ d: v.optional(v.string()), props: v.record(v.string(), GooglePropertySchema) });

const GoogleParamSchema = v.object({
  type: v.string(),
  in: v.picklist(['path', 'query']),
  required: v.optional(v.literal(true)),
  repeated: v.optional(v.literal(true)),
  enum: v.optional(v.array(v.string())),
  format: v.optional(v.string()),
  d: v.optional(v.string()),
});

export const GOOGLE_VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

const GoogleMethodSchema = v.object({
  verb: v.picklist(GOOGLE_VERBS),
  /** Relative to its API's `baseUrl`; `{name}` and `{+name}` (reserved, slashes kept) are its path parameters. */
  path: v.string(),
  d: v.optional(v.string()),
  params: v.record(v.string(), GoogleParamSchema),
  /** The request body's schema, and the response's, by name in its API's `schemas`. */
  request: v.optional(v.string()),
  response: v.optional(v.string()),
  /** It can answer with the file itself (`alt=media`). */
  download: v.optional(v.literal(true)),
});

export type GoogleMethod = v.InferOutput<typeof GoogleMethodSchema>;

export const GoogleApiSchema = v.object({
  title: v.string(),
  version: v.string(),
  /** The Discovery document's revision and sha256, as pinned. */
  revision: v.string(),
  sha256: v.string(),
  baseUrl: v.string(),
  methods: v.record(v.string(), GoogleMethodSchema),
  schemas: v.record(v.string(), GoogleSchemaSchema),
});

export type GoogleApi = v.InferOutput<typeof GoogleApiSchema>;
