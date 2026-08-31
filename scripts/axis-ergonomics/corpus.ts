/**
 * The ergonomics corpus: 20 prose requests, each with an expert key.
 *
 * Built from the owner's own words, because those are the real requests —
 * optimise a program, solve a mathematical problem, disprove Collatz,
 * open-ended research and recon, redteam and cyber, code quality auditing —
 * plus the shapes that must NOT become a search.
 *
 * A corpus where everything passes ranks nothing. This repo has already paid
 * for that lesson once (`tests/eval-corpus-quality.test.ts` exists because an
 * earlier corpus was saturated and could not exercise a single mechanism), so
 * the cases here are chosen for the DISCRIMINATION each one buys:
 *
 *   - `latency-ideate` / `latency-optimise` are a MINIMAL PAIR: byte-for-byte
 *     the same request except that one of them mentions a harness that prints a
 *     number. A model that answers both the same way is not reading the axis
 *     the whole design turns on, and no aggregate score would show it.
 *   - `collatz` has no scalar at all. FunSearch states the scope condition in
 *     the paper and rules theorem proving out for exactly this reason. It is
 *     the owner's own example and it is the one case where the correct answer
 *     is "not like this".
 *   - `tree-no-score`, `archive-judged-key`, `archive-no-filter` are the three
 *     refused regions of the validity table, phrased as something a user would
 *     plausibly ask for. They are the only way to test whether a refusal that
 *     carries its reason actually corrects the caller.
 *   - `competitor-billing` is a preset wearing custom's clothes: a model that
 *     hand-rolls the axes here has failed to find the tested path.
 *
 * `expect.presets` is the set a human expert would accept; `forbidden` is the
 * set that proves a misread rather than a taste difference. Region-correctness
 * is scored separately from label-correctness on purpose: research / audit /
 * redteam are ONE legal region (archive + novelty) differing only in the key,
 * so preferring one label over another on a dual-nature task is not a failure
 * of the surface and must not be counted as one.
 */
import type { AxisName, PresetName } from './surface';

export type Decision = 'swarm' | 'no-swarm';

/** The three legal regions of the design's section 3, used so that a label
 *  disagreement inside one region is not scored as a region error. */
export type Region = 'flat' | 'archive' | 'verifier-tree' | 'none';

export const PRESET_REGION = {
  ideate: 'flat',
  research: 'archive',
  audit: 'archive',
  redteam: 'archive',
  optimise: 'verifier-tree',
} satisfies Record<PresetName, Region>;

export interface ExpertKey {
  /** Should this become a swarm at all? */
  readonly decision: Decision;
  /** Presets a human expert would accept. `custom` allowed where no preset fits. */
  readonly presets: readonly (PresetName | 'custom')[];
  /** The region the task genuinely needs. */
  readonly region: Region;
  /** Choosing one of these is a demonstrated misread, not a taste difference. */
  readonly forbidden: readonly (PresetName | 'custom')[];
  /** For `custom` cases: the axis settings that make the config actually serve
   *  the task. A custom answer missing one of these is expressible-but-missed. */
  readonly requiredAxes?: Partial<Record<AxisName, readonly string[]>>;
  /** True when the honest answer must point out there is no scalar to climb. */
  readonly needsScalarObjection?: boolean;
  /** Why the key is what it is — cited to the design where the design decides it. */
  readonly rationale: string;
}

export interface Case {
  readonly id: string;
  readonly group: 'owner' | 'no-swarm' | 'custom' | 'trap' | 'illegal';
  readonly prompt: string;
  readonly expect: ExpertKey;
}

export const CORPUS: readonly Case[] = [
  // ── A. The owner's own six requests ──────────────────────────────────────
  {
    id: 'program-optimise',
    group: 'owner',
    prompt:
      'The JSON encoder in packages/core is on our hot path and it is too slow. '
      + 'Make it faster. `bun run bench:encode` prints nanoseconds per operation, '
      + 'lower is better, and the existing unit tests must keep passing.',
    expect: {
      decision: 'swarm',
      presets: ['optimise'],
      region: 'verifier-tree',
      forbidden: ['ideate', 'research', 'audit', 'redteam'],
      rationale:
        'A caller-supplied command that prints a number, and a direction. This is the '
        + 'top row of the design\'s tau table — reward IS the outcome, tau 1.000 — and the '
        + 'only region where a tree is measured to beat re-ranking.',
    },
  },
  {
    id: 'math-solution',
    group: 'owner',
    prompt:
      'I want a fast exact algorithm for counting lattice paths that stay under a '
      + 'staircase boundary. I have a brute-force reference that is correct up to n=12, '
      + 'and a script that reports how many of those 12 cases a candidate matches and how '
      + 'long it takes.',
    expect: {
      decision: 'swarm',
      presets: ['optimise', 'custom'],
      region: 'verifier-tree',
      forbidden: ['ideate', 'redteam'],
      rationale:
        'A mathematical problem WITH a graded checker: 0-12 matched is a scalar with a '
        + 'gradient, not a binary. This is the shape FunSearch is for, and it is the '
        + 'contrast case for collatz.',
    },
  },
  {
    id: 'collatz',
    group: 'owner',
    prompt: 'Prove the Collatz conjecture wrong.',
    expect: {
      decision: 'no-swarm',
      presets: [],
      region: 'none',
      forbidden: ['optimise', 'ideate', 'research', 'audit', 'redteam', 'custom'],
      needsScalarObjection: true,
      rationale:
        'There is no scalar. A counterexample is a witness: binary, no gradient, and '
        + 'nothing for a tree to climb. FunSearch states this as a scope condition in the '
        + "paper and rules theorem proving out for it; it is also this repo's own "
        + 'eval-outcome.ts:24-27 finding. The honest answers are to refuse, or to demand a '
        + 'scalar proxy (largest n verified, trajectory height) and optimise THAT. Accepting '
        + '`optimise` with "disprove it" as the verifier is the failure this case exists to catch.',
    },
  },
  {
    id: 'harness-recon',
    group: 'owner',
    prompt:
      'I need a map of how every major agent harness handles mid-turn steering — '
      + 'interrupting a running turn with new instructions. I care about not missing a '
      + 'family of approach, more than about depth on any one of them.',
    expect: {
      decision: 'swarm',
      presets: ['research'],
      region: 'archive',
      forbidden: ['optimise', 'ideate'],
      rationale:
        '"Not missing a family" is a coverage objective with a nameable key. That is the '
        + 'archive region, and the design says research needs exactly a coverage key.',
    },
  },
  {
    id: 'redteam-dispatcher',
    group: 'owner',
    prompt:
      'Find prompt-injection paths into our tool dispatcher that end in shell execution. '
      + 'I want genuinely different attack routes, not twenty rewordings of the same one.',
    expect: {
      decision: 'swarm',
      presets: ['redteam'],
      region: 'archive',
      forbidden: ['optimise', 'ideate'],
      rationale:
        '"Not twenty rewordings" is the novelty rejection test stated by the user. '
        + 'Rainbow Teaming without it collapses the archive onto one prompt (self-BLEU '
        + '0.42 -> 0.79) while still reporting coverage.',
    },
  },
  {
    id: 'code-audit',
    group: 'owner',
    prompt:
      'Audit packages/core for type-safety holes, dead code and duplicated logic. '
      + 'I want a list of distinct problems, one entry per kind of problem.',
    expect: {
      decision: 'swarm',
      presets: ['audit'],
      region: 'archive',
      forbidden: ['optimise', 'ideate'],
      rationale: 'One entry per kind of problem is a finding-class key. Archive region.',
    },
  },

  // ── B. Should refuse, or should not be a swarm at all ────────────────────
  {
    id: 'one-line-fix',
    group: 'no-swarm',
    prompt:
      'The request timeout on line 44 of gateway.ts is 5000 and it should be 30000. '
      + 'Change it.',
    expect: {
      decision: 'no-swarm',
      presets: [],
      region: 'none',
      forbidden: ['ideate', 'research', 'audit', 'redteam', 'optimise', 'custom'],
      rationale:
        'The surface says so in as many words: "A single short coherent change is yours to '
        + 'make directly." If a model still swarms it, the Avoid-when clause is not read.',
    },
  },
  {
    id: 'single-file-read',
    group: 'no-swarm',
    prompt:
      'What does converge() return when the two best branches have identical scores? '
      + 'It is in the mcts controller somewhere.',
    expect: {
      decision: 'no-swarm',
      presets: [],
      region: 'none',
      forbidden: ['ideate', 'research', 'audit', 'redteam', 'optimise', 'custom'],
      rationale: 'One file answers it. A search here spends a budget to reproduce a read.',
    },
  },
  {
    id: 'optimise-no-verifier',
    group: 'no-swarm',
    prompt:
      'Optimise our onboarding copy so that more people finish signup. Make it as good '
      + 'as you can.',
    expect: {
      decision: 'swarm',
      presets: ['ideate'],
      region: 'flat',
      forbidden: ['optimise'],
      needsScalarObjection: true,
      rationale:
        'The word "optimise" is in the prose and there is no verifier behind it — no '
        + 'conversion number is reachable from inside a run. `optimise` is statically '
        + 'refused for the missing verifier. The correct move is ideate, or to ask for the '
        + 'measurement. This is the case that tests whether the model reads the requirement '
        + 'or the vocabulary.',
    },
  },
  {
    id: 'tree-no-score',
    group: 'illegal',
    prompt:
      'Run an MCTS over possible refactorings of the auth module and show me the tree. '
      + 'Do not bother scoring the branches, I will read them myself and decide.',
    expect: {
      decision: 'swarm',
      presets: ['ideate'],
      region: 'flat',
      forbidden: ['optimise'],
      rationale:
        'The user has asked, in as many words, for a refused combination: tree selector '
        + "with score:'none'. The design proves it degenerates — with equal values the argmax "
        + 'is driven entirely by the exploration term, so the tree is a breadth-first '
        + 'enumerator and the winner is SQLite row order. The correct answer is the flat '
        + 'preset, which is what the user actually wants. Composing the illegal custom is '
        + 'the failure, and then the refusal text has to correct it.',
    },
  },

  // ── C. Genuinely custom: no preset fits ──────────────────────────────────
  {
    id: 'graph-of-merges',
    group: 'custom',
    prompt:
      'Have several independent analyses of the incident run, then merge them pairwise '
      + 'into combined analyses, then merge those merges into one. I want a graph of '
      + 'combinations, not a tree of refinements.',
    expect: {
      decision: 'swarm',
      presets: ['custom'],
      region: 'flat',
      forbidden: ['optimise', 'redteam'],
      requiredAxes: { expand: ['aggregate'] },
      rationale:
        "expand:'aggregate' is fan-in, k parents to one child, and it is precisely what "
        + 'makes the shape a DAG. The design says GoT\'s Aggregate vertex and MoA\'s layers '
        + 'are both this value and that neither is expressible without it. If a model cannot '
        + 'find it from a request that literally says "graph, not tree", the value is '
        + 'mis-named.',
    },
  },
  {
    id: 'evolve-heuristic',
    group: 'custom',
    prompt:
      'Our scheduler picks the next job with a hand-written heuristic function. I want '
      + 'that FUNCTION improved — evolve it. Each candidate heuristic gets replayed over '
      + 'a recorded workload trace and scored on total tardiness, lower is better. Keep '
      + 'the good ones around between rounds.',
    expect: {
      decision: 'swarm',
      presets: ['custom', 'optimise'],
      region: 'verifier-tree',
      forbidden: ['ideate', 'research', 'redteam'],
      requiredAxes: { unit: ['generator'], score: ['verify'], carry: ['elites', 'artifacts'] },
      rationale:
        'FunSearch shape. The node is the program, not the answer, which is exactly what '
        + "unit:'generator' is for; \"keep the good ones around between rounds\" is "
        + "carry:'elites' said in prose, and the design's whole argument for `carry` is that "
        + 'FunSearch\'s "W/O Evolution" ablation — best-of-N with no carry — is one of its '
        + 'two worst curves at matched program count.',
    },
  },
  {
    id: 'learn-from-failures',
    group: 'custom',
    prompt:
      'Keep retrying this flaky database migration until it works, but I do not want '
      + 'twenty blind retries — each attempt has to actually take on board why the '
      + 'previous one failed.',
    expect: {
      decision: 'swarm',
      presets: ['custom'],
      region: 'flat',
      forbidden: ['research', 'redteam'],
      requiredAxes: { carry: ['reflections'], observe: ['own', 'ancestors'] },
      rationale:
        'Reflexion. The design states that `carry` is the ONLY axis that distinguishes it '
        + 'from plain retry, and `observe` is what puts the environment\'s verdict — rather '
        + "than the parent's proposal — into the next prompt (commit 47845c27). Both axes "
        + 'are named in the prose. This is the cleanest test of whether `carry` and '
        + '`observe` are legible words.',
    },
  },
  {
    id: 'multi-metric-prompt',
    group: 'custom',
    prompt:
      'Improve this system prompt against six different eval metrics at once. I do not '
      + 'want them collapsed into one score — show me the trade-off surface, the '
      + 'configurations where you cannot improve one metric without hurting another.',
    expect: {
      decision: 'swarm',
      presets: ['custom'],
      region: 'verifier-tree',
      forbidden: ['ideate', 'redteam', 'audit'],
      requiredAxes: { advance: ['pareto'], unit: ['generator'] },
      rationale:
        "GEPA. advance:'pareto' is single-use in the matrix and survives because its own "
        + 'ablation earns it inside the same budget (up to +8.17% over scalar-best and up to '
        + '+11.33% over beam, each at its best benchmark). The user has described a Pareto '
        + 'frontier without using the word, which is the right way to test whether the word '
        + 'is findable.',
    },
  },

  // ── D. Traps: the minimal pair, and the preset in custom's clothing ──────
  {
    id: 'latency-ideate',
    group: 'trap',
    prompt:
      'Think through the ways we might bring our p99 request latency down. I want the '
      + 'range of approaches on the table before we commit to one.',
    expect: {
      decision: 'swarm',
      presets: ['ideate'],
      region: 'flat',
      forbidden: ['optimise'],
      rationale:
        'Minimal pair with latency-optimise. No measurement is reachable, so there is no '
        + 'value signal, so a tree is the bottom row of the tau table: tau 0.500, tree minus '
        + 'flat +0.000, provably a list. The design makes ideate flat for this exact reason.',
    },
  },
  {
    id: 'latency-optimise',
    group: 'trap',
    prompt:
      'Bring our p99 request latency down. `bun run loadtest` replays production traffic '
      + 'and prints the p99 in milliseconds at the end.',
    expect: {
      decision: 'swarm',
      presets: ['optimise'],
      region: 'verifier-tree',
      forbidden: ['ideate', 'research', 'redteam', 'audit'],
      rationale:
        'Minimal pair with latency-ideate: the same task, plus one sentence naming a '
        + 'command that prints a number. If a model gives the same preset to both, it is not '
        + 'reading the one bit the design turns on, and the aggregate score would hide that.',
    },
  },
  {
    id: 'competitor-billing',
    group: 'trap',
    prompt:
      'Go find every distinct way our competitors structure their billing, and tell me '
      + 'which structures we have not considered. I want breadth — I will worry about '
      + 'which one is best afterwards.',
    expect: {
      decision: 'swarm',
      presets: ['research'],
      region: 'archive',
      forbidden: ['custom', 'optimise'],
      rationale:
        'A preset covers this exactly: breadth over distinct structures with a coverage '
        + 'key. Hand-rolling it as custom is the F3 failure — the caller lands in the '
        + 'untested tier when a tested path existed, which is a failure of the surface to '
        + 'advertise itself, not of the caller.',
    },
  },

  // ── E. The two remaining refused regions ─────────────────────────────────
  {
    id: 'archive-judged-key',
    group: 'illegal',
    prompt:
      'Build me a diverse archive of marketing angles for the launch. Have a model read '
      + 'each angle and decide which emotional category it belongs in, and keep the best '
      + 'one per category.',
    expect: {
      decision: 'swarm',
      presets: ['ideate', 'research'],
      region: 'archive',
      forbidden: ['optimise'],
      rationale:
        'The user has described archive with a JUDGED descriptor, which is refused: judge '
        + 'variance in the archive KEY is unrecoverable, because a mis-ranked candidate can '
        + 'be re-ranked but a mis-binned elite is silently lost. Pugh et al. over 900 runs: '
        + 'a bad descriptor fills the grid while "many bins contain low-quality behaviors". '
        + 'The key must be something a record can witness, not something a model decides.',
    },
  },
  {
    id: 'archive-no-filter',
    group: 'illegal',
    prompt:
      'Give me an archive of jailbreak prompts organised by ATT&CK tactic. Do not filter '
      + 'anything out for being similar — I want absolutely everything you generate.',
    expect: {
      decision: 'swarm',
      presets: ['redteam'],
      region: 'archive',
      forbidden: ['optimise', 'ideate'],
      rationale:
        'Archive with the novelty rejection test explicitly switched off, which is refused. '
        + 'Measured: dropping Rainbow Teaming\'s BLEU tau=0.6 filter buys 7 points of attack '
        + 'success and collapses the archive onto one prompt across every cell while still '
        + 'reporting full coverage. The user is asking for a number that will lie to them.',
    },
  },
  {
    id: 'agent-trajectory-search',
    group: 'trap',
    prompt:
      'Spawn eight full agents on this bug, each with tools and a real workspace, let '
      + 'them work, and keep expanding whichever one is making the most progress.',
    expect: {
      decision: 'swarm',
      presets: ['custom'],
      region: 'verifier-tree',
      forbidden: ['ideate', 'research'],
      requiredAxes: { unit: ['trajectory'] },
      rationale:
        "unit:'trajectory' with score:'verify' is the one combination the design says is "
        + 'BLOCKED — heads share one workspace (exploration.ts:264) and are only asked to '
        + 'isolate themselves, so no node can be graded on what it changed. A model has no '
        + 'way to know that from the surface, so this case does not test the model; it tests '
        + 'whether the SURFACE discloses its own blocked region. Finding the right value and '
        + 'being told nothing is a surface defect worth reporting.',
    },
  },
];

/**
 * POST-HOC, and kept out of `CORPUS` for exactly that reason.
 *
 * The pre-registered 20 are frozen. These two exist only for the `zoo` surface
 * variant, which is itself a follow-up `ObjectiveSpec` asked for after the main
 * run had landed: does a discouraging docstring sentence stop a model reaching
 * for a model zoo when the task asks for diversity?
 *
 * The main corpus cannot answer that at full strength. `redteam-dispatcher`
 * asks for "genuinely different attack routes" and tempts a zoo implicitly, but
 * nothing in the 20 asks for one in as many words — and the sharpest form of
 * the question is what happens when the USER demands the measured-worse thing.
 * That is the same shape as `tree-no-score`, where the user asks for a refused
 * combination in prose, and it is the shape that separates a docstring from a
 * refusal: a sentence can inform a caller who has no opinion, and only a
 * refusal can stop one who does.
 *
 * Reported separately from the 20, always. Mixing a post-hoc case into a
 * pre-registered corpus is how a corpus stops meaning anything.
 */
export const ZOO_EXTRA_CASES: readonly Case[] = [
  {
    id: 'zoo-explicit',
    group: 'trap',
    prompt:
      'Generate landing-page headlines and pick the best. Use a mix of several different '
      + 'models for this — a spread of vendors will give us more diverse ideas than one '
      + 'model ever could.',
    expect: {
      decision: 'swarm',
      presets: ['ideate'],
      region: 'flat',
      forbidden: ['optimise', 'redteam'],
      rationale:
        'The user asks, in as many words, for heterogeneity AS a diversity mechanism — the '
        + 'thing Self-MoA (2502.00674) measured worse than repeated sampling from the best '
        + 'single model, 59.1 vs 65.7 with the proposer count and topology held fixed (six '
        + 'proposals, one aggregator; the paper claims no cost parity), re-running MoA\'s own '
        + 'over the same six models. Correct is to decorrelate on the `decorrelate` axis and '
        + 'either leave `models` unset or say why. Populating `models` for diversity after '
        + 'reading the field\'s own description is the failure, and it is the only evidence '
        + 'that can tell a docstring sentence apart from a refusal.',
    },
  },
  {
    id: 'zoo-cost-routing',
    group: 'custom',
    prompt:
      'Survey the competitor landscape — there is a lot of shallow reading to do and then '
      + 'one hard synthesis at the end. Keep the bill down; do not spend a frontier model on '
      + 'the skimming.',
    expect: {
      decision: 'swarm',
      presets: ['research', 'custom'],
      region: 'archive',
      forbidden: ['optimise'],
      rationale:
        'The CONTROL case for zoo-explicit, and it is the reason a single number would '
        + 'mislead. This is capability-and-cost routing, which is what the field is FOR. A '
        + 'model that populates `models` here is right; one that populates it on zoo-explicit '
        + 'is wrong. Without this pair, "never populated it" and "understood when to" are '
        + 'indistinguishable — and a field nobody ever uses is a field that should not ship.',
    },
  },
];
