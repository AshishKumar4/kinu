// What earns the owner a sound and a notification (owner, 2026-10-15): a workspace's turn finishing, or something
// new waiting on them; never a tool call, and never while they are looking at Kinu.
import { describe, expect, test } from 'bun:test';
import { ownerAlertOf, ownerIsAway, type RosterEntry, type WorkspaceOverview } from '../src/index';

const overview = (activity: WorkspaceOverview['activity'], decisionsWaiting = 0): WorkspaceOverview => ({
  activity, decisionsWaiting, hasUpdates: false, latestRun: null, slates: [], shares: [], awaitsSettings: false,
});

const entry = (activity: WorkspaceOverview['activity'] | null, decisions = 0): RosterEntry => ({
  name: 'ledger', displayName: 'Ledger', createdAt: 1, lastVisited: 2, decisions, overview: activity === null ? null : overview(activity, decisions),
});

describe("a roster frame's alert", () => {
  test('a turn that ends tells the owner it finished; a workspace still working, or one already idle, tells nothing', () => {
    expect(ownerAlertOf(entry('working'), entry('idle'))).toBe('finished');
    expect(ownerAlertOf(entry('working'), entry('unfinished'))).toBe('finished');
    expect(ownerAlertOf(entry('working'), entry('working'))).toBeNull();
    expect(ownerAlertOf(entry('idle'), entry('idle'))).toBeNull();
    expect(ownerAlertOf(entry('idle'), entry('working'))).toBeNull();
  });

  test('a new decision waiting tells the owner, even mid-turn; one answered, or the same count again, tells nothing', () => {
    expect(ownerAlertOf(entry('working', 0), entry('working', 1))).toBe('needs-you');
    expect(ownerAlertOf(entry('idle', 1), entry('idle', 2))).toBe('needs-you');
    expect(ownerAlertOf(entry('idle', 2), entry('idle', 1))).toBeNull();
    expect(ownerAlertOf(entry('idle', 1), entry('idle', 1))).toBeNull();
  });

  test('a turn that ends on a decision is one alert, the decision, however the roster saw it arrive', () => {
    expect(ownerAlertOf(entry('working', 0), entry('idle', 1))).toBe('needs-you');
    // The decision told mid-turn: the turn's end that leaves it waiting tells nothing more.
    expect(ownerAlertOf(entry('working', 1), entry('idle', 1))).toBeNull();
  });

  test('a turn that failed is finished too: its tile stops working, unfinished when work is still owed', () => {
    expect(ownerAlertOf(entry('working'), entry('unfinished'))).toBe('finished');
  });

  test('one turn ending is one alert, however many frames the roster sends after it', () => {
    const frames = [entry('idle'), entry('working'), entry('working'), entry('working'), entry('idle'), entry('idle'), entry('unfinished'), entry('idle')];
    const alerts = frames.slice(1).map((after, at) => ownerAlertOf(frames[at] ?? null, after)).filter((alert) => alert !== null);

    expect(alerts).toEqual(['finished']);
  });

  test('a workspace first seen, or one that left the roster, tells nothing', () => {
    expect(ownerAlertOf(null, entry('idle', 3))).toBeNull();
    expect(ownerAlertOf(entry('working', 0), null)).toBeNull();
    expect(ownerAlertOf(entry('working'), entry(null))).toBeNull();
  });
});

describe('when the owner is away', () => {
  test('only a page they are looking at, shown and focused, keeps quiet', () => {
    expect(ownerIsAway({ visibility: 'visible', focused: true })).toBe(false);
    expect(ownerIsAway({ visibility: 'visible', focused: false })).toBe(true);
    expect(ownerIsAway({ visibility: 'hidden', focused: false })).toBe(true);
    expect(ownerIsAway({ visibility: 'hidden', focused: true })).toBe(true);
  });
});
