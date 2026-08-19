/**
 * The literature gate's own decision logic, proven RED in every direction it claims
 * to govern and green on the corrected text.
 *
 * Every red case below is a defect that was ACTUALLY in this tree, taken from a
 * removed internal audit of seven numbers — `+12.5 at matched compute` over
 * a subtraction spanning a no-search row, a source's own `up to` deleted, and a
 * locator naming the wrong table. A gate whose rules are only ever exercised by a
 * clean tree cannot tell you whether it still works.
 *
 * `unitWords` is the one direction that had to be RE-ANCHORED rather than inherited.
 * Every claim declaring a confusable unit was a Chen et al. entry, and that work left
 * the register when the last document citing it left the repository. The register's
 * own CL-Bench pair carries the same property — one board reports one leader as
 * `22.3%` normalised reward and `25.4%` gain, three points apart, so a bare `25.4%`
 * reads as the level rather than the delta — and the rule is proven against that.
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
    // registered from what turned out to be one of our own section numbers.
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
    expect(audit('Koh et al. 2407.01476 Table 4 reports 28.5% on the same subset.')).toEqual([]);
  });

  test('a source cited with numbers and no register entry at all is refused', () => {
    const found = audit('Vaswani et al. report 28.4 BLEU on WMT14 English-to-German.');
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('no register entry');
  });
});

describe('a compute-dependent claim under a bare adjective', () => {
  test('the exact string that hid the Koh defect is refused', () => {
    // The whole reason this gate exists in this shape. `28.5%` is real, its digits
    // were never wrong, and every digit-comparing checker would have passed it.
    const found = audit('Koh et al. 2407.01476 Table 4 gives 28.5% at matched compute.');
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('is an adjective where a compute condition belongs');
    expect(found[0]).toContain('node expansions held fixed');
  });

  test('every parity adjective in the family, not just the one we were bitten by', () => {
    for (const adjective of [
      'at matched compute', 'at identical compute', 'at equal inference compute',
      'at the same budget', 'compute-matched', 'matched-budget', 'at parity',
    ]) {
      const found = audit(`Koh et al. 2407.01476 Table 4 gives 28.5% ${adjective}.`);
      expect(found.length).toBeGreaterThan(0);
      expect(found.join(' ')).toContain('adjective where a compute condition belongs');
    }
  });

  test('the same sentence passes once it says what was held fixed', () => {
    expect(audit(
      'Koh et al. 2407.01476 Table 4 gives 28.5% with node expansions held fixed at c=20,'
      + ' d=5, b=5 across all five search rows.',
    )).toEqual([]);
  });

  test('a claim that does NOT depend on a compute condition is not policed for one', () => {
    // LATS's generated-assertion count is a setup parameter, not a budget
    // comparison, so the adjective rule must not fire on it — a gate that refused
    // every adjective everywhere would be refusing English.
    expect(audit(
      'LATS 2310.04406 §5.2 generates 4 assertions per candidate at the same budget.',
    )).toEqual([]);
  });
});

describe('a hedge the source states and our prose drops', () => {
  test("Self-MoA's own `up to` may not be deleted", () => {
    const found = audit('Self-MoA 2502.00674 Table 4 puts quality over diversity by 3.2×.');
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('without the source\'s own "up to"');
  });

  test('and passes when the hedge is kept', () => {
    expect(audit(
      'Self-MoA 2502.00674 Table 4 puts quality over diversity by up to 3.2×.',
    )).toEqual([]);
  });
});

describe('a unit whose twin says something else', () => {
  test('a bare CL-Bench percentage does not say whether it is the level or the gain', () => {
    // Read as the level, 25.4% puts the leader above the 22.3% the register records
    // for it and states no gain at all — the shape of the Chen defect this rule was
    // written for, in the one surviving register entry that still has it.
    const found = audit("CL-Bench's leader reaches 25.4% on the public leaderboard.");
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('has a confusable twin');
  });

  test('and passes once the unit is named', () => {
    expect(audit("CL-Bench's leader reaches 25.4% gain over the stateless arm.")).toEqual([]);
  });

  test('the unit is named once and then argued, so the window carries it', () => {
    // Read over the paragraph rather than the sentence on purpose: an author names the
    // quantity and then reasons about it in sentences that do not repeat the noun.
    // `docs/BENCH.md` is exactly this, and dropping the word from the whole paragraph
    // is what makes the live site red.
    expect(audit(
      "CL-Bench's leader reaches 22.3% normalized reward and 25.4%."
      + ' A gain near zero is the normal outcome, not a harness bug.',
    )).toEqual([]);
  });
});

describe('a locator that does not hold the number', () => {
  test('prose naming Table 4 for a Table 1 number is refused', () => {
    const found = audit('Self-MoA 2502.00674 Table 4 puts Mixed-MoA at 59.1.');
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('which the register locates at Table 1');
  });

  test('the same number under its own locator passes', () => {
    expect(audit('Self-MoA 2502.00674 Table 1 puts Mixed-MoA at 59.1.')).toEqual([]);
  });

  test('two locators in one sentence are not compared, and this is a stated blind spot', () => {
    // `59.1` lives in Table 1 and the quality-over-diversity ratio in Table 4. Which
    // number belongs to which is not readable from the text, so a comparison here
    // would be a guess dressed as a check.
    expect(audit(
      'Self-MoA 2502.00674 Table 1 and Table 4 put Mixed-MoA at 59.1 with quality'
      + ' dominating diversity by up to 3.2×.',
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
      + ' that no-search to judge+SC(20) was "+12.5 at matched compute".',
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
      'Agrawal et al. ran GEPA on GPT-4.1-Mini, and a version number is not a result.',
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
      '| tree selector + judge | Koh et al. 2407.01476 Table 4: 28.5% at SC(1). |',
      '| archive + judged descriptor | judge variance in the key is unrecoverable, 3 of 5. |',
    ].join('\n'))).toEqual([]);
  });
});

describe('reach, and the recorded corpus that showed it was unbounded', () => {
  /** A recording as its writer emits one: the timestamp stamped at the head of the
   *  document, and no blank line anywhere after it. */
  const recorded = (body: string): string =>
    `{\n  "ranAt": "2026-08-18T06:06:17.962Z",\n  "replies": [\n${body}\n  ]\n}`;

  /** The sentence the real runs echo hundreds of times: this repository's own R7
   *  refusal, quoted back by the models it was shown to. It carries a genuine
   *  bare-parity defect, and that is the point — a recording is not exempt because it
   *  happens to be clean. */
  const reply =
    '    { "error": "That is the arm Self-MoA (2502.00674) re-ran over Mixture-of-Agents\''
    + ' own six models and measured WORSE than repeated sampling from the single best one'
    + ' — 59.1 against 65.7 at identical compute." },';

  /** Machine-written structure: no blank line and no punctuation, which is what made
   *  a 206KB file one paragraph AND one sentence. */
  const structure = Array.from(
    { length: 600 }, (_, index) => `    { "candidate": ${String(9000 + index)} },`,
  ).join('\n');

  /** One paragraph of prose that names no author, sized like a real one. */
  const passage = 'Filler that names no author and carries no number. '.repeat(17);

  test('the raw recorded corpus produces no findings', () => {
    // 369 of them before this: `-08` out of an ISO timestamp, array indices, and JSON
    // structure, all read as unlocated claims about a paper because a minified or
    // machine-written document is one paragraph and a paragraph was the reach.
    expect(auditProse(
      'scripts/axis-ergonomics/runs/axis-fixture.json',
      recorded(`${reply}\n${structure}`),
      coverage(),
    )).toEqual([]);
  });

  test('and REACH, not the declaration, is what stops a citation crossing a blob', () => {
    // The same bytes with the declaration removed, so the file is fully governed. The
    // candidate beside the citation is a finding; the one 16KB down the same
    // structureless paragraph is not. Under paragraph reach it was.
    const found = auditProse(
      'scripts/axis-ergonomics/runs/axis-fixture.json',
      recorded(`${reply}\n${structure}`).replace('"ranAt"', '"stampedAt"'),
      coverage(),
    );
    expect(found.some((finding) => finding.includes('cites 9000 beside'))).toBe(true);
    expect(found.some((finding) => finding.includes('cites 9599 beside'))).toBe(false);
    // And the load-bearing check still fires on the same text, so the bound did not
    // buy quiet by going blind.
    expect(found.some((finding) =>
      finding.includes('adjective where a compute condition belongs'))).toBe(true);
  });

  test('a real unlocated number in ordinary prose still fails', () => {
    const found = auditProse(
      'scripts/axis-ergonomics/runs/axis-fixture.json',
      recorded(reply).replace('"ranAt"', '"stampedAt"'),
      coverage(),
    );
    expect(found.some((finding) =>
      finding.includes('adjective where a compute condition belongs'))).toBe(true);
  });

  test('a claim three paragraphs from its citation is still governed', () => {
    // The shape that set the bound: a citation opens the passage and
    // the argument runs on for paragraphs without naming an author again. Sentence
    // scope left every number of those paragraphs ungoverned.
    const found = audit([
      '## The passage',
      'Koh et al. 2407.01476 Table 4 holds node expansions fixed at c=20, d=5, b=5.',
      passage, passage, passage,
      'The judged selector still gives 28.5% at matched compute.',
    ].join('\n\n'));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('adjective where a compute condition belongs');
  });

  test('and past the reach it is not — the bound is a blind spot, printed as one', () => {
    expect(audit([
      '## The passage',
      'Koh et al. 2407.01476 Table 4 holds node expansions fixed at c=20, d=5, b=5.',
      passage, passage, passage, passage, passage, passage,
      'The judged selector still gives 28.5% at matched compute.',
    ].join('\n\n'))).toEqual([]);
  });

  test('a register entry whose only home is a recording is a finding, not a pass', () => {
    // The residual that makes the category self-policing. Credit is withheld along
    // with blame, so relabelling real prose as a recording is INEFFECTIVE rather than
    // exculpatory: every number it was carrying becomes a coverage finding, and the
    // corpus reports that it cannot fail.
    const seen = coverage();
    auditProse('scripts/axis-ergonomics/runs/axis-fixture.json', recorded(reply), seen);
    const found = auditCoverage(seen);
    expect(found.some((finding) =>
      finding.includes('self-moa 59.1 is quoted only inside recorded output'))).toBe(true);
    expect(found.some((finding) => finding.includes('cannot fail'))).toBe(true);
  });

  test('a timestamp anywhere but the head of the document exempts nothing', () => {
    // The declared property is that a PROGRAM wrote this document, in one pass, as the
    // record of a run. A `ranAt` pasted into a hand-written file is a suppression
    // handle, and it is refused.
    const found = auditProse(
      'scripts/axis-ergonomics/runs/axis-fixture.json',
      `{\n  "note": "hand written",\n  "ranAt": "2026-08-18T06:06:17.962Z",\n${reply}\n}`,
      coverage(),
    );
    expect(found.some((finding) =>
      finding.includes('adjective where a compute condition belongs'))).toBe(true);
  });

  test('a document placed beside the recordings is governed like any other', () => {
    // Why this is a property of the content and not a glob over `runs/`: a glob would
    // make the gate blind to every future document written there.
    expect(auditProse(
      'scripts/axis-ergonomics/runs/README.md',
      'Koh et al. 2407.01476 Table 4 gives 28.5% at matched compute.',
      coverage(),
    )).toHaveLength(1);
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
