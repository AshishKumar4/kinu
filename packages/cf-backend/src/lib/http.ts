// Shared HTTP helpers for cf-backend route modules — one home instead of a
// per-route-file clone of json/err/safeJson/escapeHtml.
import { inlineFileType, projectJsonValue } from '@kinu.run/core';
import { tolerateAsync } from '@kinu.run/core/obs';
import * as v from 'valibot';

export function json<Body>(body: Body, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(projectJsonValue({ value: body })), { ...init, headers });
}

export function err(status: number, message: string): Response {
  return json({ error: message }, { status });
}

export async function safeJson<Schema extends v.GenericSchema>(
  request: Request,
  schema: Schema,
): Promise<v.InferOutput<Schema> | null> {
  const parsed = v.safeParse(schema, await tolerateAsync(() => request.json(), 'malformed-input'));
  return parsed.success ? parsed.output : null;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}


/**
 * The file-download route's header policy, split out so the security posture
 * is a tested contract: inline only for types a browser renders harmlessly,
 * `nosniff` always, a `sandbox` CSP on images so an SVG opened as a document
 * cannot run scripts on this origin, attachment for everything else. The PDF
 * viewer keeps its scripts — they are the platform's, not this origin's, and
 * `nosniff` already pins the type.
 */
export function fileResponseHeaders(path: string, download: boolean): Headers {
  const name = path.slice(path.lastIndexOf('/') + 1) || 'file';
  const inlineType = download ? undefined : inlineFileType(path);
  const headers = new Headers({
    'content-type': inlineType ?? 'application/octet-stream',
    'content-disposition': `${inlineType ? 'inline' : 'attachment'}; filename="${encodeURIComponent(name)}"`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  if (inlineType?.startsWith('image/')) headers.set('content-security-policy', 'sandbox');
  return headers;
}
