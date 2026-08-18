// GEPA selection honesty (wiring). The optimiser must be handed a train set
// DISJOINT from the set its winner is scored on, and must refuse to run at all
// when the ledger has no failure to optimise toward — an empty train set would
// otherwise fall back to the eval set inside runGepa, putting us right back to
// selecting a winner on the instances it was written against.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildOutcomeEvalSplit, recordTurnOutcome } from '../src/index';
import { createTestWorkspace } from './helpers';

const control = readFileSync(join(import.meta.dir, '..', 'src', 'evolution', 'control.ts'), 'utf8');
const gepaCall = (() => {
  const start = control.indexOf('export async function runScaffoldGepaOptimization(');
  return control.slice(start, control.indexOf('\nexport ', start + 1));
})();

describe('runScaffoldGepaOptimization — split wiring', () => {
  test('refuses to run when the split cannot support an out-of-sample selection', () => {
    expect(gepaCall).toContain("split.degeneracy === 'no_labeled_turns' || split.degeneracy === 'no_negatives'");
    expect(gepaCall).toContain('describeSplitDegeneracy(split.degeneracy)');
  });

  test('passes the disjoint sets through and reports what selection rested on', () => {
    expect(gepaCall).toContain('const { train: trainSet, val: evalSet } = split');
    expect(gepaCall).toContain('heldOutNegatives: split.heldOutNegatives');
    expect(gepaCall).toContain(
      'if (split.degeneracy) output.selectionWarning = describeSplitDegeneracy(split.degeneracy)',
    );
  });

  test('the split it consumes really is disjoint on the ledger it reads', () => {
    const { sql } = createTestWorkspace();
    for (let i = 0; i < 6; i++) {
      recordTurnOutcome(sql, {
        turnId: `n${i}`, outcome: 'corrected', confidence: 1, source: 'classifier',
        userMessage: `fix ${i}`, assistantResponse: 'bad', followup: 'no', now: 1000 + i,
      });
      recordTurnOutcome(sql, {
        turnId: `a${i}`, outcome: 'accepted', confidence: 1, source: 'classifier',
        userMessage: `good ${i}`, assistantResponse: 'ok', now: 2000 + i,
      });
    }
    const split = buildOutcomeEvalSplit(sql, 24);
    const trainInputs = new Set(split.train.map((i) => i.input));
    expect(split.val.some((i) => trainInputs.has(i.input))).toBe(false);
    expect(split.heldOutNegatives).toBeGreaterThan(0);
    expect(split.degeneracy).toBeNull();
  });
});
