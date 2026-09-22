// Cloudflare v4 API for the deploy flow. Errors carry Cloudflare's message verbatim:
// it is the only sentence that tells a person what to change.
import * as v from 'valibot';
import { JsonValueSchema, type JsonObject, type JsonValue } from '../utils/json';
import { tolerate } from '../obs/index';

const CLOUDFLARE_API_ROOT = 'https://api.cloudflare.com/client/v4';

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface CloudflareCall {
  readonly method: HttpMethod;
  readonly path: string;
  readonly body?: JsonObject;
}

export interface CloudflareHttpResponse {
  readonly status: number;
  readonly body: JsonValue;
}

export interface UploadPart {
  readonly name: string;
  readonly filename?: string;
  readonly contentType: string;
  readonly body: string | Uint8Array<ArrayBuffer>;
}

export interface MultipartUpload {
  readonly method: 'POST' | 'PUT';
  readonly path: string;
  /** The asset upload leg needs the session JWT; the account token there is a 403. */
  readonly bearer?: string;
  readonly parts: readonly UploadPart[];
}

export interface CloudflareTransport {
  request(call: CloudflareCall): Promise<CloudflareHttpResponse>;
  upload(upload: MultipartUpload): Promise<CloudflareHttpResponse>;
}

export interface CloudflareErrorDetail {
  readonly code: number;
  readonly message: string;
}

export class CloudflareApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly detail: string,
    readonly errors: readonly CloudflareErrorDetail[],
  ) {
    super(`${path}: ${detail}`);
    this.name = 'CloudflareApiError';
  }

  get code(): number {
    return this.errors[0]?.code ?? 0;
  }
}

const EnvelopeSchema = v.object({
  success: v.optional(v.boolean()),
  errors: v.optional(v.array(v.object({
    code: v.optional(v.number()),
    message: v.optional(v.string()),
  }))),
  messages: v.optional(v.array(JsonValueSchema)),
  result: v.optional(JsonValueSchema),
});

export async function cloudflareResult<Result>(
  transport: CloudflareTransport,
  call: CloudflareCall,
  schema: v.GenericSchema<Result>,
): Promise<Result> {
  const response = await transport.request(call);

  return readEnvelope(call.path, response, schema);
}

export function readEnvelope<Result>(
  path: string,
  response: CloudflareHttpResponse,
  schema: v.GenericSchema<Result>,
): Result {
  const envelope = v.safeParse(EnvelopeSchema, response.body);

  if (!envelope.success) {
    throw new CloudflareApiError(response.status, path, renderNonEnvelope(response), []);
  }

  const errors: CloudflareErrorDetail[] = (envelope.output.errors ?? [])
    .map((error) => ({ code: error.code ?? 0, message: error.message ?? '' }))
    .filter((error) => error.message !== '' || error.code !== 0);

  const refused = response.status < 200 || response.status >= 300 || envelope.output.success === false;

  if (refused) {
    throw new CloudflareApiError(response.status, path, errors[0]?.message ?? `HTTP ${response.status}`, errors);
  }

  const result = v.safeParse(schema, envelope.output.result);

  if (!result.success) {
    throw new CloudflareApiError(
      response.status,
      path,
      `the answer did not carry ${describe(result.issues)}`,
      errors,
    );
  }

  return result.output;
}

function renderNonEnvelope(response: CloudflareHttpResponse): string {
  return `HTTP ${response.status} with a body that is not a Cloudflare API answer`;
}

function describe(issues: readonly v.BaseIssue<unknown>[]): string {
  const first = issues[0];

  if (first === undefined) return 'the expected result';
  const path = (first.path ?? []).map((entry) => String(entry.key)).join('.');

  return path === '' ? 'the expected result' : `\`${path}\``;
}

export function bearerTransport(
  token: string,
  fetchImpl: typeof fetch = fetch,
  apiRoot: string = CLOUDFLARE_API_ROOT,
): CloudflareTransport {
  const authorization = `Bearer ${token}`;

  return {
    async request(call: CloudflareCall): Promise<CloudflareHttpResponse> {
      const response = await fetchImpl(`${apiRoot}${call.path}`, {
        method: call.method,
        headers: {
          accept: 'application/json',
          authorization,
          ...(call.body === undefined ? undefined : { 'content-type': 'application/json' }),
        },
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
      });

      return { status: response.status, body: await readJsonBody(response) };
    },

    async upload(upload: MultipartUpload): Promise<CloudflareHttpResponse> {
      const form = new FormData();

      for (const part of upload.parts) {
        const blob = new Blob([part.body], { type: part.contentType });

        if (part.filename === undefined) form.set(part.name, blob);
        else form.set(part.name, blob, part.filename);
      }

      const response = await fetchImpl(`${apiRoot}${upload.path}`, {
        method: upload.method,
        headers: {
          accept: 'application/json',
          authorization: upload.bearer === undefined ? authorization : `Bearer ${upload.bearer}`,
        },
        body: form,
      });

      return { status: response.status, body: await readJsonBody(response) };
    },
  };
}

async function readJsonBody(response: Response): Promise<JsonValue> {
  const text = await response.text();
  const parsed = tolerate(() => JSON.parse(text), 'malformed-input');
  const value = v.safeParse(JsonValueSchema, parsed);

  return value.success ? value.output : null;
}
