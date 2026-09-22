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
  EXPERIENCE_KINDS, JsonValueSchema, decodeJsonWire, parseExperiencePayload, type ExperienceEntry,
} from '@kinu.run/core';
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

export function decodeExperienceEntry(wire: string): ExperienceEntry {
  return experienceEntryOf(v.parse(ExperienceEntryWireSchema, decodeJsonWire(wire)));
}

export function decodeExperienceEntries(wire: string): ExperienceEntry[] {
  return v.parse(v.array(ExperienceEntryWireSchema), decodeJsonWire(wire)).map(experienceEntryOf);
}

/** `null` crosses as the JSON text `null`: an entry nobody published. */
export function decodeOptionalExperienceEntry(wire: string): ExperienceEntry | null {
  const decoded = decodeJsonWire(wire);

  return decoded === null ? null : experienceEntryOf(v.parse(ExperienceEntryWireSchema, decoded));
}
