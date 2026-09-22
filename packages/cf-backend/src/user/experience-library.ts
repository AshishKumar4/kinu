/**
 * The owner's experience library as core's client, over one hub: each call
 * reaches the account object's own method on its stub, as the caller the hub
 * resolved. No holder repeats the three hops.
 */
import type { ExperienceLibraryClient, UserCaller } from '@kinu.run/core';
import type { UserDO } from './user-do';

/** The library methods a holder reaches on the owner's object. */
export type ExperienceLibrary = Pick<UserDO, 'publishExperience' | 'searchExperience' | 'getExperienceEntry'>;

export function experienceLibraryOver(hub: () => Promise<{ stub: ExperienceLibrary; caller: UserCaller }>): ExperienceLibraryClient {
  return {
    publish: async (candidate) => {
      const { stub, caller } = await hub();

      return stub.publishExperience(caller, candidate);
    },
    search: async (options) => {
      const { stub, caller } = await hub();

      return stub.searchExperience(caller, options);
    },
    get: async (id) => {
      const { stub, caller } = await hub();

      return stub.getExperienceEntry(caller, id);
    },
  };
}
