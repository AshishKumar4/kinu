/**
 * The external-number register: every number this repository quotes from a paper,
 * with a locator, a unit, a compute condition where the argument needs one, and
 * the DEPTH of the hand it came from.
 *
 * WHY IT EXISTS. `lean-citations.ts` closed TypeScript -> Lean and immediately
 * found three stale citations, two of them theorems that had never existed. The
 * pattern generalises past Lean: this tree's citations are well kept exactly where
 * something mechanically checks them, and drifted everywhere a boundary was
 * crossed that nothing checks. `docs -> literature` was the last such boundary,
 * and a removed internal audit of seven numbers found six of seven digits correct
 * and four qualifiers wrong — *"at matched compute"* over a comparison that was not,
 * *"58.2 to 83.6"* with no unit over a quantity that has two, an *"up to"*
 * deleted from the paper's own sentence, and a model quotation that was a
 * reviewer's compression.
 *
 * SO THIS REGISTER AIMS AT THE QUALIFIER, NOT THE DIGIT. A gate that compared
 * digits would have passed all seven. What moved was the condition the prose
 * attached to a number the source states without it.
 *
 * WHAT IT CANNOT DO, stated here rather than discovered later. Nothing in this
 * repository can open a paper, so no field below is a verified digit and no
 * `where` is a verified locator. The register makes four different things
 * mechanically true instead:
 *
 *   1. every external number in use is ENUMERABLE, so re-verification has a
 *      worklist rather than a re-read;
 *   2. every one carries a LOCATOR, or says in the register that nobody has one;
 *   3. a claim whose argument depends on a compute condition carries the
 *      condition as a STATEMENT of what was held fixed and where the source
 *      declares it — an adjective is not a condition, and `"matched"` is the
 *      exact string that hid the Koh defect;
 *   4. provenance DEPTH is visible: `primary` means someone here opened the
 *      source, `artifact` means the nearest hand is an internal summary, and
 *      `unverified` means nobody has read it at all. Five of the seven audited
 *      qualifier losses entered through an internal artifact rather than a
 *      source — a summary is a boundary nothing checks, and an artifact is a
 *      summary — so second-hand numbers are legal, enumerable, and visibly
 *      second-hand.
 *
 * `scripts/literature-citations.ts` is the checker. It compares prose against
 * this file; it never re-derives a number.
 */

/**
 * How close the nearest hand got to the source.
 *
 * `artifact` is not a lesser citation and must not be treated as one — it is how
 * research actually reaches a design. It is a WORKLIST entry, because the one
 * drift flag this audit refuted was refuted by going to the paper the librarian
 * had summarised.
 *
 * `withdrawn` is the fourth hand and the one a register normally lacks: a number
 * this repository CITED and has since retracted. It exists because gating the CLAIM
 * must not gate the CAVEAT. The retraction that set this rule keeps
 * *"+12.5 at matched compute"* inside the paragraph that withdraws it, and a rule
 * refusing every bare parity adjective beside a cited number would force the
 * correction to be deleted in order to pass —
 * making the gate an instrument for silent retractions. So the retraction is
 * DECLARED here instead, which is stronger than tolerating it: a withdrawn number
 * may appear only where its paragraph marks it as withdrawn, so re-asserting it as
 * live fails.
 */
export type Hand = 'primary' | 'artifact' | 'unverified' | 'withdrawn';

/** A cited work. `cites` is how it is spelled in our prose; `parameters` are the
 *  source's own experimental settings, which are numbers a claim sentence may
 *  legitimately carry without being results. */
export interface Work {
  readonly id: string;
  readonly source: string;
  readonly cites: readonly string[];
  readonly parameters?: readonly string[];
}

/**
 * One external number.
 *
 * Atomic on purpose: a claim is a NUMBER, not a paragraph, because "every named
 * external number carries a locator" is the property being enforced and a
 * paragraph-sized entry lets one locator cover numbers from three tables.
 */
export interface Claim {
  /** `Work.id`. */
  readonly work: string;
  /** As written in prose, sign and unit suffix included: `+25.4`, `37.0%`, `3.2×`. */
  readonly value: string;
  /** What the number IS. The Chen defect was a number whose `says` and whose
   *  prose disagreed while the digits matched. */
  readonly says: string;
  /** The source's own coordinate: `Table 4`, `Fig. 6`, `Appendix A.2`. Or
   *  `NO_LOCATOR` when nobody here has one — never a guess. */
  readonly where: string;
  /** The quantity's unit. Not decoration: `+25.4` is points of DISCRIMINATION
   *  accuracy, and read as task accuracy it argues the opposite of what it says. */
  readonly unit: string;
  readonly hand: Hand;
  /** REQUIRED when `hand: 'artifact'` — the internal summary that carried it. */
  readonly via?: string;
  /** Who established this entry and how. Attribution, so a future drift has an
   *  address. */
  readonly verifiedBy: string;
  /** A hedge the source states and prose MUST keep. GEPA's paper says *"up to
   *  11.33%"*; the spec said `+11.33%`, overstating its own justification. */
  readonly hedge?: string;
  /** Words that name the unit. When present, prose citing this number must use
   *  one of them. */
  readonly unitWords?: readonly string[];
  /** REQUIRED when `computeDependent`: what was held fixed, and where the source
   *  declares it. */
  readonly condition?: string;
  /** Set when the ARGUMENT made from this number depends on a compute condition.
   *  Both drifts that changed an argument rather than a footnote were of this
   *  kind. */
  readonly computeDependent?: true;
  /** Why nobody has read it, and what a verifier should do. Required for
   *  `unverified`. */
  readonly note?: string;
}

/** No locator is on record. Distinguishable from a locator, and from a locator
 *  that turns out to be wrong — which is the whole point of the crash-versus-zero
 *  rule in `strategy/objective.ts`'s `VerifierFault`, applied to citations. */
export const NO_LOCATOR = 'no locator on record';

export const WORKS: readonly Work[] = [
  {
    id: 'koh-tree-search',
    source: 'Koh et al., Tree Search for Language Model Agents, arXiv:2407.01476v2',
    cites: ['Koh et al.', 'Koh Table', 'Koh 5', '2407.01476',
      'Koh et al.'],
    // c/d/b are the search hyperparameters; SC(n) counts are value-function calls;
    // 200 is the ablation subset size; n=7 is the re-ranking arm's plateau point.
    parameters: ['20', '5', '3', '1', '7', '200'],
  },
  {
    id: 'self-moa',
    source: 'Wang et al., Rethinking Mixture-of-Agents, arXiv:2502.00674',
    cites: ['Self-MoA (2502.00674)', 'Self-MoA, arXiv 2502.00674', '2502.00674', 'Self-MoA'],
  },
  {
    id: 'gepa',
    source: 'Agrawal et al., GEPA: Reflective Prompt Evolution, ICLR 2026, arXiv:2507.19457',
    cites: ['GEPA', '2507.19457', 'Agrawal et al.'],
  },
  {
    id: 'rainbow-teaming',
    source: 'Samvelyan et al., Rainbow Teaming, arXiv:2402.16822',
    cites: ['Rainbow Teaming', 'Rainbow-Teaming', '2402.16822'],
  },
  {
    id: 'funsearch',
    source: 'Romera-Paredes et al., FunSearch, Nature 625, 2024',
    cites: ['FunSearch'],
    parameters: ['2', '1', '5', '15', '10'],
  },
  {
    id: 'lats',
    source: 'Zhou et al., Language Agent Tree Search, arXiv:2310.04406',
    cites: ['LATS', '2310.04406'],
    parameters: ['4', '7'],
  },
  {
    id: 'tot',
    source: 'Yao et al., Tree of Thoughts, arXiv:2305.10601',
    cites: ['ToT', 'Tree of Thoughts', '2305.10601'],
  },
  {
    id: 'landis-koch',
    source: 'Landis & Koch, The Measurement of Observer Agreement for Categorical Data,'
      + ' Biometrics 33:159, 1977',
    cites: ['Landis & Koch'],
  },
  {
    id: 'absolute-zero',
    source: 'Zhao et al., Absolute Zero, NeurIPS 2025 Spotlight, arXiv:2505.03335',
    cites: ['Absolute Zero', '2505.03335'],
  },
  {
    id: 'self-selection-plateau',
    source: 'arXiv:2602.18998',
    cites: ['arXiv:2602.18998'],
  },
  {
    id: 'clbench',
    source: 'CL-Bench public leaderboard',
    cites: ['CL-Bench'],
  },
];

export const CLAIMS: readonly Claim[] = [
  /* ── Koh: the paragraph a whole refusal is stated over ─────────────────── */
  {
    work: 'koh-tree-search',
    value: '28.5%',
    says: 'GPT-4o value function with NO self-consistency, inside the tree',
    where: 'Table 4',
    unit: 'VWA task success rate, 200-task subset, GPT-4o agent',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2407.01476v2 PDF, 2026-08-18',
    computeDependent: true,
    condition: 'node expansions held fixed at c=20, d=5, b=5 across all five search rows'
      + ' of Table 4; LM calls are NOT held fixed, since SC(n) is n value-function calls'
      + ' per state (Table 4, §5.1)',
  },
  {
    work: 'koh-tree-search',
    value: '30.0%',
    says: 'a WEAKER judge (LLaVA-v1.6-34B) marginalised to SC(20), inside the same tree —'
      + ' not a re-ranking arm',
    where: 'Table 4',
    unit: 'VWA task success rate, 200-task subset, GPT-4o agent',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2407.01476v2 PDF, 2026-08-18',
    computeDependent: true,
    condition: 'node expansions held fixed at c=20, d=5, b=5; only the value function'
      + ' varies (Table 4, §5.1)',
  },
  {
    work: 'koh-tree-search',
    value: '+8.5',
    says: 'marginalising the same judge SC(1) -> SC(20) at fixed expansions (28.5 -> 37.0)',
    where: 'Table 4',
    unit: 'points of VWA task success rate',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2407.01476v2 PDF, 2026-08-18',
    computeDependent: true,
    condition: 'node expansions held fixed at c=20, d=5, b=5, and LM calls are NOT:'
      + ' SC(20) is twenty value-function calls per state against one (Table 4, §5.1)',
  },
  {
    work: 'koh-tree-search',
    value: '+12.5',
    says: 'WITHDRAWN. 37.0 - 24.5, cited for a year as "+12.5 at matched compute". The span'
      + ' crosses the no-search row, which performs zero expansions, so it is not matched'
      + ' compute by construction; §5.4 prices the span at "up to 20x more LM calls than an'
      + ' agent without search". The supported comparisons are the five Table 4 rows at'
      + ' fixed expansions, and Appendix A.2 Fig. 6 for search-versus-not',
    where: 'Table 4',
    unit: 'points of VWA task success rate — over a row that does no search',
    hand: 'withdrawn',
    verifiedBy: 'SpecAudit.SpecEvidence found the drift; LiteratureGate confirmed it against'
      + ' arXiv:2407.01476v2, 2026-08-18',
    note: 'It may appear ONLY inside a retraction. The retraction keeps it as history,'
      + ' because a document that found this defect in its own citations owes the reader'
      + ' the correction rather than a silent edit — and a withdrawn number that is merely'
      + ' deleted comes back.',
  },

  /* ── Self-MoA: the second "identical compute" that is not a cost claim ──── */
  {
    work: 'self-moa',
    value: '59.1',
    says: 'Mixed-MoA — two-layer MoA over six different proposers',
    where: 'Table 1',
    unit: 'AlpacaEval 2.0 length-controlled win rate',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2502.00674 PDF, 2026-08-18',
    computeDependent: true,
    condition: 'six proposals and one aggregator (Qwen1.5-110B-Chat) held fixed across both'
      + ' arms, §3.1 and Table 1. The paper claims NO cost parity: the six mixed proposers'
      + ' span 132B-141B MoE downward, so token cost differs',
  },
  {
    work: 'self-moa',
    value: '65.7',
    says: 'Self-MoA — six samples from the single strongest proposer, same aggregator',
    where: 'Table 1',
    unit: 'AlpacaEval 2.0 length-controlled win rate',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2502.00674 PDF, 2026-08-18',
    computeDependent: true,
    condition: 'six proposals and one aggregator (Qwen1.5-110B-Chat) held fixed across both'
      + ' arms, §3.1 and Table 1. The Self-MoA arm is the KNOWN-STRONGEST model, and §4.2'
      + ' shows the sign reversing once proposer quality is matched',
  },
  {
    work: 'self-moa',
    value: '3.2×',
    says: 'the largest ratio of the quality coefficient to the diversity coefficient across'
      + ' the three regressions (CRUX: 4.548 vs 1.421)',
    where: 'Table 4',
    unit: 'ratio of standardised linear-regression coefficients, quality over diversity',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2502.00674 PDF, 2026-08-18 — MMLU 1.39x, CRUX 3.20x,'
      + ' MATH 1.66x, so "up to" is the honest quantifier',
    hedge: 'up to',
  },

  /* ── Second-hand: the audit read these, this gate did not ───────────────── */
  {
    work: 'rainbow-teaming',
    value: '0.6',
    says: 'the parent-child BLEU similarity threshold above which a mutant is discarded —'
      + ' a PARENT-CHILD filter, not novelty against the archive',
    where: NO_LOCATOR,
    unit: 'BLEU similarity threshold',
    hand: 'artifact',
    via: 'agent://SpecAudit.SpecEvidence',
    verifiedBy: 'SpecAudit.SpecEvidence read the paper first-hand; this gate has not',
    note: 'the numbers were read first-hand by the audit but the table designator was not'
      + ' carried back, so no locator reached this register. A verifier reading the'
      + ' similarity-filter ablation should record it — and check the mechanism while there,'
      + ' since our prose says "no novelty rejection test", which normally means novelty'
      + ' against the ARCHIVE, while the paper ablates a PARENT-CHILD filter, which is'
      + ' strictly weaker.',
  },
  {
    work: 'rainbow-teaming',
    value: '0.4',
    says: 'NOT a number the paper states. It is this repository\'s archive novelty floor,'
      + ' derived as 1 − 0.6 because `advance:{kind:"archive"}` takes a DISTANCE floor'
      + ' where the paper states a SIMILARITY ceiling. Registered so the conversion and'
      + ' its caveat travel with the digit.',
    where: NO_LOCATOR,
    unit: 'Jaccard distance floor, converted from a BLEU similarity ceiling',
    hand: 'artifact',
    via: 'agent://SpecAudit.SpecEvidence',
    verifiedBy: 'derived here from the 0.6 entry above; no paper states 0.4',
    note: 'TWO QUALIFIERS ARE LOST AND BOTH ARE STATED RATHER THAN HIDDEN. The paper'
      + ' ablates a PARENT-CHILD filter and this floor is measured against the ARCHIVE,'
      + ' which is a different and stronger mechanism; and the paper measures BLEU'
      + ' similarity where `noveltyDistance` is one minus Jaccard token overlap, which is'
      + ' a different metric. So this is the only measured rejection bar in evidence,'
      + ' adopted for the SHAPE of the rule rather than for its magnitude, and nobody has'
      + ' measured a floor for these archives. A run that finds cells collapsing or'
      + ' starving should move it and record what it measured.',
  },
  {
    work: 'lats',
    value: '4',
    says: 'the number of independent assertions LATS generates per candidate',
    where: '§5.2, the programming instantiation',
    unit: 'generated assertions per candidate',
    hand: 'artifact',
    via: 'agent://TreeSearchLiterature',
    verifiedBy: 'MctsAsLats read the reference implementation (programming/mcts.py); the'
      + ' paper section itself is second-hand here',
  },
  {
    work: 'lats',
    value: '7',
    says: 'the maximum search depth LATS runs',
    where: NO_LOCATOR,
    unit: 'tree depth',
    hand: 'unverified',
    verifiedBy: 'nobody',
    note: 'used to argue our depth cap. A verifier should confirm the depth is 7 in the'
      + ' programming instantiation rather than in the ReAct one, since the spec relies on'
      + ' that distinction elsewhere.',
  },
  {
    work: 'tot',
    value: '3',
    says: 'the maximum depth Tree-of-Thoughts runs',
    where: NO_LOCATOR,
    unit: 'tree depth',
    hand: 'unverified',
    verifiedBy: 'nobody',
    note: 'part of the "every cited system runs 2-7" range. Cheap to verify and it bounds'
      + ' a shipped default.',
  },
  {
    work: 'landis-koch',
    value: '0.61',
    says: 'the lower bound of the "substantial agreement" band on the kappa scale',
    where: NO_LOCATOR,
    unit: 'Cohen kappa',
    hand: 'unverified',
    verifiedBy: 'nobody',
    note: 'a famous benchmark scale used as a shipped acceptance threshold. Verifying it'
      + ' is one table lookup.',
  },
  {
    work: 'absolute-zero',
    value: '0.3',
    says: 'the low end of the "barely succeeds" success-rate band',
    where: NO_LOCATOR,
    unit: 'task success rate',
    hand: 'unverified',
    verifiedBy: 'nobody',
    note: 'drives curriculum difficulty selection. Verify the band is stated as a success'
      + ' rate rather than as a reward.',
  },
  {
    work: 'absolute-zero',
    value: '0.7',
    says: 'the high end of the "barely succeeds" success-rate band',
    where: NO_LOCATOR,
    unit: 'task success rate',
    hand: 'unverified',
    verifiedBy: 'nobody',
    note: 'see the 0.3 entry.',
  },
  {
    work: 'self-selection-plateau',
    value: '55%',
    says: 'where model self-selection plateaus',
    where: NO_LOCATOR,
    unit: 'selection accuracy',
    hand: 'unverified',
    verifiedBy: 'nobody',
    note: 'cited in `mcts/evaluation.ts` as research grounding for the evaluation design.'
      + ' Neither number has a locator and neither has been read here.',
  },
  {
    work: 'self-selection-plateau',
    value: '99%',
    says: 'the oracle comparison for the same plateau',
    where: NO_LOCATOR,
    unit: 'selection accuracy',
    hand: 'unverified',
    verifiedBy: 'nobody',
    note: 'see the 55% entry.',
  },
  {
    work: 'clbench',
    value: '22.3%',
    says: 'the leaderboard leader\'s normalised reward',
    where: NO_LOCATOR,
    unit: 'normalised reward',
    hand: 'artifact',
    via: 'agent://BenchAnchors',
    verifiedBy: 'transcribed from the public leaderboard into `bench/report.ts`; the'
      + ' leaderboard is a moving target and no snapshot date is recorded',
    note: 'a LIVE leaderboard, which is the one source shape that drifts without anybody'
      + ' editing our prose. Re-verification here means re-reading the board and recording'
      + ' the date, and the absence of a snapshot date is the finding.',
  },
  {
    work: 'clbench',
    value: '25.4%',
    says: 'the same leader\'s gain',
    where: NO_LOCATOR,
    unit: 'gain over the stateless arm — a DELTA, not a reward level',
    unitWords: ['gain'],
    hand: 'artifact',
    via: 'agent://BenchAnchors',
    verifiedBy: 'transcribed from the public leaderboard; no snapshot date is recorded',
    note: 'see the 22.3% entry — no snapshot date. Its unit is CONFUSABLE with the entry'
      + ' above: the same board reports the same leader as 22.3% normalised reward and'
      + ' 25.4% gain, so both are percentages about one subject, three points apart, and'
      + ' a bare 25.4% reads as the reward level — which asserts the leader scores above'
      + ' the 22.3% this register records for it and leaves the gain unstated. `gain` is'
      + ' the word that separates them, so prose citing this number must carry it.',
  },
];
