/**
 * A guided run's identity: the id that names it and the key that authorizes it.
 *
 * The door is public — a person deploying their own Kinu has no Kinu account
 * yet, so there is no session to gate on. What gates it is the key: 192 random
 * bits handed to the browser (or to the CLI) once, presented on every call and
 * on the socket upgrade, compared against a stored DIGEST rather than against
 * itself. A run's storage therefore never holds the key, and neither does a
 * log line, a ledger row or a diagnostics field — the run id is what identifies
 * a run in every one of those places.
 */
import { base64Url, timingSafeEqual } from '../utils/crypto';

/** 192 bits. Above the 128-bit floor, and a multiple of three so the base64url
 *  form carries no padding to trim. */
const KEY_BYTES = 24;

const ID_BYTES = 12;

export interface DeployRunTicket {
  readonly runId: string;
  readonly runKey: string;
}

export function mintDeployRun(): DeployRunTicket {
  const id = new Uint8Array(ID_BYTES);
  const key = new Uint8Array(KEY_BYTES);

  crypto.getRandomValues(id);
  crypto.getRandomValues(key);

  return { runId: base64Url(id), runKey: base64Url(key) };
}

/** What the run stores instead of the key. */
export async function runKeyDigest(runKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(runKey));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function runKeyAdmits(presented: string, storedDigest: string): Promise<boolean> {
  if (presented === '' || storedDigest === '') return false;

  return timingSafeEqual(await runKeyDigest(presented), storedDigest);
}

export const DEPLOY_RUN_ID = /^[A-Za-z0-9_-]{16}$/u;
