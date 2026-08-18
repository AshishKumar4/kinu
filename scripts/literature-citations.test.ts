/**
 * The literature gate's own decision logic, proven RED in every direction it claims
 * to govern and green on the corrected text.
 *
 * Every red case below is a defect that was ACTUALLY in this tree tonight, taken
 * from the seven-number audit of `docs/EXPLORATION-SPEC.md` — `+12.5 at matched
 * compute` over a subtraction spanning a no-search row, `58.2 to 83.6` with no unit
 * over a quantity that has two, GEPA's `up to` deleted, and a locator naming the
 * wrong figure. A gate whose rules are only ever exercised by a clean tree cannot
 * tell you whether it still works.
 *
 * The false positives at the bottom are equally load-bearing, and each one cost a
 * design change: this gate reads prose, and earlier versions demanded a paper
 * locator for an auto-GEPA cadence, for a `criteria 2-5` label, for `GPT-4.1-Mini`'s
 * version number, and for our own confidence bound standing beside a citation.
 */

import { describe, test, expect } from 'bun:test';
import { auditCoverage, auditProse, auditRegister, coverage } from './literature-citations';

/** One markdown file, as the gate reads its corpus. */
function audit(text: string): string[] {
  return auditProse('docs/FIXTURE.md', text, coverage());
}

/** One source file, where a citation reaches its own sentence only. */
function auditSource(text: string): string[] {
  return auditProse('packages/core/src/fixture.ts', text, coverage());
}

describe('the register governs itself before it judges prose', () => {
  test('the shipped register is coherent', () => {
    // Not a tautology: this is the check that made `where: "the similarity-filter
    // ablation"` a finding rather than a locator, and that caught a `8.4` entry
    // registered from what turned out to be our own `§8.4`.
    expect(auditRegister()).toEqual([]);
  });
});

describe('a number with no locator', () => {
  test('an unregistered figure beside a cited source is refused', () => {
    const found = audit(
      'Koh et al. 2407.01476 Table 4 reports 41.7% on the same 200-task subset.',
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('41.7%');
    expect(found[0]).toContain('carries no locator');
  });

  test('and the registered figure beside it passes, so the check is not blanket', () => {
    expect(audit('Koh et al. 2407.01476 Table 4 reports 37.0% on the same subset.')).toEqual([]);
  });

  test('a source cited with numbers and no register entry at all is refused', () => {
    const found = audit('Vaswani et al. report 28.4 BLEU on WMT14 English-to-German.');
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('no register entry');
  });
});

describe('a compute-dependent claim under a bare adjective', () => {
  test('the exact string that hid the Koh defect is refused', () => {
    // The whole reason this gate exists in this shape. `37.0%` is real, its digits
    // were never wrong, and every digit-comparing checker would have passed it.
    const found = audit('Koh et al. 2407.01476 Table 4 gives 37.0% at matched compute.');
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('is an adjective where a compute condition belongs');
    expect(found[0]).toContain('node expansions held fixed');
  });

  test('every parity adjective in the family, not just the one we were bitten by', () => {
    for (const adjective of [
      'at matched compute', 'at identical compute', 'at equal inference compute',
      'at the same budget', 'compute-matched', 'matched-budget', 'at parity',
    ]) {
      const found = audit(`Koh et al. 2407.01476 Table 4 gives 37.0% ${adjective}.`);
      expect(found.length).toBeGreaterThan(0);
      expect(found.join(' ')).toContain('adjective where a compute condition belongs');
    }
  });

  test('the same sentence passes once it says what was held fixed', () => {
    expect(audit(
      'Koh et al. 2407.01476 Table 4 gives 37.0% with node expansions held fixed at c=20,'
      + ' d=5, b=5 across all five search rows.',
    )).toEqual([]);
  });

  test('a claim that does NOT depend on a compute condition is not policed for one', () => {
    // Chen's Table 3 numbers are end-to-end accuracies, not a budget comparison, so
    // the adjective rule must not fire on them — a gate that refused every adjective
    // everywhere would be refusing English.
    expect(audit(
      'Chen et al. 2402.10890 Table 3 puts greedy generation at 62.3 at the same budget.',
    )).toEqual([]);
  });
});

describe('a hedge the source states and our prose drops', () => {
  test("GEPA's own `up to` may not be deleted", () => {
    const found = audit('GEPA earns it inside its own budget (+11.33% over beam).');
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('without the source\'s own "up to"');
  });

  test('and passes when the hedge is kept', () => {
    expect(audit('GEPA earns it inside its own budget (up to +11.33% over beam).')).toEqual([]);
  });
});

describe('a unit with a confusable twin', () => {
  test('the Chen relabel: 58.2 to 83.6 without naming which accuracy is refused', () => {
    // The original sentence, verbatim from before the fix. Its digits are exact.
    const found = audit(
      'Chen et al. measure execution grounding lifting CodeLlama-13B from 58.2 to 83.6 on'
      + ' Spider, so a plan-mode tree runs where the literature says a tree does not pay.',
    );
    expect(found).toHaveLength(2);
    expect(found[0]).toContain('without naming its unit');
  });

  test('"discriminator" is not "discrimination" — the thing is not the unit', () => {
    const found = audit(
      'Chen et al. 2402.10890 says the discriminator lifts CodeLlama-13B from 58.2 to 83.6.',
    );
    expect(found).toHaveLength(2);
  });

  test('and the corrected paragraph passes, naming the unit once for the paragraph', () => {
    expect(audit(
      'Chen et al. 2402.10890 Table 2 measures discrimination accuracy, not task accuracy:'
      + ' environmental observations lift CodeLlama-13B on Spider from 58.2 to 83.6.'
      + '\nIt is exactly the quantity this claim is about, and 83.6 is still under the bar.',
    )).toEqual([]);
  });
});

describe('a locator that does not hold the number', () => {
  test('prose naming Table 4 for a Table 3 number is refused', () => {
    const found = audit('Chen et al. 2402.10890 Table 4 gives 62.3 for greedy generation.');
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('which the register locates at Table 3');
  });

  test('the same number under its own locator passes', () => {
    expect(audit('Chen et al. 2402.10890 Table 3 gives 62.3 for greedy generation.')).toEqual([]);
  });

  test('two locators in one sentence are not compared, and this is a stated blind spot', () => {
    // `32.0%` lives in Fig. 2 and the re-ranking arm in Appendix A.2 / Fig. 6. Which
    // number belongs to which is not readable from the text, so a comparison here
    // would be a guess dressed as a check.
    expect(audit(
      'Koh et al. 2407.01476 Appendix A.2, Fig. 6 has re-ranking plateau at 30% against'
      + ' 32.0% for tree search at c=5.',
    )).toEqual([]);
  });
});

describe('a withdrawn number', () => {
  test('re-asserting it as live is refused', () => {
    const found = audit(
      'Koh et al. 2407.01476 Table 4 shows +12.5 from a purely judged scalar.',
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('WITHDRAWN');
  });

  test('quoting it inside a retraction passes — the gate must not force silent edits', () => {
    // ObjectiveSpec's case, and the reason `hand: 'withdrawn'` exists: satisfying a
    // blanket adjective rule would have meant DELETING the evidence that the claim
    // was withdrawn.
    expect(audit(
      'Wrong the first time — a matched-compute claim assembled from two unmatched'
      + ' comparisons. I wrote that Koh et al. 2407.01476 Table 4 held the budget fixed and'
      + ' that no-search 24.5% to judge+SC(20) 37.0% was "+12.5 at matched compute".',
    )).toEqual([]);
  });

  test('retraction vocabulary matches the words a documenting author writes', () => {
    // `LeanModel` hit the inverse of this building the sibling category: a trailing
    // `\b` after a stem meant the regex never matched the inflected form anyone
    // actually types. Every form below must license the quotation.
    for (const marker of [
      'This is withdrawn.', 'It was withdrawn.', 'I am withdrawing it.',
      'Retracted.', 'This retraction stands.', 'The arm was fabricated.',
      'A fabrication, not a drift.', 'It was wrong.', 'Relabelled after a read.',
      'An earlier revision said otherwise.', 'It must not be cited.',
    ]) {
      expect(audit(`${marker} Koh et al. 2407.01476 Table 4 showed +12.5.`)).toEqual([]);
    }
  });
});

describe('the false positives that shaped the corpus decision', () => {
  test('an auto-GEPA cadence is not a citation of GEPA', () => {
    // A product name is not an attribution: `GEPA` is a module here as often as it
    // is a paper, and demanding a paper locator for a turn count is how a gate
    // teaches people to stop citing.
    expect(auditSource(
      '/** Default auto-GEPA cadence when the agent has no explicit setting: one pass per'
      + ' 25 turns of new traces. */',
    )).toEqual([]);
  });

  test('a label on one of our own criteria is not a result', () => {
    expect(auditSource(
      '/** The laundering path arXiv:2509.26354 describes — so criteria 2-5 are enforced'
      + ' here in full. */',
    )).toEqual([]);
  });

  test("a model name's version number is not a measurement", () => {
    expect(audit(
      "GEPA's Merge flips sign by model (GPT-4.1-Mini 66.36 vs 65.22).",
    )).toEqual([]);
  });

  test('our own confidence bound beside a citation belongs to us', () => {
    // Two sentences, and reading them as one attributed OUR 95% bound to Landis &
    // Koch. The sentence splitter has to survive `0.60.**` followed by a citation.
    expect(auditSource(
      '/** kappa lower 95% bound >= 0.60.** Landis & Koch put "substantial" agreement at'
      + ' 0.61 and up. */',
    )).toEqual([]);
  });

  test('a doc comment does not pool one citation over a module of constants', () => {
    // The reach differs by file kind: in Markdown a citation carries forward through
    // the section, in a doc comment it reaches its own sentence. Sharing one rule
    // demanded paper locators for a whole module's defaults.
    expect(auditSource([
      '/**',
      ' * Self-MoA (2502.00674) found the homogeneous ensemble beat the mixed one 65.7 vs',
      ' * 59.1 with the proposer count and topology held fixed.',
      ' * The live default of 20 is above every system in the literature.',
      ' * Evaluation failures score 0, not neutral 0.5.',
      ' */',
    ].join('\n'))).toEqual([]);
  });

  test('a table row does not inherit the row above it', () => {
    expect(audit([
      '| refused | why, measured |',
      '| tree selector + judge | Koh et al. 2407.01476 Table 4: 37.0% at SC(20). |',
      '| archive + judged descriptor | judge variance in the key is unrecoverable, 3 of 5. |',
    ].join('\n'))).toEqual([]);
  });
});

describe('the enumerability ratchet', () => {
  test('an empty corpus is a finding, not a pass', () => {
    // The one failure a gate must not have, and the reason `sources.ts` throws on an
    // empty enumeration.
    const found = auditCoverage(coverage());
    expect(found.some((finding) => finding.includes('cannot fail'))).toBe(true);
  });

  test('a register entry nothing cites is a finding', () => {
    const seen = coverage();
    auditProse('docs/FIXTURE.md', 'Nothing is cited here.', seen);
    expect(auditCoverage(seen).some((f) => f.includes('is cited nowhere'))).toBe(true);
  });
});
