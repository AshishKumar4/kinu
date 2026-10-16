/**
 * What earns the owner a sound and a notification (owner, 2026-10-15): a workspace's turn finishing, or something new
 * waiting on them, read off their roster as each workspace's tile changes. Never a tool call or progress, and never
 * while they are looking at Kinu: at any of its pages, in any tab, on any device.
 */
import type { RosterEntry } from './account-wire';

export type OwnerAlert = 'finished' | 'needs-you';

/**
 * The alert one roster frame earns, from the tile before it to the tile it carries: more decisions waiting than before
 * is `needs-you` (an approval, a plan, a consent, a question to the owner), which a turn ending on one is too; a turn
 * that stopped working with nothing waiting is `finished`. A turn that stops on a decision already told is that
 * decision still, so it earns none. A workspace first seen, or gone, earns none: there is nothing to compare.
 */
export function ownerAlertOf(before: RosterEntry | null, after: RosterEntry | null): OwnerAlert | null {
  if (before === null || after === null || after.overview === null) return null;

  if (after.decisions > before.decisions) return 'needs-you';

  return before.overview?.activity === 'working' && after.overview.activity !== 'working' && after.decisions === 0 ? 'finished' : null;
}

/**
 * Away is away from Kinu, not from one tab: no page of it shown and focused here, in another tab of this browser
 * (`otherTabs`, told across the browser's tabs), or anywhere on the account (`account`, every device's pages as the
 * roster's socket counts them, this one's among them).
 */
export function ownerIsAway(looking: { readonly here: boolean; readonly otherTabs: number; readonly account: number }): boolean {
  return !looking.here && looking.otherTabs === 0 && looking.account === 0;
}
