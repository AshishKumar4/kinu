/**
 * The experience library as it crosses a `UserDO` stub.
 *
 * An entry's payload is a `JsonValue`, and a stub's RPC mapping over that
 * recursion exceeds TypeScript's instantiation depth, so the library's methods
 * cross as JSON text (`publishExperienceWire`, `searchExperienceWire`,
 * `getExperienceEntryWire` on `UserDO`) and every holder of a stub reads them
 * back here. Core's own parser is the one reader of the four-kind payload union.
 */
import {
  EXPERIENCE_KINDS, JsonValueSchema, decodeJsonWire, parseExperiencePayload,
  type ExperienceEntry, type ExperienceLibraryClient, type UserCaller,
} from '@kinu.run/core';
import type { UserDO } from './user-do';
import { KinuError } from '@kinu.run/core/obs';
import * as v from 'valibot';

const ExperienceEntryWireSchema = v.object({
  id: v.string(),
  kind: v.picklist(EXPERIENCE_KINDS),
  key: v.string(),
  title: v.string(),
  payload: JsonValueSchema,
  evidence: v.string(),
  sourceWorkspace: v.string(),
  publishedAt: v.number(),
});

function experienceEntryOf(row: v.InferOutput<typeof ExperienceEntryWireSchema>): ExperienceEntry {
  const payload = parseExperiencePayload(JSON.stringify(row.payload));

  if (payload === null) {
    throw new KinuError('io', `experience entry ${row.id} carries a payload no kind describes`);
  }

  return { ...row, payload };
}

function decodeExperienceEntry(wire: string): ExperienceEntry {
  return experienceEntryOf(v.parse(ExperienceEntryWireSchema, decodeJsonWire(wire)));
}

function decodeExperienceEntries(wire: string): ExperienceEntry[] {
  return v.parse(v.array(ExperienceEntryWireSchema), decodeJsonWire(wire)).map(experienceEntryOf);
}

/** `null` crosses as the JSON text `null`: an entry nobody published. */
function decodeOptionalExperienceEntry(wire: string): ExperienceEntry | null {
  const decoded = decodeJsonWire(wire);

  return decoded === null ? null : experienceEntryOf(v.parse(ExperienceEntryWireSchema, decoded));
}

/** The wire methods a library holder reaches on the owner's object. */
export type ExperienceLibraryWire = Pick<UserDO, 'publishExperienceWire' | 'searchExperienceWire' | 'getExperienceEntryWire'>;

/** The owner's library as core's client, over one hub: every call crosses as
 *  wire text and is decoded here, so no holder repeats the three hops. */
export function experienceLibraryOver(hub: () => Promise<{ stub: ExperienceLibraryWire; caller: UserCaller }>): ExperienceLibraryClient {
  return {
    publish: async (candidate) => {
      const { stub, caller } = await hub();

      return decodeExperienceEntry(await stub.publishExperienceWire(caller, candidate));
    },
    search: async (options) => {
      const { stub, caller } = await hub();

      return decodeExperienceEntries(await stub.searchExperienceWire(caller, options));
    },
    get: async (id) => {
      const { stub, caller } = await hub();

      return decodeOptionalExperienceEntry(await stub.getExperienceEntryWire(caller, id));
    },
  };
}
