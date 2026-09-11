import { KinuError } from '../obs/error';

const EXPLORATION_PREFIX = 'exp:';

const SUBORDINATE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** Apply creation grammar only. Retained names and imported paths stay exact. */
export function requireSubordinateActorName(name: string): void {
  if (!SUBORDINATE_NAME.test(name)) throw new KinuError('bad_input', 'Subordinate names must be lowercase URL-safe slugs.');
}

export function explorationActorKey(id: string): string {
  if (id.length === 0) throw new KinuError('bad_input', 'An exploration actor needs an ID.');

  return `${EXPLORATION_PREFIX}${encodeURIComponent(id)}`;
}

export function isExplorationActorKey(key: string): boolean {
  return key.startsWith(EXPLORATION_PREFIX);
}

export interface ParsedActorKey { readonly family: 'exploration' | 'subordinate'; readonly id: string }

export function parseActorKey(key: string): ParsedActorKey {
  if (!isExplorationActorKey(key)) return { family: 'subordinate', id: key };

  try {
    return { family: 'exploration', id: decodeURIComponent(key.slice(EXPLORATION_PREFIX.length)) };
  } catch (cause) {
    throw new KinuError('bad_input', 'The exploration actor key is malformed.', { cause });
  }
}
