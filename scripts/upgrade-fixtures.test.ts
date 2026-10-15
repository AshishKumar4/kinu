// What a staging deploy's upgrade fixtures do with what the previous deploy seeded: checked against the anchor the
// releases bucket holds, outside every workspace it checks. A miss is red and changes nothing, so a rerun is red too;
// fixtures gone with the anchor still there are a miss; only an absent anchor (a full reset deletes it) seeds a first.
import { expect, test } from 'bun:test';
import { runFixtures, type FixtureRun, type Manifest, type Verdict } from './upgrade-fixtures';

/** A deployment as the fixtures meet it: the bucket's anchor, and what the fixture account still holds. */
function staging(holds: { anchor: Manifest | null; kept: boolean }) {
  const retired: string[] = [];
  const checked: string[] = [];
  const state = { anchor: holds.anchor, kept: holds.kept, seeds: 0, retired, fresh: 0, checked };

  const run: FixtureRun = {
    anchor: async () => state.anchor,
    continuity: async (expected) => {
      state.checked.push(expected.seededAt);

      return [['the roster names the workspace', state.kept, `the roster does not name ${expected.workspace}`]] satisfies Verdict[];
    },
    freshStart: async () => {
      state.fresh += 1;

      return { workspace: `upgrade-fresh-${String(state.fresh)}`, verdicts: [] };
    },
    seed: async ({ fresh, previous }) => {
      state.seeds += 1;
      const seededAt = `seed-${String(state.seeds)}`;

      return {
        manifest: {
          seededAt, workspace: 'upgrade-fixture', note: { path: previous?.note.path === 'notes/upgrade-a.md' ? 'notes/upgrade-b.md' : 'notes/upgrade-a.md', text: seededAt },
          said: seededAt, senderWorkspace: 'upgrade-sender', share: `share-${seededAt}`, device: `device-${seededAt}`, fresh,
        },
        verdicts: [['the seed holds', true, '']],
      };
    },
    writeAnchor: async (manifest) => {
      state.anchor = manifest;
      // What the seed made is what the account holds now.
      state.kept = true;
    },
    retire: async (made) => { state.retired.push(made.seededAt); },
  };

  return { state, run };
}

const silent = (_title: string, verdicts: readonly Verdict[]) => verdicts.every(([, held]) => held);

const BASELINE: Manifest = {
  seededAt: 'baseline', workspace: 'upgrade-fixture', note: { path: 'notes/upgrade-a.md', text: 'baseline' }, said: 'baseline',
  senderWorkspace: 'upgrade-sender', share: 'share-baseline', device: 'device-baseline', fresh: 'upgrade-fresh-0',
};

test('a continuity miss is red, run twice, and leaves the baseline and the anchor as they were', async () => {
  const { state, run } = staging({ anchor: BASELINE, kept: false });

  expect(await runFixtures(run, silent)).toBe(false);
  expect(await runFixtures(run, silent)).toBe(false);
  expect(state).toEqual({ anchor: BASELINE, kept: false, seeds: 0, retired: [], fresh: 0, checked: ['baseline', 'baseline'] });
});

test('every fixture gone while the anchor is still there is a miss, never a first seed', async () => {
  const { state, run } = staging({ anchor: BASELINE, kept: false });

  expect(await runFixtures(run, silent)).toBe(false);
  expect({ seeds: state.seeds, anchor: state.anchor?.seededAt }).toEqual({ seeds: 0, anchor: 'baseline' });
});

test('after a full reset, which deletes the anchor, one first seed; the deploy after it checks that seed', async () => {
  const { state, run } = staging({ anchor: null, kept: false });

  expect(await runFixtures(run, silent)).toBe(true);
  expect({ seeds: state.seeds, anchor: state.anchor?.seededAt, checked: state.checked }).toEqual({ seeds: 1, anchor: 'seed-1', checked: [] });

  expect(await runFixtures(run, silent)).toBe(true);
  expect({ seeds: state.seeds, anchor: state.anchor?.seededAt, checked: state.checked, retired: state.retired })
    .toEqual({ seeds: 2, anchor: 'seed-2', checked: ['seed-1'], retired: ['seed-1'] });
  // Each seed's file takes the path the baseline's does not.
  expect(state.anchor?.note.path).toBe('notes/upgrade-b.md');
});

test('a seed that does not hold is removed, and the anchor stays the baseline it would have replaced', async () => {
  const { state, run } = staging({ anchor: BASELINE, kept: true });

  const failing: FixtureRun = { ...run, seed: async (made) => ({ ...await run.seed(made), verdicts: [['the seed holds', false, 'its share never arrived']] }) };

  expect(await runFixtures(failing, silent)).toBe(false);
  expect({ anchor: state.anchor?.seededAt, retired: state.retired }).toEqual({ anchor: 'baseline', retired: ['seed-1'] });
});
