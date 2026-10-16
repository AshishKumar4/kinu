/**
 * What earns the owner a sound and a notification (owner, 2026-10-15): a workspace's run finishing, or something new
 * waiting on them, read off their roster as each workspace's tile changes. Never a tool call or progress, and never
 * while they are looking at Kinu: at any of its pages, in any tab, on any device.
 */
import type { RosterEntry } from './account-wire';

export type OwnerAlert = 'finished' | 'needs-you';

/** A workspace as a page last saw it: its tile, and the main agent's sealed run it already told of, or found sealed. */
export interface AlertWatch {
  readonly tile: RosterEntry;
  readonly told: string | null;
}

/** What one frame earns: its alert, if any, and the workspace's watch after it (null once it has gone). */
export interface WatchedFrame {
  readonly alert: OwnerAlert | null;
  readonly watch: AlertWatch | null;
}

/** The main agent's newest run once it has ended, however it ended; null while it runs, or on a tile that names none. */
function sealedRun(tile: RosterEntry): string | null {
  const run = tile.overview?.latestRun;

  return run === null || run === undefined || run.status === null ? null : run.run;
}

/**
 * Folds one roster frame into a workspace's watch: the alert the frame earns, and the watch after it. More decisions
 * waiting than before is `needs-you` (an approval, a plan, a consent, a question to the owner), mid-run too. A run the
 * page has not told of that has ended, with the workspace no longer working and nothing waiting, is `finished`: so a
 * failed run counts, a run whose agents still work counts at their end, and the tile working a moment without a run
 * (owed deliveries flushing, a terminal closing) earns nothing. What the page first sees is not news.
 */
export function watchFrame(watch: AlertWatch | null, after: RosterEntry | null): WatchedFrame {
  if (after === null) return { alert: null, watch: null };

  const sealed = sealedRun(after);

  if (watch === null) return { alert: null, watch: { tile: after, told: sealed } };

  const settled = after.overview !== null && after.overview.activity !== 'working';
  const told = settled && sealed !== null ? sealed : watch.told;

  if (after.decisions > watch.tile.decisions) return { alert: 'needs-you', watch: { tile: after, told } };

  const finished = settled && sealed !== null && sealed !== watch.told && after.decisions === 0;

  return { alert: finished ? 'finished' : null, watch: { tile: after, told } };
}

/**
 * Away is away from Kinu, not from one tab: no page of it shown and focused here, in another tab of this browser
 * (`otherTabs`, told across the browser's tabs), or anywhere on the account (`account`, every device's pages as the
 * roster's socket counts them, this one's among them).
 */
export function ownerIsAway(looking: { readonly here: boolean; readonly otherTabs: number; readonly account: number }): boolean {
  return !looking.here && looking.otherTabs === 0 && looking.account === 0;
}
