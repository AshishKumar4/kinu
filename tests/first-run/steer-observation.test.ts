import { expect, test } from 'bun:test';
import { LISTING_TURN, STEER, STEER_MARKER, STEER_TURN, steerSubgoals, type SteerEvidence } from './steer-observation';

const WAL = 'Append each change before applying it.\nFlush the log to disk.\nApply the change.\nReplay the log after a crash.\n';

/** What a deployment that carried the correction leaves behind. */
const CARRIED: SteerEvidence = {
  landing: 'mid-turn',
  steered: `${STEER_MARKER}\nA log written before the data it protects.\n`,
  wal: WAL,
  history: [
    { role: 'user', text: STEER_TURN }, { role: 'user', text: STEER }, { role: 'assistant', text: 'DONE' },
    { role: 'user', text: LISTING_TURN }, { role: 'assistant', text: 'steered.txt\nwal.txt' },
  ],
};

function missed(evidence: SteerEvidence): string[] {
  return steerSubgoals(evidence).filter((subgoal) => !subgoal.reached).map((subgoal) => subgoal.what);
}

test('a correction the deployment carried reaches every subgoal, whichever way it landed', () => {
  expect(missed(CARRIED)).toEqual([]);
  expect(missed({ ...CARRIED, landing: 'turn' })).toEqual([]);
});

test('a correction the running turn never read is red: the work follows the first instruction', () => {
  // The planted defect: the steer is acknowledged and dropped, so the one-line version lands where
  // the first instruction put it and the transcript holds no row for the correction.
  const dropped: SteerEvidence = {
    ...CARRIED,
    steered: '',
    history: CARRIED.history.filter((row) => row.text !== STEER).map((row) => row.text === 'steered.txt\nwal.txt'
      ? { ...row, text: 'short.txt\nwal.txt' }
      : row),
  };

  expect(missed(dropped)).toEqual(['correction-applied', 'steer-is-durable', 'listing-truthful']);
});

test('a steer the workspace never answered, and a listing of a file it does not hold, are each red', () => {
  expect(missed({ ...CARRIED, landing: null })).toEqual(['landing']);
  expect(missed({ ...CARRIED, wal: '' })).toEqual(['listing-truthful']);
});
