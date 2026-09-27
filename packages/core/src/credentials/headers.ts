// Header mapping lives beside the store so secret material never leaves it.
import { Effect } from 'effect';
import { KinuError, settleSync } from '../obs/index';
import { codexCredentialToHeaders } from '../providers/codex-oauth';
import { baseCredentialKey } from './accounts';
import type { Credential } from './store';

export interface CredentialHeaders {
  [name: string]: string;
}

/** The base key picks the header flavor: codex.oauth its WAF-bypass set, the rest Bearer. */
export function credentialToHeaders(key: string, cred: Credential): CredentialHeaders {
  return settleSync(headersOf(key, cred));
}

function headersOf(key: string, cred: Credential): Effect.Effect<CredentialHeaders, KinuError> {
  const base = baseCredentialKey(key);

  if (base === 'codex.oauth') {
    if (cred.kind !== 'oauth') return Effect.fail(new KinuError('bad_input', 'codex.oauth credential must be oauth kind'));

    return Effect.succeed(codexCredentialToHeaders(cred));
  }

  if (base === 'anthropic.bearer') {
    if (cred.kind !== 'bearer') return Effect.fail(new KinuError('bad_input', 'anthropic.bearer credential must be bearer kind'));

    return Effect.succeed({
      'x-api-key': cred.token,
      'anthropic-version': '2023-06-01',
    });
  }

  if (cred.kind === 'bearer') {
    return Effect.succeed({ Authorization: `Bearer ${cred.token}` });
  }

  // baseURL is applied at provider construction.
  if (cred.kind === 'openai-compat') {
    return Effect.succeed({ Authorization: `Bearer ${cred.apiKey}`, ...cred.extraHeaders });
  }

  if (cred.kind === 'oauth') {
    return Effect.succeed({ Authorization: `Bearer ${cred.accessToken}` });
  }

  return Effect.fail(new KinuError('bad_input', `unhandled credential kind for key=${key}`));
}
