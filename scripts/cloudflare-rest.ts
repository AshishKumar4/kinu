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
 */
import { spawnSync } from 'node:child_process';
import * as v from 'valibot';

const API = 'https://api.cloudflare.com/client/v4';

const DeletedSchema = v.pipe(v.string(), v.parseJson(), v.object({
  success: v.boolean(),
  errors: v.optional(v.array(v.object({ message: v.optional(v.string()) }))),
}));

const ObjectPageSchema = v.object({
  success: v.literal(true),
  result: v.array(v.object({ key: v.string(), size: v.optional(v.number()) })),
  // Absent on the last page.
  result_info: v.optional(v.object({ cursor: v.optional(v.string()), is_truncated: v.optional(v.boolean()) })),
});

const KeysDeletedSchema = v.object({ success: v.literal(true), result: v.array(v.object({ key: v.string() })) });

/** The keys one list call and one delete call carry. */
const PAGE = 1_000;

/**
 * The deploy's Cloudflare REST token. KINU_CLOUDFLARE_API_TOKEN first, ON PURPOSE: wrangler honours both generic
 * names (CLOUDFLARE_API_TOKEN and CF_API_TOKEN), so a REST token exported under either hijacks every wrangler
 * subcommand the deploy also runs (measured: `wrangler vectorize list` refusing under an Access-only token). A name
 * wrangler never reads keeps the deploy's OAuth login serving wrangler.
 */
export function restApiToken(): string {
  return (process.env['KINU_CLOUDFLARE_API_TOKEN'] ?? process.env['CLOUDFLARE_API_TOKEN'] ?? process.env['CF_API_TOKEN'] ?? '').trim();
}

/** Only the REST API deletes an application whose id has this shape. */
export function deletedByRest(applicationId: string): boolean {
  return /^[0-9a-f]{32}$/u.test(applicationId);
}

/** `DELETE /accounts/{account}/containers/applications/{id}` with CLOUDFLARE_API_TOKEN. The token goes to
 *  curl on stdin, never in its arguments. */
export function deleteApplicationByRest(accountId: string, applicationId: string): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const token = restApiToken();

  if (token === '') {
    return { ok: false, reason: `container application ${applicationId} is deleted only through the REST API, and no REST token is set (KINU_CLOUDFLARE_API_TOKEN)` };
  }

  const answered = spawnSync('curl', [
    '-s', '-X', 'DELETE', '-H', '@-', `${API}/accounts/${accountId}/containers/applications/${applicationId}`,
  ], { input: `Authorization: Bearer ${token}\n`, encoding: 'utf8', timeout: 60_000 });

  const parsed = v.safeParse(DeletedSchema, answered.stdout);

  if (parsed.success && parsed.output.success) return { ok: true };

  const detail = parsed.success
    ? (parsed.output.errors ?? []).map((error) => error.message ?? '').join('; ')
    : `${answered.stdout}${answered.stderr}`.slice(0, 240);

  return { ok: false, reason: `DELETE container application ${applicationId} failed: ${detail || `curl exit ${String(answered.status)}`}` };
}

export interface PrefixDeletion {
  readonly accountId: string;
  readonly bucket: string;
  readonly prefix: string;
  /** The API root; a test serves its own. */
  readonly api?: string;
  readonly token?: string;
}

/** One REST call, its answer parsed at this boundary. */
async function restCall<TSchema extends v.GenericSchema>(request: { method: string; url: string; token: string; keys?: readonly string[] }, schema: TSchema): Promise<v.InferOutput<TSchema>> {
  const headers = new Headers({ authorization: `Bearer ${request.token}` });

  if (request.keys !== undefined) headers.set('content-type', 'application/json');

  const answer = await fetch(request.url, {
    method: request.method,
    headers,
    body: request.keys === undefined ? undefined : JSON.stringify(request.keys),
    signal: AbortSignal.timeout(60_000),
  });

  const text = await answer.text();

  if (!answer.ok) throw new Error(`${request.method} ${new URL(request.url).pathname} answered ${String(answer.status)}: ${text.slice(0, 240)}`);

  return v.parse(v.pipe(v.string(), v.parseJson(), schema), text);
}

/** Deletes every object under `prefix` and answers how many; it lists again from the start after each page, so
 *  a key it deleted can never hold a cursor it still needs. */
export async function deleteR2Prefix(deletion: PrefixDeletion): Promise<number> {
  const token = deletion.token ?? restApiToken();

  if (token === '') throw new Error(`the objects under ${deletion.bucket}/${deletion.prefix} are deleted only through the REST API, and no REST token is set (KINU_CLOUDFLARE_API_TOKEN)`);
  const objects = `${deletion.api ?? API}/accounts/${deletion.accountId}/r2/buckets/${deletion.bucket}/objects`;
  let deleted = 0;

  for (;;) {
    const page = await restCall({ method: 'GET', url: `${objects}?prefix=${encodeURIComponent(deletion.prefix)}&per_page=${String(PAGE)}`, token }, ObjectPageSchema);
    const keys = page.result.map((object) => object.key).filter((key) => key.startsWith(deletion.prefix));

    if (keys.length === 0) return deleted;
    const answered = await restCall({ method: 'DELETE', url: objects, token, keys }, KeysDeletedSchema);
    const missed = keys.filter((key) => !answered.result.some((each) => each.key === key));

    if (missed.length > 0) throw new Error(`DELETE ${deletion.bucket} left ${String(missed.length)} of ${String(keys.length)} keys, first ${missed[0] ?? ''}`);
    deleted += keys.length;
  }
}

/** The size of `key` in a bucket, or undefined when the bucket does not hold it. */
export async function r2ObjectSize(lookup: Omit<PrefixDeletion, 'prefix'> & { readonly key: string }): Promise<number | undefined> {
  const token = lookup.token ?? restApiToken();
  const objects = `${lookup.api ?? API}/accounts/${lookup.accountId}/r2/buckets/${lookup.bucket}/objects`;
  const page = await restCall({ method: 'GET', url: `${objects}?prefix=${encodeURIComponent(lookup.key)}&per_page=1`, token }, ObjectPageSchema);

  return page.result.find((object) => object.key === lookup.key)?.size;
}
