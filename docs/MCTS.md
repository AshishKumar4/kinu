# MCTS exploration

MCTS explores solution approaches. Cloud branches run as logical actors on the workspace's one SQLite. Local branches run as separate processes bound to the same workspace database file.

## No tool reaches this engine

No action of the `agents` tool (`swarm | hire | msg | list | dismiss`) dispatches here. Model-facing calls refuse or reach another engine (`packages/core/src/delegation/agents-tool.ts`).

Models use `action:'swarm'`, `depth`, the verifier registry, and
`strategy/swarm-run.ts`. The swarm shares `uct.ts`, `backpropagation.ts`,
`record-node.ts`, and `pruning.ts` with MCTS, but not its dispatch.
[EXPLORATION.md](./EXPLORATION.md) covers that surface.

Every caller calls `runMCTS` directly. Lifetime evolution
(`evolution/engine.ts`, `lifetimeMCTSBudget`) is the only caller in product code;
the rest are suites, among them `tests/evals/exploration.eval.test.ts` and
`packages/core/tests/integration-mcts.test.ts`. `mcts_search_runs`
(`mcts/search-store.ts`) keeps config, iteration, and budget under a lease
epoch for resume. The swarm shares that table (`engine: 'swarm'`; `findRunningSwarms` in
`strategy/swarm-resume.ts`), and scoped queries keep the trees apart. A swarm is
scored against an objective; MCTS branches are judged.

## Which paper this is

LATS ([arXiv:2310.04406](https://arxiv.org/abs/2310.04406)), in its §5.2
programming instantiation, not the ReAct one used for HotPotQA and WebShop.
Kinu's `explore()` is one `generateText` call with no `ToolSet`. Section 5.2
uses complete-solution actions, test-suite and compiler observations, skipped
simulation, and percentage-passed reward.

Here, `rt.executor` plus `generateAssertionSuite` is the environment, one
action is one candidate, and execution selects the reward band. Selection
through reflection are the §4.2 operations.

- `plan` mode has no environment: `executionPolicy: 'judge-only'` runs
  nothing. That is Tree of Thoughts ([arXiv:2305.10601](https://arxiv.org/abs/2305.10601))
  with UCT and backpropagation, the weaker CoT variant of LATS §5.4. Its score is an
  opinion.
- Reward is banded around the pass fraction. LATS backpropagates
  `passed_test_count / len(tests)`; here that fraction positions a branch inside the fail band. A pass is
  always higher, so clean code cannot lose to failing code.

## Search flow

```mermaid
flowchart TD
    Start([runMCTS]) --> Init[Create root node<br/>in search_nodes]
    Init --> Budget{budget > 0?}
    Budget -->|No| Conv[Convergence check]
    Budget -->|Yes| Select[UCT Selection<br/>Pick best open node]
    Select --> Expand[Expand: spawn N branches<br/>via hosted branch actors]
    Expand --> Sim1[Branch 1: explore]
    Expand --> Sim2[Branch 2: explore]
    Expand --> SimN[Branch N: explore]
    Sim1 --> Eval1[Evaluate branch 1]
    Sim2 --> Eval2[Evaluate branch 2]
    SimN --> EvalN[Evaluate branch N]
    Eval1 --> BP[Backpropagation<br/>WITH RECURSIVE CTE<br/>update ancestors]
    Eval2 --> BP
    EvalN --> BP
    BP --> Prune{Score < threshold<br/>AND visits ≥ 2?}
    Prune -->|Yes| PruneNode[Mark pruned<br/>Generate reflection<br/>Write lesson to memory]
    Prune -->|No| Budget
    PruneNode --> Budget
    Conv --> Best{Best terminal node?}
    Best -->|Yes| Success[Write success lesson<br/>Maybe extract crafted tool]
    Best -->|No| Fail[Write failure lesson]

    style Start fill:#1a1a2e
    style Conv fill:#16213e
    style Success fill:#0f3460
    style Fail fill:#533483
```

## UCT formula

```
UCT(node) = value + W × √(ln(parent_visits) / node_visits)
```

`value` is the 0-1 reward mean. `W` is
`DEFAULT_CONFIG.mcts.explorationWeight`, `Math.SQRT2` (about 1.414). The visit terms
are counts.

`mcts/uct.ts` selects the argmax over this tree's open nodes:
```sql
SELECT
  s.*,
  COALESCE(p.visits, max(2, s.visits)) AS parent_visits
FROM search_nodes s
LEFT JOIN search_nodes p ON p.actor_id = s.actor_id AND s.parent_id = p.id
WHERE s.actor_id = :actorId AND s.root_id = :rootId
  AND s.status = 'open' AND s.depth < :maxDepth
ORDER BY (
  s.value + W * sqrt(
    (log(max(2.0, COALESCE(p.visits, max(2, s.visits)))) / log(exp(1.0))) /
    max(1.0, s.visits)
  )
) DESC
LIMIT 1
```

SQLite's `log()` is log10, hence `log(x) / log(exp(1.0))`. The root has no parent, so it uses its own
visit count floored at 2: `ln(1)` would erase the exploration term and freeze
breadth at `branches`. `s.depth < :maxDepth` skips capped nodes rather than
aborting on a deep argmax. `root_id` stops an interrupted tree's open node
from taking the next task's budget.

Defaults (`DEFAULT_CONFIG.mcts`, `packages/core/src/config.ts`): `budget: 5`, `branches: 3`, `maxDepth: 5`,
`explorationWeight: Math.SQRT2`, `pruneThreshold: 0.25`,
`minAcceptableScore: 0.3`, `minVisitsForPrune: 2`, `reflectionThreshold: 0.35`,
`judgeSamples: 3`, `maxEvalLLMCalls: 4`, `maxCostUSD: 10`. Lifetime evolution
runs smaller (budget 2, branches 2).

`MctsOverrides` (`packages/core/src/config/store.ts`) stores exploration weight,
iteration budget, depth cap, branch count, judge ensemble size, and eval-call
ceiling in `agent_config`. Lifetime evolution reads five of them, all but the budget (`evolution/engine.ts`).
`getMctsConfig` and `setMctsConfig` (`read-models/config-plane.ts`) expose
three: exploration constant, iteration budget, and branch count. The depth cap is left out because beside the
iteration budget it duplicates one limit. Swarm depth comes from its preset.

## Scoring: execution picks the band, and inside the fail band it positions too

`mcts/evaluation.ts` is the only scorer. Execution selects the band and the judge
positions the branch within it. The two are never averaged.

| Branch produced | Score | Range |
|---|---|---|
| Code that ran and **passed** every check | `0.60 + 0.40 · j` | 0.60-1.00 |
| Code that ran and failed some, with a check suite | `0.05 + 0.25 · f` | 0.05-0.30 |
| Code that ran and failed, no check suite | `0.05 + 0.25 · j` | 0.05-0.30 |
| Code that did not parse | `0.05`, no judge call | 0.05 |
| Code in a language the executor cannot run | `0.30 · j` | 0.00-0.30 |
| Prose only, no sibling wrote code | `0.75 · j` | 0.00-0.75 |
| Prose only, a sibling **did** write code | `0.30 · j` | 0.00-0.30 |

`f` is `passedChecks / totalChecks`, the reward LATS measures. `j` is the
median of `judgeSamples` samples. Unparseable samples are dropped; if none survive, the
branch lands on its band floor. An empty trajectory scores 0 without a judge call.

### `judgeSamples` is a request, and `maxEvalLLMCalls` is its ceiling

`maxEvalLLMCalls` is the evaluation's call pool. Code spends one call on its check
suite, and the ensemble gets the rest. `judgeCallBudget`
(`mcts/evaluation.ts`) does the arithmetic:

| Branch | Realised ensemble | On shipped defaults (3, 4) |
|---|---|---|
| code the executor can run | `min(judgeSamples, maxEvalLLMCalls − 1)` | 3 |
| prose only, or `plan` mode | `min(judgeSamples, maxEvalLLMCalls)` | 3 |
| `maxEvalLLMCalls: 1` | 1, no check suite is bought | 1 |

So `judgeSamples: 20` becomes three code-branch samples on shipped defaults.
Each evaluation returns `BranchEvaluation.judgeSamplesAttempted`. For each realised
size in a search, MCTS logs `mcts.judge_ensemble_clamped`
(`judgeSamplesRequested` / `judgeSamplesRealised` / `maxEvalLLMCalls`); heads
log `head.judge_ensemble_clamped`. `mcts_search_runs.config_json` stores the
resolved knobs, and `mcts_search_runs.judge_samples_realised` stores the smallest
ensemble sampled, folded in SQL. `read-models/fork-params.ts` reports requested
versus realised, never a prediction. Short-circuits realise less than the
table's ceiling. Raising the request alone buys nothing; raise
`maxEvalLLMCalls` too.

Used 0 and attempted 3 means an ensemble answered nothing usable. Attempted 0
means it was never asked.

The fail band uses `f` because appended suites stop at the first throw, which makes
"three of four aspects correct" and "nothing works" the same observation
apart from judge noise. That binary reward degenerates search toward best-of-n
(`test-utils/src/eval-outcome.ts`). FunSearch requires "a 'rich' scoring
feedback ... as opposed to a binary signal". The judge stays in the pass band,
where `f` is 1.

When two or more eval calls remain, one LLM call generates up to `MAX_GENERATED_CHECKS` (4)
independent checks, matching LATS's four generated tests. Each check runs separately.
Executor calls cost no tokens, so `f` costs sandbox
round-trips, not spend. Without a suite, `f` and
`passedChecks`/`totalChecks` are absent, not zero, and the judge positions the branch instead.

Prose caps at 0.30 when a sibling produced running code, below
`minAcceptableScore`. The thresholds sit on the band edges: `craftExtractionThreshold` 0.80 is the pass-band midpoint,
`minAcceptableScore` 0.30 is the fail ceiling, `reflectionThreshold` 0.35 sits just
above it, and `pruneThreshold` 0.25 sits inside it.

## Backpropagation

`backpropagate` (`mcts/backpropagation.ts`) walks leaf to root with a `WITH RECURSIVE` CTE:

```sql
WITH RECURSIVE ancestors(id, depth) AS (
  SELECT id, 0 FROM search_nodes
    WHERE actor_id = :actorId AND id = :leafNodeId
  UNION ALL
  SELECT s.parent_id, a.depth + 1
  FROM search_nodes s
  JOIN ancestors a ON s.id = a.id
  WHERE s.actor_id = :actorId AND s.parent_id IS NOT NULL
)
UPDATE search_nodes
SET
  visits = visits + 1,
  value  = (value * visits + :reward) / (visits + 1)
WHERE actor_id = :actorId AND id IN (SELECT id FROM ancestors)
```

Rewards are clamped to `[0, 1]`. The new value is `(old_value × visits + reward) / (visits + 1)`.

## Branch isolation

| Platform | Mechanism | Isolation |
|----------|-----------|-----------|
| CF Workers | Hosted logical actors of kind `branch`, acquired per rollout from the workspace's one `ActorHost` (`packages/cf-backend/src/exploration-hosting.ts`) | One workspace SQLite, actor-led keys. A write under one actor leaves every other actor's rows as they were (`another_actors_writes_are_invisible` in `MCTS/StorageIsolation.lean`). |
| CLI | `child_process.fork('branch-worker.ts')` over the workspace database file (`createBranchSpawner`) | Separate OS process, same database. A branch binds its own actor row and writes its rollout traces there. |

A CF runtime built without the branch host has no fallback: `spawnBranch` refuses (`requireBranches`, `packages/cf-backend/src/runtime.ts`) rather than running a search with no rollouts.

Both backends score through `evaluation.ts`. A branch handle offers `explore` and `generateReflection(task, outcome?)`. `mcts/diversity.ts` gives each branch index a framing angle.

### The observation loop

Nodes are recorded after evaluation. `session.getHistory(node.msg_id)` gives a child
`[Node id] <proposal>` followed by `Observation: the proposed code ran against
generated assertions and FAILED: <error>`. Without it, deepening would re-read the
proposal and miss the runtime error. `generateReflection` gets the same
verdict, so `MEMORY.md` records how the attempt ended.
`search_nodes.observation` stays the proposal text that
`mcts/takes.ts` compares. Prose, plan-mode, and unrunnable branches get no invented
observation line.

An MCTS branch is one model call with no `ToolSet` and no runtime. Paired `heads`
(`packages/core/src/heads/controller.ts`) run full loops through `runHeadInference`.
Each child is spawned by `HeadController.spawnHead` and scored through
`HeadController.scoreHeads` and `evaluation.ts`.

| | `mcts` | `heads` |
|---|---|---|
| Branch | one `generateText`, no tools | multi-step loop, `eval`/`shell`/`file`/`web` |
| Isolation | actor boundary: logical actors on one SQLite (CF) or one process per branch on the same database file (CLI) | prompt-level: heads share the canonical workspace and are *asked* to make their own git worktree |
| Branches per run | tens (budget times branches, re-expanded by UCT) | a handful, spawned once |
| Relationship | rivals; most are pruned | collaborators; all are merged |

Tens of concurrent heads in one shared workspace would leave branch changes ungradeable. A swarm node is a full agent instead, graded on its reported candidate, never a tree diff. See "A node is an agent" in [EXPLORATION.md](./EXPLORATION.md). Heads spawn through `HeadController.spawnHead` into hosted logical actors. [ARCHITECTURE.md](./ARCHITECTURE.md) describes the one actor hierarchy they join.

## Pruning and convergence

After each expansion, every branch scoring below `reflectionThreshold` (0.35)
writes a reflection. `pruneLowValueBranches` (`mcts/pruning.ts`) then takes open
nodes with `value < pruneThreshold` (0.25) and `visits >= minVisitsForPrune` (2),
marks them `status = 'pruned'`, clears `branch_agent_key`, and aborts the branch.

`mcts/convergence.ts` takes the argmax over the `terminal` and `open` candidates'
own scores, the score each one's evaluation measured, never the subtree mean in
`value`.
Rivals within `takesEpsilon` (0.1) run one shared suite and compare the share of checks
each satisfies. The measured share decides, not the pass bit, so two of four beats
none of four. Value order stands when no candidate carries runnable code,
when nothing measured beats the argmax winner's own share, and always in `plan`
mode, which keeps value order without running the suite.

Convergence refuses in two cases. One is a winner below `minAcceptableScore` (0.3).
The other is an undifferentiated search: textually distinct approaches with
exactly equal values, where `ORDER BY value DESC` would return row order while
the shared value still clears the bar. Equality is exact, not epsilon: a near-tie
belongs in alternate takes, while byte-identical scores mean the scorer is not a
function of the proposal. Either refusal sets `converged: false`, records its reason,
and marks open nodes failed rather than shipping an unearned answer.

## search_nodes table

Primary key `(actor_id, id)`.

| Column | Type | Description |
|--------|------|-------------|
| `actor_id` | TEXT | Owning actor; every query is scoped by it |
| `id` | TEXT | Node ID (nanoid) |
| `parent_id` | TEXT | Parent node ID (null for root) |
| `root_id` | TEXT | The search this node belongs to; selection is scoped by it |
| `task` | TEXT | The task being explored |
| `action` | TEXT | The approach taken at this node |
| `observation` | TEXT | Result of the exploration |
| `depth` | INTEGER | Depth in tree (root = 0) |
| `visits` | INTEGER | Number of backpropagation passes |
| `value` | REAL | Running mean score (0-1) |
| `status` | TEXT | `open`, `terminal`, `pruned`, `failed` |
| `code_used` | TEXT | Runnable source selected from an exploration proposal |
| `code_language` | TEXT | Executor language for `code_used`; null when no runnable code was offered |
| `msg_id` | TEXT | Session message ID for tree navigation |
| `branch_agent_key` | TEXT | The logical branch actor's key, for aborting its rollout |
| `evaluation_json` | TEXT | Bounded per-branch evaluation facts as JSON; null for a node that was never evaluated |
| `created_at` | INTEGER | Epoch milliseconds |

## Formal properties (Lean 4)

39 of the corpus's 429 named declarations live in `lean/Kinu/MCTS/`
(measured 2026-09-23 with `node lean/check-traceability.mjs --list-declarations`). The model uses exact scaled-integer arithmetic; SQLite
uses IEEE-754 `REAL`. [FORMAL-SPEC.md](./FORMAL-SPEC.md) defines claim status.

| Property | File | Theorem | Claim status |
|----------|------|---------|--------------|
| Budget terminates (well-founded on Nat) | `StorageIsolation.lean` | `budget_well_founded` | proved-in-abstract-model |
| Initial state is storage-isolated | `StorageIsolation.lean` | `init_isolated` | proved-in-abstract-model |
| All 7 MCTS transitions keep branches off the orchestrator's actor | `StorageIsolation.lean` | `transition_preserves_isolation` | proved-in-abstract-model |
| A write under one actor leaves every other actor's rows | `StorageIsolation.lean` | `a_write_leaves_other_actors_alone` | proved-in-abstract-model |
| A reward in [0,S] keeps a node's mean in range | `Backpropagation.lean` | `update_preserves_range` | proved-and-refined |
| …lifted to a whole reward history | `Backpropagation.lean` | `applyRewards_preserves_range` | proved-and-refined |
| `value · visits = Σ rewards` after any history | `Backpropagation.lean` | `applyRewards_sum_invariant`, `sum_invariant` | proved-and-refined |
| At the first visit the init value is erased | `Backpropagation.lean` | `init_values_equal_at_first_step` | by-construction-witness |
| One update yields exactly the running-mean numerator | `Backpropagation.lean` | `update_matches_ts_numerator` | by-construction-witness |
| A fresh node starts in range | `Backpropagation.lean` | `initial_in_range` | by-construction-witness |
| The ancestor walk touches visits/value only, never row IDs | `Backpropagation.lean` | `backprop_preserves_ids` | by-construction-witness |
| The bonus falls with a node's own visits from one visit on | `Uct.lean` | `bonus_falls_with_own_visits` | proved-and-refined |
| The bonus rises with the parent's visits from two on | `Uct.lean` | `bonus_rises_with_parent_visits` | proved-and-refined |
| The root's bonus rises from two visits to three | `Uct.lean` | `the_root_bonus_rises_from_two_visits_to_three` | proved-and-refined |
| The selected row is eligible and no eligible row outranks it | `Uct.lean` | `select_is_eligible`, `select_is_maximal` | proved-and-refined |
| Every winner carries the best reward a candidate reached | `Convergence.lean` | `the_winner_carries_the_best_reward` | proved-and-refined |
| The search keeps its best candidate through weak refinements | `Convergence.lean` | `the_search_expands_its_best_candidate_and_converges_on_it` | proved-and-refined |

The bonus order is exact: for W > 0, `W·√(ln M₁ / N₁) < W·√(ln M₂ / N₂)` exactly
when `M₁^N₂ < M₂^N₁` (`bonus_order_is_power_order`), so every monotonicity claim
is about natural powers. `converge` ranks a candidate by its own score, not by
the subtree mean `value` holds after its refinements backpropagate, so weak
refinements cannot bury the best answer the search evaluated
(`the_winner_carries_the_best_reward`).
