/**
 * One authenticated provider call, for every transport that renews a stored login (Claude, Codex, ChatGPT, the
 * account's Cloudflare endpoint): the login, the send, and on the first 401 one forced renewal of the login that was
 * refused and one resend. A revoked login reads as no login (`usableLogin`), so there is no third outcome to classify.
 * Each vendor keeps its words: it maps `absent` and `refused` to its own response.
 */
import type { AuthRequest, AuthResolution } from './types';

export type AuthenticatedAnswer =
  | { readonly kind: 'absent' }
  | { readonly kind: 'refused'; readonly reason: string; readonly response: Response }
  | { readonly kind: 'answered'; readonly response: Response; readonly auth: AuthResolution };

export async function authenticatedSend(input: {
  readonly key: string;
  readonly getAuth: (key: string, request?: AuthRequest) => Promise<AuthResolution | null>;
  /** The login already read for this call, when the caller needed it first. */
  readonly auth?: AuthResolution | null;
  readonly send: (auth: AuthResolution) => Promise<Response>;
}): Promise<AuthenticatedAnswer> {
  const auth = input.auth === undefined ? await input.getAuth(input.key) : input.auth;

  if (auth === null) return { kind: 'absent' };
  const first = await input.send(auth);

  if (first.status !== 401) return { kind: 'answered', response: first, auth };
  const renewed = await input.getAuth(input.key, { rejected: auth.headers });

  if (renewed === null) return { kind: 'refused', reason: 'the login was refused and could not be renewed', response: first };
  const second = await input.send(renewed);

  return second.status === 401
    ? { kind: 'refused', reason: 'the renewed login was refused too', response: second }
    : { kind: 'answered', response: second, auth: renewed };
}
