// Adapter from a plain credential double to the gated UserDO surface the
// provider registry consumes.
//
// The real UserDO takes a `UserCaller` as the first argument of every
// privileged method. Tests are about credentials, not about the gate, so they
// describe the store in its natural shape and this wraps it with a caller —
// owner-session by default, or a workspace capability token when the test is
// specifically about attenuation.
import type { UserCredentialSource } from '../../src/providers/agent-registry.js';
import { OWNER_SESSION, type UserCaller } from '../../src/user/workspace-capability.js';

export interface CredentialSummaryDouble {
  key: string;
  kind: string;
  createdAt: number;
  updatedAt: number;
}

export interface CredentialStoreDouble {
  getAuthHeaders(key: string, opts?: { forceRefresh?: boolean }): Promise<Record<string, string> | null>;
  listCredentials(): Promise<CredentialSummaryDouble[]>;
  getCredentialBaseURL(key: string): Promise<string | null>;
}

export function userCredentialSource(store: CredentialStoreDouble): UserCredentialSource {
  return {
    caller: OWNER_SESSION,
    stub: {
      getAuthHeaders: (_caller: UserCaller, key: string, opts?: { forceRefresh?: boolean }) =>
        store.getAuthHeaders(key, opts),
      listCredentials: (_caller: UserCaller) => store.listCredentials(),
      getCredentialBaseURL: (_caller: UserCaller, key: string) => store.getCredentialBaseURL(key),
    } as unknown as UserCredentialSource['stub'],
  };
}
