import { Effect } from 'effect';
import { KinuError } from '../obs/error';
import { settleSync } from '../obs/effect';

const EXPLORATION_PREFIX = 'exp:';

const SUBAGENT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** Apply creation grammar only. Retained names and imported paths stay exact. */
export function requireSubagentActorName(name: string): void {
  if (!SUBAGENT_NAME.test(name)) return settleSync(Effect.fail(new KinuError('bad_input', 'Subagent names must be lowercase URL-safe slugs.')));
}

export function explorationActorKey(id: string): string {
  if (id.length === 0) return settleSync(Effect.fail(new KinuError('bad_input', 'An exploration actor needs an ID.')));

  return `${EXPLORATION_PREFIX}${encodeURIComponent(id)}`;
}

export function isExplorationActorKey(key: string): boolean {
  return key.startsWith(EXPLORATION_PREFIX);
}

export interface ParsedActorKey { readonly family: 'exploration' | 'subagent'; readonly id: string }

export function parseActorKey(key: string): ParsedActorKey {
  if (!isExplorationActorKey(key)) return { family: 'subagent', id: key };

  return settleSync(Effect.try({
    try: (): ParsedActorKey => ({ family: 'exploration', id: decodeURIComponent(key.slice(EXPLORATION_PREFIX.length)) }),
    catch: (cause) => new KinuError('bad_input', 'The exploration actor key is malformed.', { cause }),
  }));
}
