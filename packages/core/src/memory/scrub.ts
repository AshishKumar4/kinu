/**
 * What memory keeps of what it is handed: every credential the one detector finds leaves as a marker naming its kind
 * (`scrubSecrets`, `<redacted:openai-key>`). Each store that keeps memory text writes through it: a memory file's write
 * and append (`adaptMemory`: a note, the scaffold, the MCP's note), a file write or edit under `memory/`, a note the
 * index takes in however it was written (a shell's, written back scrubbed before it is indexed), a fact's value
 * (`FactsStore.upsert`: the agent, the owner, a dream, an import, sleep-time), the sleep-time answer kept for a replay,
 * an account proposal, a lesson, and the conversation index. A secret said in chat then reaches none of them; the
 * conversation itself keeps what was said.
 */

import { scrubSecrets } from '../safety/secret-patterns';
import type { JsonValue } from '../utils/json';

/** `value` with every string in it scrubbed, keys included: a JSON value is kept as written but for its credentials. */
export function scrubMemoryValue(value: JsonValue): JsonValue {
  if (typeof value === 'string') return scrubSecrets(value);

  if (Array.isArray(value)) return value.map(scrubMemoryValue);

  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(Object.entries(value).map(([key, field]) => [scrubSecrets(key), scrubMemoryValue(field)]));
}
