// Shared HTTP helpers for cf-backend route modules — one home instead of a
// per-route-file clone of json/err/safeJson/escapeHtml.
import { projectJsonValue } from '@proteus/core';
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
  try {
    const parsed = v.safeParse(schema, await request.json());
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
