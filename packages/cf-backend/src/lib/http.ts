// Shared HTTP helpers for cf-backend route modules — one home instead of a
// per-route-file clone of json/err/safeJson/escapeHtml.
import { projectJsonValue } from '@kinu.run/core';
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

/** The inline-previewable types, by extension. Everything else downloads. */
// Extensions arrive from untrusted request paths, so the lookup is keyed at
// runtime — a Map rather than an object table.
const INLINE_TYPES = new Map<string, string>(
  Object.entries({
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
  }),
);

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
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  const inlineType = download ? undefined : INLINE_TYPES.get(ext);
  const headers = new Headers({
    'content-type': inlineType ?? 'application/octet-stream',
    'content-disposition': `${inlineType ? 'inline' : 'attachment'}; filename="${encodeURIComponent(name)}"`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  if (inlineType?.startsWith('image/')) headers.set('content-security-policy', 'sandbox');
  return headers;
}
