// Header mapping lives beside the store so secret material never leaves it.
import { codexCredentialToHeaders } from '../providers/codex-oauth';
import type { Credential } from './store';

export interface CredentialHeaders {
  [name: string]: string;
}

/** The credential key picks the header flavor (codex.oauth = WAF-bypass set; others Bearer, plus extras for compat). */
export function credentialToHeaders(key: string, cred: Credential): CredentialHeaders {
  if (key === 'codex.oauth') {
    if (cred.kind !== 'oauth') throw new Error('codex.oauth credential must be oauth kind');

    return codexCredentialToHeaders(cred);
  }

  if (key === 'anthropic.bearer') {
    if (cred.kind !== 'bearer') throw new Error('anthropic.bearer credential must be bearer kind');

    return {
      'x-api-key': cred.token,
      'anthropic-version': '2023-06-01',
    };
  }

  if (cred.kind === 'bearer') {
    return { Authorization: `Bearer ${cred.token}` };
  }

  // baseURL is applied at provider construction.
  if (cred.kind === 'openai-compat') {
    return { Authorization: `Bearer ${cred.apiKey}`, ...cred.extraHeaders };
  }

  if (cred.kind === 'oauth') {
    return { Authorization: `Bearer ${cred.accessToken}` };
  }

  throw new Error(`unhandled credential kind for key=${key}`);
}
