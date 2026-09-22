// Wraps a plain credential double with the `UserCaller` every privileged UserDO method takes:
// owner-session by default, a workspace capability token for attenuation tests.
import type { UserCredentialSource } from '../../src/providers/agent-registry';
import type { CredentialSummary } from '../../src/user/user-do';
import { ownerCaller, type UserCaller } from '@kinu.run/core';
import { TEST_USER_ENV } from './user-do';

export type CredentialSummaryDouble = CredentialSummary;

export interface CredentialStoreDouble {
  getAuthHeaders(key: string, opts?: { forceRefresh?: boolean }): Promise<Record<string, string> | null>;
  hasCredential?(key: string): Promise<boolean>;
  listCredentials(): Promise<CredentialSummaryDouble[]>;
  getCredentialBaseURL(key: string): Promise<string | null>;
}

export function userCredentialSource(store: CredentialStoreDouble): UserCredentialSource {
  return {
    caller: () => ownerCaller(TEST_USER_ENV),
    stub: {
      getAuthHeaders: (_caller: UserCaller, key: string, opts?: { forceRefresh?: boolean }) =>
        store.getAuthHeaders(key, opts),
      listCredentials: (_caller: UserCaller) => store.listCredentials(),
      getCredentialBaseURL: (_caller: UserCaller, key: string) => store.getCredentialBaseURL(key),
    },
  };
}
