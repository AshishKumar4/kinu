/**
 * Typed client for `/api/shared/*` and the one public read behind the
 * blueprint page. The session rides the HttpOnly cookie, so the fetches are
 * bare; the blueprint read needs none.
 */
import {
  BlueprintForkSchema, BlueprintViewSchema, SharedLibrarySchema,
  type BlueprintFork, type BlueprintView, type SharedLibrary,
} from '@kinu.run/core';
import { tolerateAsync } from '@kinu.run/core/obs';
import { DEFAULT_CALL_TIMEOUT_MS } from 'agents/client';
import * as v from 'valibot';

const ErrorBody = v.object({ error: v.string() });

async function errorDetail(res: Response): Promise<string> {
  const parsed = v.safeParse(ErrorBody, await tolerateAsync(() => res.json(), 'malformed-input'));

  return parsed.success ? parsed.output.error : '';
}

async function api<Schema extends v.GenericSchema, Body>(schema: Schema, method: string, path: string, body?: Body): Promise<v.InferOutput<Schema>> {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: method === 'GET' ? AbortSignal.timeout(DEFAULT_CALL_TIMEOUT_MS) : undefined,
  });

  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await errorDetail(res)}`);

  return v.parse(schema, await res.json());
}

/** My shared and shared with me. */
export function getSharedLibrary(): Promise<SharedLibrary> {
  return api(SharedLibrarySchema, 'GET', '/api/shared');
}

/** A blueprint's read-only page; refused as 404 when unminted or revoked. */
export function getBlueprint(id: string): Promise<BlueprintView> {
  return api(BlueprintViewSchema, 'GET', `/api/shared/blueprint/${encodeURIComponent(id)}`);
}

const PublishedLink = v.object({ id: v.string(), share: v.string(), users: v.array(v.string()) });

/** What publishing answered: the signed link and who was named. */
export type Published = v.InferOutput<typeof PublishedLink>;

export function publishBlueprint(input: { workspace: string; slate: string; version: string; include?: string[]; emails?: string[] }): Promise<Published> {
  return api(PublishedLink, 'POST', '/api/shared/publish', input);
}

export function forkBlueprint(input: { blueprint: string; workspace: string }): Promise<BlueprintFork> {
  return api(BlueprintForkSchema, 'POST', '/api/shared/fork', input);
}

const MeSchema = v.object({ user: v.nullable(v.object({ email: v.string() })) });

/** Whether this browser holds a Kinu session; the one read the public page makes about the viewer. */
export async function signedInEmail(): Promise<string | null> {
  const res = await fetch('/api/auth/me', { signal: AbortSignal.timeout(DEFAULT_CALL_TIMEOUT_MS) });

  if (res.status === 401) return null;

  if (!res.ok) throw new Error(`GET /api/auth/me → ${res.status} ${await errorDetail(res)}`);

  return v.parse(MeSchema, await res.json()).user?.email ?? null;
}
