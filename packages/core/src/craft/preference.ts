import { markStoreChanged } from '@kinu.run/agent-utils';
/**
 * Crafted tools by preference (docs/EVOLUTION.md, "CraftStore lifecycle"): how often the model chose a tool when it was
 * offered, weighted by how the turns that used it were rated. A raise is not fitness: it marks the tool broken with its
 * error, which the declaration the model reads shows until a rewrite or a clean return clears it.
 */

import type { SqlExecutor } from '../types/primitives';
import { DEFAULT_CONFIG } from '../config';
import { evidenceWindow } from '../utils/evidence-window';

/** A tool's last raise, as much of it as its declaration shows. */
const BROKEN_CHARS = 300;

const MS_PER_DAY = 86_400_000;

export interface CraftPreferenceRow {
  readonly name: string;
  /** Turns it was offered, turns that chose it, and of those the rated ones with the sum of rating/5. */
  readonly offered: number;
  readonly chosen: number;
  readonly rated: number;
  readonly rating_sum: number;
  /** Its last raise; null while it returns clean. */
  readonly broken: string | null;
  /** When a turn last chose it; 0 for never. */
  readonly last_used_at: number;
}

/** Each crafted tool's counts, by name. */
export function craftPreferences(sql: SqlExecutor): Map<string, CraftPreferenceRow> {
  return new Map(sql<CraftPreferenceRow>`SELECT name, offered, chosen, rated, rating_sum, broken, last_used_at FROM crafted_tools`
    .map((row) => [row.name, row]));
}

/**
 * Chosen when offered, weighted by the ratings of the turns that chose it: (chosen + 1)/(offered + 2) times
 * (rating_sum + 1.2)/(rated + 2). The smoothing reads a new tool as chosen once in two offers, rated 3 of 5.
 */
export function craftPreference(row: Pick<CraftPreferenceRow, 'offered' | 'chosen' | 'rated' | 'rating_sum'>): number {
  return ((row.chosen + 1) / (row.offered + 2)) * ((row.rating_sum + 1.2) / (row.rated + 2));
}

/**
 * The crafted tools a turn is offered: by preference, newest first among equals, at most `cap`. Each carries its
 * broken flag. The one offering policy, so the declarations and the sandboxes cannot drift.
 */
export function rankByPreference<T extends { readonly name: string }>(
  sql: SqlExecutor, tools: readonly T[], cap: number = DEFAULT_CONFIG.craftStore.offeredCap,
): (T & { readonly broken: string | null })[] {
  const rows = craftPreferences(sql);

  const preference = (name: string): number => {
    const row = rows.get(name);

    return row === undefined ? craftPreference({ offered: 0, chosen: 0, rated: 0, rating_sum: 0 }) : craftPreference(row);
  };

  // A stable sort keeps the store's newest-first order among equal preferences.
  return [...tools].sort((a, b) => preference(b.name) - preference(a.name)).slice(0, cap)
    .map((tool) => ({ ...tool, broken: rows.get(tool.name)?.broken ?? null }));
}

/** Its last raise, recorded on the tool. Updates only an existing row, so an observation never resurrects a tool. */
export function markCraftBroken(sql: SqlExecutor, name: string, error: string): void {
  void sql`UPDATE crafted_tools SET broken = ${evidenceWindow(error, BROKEN_CHARS)} WHERE name = ${name}`;
  markStoreChanged(sql);
}

/** A clean return clears the flag. */
export function clearCraftBroken(sql: SqlExecutor, names: readonly string[]): void {
  for (const name of names) void sql`UPDATE crafted_tools SET broken = NULL WHERE name = ${name} AND broken IS NOT NULL`;

  if (names.length > 0) markStoreChanged(sql);
}

/** One turn's offer: each tool it was offered counts the offer, and each of those it called counts a choice. */
export function countCraftOffers(sql: SqlExecutor, turn: { readonly offered: readonly string[]; readonly chosen: readonly string[]; readonly at: number }): void {
  const chosen = new Set(turn.chosen);

  for (const name of new Set(turn.offered)) {
    void (chosen.has(name)
      ? sql`UPDATE crafted_tools SET offered = offered + 1, chosen = chosen + 1, last_used_at = ${turn.at} WHERE name = ${name}`
      : sql`UPDATE crafted_tools SET offered = offered + 1 WHERE name = ${name}`);
  }

  if (turn.offered.length > 0) markStoreChanged(sql);
}

/** A rated turn's verdict on each tool it chose. */
export function rateCraftedTools(sql: SqlExecutor, chosen: readonly string[], score: number): void {
  for (const name of new Set(chosen)) void sql`UPDATE crafted_tools SET rated = rated + 1, rating_sum = rating_sum + ${score / 5} WHERE name = ${name}`;

  if (chosen.length > 0) markStoreChanged(sql);
}

/** Offered at least {@link CraftStoreDefaults.offersBeforeRetirement} turns and chosen by none in the last {@link CraftStoreDefaults.unchosenDays}. */
export function unchosen(row: CraftPreferenceRow, now: number): boolean {
  const { offersBeforeRetirement, unchosenDays } = DEFAULT_CONFIG.craftStore;

  return row.offered >= offersBeforeRetirement && now - row.last_used_at >= unchosenDays * MS_PER_DAY;
}
