/**
 * The account owner's profile: their account's facts, which every agent of the account reads in its system prompt on
 * every turn, with no search (owner, 2026-11-11). One budget, `memory.account_profile_chars`; a fact past it is named
 * with its size, never dropped unsaid. Rendered by key from values alone, so its bytes move only when a fact does.
 */
import type { JsonValue } from '../utils/json';
import { PLATFORM_LIMITS } from '../platform-limits';
import { renderFactValue, type Fact, type MemoryScope } from './facts';

export const ACCOUNT_PROFILE_CHARS = PLATFORM_LIMITS['memory.account_profile_chars'].value;

/** A key's value as this agent reads it: the account's, or this workspace's own where it holds the same key. */
export interface ProfileFact {
  readonly key: string;
  readonly value: JsonValue;
  readonly scope: MemoryScope;
}

/** A fact the profile leaves out, by its rendered size against {@link ACCOUNT_PROFILE_CHARS}. */
export interface UnshownFact {
  readonly key: string;
  readonly chars: number;
}

export interface AccountProfile {
  /** The lines shown, by key. */
  readonly lines: readonly string[];
  /** Keys shown, so the memory block does not show them again. */
  readonly shown: readonly string[];
  readonly used: number;
  readonly budget: number;
  readonly unshown: readonly UnshownFact[];
}

/** The account's facts with this workspace's value in place of any key it holds too, as `memory.recall` answers. */
export function effectiveProfileFacts(account: readonly Pick<Fact, 'key' | 'value'>[], own: readonly Pick<Fact, 'key' | 'value'>[]): ProfileFact[] {
  const mine = new Map(own.map((fact) => [fact.key, fact.value]));

  return account.map((fact) => {
    const value = mine.get(fact.key);

    return value === undefined ? { key: fact.key, value: fact.value, scope: 'account' } : { key: fact.key, value, scope: 'workspace' };
  });
}

/** A line's share of the budget: itself and the newline after it. */
const charsOf = (line: string): number => line.length + 1;

/** As many facts as fit, shortest first, shown by key. */
export function accountProfile(facts: readonly ProfileFact[]): AccountProfile {
  const sized = facts.map((fact) => ({ key: fact.key, line: `${fact.key}: ${renderFactValue(fact.value)}${fact.scope === 'workspace' ? '  # this workspace\'s' : ''}` }))
    .sort((a, b) => charsOf(a.line) - charsOf(b.line) || a.key.localeCompare(b.key));

  const shown: { key: string; line: string }[] = [];
  const unshown: UnshownFact[] = [];
  let used = 0;

  for (const fact of sized) {
    if (used + charsOf(fact.line) <= ACCOUNT_PROFILE_CHARS) {
      shown.push(fact);
      used += charsOf(fact.line);
    } else {
      unshown.push({ key: fact.key, chars: charsOf(fact.line) });
    }
  }

  shown.sort((a, b) => a.key.localeCompare(b.key));

  return {
    lines: shown.map((fact) => fact.line), shown: shown.map((fact) => fact.key), used, budget: ACCOUNT_PROFILE_CHARS,
    unshown: unshown.sort((a, b) => a.key.localeCompare(b.key)),
  };
}

/** Whether `key` holding `value` would be left out of the profile of `facts`; its size when it would. */
export function unshownIfKept(facts: readonly Pick<Fact, 'key' | 'value'>[], key: string, value: JsonValue): UnshownFact | null {
  const kept = [...facts.filter((fact) => fact.key !== key), { key, value }];

  return accountProfile(effectiveProfileFacts(kept, [])).unshown.find((fact) => fact.key === key) ?? null;
}

/** What a turn reads of its account's object, once: its facts, and its limits near their end, said once a period; null
 *  when there is nothing new to say. */
export interface AccountRead {
  readonly facts: readonly Fact[];
  readonly limits: string | null;
}

/** The same with its facts as this agent reads them (`effectiveProfileFacts`). */
export interface AccountTurnRead {
  readonly facts: readonly ProfileFact[];
  readonly limits: string | null;
}

/** The same as every step of the turn renders it. */
export interface AccountTurnView {
  readonly profile: AccountProfile;
  readonly limits: string | null;
}
