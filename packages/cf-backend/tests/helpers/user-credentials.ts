// Wraps a plain credential double with the `UserCaller` every privileged UserDO method takes:
// owner-session by default, a workspace capability token for attenuation tests.
import type { UserCredentialSource } from '../../src/providers/agent-registry';
import type { CredentialSummary } from '../../src/user/user-do';
import type { ModelRelayHub } from '../../src/egress/codex-egress-route';
import { ownerCaller, type AuthRequest, type UserCaller } from '@kinu.run/core';
import { TEST_USER_ENV } from './user-do';

export type CredentialSummaryDouble = CredentialSummary;

export interface CredentialStoreDouble {
  getAuthHeaders(key: string, opts?: AuthRequest): Promise<Record<string, string> | null>;
  hasCredential?(key: string): Promise<boolean>;
  listCredentials(): Promise<CredentialSummaryDouble[]>;
  getCredentialBaseURL(key: string): Promise<string | null>;
}

export const NO_RELAY_MACHINE: ModelRelayHub = {
  relayDevice: async () => null,
  relayModelCall: async () => { throw new Error('no machine is online to relay through'); },
  cancelModelRelay: async () => {},
};

export function userCredentialSource(store: CredentialStoreDouble): UserCredentialSource {
  return {
    caller: () => ownerCaller(TEST_USER_ENV),
    stub: {
      ...NO_RELAY_MACHINE,
      getAuth: async (_caller: UserCaller, key: string, opts?: AuthRequest) => {
        const headers = await store.getAuthHeaders(key, opts);
        const baseURL = headers === null ? null : await store.getCredentialBaseURL(key);

        return headers === null ? null : { headers, ...(baseURL !== null && { baseURL }) };
      },
      listCredentials: (_caller: UserCaller) => store.listCredentials(),
    },
  };
}
