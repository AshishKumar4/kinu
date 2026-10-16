// What earns the owner a sound and a notification (owner, 2026-10-15): a workspace's turn finishing, or something
// new waiting on them; never a tool call, and never while they are looking at Kinu.
import { describe, expect, test } from 'bun:test';
import { ownerIsAway, watchFrame, type AlertWatch, type OwnerAlert, type RosterEntry, type WorkspaceOverview } from '../src/index';

/** A tile: the workspace's activity, the decisions waiting, and the main agent's newest run, `run!` once sealed. */
const endOf = (run: string): string | null => {
  if (!run.endsWith('!')) return null;

  return run.includes('err') ? 'error' : 'complete';
};

const tile = (activity: WorkspaceOverview['activity'], run: string | null = null, decisions = 0): RosterEntry => {
  const latestRun = run === null ? null : { status: endOf(run), task: 'Run ten commands', run: run.replace('!', '') };

  return {
    name: 'ledger', displayName: 'Ledger', createdAt: 1, lastVisited: 2, decisions,
    overview: { activity, decisionsWaiting: decisions, hasUpdates: false, latestRun, slates: [], shares: [], awaitsSettings: false },
  };
};

/** The alerts a page hears over `frames`, the first the roster it loaded with. */
function alertsOver(frames: readonly (RosterEntry | null)[]): OwnerAlert[] {
  let watch: AlertWatch | null = null;
  const heard: OwnerAlert[] = [];

  for (const frame of frames) {
    const next = watchFrame(watch, frame);

    watch = next.watch;

    if (next.alert !== null) heard.push(next.alert);
  }

  return heard;
}

describe("a workspace's alerts, frame by frame", () => {
  test('a run that ends tells the owner it finished, once, however many frames follow', () => {
    expect(alertsOver([tile('idle', 'r1!'), tile('working', 'r2'), tile('working', 'r2'), tile('idle', 'r2!'), tile('idle', 'r2!'), tile('unfinished', 'r2!')])).toEqual(['finished']);
  });

  test('a run that failed is finished too', () => {
    expect(alertsOver([tile('idle', 'r1!'), tile('working', 'r2'), tile('unfinished', 'r2err!')])).toEqual(['finished']);
  });

  // Owed deliveries flushing, a terminal closing, a tab coming or going: the tile works a moment and no run ran.
  test('a tile that works a moment with no new run tells nothing', () => {
    expect(alertsOver([tile('idle', 'r1!'), tile('working', 'r1!'), tile('unfinished', 'r1!'), tile('working', 'r1!'), tile('idle', 'r1!')])).toEqual([]);
  });

  test('two runs, two alerts, each at its end', () => {
    expect(alertsOver([tile('idle', 'r1!'), tile('working', 'r2'), tile('idle', 'r2!'), tile('working', 'r3'), tile('idle', 'r3!')])).toEqual(['finished', 'finished']);
  });

  test("a run that ends while the workspace still works, as its agents do, tells at the workspace's end", () => {
    expect(alertsOver([tile('idle', 'r1!'), tile('working', 'r2'), tile('working', 'r2!'), tile('working', 'r2!'), tile('idle', 'r2!')])).toEqual(['finished']);
  });

  test('a new decision waiting tells the owner, even mid-run; a run that then ends on it tells nothing more', () => {
    expect(alertsOver([tile('idle', 'r1!'), tile('working', 'r2'), tile('working', 'r2', 1), tile('idle', 'r2!', 1)])).toEqual(['needs-you']);
    expect(alertsOver([tile('idle', 'r1!'), tile('working', 'r2'), tile('idle', 'r2!', 1)])).toEqual(['needs-you']);
    // Answered mid-run: the run's end is news again.
    expect(alertsOver([tile('idle', 'r1!'), tile('working', 'r2', 1), tile('working', 'r2'), tile('idle', 'r2!')])).toEqual(['needs-you', 'finished']);
  });

  test('a decision answered, or the same count again, tells nothing', () => {
    expect(alertsOver([tile('idle', 'r1!', 2), tile('idle', 'r1!', 1), tile('idle', 'r1!', 1)])).toEqual([]);
  });

  test('what the page loaded with is not news: a run that ended before, or one still running that ends after, once', () => {
    expect(alertsOver([tile('idle', 'r1!', 3), tile('idle', 'r1!', 3)])).toEqual([]);
    expect(alertsOver([tile('working', 'r1'), tile('idle', 'r1!')])).toEqual(['finished']);
  });

  test('a workspace gone tells nothing, and a tile stored before it named its runs earns no finish', () => {
    expect(alertsOver([tile('working', 'r2'), null])).toEqual([]);
    expect(alertsOver([tile('idle'), tile('working'), tile('idle')])).toEqual([]);
  });
});

describe('when the owner is away', () => {
  test('away is away from Kinu: no page of it looked at here, in another tab of this browser, or on another device', () => {
    expect(ownerIsAway({ here: false, otherTabs: 0, account: 0 })).toBe(true);
    expect(ownerIsAway({ here: true, otherTabs: 0, account: 1 })).toBe(false);
    // The owner reading another tab of Kinu: this one stays quiet.
    expect(ownerIsAway({ here: false, otherTabs: 1, account: 0 })).toBe(false);
    // Or Kinu on their phone: this browser stays quiet.
    expect(ownerIsAway({ here: false, otherTabs: 0, account: 1 })).toBe(false);
  });
});
