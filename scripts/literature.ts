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
 * and a seven-number audit found six of seven digits correct and four qualifiers
 * wrong — *"at matched compute"* over a comparison that was not,
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
 * must not gate the CAVEAT. §6.5 keeps *"+12.5 at matched compute"* inside the
 * paragraph that withdraws it, and a rule refusing every bare parity adjective
 * beside a cited number would force the correction to be deleted in order to pass —
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
 *  that turns out to be wrong — which is the whole point of §3.4's crash-versus-
 *  zero rule applied to citations. */
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
    id: 'chen-discriminator',
    source: 'Chen et al., When is Tree Search Useful for LLM Planning? It Depends on the'
      + ' Discriminator, ACL 2024, arXiv:2402.10890',
    cites: ['Chen et al. 2402.10890', '2402.10890', 'Chen et al.'],
    parameters: ['90', '10', '20'],
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
    id: 'seidr',
    source: 'SEIDR, arXiv:2503.07693',
    cites: ['SEIDR', '2503.07693'],
  },
  {
    id: 'pugh-quality-diversity',
    source: 'Pugh, Soros & Stanley, Quality Diversity: A New Frontier for Evolutionary'
      + ' Computation, Frontiers in Robotics and AI, 2016',
    cites: ['Pugh et al.'],
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
    value: '24.5%',
    says: 'no search at all — zero node expansions',
    where: 'Table 4',
    unit: 'VWA task success rate, 200-task subset, GPT-4o agent',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2407.01476v2 PDF, 2026-08-18',
    computeDependent: true,
    condition: 'nothing is held fixed against the search rows: this row performs zero'
      + ' expansions, and §5.4 prices search at "up to 20x more LM calls than an agent'
      + ' without search"',
  },
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
    value: '32.5%',
    says: 'GPT-4o value function marginalised to SC(5)',
    where: 'Table 4',
    unit: 'VWA task success rate, 200-task subset, GPT-4o agent',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2407.01476v2 PDF, 2026-08-18',
    computeDependent: true,
    condition: 'node expansions held fixed at c=20, d=5, b=5 (Table 4, §5.1)',
  },
  {
    work: 'koh-tree-search',
    value: '37.0%',
    says: 'GPT-4o value function marginalised to SC(20) — the best non-oracle row',
    where: 'Table 4',
    unit: 'VWA task success rate, 200-task subset, GPT-4o agent',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2407.01476v2 PDF, 2026-08-18',
    computeDependent: true,
    condition: 'node expansions held fixed at c=20, d=5, b=5 (Table 4, §5.1)',
  },
  {
    work: 'koh-tree-search',
    value: '43.5%',
    says: 'ground-truth reward as the value function — the oracle ceiling',
    where: 'Table 4',
    unit: 'VWA task success rate, 200-task subset, GPT-4o agent',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2407.01476v2 PDF, 2026-08-18',
    computeDependent: true,
    condition: 'node expansions held fixed at c=20, d=5, b=5 (Table 4, §5.1)',
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
    value: '+4.5',
    says: 'SC(5) -> SC(20) on the same judge (32.5 -> 37.0)',
    where: 'Table 4',
    unit: 'points of VWA task success rate',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2407.01476v2 PDF, 2026-08-18',
    computeDependent: true,
    condition: 'node expansions held fixed at c=20, d=5, b=5; value-function calls rise'
      + ' 4x (Table 4, §5.1)',
  },
  {
    work: 'koh-tree-search',
    value: '6.5',
    says: 'oracle headroom over the best judge (43.5 - 37.0)',
    where: 'Table 4',
    unit: 'points of VWA task success rate',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2407.01476v2 PDF, 2026-08-18',
    computeDependent: true,
    condition: 'node expansions held fixed at c=20, d=5, b=5; both rows are the same'
      + ' search (Table 4, §5.1)',
  },
  {
    work: 'koh-tree-search',
    value: '32.0%',
    says: 'tree search at the SMALL budget c=5, the arm the paper compares to re-ranking',
    where: 'Fig. 2',
    unit: 'VWA task success rate, 200-task subset, GPT-4o agent',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2407.01476v2 PDF, 2026-08-18',
    computeDependent: true,
    condition: 'the VALUE FUNCTION is held identical across both arms — the same judge'
      + ' re-ranks the trajectories it scored inside the tree — while the budget axis'
      + ' differs by construction, c expansions against n trajectories (Appendix A.2,'
      + ' Fig. 6). The paper states "this underperforms our approach with search budget'
      + ' c >= 5" and nowhere claims equal inference compute',
  },
  {
    work: 'koh-tree-search',
    value: '30%',
    says: 'trajectory re-ranking through the same value function, plateauing around n=7',
    where: 'Appendix A.2',
    unit: 'VWA task success rate, 200-task subset, GPT-4o agent',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2407.01476v2 PDF, 2026-08-18',
    computeDependent: true,
    condition: 'the value function is held identical to the tree arm; the budget axis is'
      + ' n trajectories against c expansions (Appendix A.2, Fig. 6)',
  },
  {
    work: 'koh-tree-search',
    value: '+2',
    says: 'tree search at c=5 over re-ranking at its plateau (32.0 - 30)',
    where: 'Appendix A.2',
    unit: 'points of VWA task success rate',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2407.01476v2 PDF, 2026-08-18',
    computeDependent: true,
    condition: 'the value function is held identical across both arms; the small search'
      + ' budget c=5 against the re-ranking plateau at n=7 (Appendix A.2, Fig. 6, with'
      + ' Fig. 2 for c=5)',
  },
  {
    work: 'koh-tree-search',
    value: '+7',
    says: 'tree search at c=20 over re-ranking at its plateau (37.0 - 30)',
    where: 'Appendix A.2',
    unit: 'points of VWA task success rate',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2407.01476v2 PDF, 2026-08-18',
    computeDependent: true,
    condition: 'the value function is held identical across both arms; the tree is at'
      + ' c=20, four times the small-budget arm (Appendix A.2, Fig. 6)',
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
    note: 'It may appear ONLY inside a retraction. §6.5 keeps it as history, because a'
      + ' document that found this defect in its own citations owes the reader the'
      + ' correction rather than a silent edit — and a withdrawn number that is merely'
      + ' deleted comes back.',
  },

  /* ── Chen: the number that has two units, one of which argues the opposite ─ */
  {
    work: 'chen-discriminator',
    value: '58.2',
    says: 'a naive CodeLlama-13B discriminator on Spider, before environmental observations',
    where: 'Table 2',
    unit: 'points of DISCRIMINATION accuracy — not task accuracy',
    unitWords: ['discrimination'],
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2402.10890 PDF, 2026-08-18 — Table 2 caption reads'
      + ' "Discrimination accuracy of observation-enhanced LLMs"',
  },
  {
    work: 'chen-discriminator',
    value: '78.7',
    says: 'the same discriminator with an executability check alone',
    where: 'Table 2',
    unit: 'points of DISCRIMINATION accuracy — not task accuracy',
    unitWords: ['discrimination'],
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2402.10890 PDF, 2026-08-18',
  },
  {
    work: 'chen-discriminator',
    value: '83.6',
    says: 'the same discriminator with executability check AND execution results',
    where: 'Table 2',
    unit: 'points of DISCRIMINATION accuracy — not task accuracy',
    unitWords: ['discrimination'],
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2402.10890 PDF, 2026-08-18',
  },
  {
    work: 'chen-discriminator',
    value: '+25.4',
    says: 'the absolute gain environmental observations buy on Spider (58.2 -> 83.6)',
    where: 'Table 2',
    unit: 'points of DISCRIMINATION accuracy — not task accuracy',
    unitWords: ['discrimination'],
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2402.10890 PDF, 2026-08-18',
  },
  {
    work: 'chen-discriminator',
    value: '57.5',
    says: 'END-TO-END Spider execution accuracy, re-ranking with the naive CodeLlama-13B',
    where: 'Table 3',
    unit: 'points of end-to-end execution accuracy',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2402.10890 PDF, 2026-08-18',
  },
  {
    work: 'chen-discriminator',
    value: '65.5',
    says: 'END-TO-END Spider execution accuracy, re-ranking with the observation-enhanced'
      + ' discriminator',
    where: 'Table 3',
    unit: 'points of end-to-end execution accuracy',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2402.10890 PDF, 2026-08-18',
  },
  {
    work: 'chen-discriminator',
    value: '62.3',
    says: 'greedy generation with NO planning at all — the bar every planning method is'
      + ' measured against',
    where: 'Table 3',
    unit: 'points of end-to-end execution accuracy',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2402.10890 PDF, 2026-08-18 — Table 3 header reads'
      + ' "Spider (Greedy Gen = 62.3)"',
  },
  {
    work: 'chen-discriminator',
    value: '62.5',
    says: 'TREE SEARCH end-to-end on Spider with the observation-enhanced discriminator —'
      + ' below the 65.5 re-ranking arm',
    where: 'Table 3',
    unit: 'points of end-to-end execution accuracy',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2402.10890 PDF, 2026-08-18',
  },
  {
    work: 'chen-discriminator',
    value: '55.5',
    says: 'TREE SEARCH end-to-end on Spider with the naive discriminator — below the 57.5'
      + ' re-ranking arm',
    where: 'Table 3',
    unit: 'points of end-to-end execution accuracy',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2402.10890 PDF, 2026-08-18',
  },
  {
    work: 'chen-discriminator',
    value: '0.9',
    says: 'WITHDRAWN AS AN ALIGNMENT, not as a number. Chen\'s tau IS ~0.9 as the'
      + ' discrimination accuracy advanced planning needs before it beats re-ranking. What'
      + ' is withdrawn is the row-wise alignment `local://mcts-as-lats-design.md` §1 drew'
      + ' between it and our simulated tau: Chen\'s tau is a SIGN-INVERSION probability —'
      + ' §5.1, "generate a number p in [0,1). If p < tau, the discriminator returns the'
      + ' score s. Otherwise, it returns an inverted score 1 - s. In this way, we ensure'
      + ' that the discriminator\'s accuracy is at most tau" — while ours is additive'
      + ' Gaussian noise around a true mean, which backpropagation averages away. Sign'
      + ' inversion produces the commitment failure Chen documents; jitter does not. The'
      + ' design table printed "tree LOSES to re-ranking" in Chen\'s column on the same rows'
      + ' its own column printed +0.078, a contradiction rendered as a concordance',
    where: '§5.1',
    unit: 'sign-inversion probability bounding discrimination accuracy',
    hand: 'withdrawn',
    verifiedBy: 'SpecAudit.SpecEvidence raised the mismatch; LiteratureGate confirmed the'
      + ' definition against arXiv:2402.10890, 2026-08-18',
    note: 'The register keeps it so that re-introducing the alignment fails a gate rather'
      + ' than a reviewer. Chen\'s end-to-end numbers are the honest evidence and they are'
      + ' registered above: tree search sits below re-ranking at every non-oracle'
      + ' discriminator.',
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

  /* ── GEPA: the hedge the paper states and our prose deleted ─────────────── */
  {
    work: 'gepa',
    value: '+8.17%',
    says: 'GEPA over the SelectBestCandidate strategy, at its BEST benchmark. The paper'
      + ' says "up to", and gives the aggregate margin as +6.4%',
    where: '§6',
    unit: 'points of task accuracy, Qwen3 8B, four benchmarks',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2507.19457 PDF, 2026-08-18 — verbatim: "the'
      + ' BeamSearch strategy by upto 11.33%, and SelectBestCandidate strategy by up to'
      + ' 8.17%, with an aggregate margin of +7.33% and +6.4% across all benchmarks"',
    hedge: 'up to',
    computeDependent: true,
    condition: 'the rollout budget is held fixed across every compared strategy, §6, and'
      + ' the ablation runs inside GEPA\'s own budget rather than against a re-tuned'
      + ' baseline',
  },
  {
    work: 'gepa',
    value: '+11.33%',
    says: 'GEPA over the BeamSearch strategy, at its BEST benchmark. The paper says "up to",'
      + ' and gives the aggregate margin as +7.33%',
    where: '§6',
    unit: 'points of task accuracy, Qwen3 8B, four benchmarks',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2507.19457 PDF, 2026-08-18',
    hedge: 'up to',
    computeDependent: true,
    condition: 'the rollout budget is held fixed across every compared strategy, §6, with'
      + ' the per-benchmark rollout totals printed in Table 1',
  },
  {
    work: 'gepa',
    value: '+6.4%',
    says: 'the AGGREGATE margin over SelectBestCandidate across all benchmarks — the number'
      + ' true of the technique, where +8.17% is true of its best column',
    where: '§6',
    unit: 'points of task accuracy, aggregated over six benchmarks, Qwen3 8B',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2507.19457 PDF, 2026-08-18 — verbatim: "with an'
      + ' aggregate margin of +7.33% and +6.4% across all benchmarks, respectively"',
    computeDependent: true,
    condition: 'the rollout budget is held fixed across every compared strategy, §6, with'
      + ' the per-benchmark rollout totals printed in Table 1',
  },
  {
    work: 'gepa',
    value: '+7.33%',
    says: 'the AGGREGATE margin over BeamSearch across all benchmarks',
    where: '§6',
    unit: 'points of task accuracy, aggregated over six benchmarks, Qwen3 8B',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2507.19457 PDF, 2026-08-18',
    computeDependent: true,
    condition: 'the rollout budget is held fixed across every compared strategy, §6, with'
      + ' the per-benchmark rollout totals printed in Table 1',
  },
  {
    work: 'gepa',
    value: '54.85',
    says: 'GEPA without Merge, aggregate over six benchmarks on Qwen3 8B',
    where: 'Table 1',
    unit: 'aggregate task accuracy, Qwen3 8B',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2507.19457 PDF, 2026-08-18',
  },
  {
    work: 'gepa',
    value: '52.40',
    says: 'GEPA+Merge, same aggregate — the recombination operator LOSES here',
    where: 'Table 1',
    unit: 'aggregate task accuracy, Qwen3 8B',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2507.19457 PDF, 2026-08-18',
  },
  {
    work: 'gepa',
    value: '38.61',
    says: 'GEPA without Merge on IFBench specifically, the column where Merge costs most',
    where: 'Table 1',
    unit: 'IFBench task accuracy, Qwen3 8B',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2507.19457 PDF, 2026-08-18',
  },
  {
    work: 'gepa',
    value: '28.23',
    says: 'GEPA+Merge on IFBench — a 10-point loss from the same operator',
    where: 'Table 1',
    unit: 'IFBench task accuracy, Qwen3 8B',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2507.19457 PDF, 2026-08-18',
  },
  {
    work: 'gepa',
    value: '65.22',
    says: 'GEPA without Merge, aggregate on GPT-4.1 Mini',
    where: 'Table 2',
    unit: 'aggregate task accuracy, GPT-4.1 Mini',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2507.19457 PDF, 2026-08-18',
  },
  {
    work: 'gepa',
    value: '66.36',
    says: 'GEPA+Merge, aggregate on GPT-4.1 Mini — the same operator WINS here, which is'
      + ' why the sign is called model-dependent',
    where: 'Table 2',
    unit: 'aggregate task accuracy, GPT-4.1 Mini',
    hand: 'primary',
    verifiedBy: 'LiteratureGate, arXiv:2507.19457 PDF, 2026-08-18',
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
    value: '0.42',
    says: 'archive self-BLEU with the similarity filter ON',
    where: NO_LOCATOR,
    unit: 'self-BLEU across archive cells, one safety domain, one 7B target',
    hand: 'artifact',
    via: 'agent://SpecAudit.SpecEvidence',
    verifiedBy: 'SpecAudit.SpecEvidence read the paper first-hand; this gate has not',
    note: 'no locator reached this register — see the 0.6 entry.',
  },
  {
    work: 'rainbow-teaming',
    value: '0.79',
    says: 'archive self-BLEU with the similarity filter OFF — the collapse',
    where: NO_LOCATOR,
    unit: 'self-BLEU across archive cells, one safety domain, one 7B target',
    hand: 'artifact',
    via: 'agent://SpecAudit.SpecEvidence',
    verifiedBy: 'SpecAudit.SpecEvidence read the paper first-hand; this gate has not',
    note: 'no locator reached this register — see the 0.6 entry.',
  },
  {
    work: 'rainbow-teaming',
    value: '7',
    says: 'attack success points bought by dropping the filter (ASR 0.92 -> 0.99)',
    where: NO_LOCATOR,
    unit: 'points of attack success rate, one safety domain, one 7B target',
    hand: 'artifact',
    via: 'agent://SpecAudit.SpecEvidence',
    verifiedBy: 'SpecAudit.SpecEvidence read the paper first-hand; this gate has not',
    note: 'no locator reached this register — see the 0.6 entry.',
  },
  {
    work: 'pugh-quality-diversity',
    value: '900',
    says: 'the number of runs behind the filled-grid-with-poor-bins observation',
    where: NO_LOCATOR,
    unit: 'evolutionary runs',
    hand: 'unverified',
    verifiedBy: 'nobody',
    note: 'named by the audit as explicitly NOT verified. It is the sole support for the'
      + ' judged-descriptor refusal, so a verifier should locate the run count and the'
      + ' quoted sentence, and confirm the grid claim is about descriptor quality rather'
      + ' than about fitness.',
  },
  {
    work: 'seidr',
    value: '0',
    says: 'the low end of a binary per-instance score — "the score jumps from 0 to 1 as'
      + ' opposed to climbing up incrementally"',
    where: NO_LOCATOR,
    unit: 'binary per-instance score',
    hand: 'unverified',
    verifiedBy: 'nobody',
    note: 'the audit listed SEIDR\'s lexicase result among the claims it did not reach.'
      + ' It motivates a refusal and a Lean property, so it should be next after'
      + ' Böhme & Falk.',
  },
  {
    work: 'seidr',
    value: '1',
    says: 'the high end of the same binary per-instance score',
    where: NO_LOCATOR,
    unit: 'binary per-instance score',
    hand: 'unverified',
    verifiedBy: 'nobody',
    note: 'see the 0 entry.',
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
    work: 'lats',
    value: '0.21',
    says: 'exact-match cost of replacing UCT with DFS in LATS\'s own ablation',
    where: NO_LOCATOR,
    unit: 'exact match',
    hand: 'unverified',
    verifiedBy: 'nobody',
    note: 'the audit lists this among the unverified. It is the sole evidence for leaving'
      + ' a DFS selector out of the axis set.',
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
    unit: 'gain over the stateless arm',
    hand: 'artifact',
    via: 'agent://BenchAnchors',
    verifiedBy: 'transcribed from the public leaderboard; no snapshot date is recorded',
    note: 'see the 22.3% entry — no snapshot date.',
  },
];
