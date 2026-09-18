/**
 * The Cloudflare v4 API as the deploy flow uses it: one transport port, one
 * envelope reader, one error type.
 *
 * WHY A PORT AND NOT `fetch` IN THE STEPS. The steps run in three places — the
 * deploy Durable Object with a person's OAuth token, a deployment updating
 * itself with its own token, and a test with no network at all. A port keeps
 * one implementation of the steps and lets the test be a map from call to
 * answer rather than an HTTP server.
 *
 * WHY THE ERROR IS VERBATIM. Cloudflare says why it refused: `10021 experimental
 * is not a valid compatibility flag`, `10014 workers.dev subdomain already
 * taken`. A flow that renders "step 7 failed" throws away the only sentence
 * that tells a person what to change, so `CloudflareApiError.detail` is the
 * upstream message unedited and the page prints it as it came.
 */
import * as v from 'valibot';
import { JsonValueSchema, type JsonObject, type JsonValue } from '../utils/json';
import { tolerate } from '../obs/index';

const CLOUDFLARE_API_ROOT = 'https://api.cloudflare.com/client/v4';

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface CloudflareCall {
  readonly method: HttpMethod;
  /** Path under the API root, leading slash included. */
  readonly path: string;
  readonly body?: JsonObject;
}

export interface CloudflareHttpResponse {
  readonly status: number;
  readonly body: JsonValue;
}

/** One part of a multipart body. Bytes rather than text where it matters: a
 *  Worker module can be compiled `.wasm`, and an asset part is base64 text the
 *  upload endpoint decodes. */
export interface UploadPart {
  readonly name: string;
  readonly filename?: string;
  readonly contentType: string;
  readonly body: string | Uint8Array<ArrayBuffer>;
}

export interface MultipartUpload {
  readonly method: 'POST' | 'PUT';
  readonly path: string;
  /** Overrides the transport's own credential. The asset upload leg
   *  authenticates with the JWT the upload session returned, not with the
   *  account token, and sending the account token there is a 403. */
  readonly bearer?: string;
  readonly parts: readonly UploadPart[];
}

/**
 * What the steps need of the network. `request` is JSON in, JSON out; `upload`
 * is the multipart leg, kept separate so the steps never build a `FormData`
 * and a fake transport never parses one.
 */
export interface CloudflareTransport {
  request(call: CloudflareCall): Promise<CloudflareHttpResponse>;
  upload(upload: MultipartUpload): Promise<CloudflareHttpResponse>;
}

export interface CloudflareErrorDetail {
  readonly code: number;
  readonly message: string;
}

/** A refusal from Cloudflare, carrying what Cloudflare said. `detail` is the
 *  first error's message unedited — the string a person is shown and the
 *  string a retry is decided on. */
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

  /** The first error's numeric code, or 0 when the refusal carried none (a
   *  gateway error, an HTML error page, a body that was not JSON). */
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

/**
 * The `result` of a successful call, parsed into the caller's shape.
 *
 * A non-2xx, a `success: false`, or a `result` that does not match are all the
 * same thing to a step: it did not get what it asked for, and it must not
 * carry on as though it had.
 */
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

/** A body that is not a Cloudflare envelope at all — Cloudflare's edge error
 *  pages and proxies in front of it answer HTML. The status is the only fact
 *  such an answer carries, and pretending it said something else would put an
 *  invented sentence in front of a person. */
function renderNonEnvelope(response: CloudflareHttpResponse): string {
  return `HTTP ${response.status} with a body that is not a Cloudflare API answer`;
}

function describe(issues: readonly v.BaseIssue<unknown>[]): string {
  const first = issues[0];

  if (first === undefined) return 'the expected result';
  const path = (first.path ?? []).map((entry) => String(entry.key)).join('.');

  return path === '' ? 'the expected result' : `\`${path}\``;
}

/**
 * The live transport: a bearer token and `fetch`.
 *
 * The token never reaches a log line here or anywhere else — it is a closure
 * variable, and the call's path is what identifies a request in diagnostics.
 */
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
        // A Uint8Array view can be a window onto a larger buffer; Blob copies
        // the view, so a part never carries its neighbours' bytes.
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
