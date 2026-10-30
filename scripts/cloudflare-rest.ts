/**
 * The Cloudflare REST calls wrangler cannot make, each with the measurement that says why.
 *
 * Deleting a Container application. MEASURED 2026-09-30 (D50): a durable_object application's id is 32 hex
 * digits. `wrangler containers delete` refuses it before any request ("Expected a container ID but got
 * 12578b1d…", wrangler 4.143.0 and 4.145.0), and the dashed UUID form it accepts answers
 * `{"error":"APPLICATION_NOT_FOUND"}`. The REST API deletes it by the id as listed. A default-policy
 * application's id is a dashed UUID, which `wrangler containers delete` takes.
 *
 * Deleting every R2 object under a prefix. wrangler deletes one named object per call and lists none. The REST
 * API lists a prefix a page at a time and deletes a page's keys in one call (MEASURED 2026-09-30 on a
 * throwaway bucket: `GET …/objects?prefix=&per_page=&cursor=`, and `DELETE …/objects` with the keys as a JSON
 * array answering each key it deleted).
 *
 * Every call goes through {@link restAnswer}: one transport, one token on one header, one classification of a refusal.
 */
import * as v from 'valibot';
import { KinuError } from '@kinu.run/core/obs';
import { codeForStatus } from '../packages/core/src/providers/util';
import { restApiToken } from './cloudflare-token';

const API = 'https://api.cloudflare.com/client/v4';

const DeletedSchema = v.object({ success: v.literal(true) });

const ObjectPageSchema = v.object({
  success: v.literal(true),
  result: v.array(v.object({ key: v.string(), size: v.optional(v.number()) })),
  // Absent on the last page.
  result_info: v.optional(v.object({ cursor: v.optional(v.string()), is_truncated: v.optional(v.boolean()) })),
});

const KeysDeletedSchema = v.object({ success: v.literal(true), result: v.array(v.object({ key: v.string() })) });

/** The keys one list call and one delete call carry. */
const PAGE = 1_000;

/** Only the REST API deletes an application whose id has this shape. */
export function deletedByRest(applicationId: string): boolean {
  return /^[0-9a-f]{32}$/u.test(applicationId);
}

/** `DELETE /accounts/{account}/containers/applications/{id}`, with the deploy's REST token. */
export async function deleteApplicationByRest(accountId: string, applicationId: string): Promise<void> {
  const token = restApiToken();

  if (token === '') {
    throw new KinuError('denied', `container application ${applicationId} is deleted only through the REST API, and no REST token is set (KINU_CLOUDFLARE_API_TOKEN)`);
  }

  await restCall({ method: 'DELETE', path: `/accounts/${accountId}/containers/applications/${applicationId}`, token }, DeletedSchema);
}

export interface PrefixDeletion {
  readonly accountId: string;
  readonly bucket: string;
  readonly prefix: string;
  /** The API root; a test serves its own. */
  readonly api?: string;
  readonly token?: string;
}

export interface RestRequest {
  readonly method: string;
  /** Under the API root, from `/accounts/…`. */
  readonly path: string;
  readonly token: string;
  readonly body?: unknown;
  /** The API root; a test serves its own. */
  readonly api?: string;
  readonly timeoutMs?: number;
  /** Hears each answer's status and headers, refused or not, before its text is read. */
  readonly heard?: (answer: Response) => void;
}

/** One Cloudflare REST call's answer, as text. A refusal throws a KinuError classified by its status, as any HTTP
 *  answer is: 401 and 403 `denied`, 404 `missing`, a 5xx or a 429 `unavailable`, the API refusing for its own reasons. */
export async function restAnswer(request: RestRequest): Promise<string> {
  const headers = new Headers({ authorization: `Bearer ${request.token}` });

  if (request.body !== undefined) headers.set('content-type', 'application/json');

  const answer = await fetch(`${request.api ?? API}${request.path}`, {
    method: request.method,
    headers,
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    signal: AbortSignal.timeout(request.timeoutMs ?? 60_000),
  });

  request.heard?.(answer);
  const text = await answer.text();

  if (!answer.ok) {
    throw new KinuError(codeForStatus(answer.status) ?? 'io', `${request.method} ${request.path.split('?')[0] ?? ''} answered ${String(answer.status)}: ${text.slice(0, 240)}`);
  }

  return text;
}

/** One Cloudflare REST call, its answer parsed at this boundary. */
export async function restCall<TSchema extends v.GenericSchema>(request: RestRequest, schema: TSchema): Promise<v.InferOutput<TSchema>> {
  return v.parse(v.pipe(v.string(), v.parseJson(), schema), await restAnswer(request));
}

/** Deletes every object under `prefix` and answers how many; it lists again from the start after each page, so
 *  a key it deleted can never hold a cursor it still needs. */
export async function deleteR2Prefix(deletion: PrefixDeletion): Promise<number> {
  const token = deletion.token ?? restApiToken();

  if (token === '') throw new Error(`the objects under ${deletion.bucket}/${deletion.prefix} are deleted only through the REST API, and no REST token is set (KINU_CLOUDFLARE_API_TOKEN)`);
  const objects = `/accounts/${deletion.accountId}/r2/buckets/${deletion.bucket}/objects`;
  const { api } = deletion;
  let deleted = 0;

  for (;;) {
    const page = await restCall({ method: 'GET', path: `${objects}?prefix=${encodeURIComponent(deletion.prefix)}&per_page=${String(PAGE)}`, token, api }, ObjectPageSchema);
    const keys = page.result.map((object) => object.key).filter((key) => key.startsWith(deletion.prefix));

    if (keys.length === 0) return deleted;
    const answered = await restCall({ method: 'DELETE', path: objects, token, api, body: keys }, KeysDeletedSchema);
    const missed = keys.filter((key) => !answered.result.some((each) => each.key === key));

    if (missed.length > 0) throw new Error(`DELETE ${deletion.bucket} left ${String(missed.length)} of ${String(keys.length)} keys, first ${missed[0] ?? ''}`);
    deleted += keys.length;
  }
}

/** Deletes `bucket`, emptied first ({@link deleteR2Prefix}), answering the API's own words for a refusal. Through
 *  `wrangler r2 bucket delete`, a devbox tier's cleanup ran 480 s with no answer and was killed (armada
 *  20261030184103-9a4e9599, staging e9a04f6ac, 2026-10-30). */
export async function deleteR2Bucket(bucket: Omit<PrefixDeletion, 'prefix'>): Promise<void> {
  const token = bucket.token ?? restApiToken();

  if (token === '') throw new Error(`the bucket ${bucket.bucket} is deleted only through the REST API, and no REST token is set (KINU_CLOUDFLARE_API_TOKEN)`);
  await restAnswer({ method: 'DELETE', path: `/accounts/${bucket.accountId}/r2/buckets/${bucket.bucket}`, token, api: bucket.api });
}

/** `key`'s path under the REST API: each segment escaped, its slashes kept. */
function objectPath(lookup: Omit<PrefixDeletion, 'prefix'> & { readonly key: string }): string {
  return `/accounts/${lookup.accountId}/r2/buckets/${lookup.bucket}/objects/${lookup.key.split('/').map(encodeURIComponent).join('/')}`;
}

/** The text of `key` in a bucket, or undefined when the bucket holds no such key. */
export async function r2ObjectText(lookup: Omit<PrefixDeletion, 'prefix'> & { readonly key: string }): Promise<string | undefined> {
  const token = lookup.token ?? restApiToken();

  try {
    return await restAnswer({ method: 'GET', path: objectPath(lookup), token, api: lookup.api });
  } catch (cause) {
    if (cause instanceof KinuError && cause.code === 'missing') return undefined;
    throw cause;
  }
}

/** Writes `value` as JSON at `key` in a bucket. */
export async function r2PutJson(lookup: Omit<PrefixDeletion, 'prefix'> & { readonly key: string; readonly value: unknown }): Promise<void> {
  await restAnswer({ method: 'PUT', path: objectPath(lookup), token: lookup.token ?? restApiToken(), api: lookup.api, body: lookup.value });
}

/** The size of `key` in a bucket, or undefined when the bucket does not hold it. */
export async function r2ObjectSize(lookup: Omit<PrefixDeletion, 'prefix'> & { readonly key: string }): Promise<number | undefined> {
  const token = lookup.token ?? restApiToken();
  const objects = `/accounts/${lookup.accountId}/r2/buckets/${lookup.bucket}/objects`;
  const page = await restCall({ method: 'GET', path: `${objects}?prefix=${encodeURIComponent(lookup.key)}&per_page=1`, token, api: lookup.api }, ObjectPageSchema);

  return page.result.find((object) => object.key === lookup.key)?.size;
}
