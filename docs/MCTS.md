# MCTS Exploration

MCTS explores solution approaches. Cloud branches use isolated Durable Object
facets; local branches use isolated processes with their own SQLite state.

## No tool reaches this engine

Read before wiring. `swarm | hire | ask | send | reply | list | dismiss`
never dispatches here; model-facing calls refuse or reach another engine.

Models use `action:'swarm'`, `depth`, the verifier registry and
`strategy/swarm-run.ts`. It shares `uct.ts`, `backpropagation.ts`,
`record-node.ts` and `pruning.ts`, but no dispatch. Read
[EXPLORATION.md](./EXPLORATION.md) for that surface.

Only programmatic callers are `createMCTSStrategy` (`strategy/mcts.ts`, eval
and integration only, so no production registry or `createStrategyRegistry`
reader), `runEvalPair` (`core/src/eval/runner.ts`), and lifetime evolution's
`runMCTS` (`evolution/engine.ts`, `lifetimeMCTSBudget`). `mcts_search_runs`
(`mcts/search-store.ts`) retains config, iteration and budget under a lease
epoch for resume. Swarm shares it (`engine: 'swarm'`; `findRunningSwarms` in
`strategy/swarm-resume.ts`); scoped queries keep trees apart. Swarm uses an
objective; MCTS branches are judged.

## Which paper this is

LATS ([arXiv:2310.04406](https://arxiv.org/abs/2310.04406)), §5.2's
programming instantiation, not the ReAct one. HotPotQA and WebShop use
ReAct. Kinu's `explore()` is one `generateText`, no `ToolSet`. Section 5.2
uses complete-solution actions, test-suite/compiler observations, skipped
simulation and percentage-passed reward.

Here, `rt.executor` plus `generateAssertionSuite` is the environment; one
action is one candidate; execution selects the reward band. Selection through
reflection are §4.2 operations.

- `plan` mode has no environment. `executionPolicy: 'judge-only'` runs
  nothing. It is Tree of Thoughts ([arXiv:2305.10601](https://arxiv.org/abs/2305.10601)),
  UCT and backpropagation, LATS's weaker §5.4 CoT variant. Its score is an
  opinion.
- Reward is banded around the pass fraction. LATS backpropagates
  `passed_test_count / len(tests)`; here it positions the fail band. A pass is
  strictly higher, so clean code cannot lose to failing code.

## Search Flow

```mermaid
flowchart TD
    Start([runMCTS]) --> Init[Create root node<br/>in search_nodes]
    Init --> Budget{budget > 0?}
    Budget -->|No| Conv[Convergence check]
    Budget -->|Yes| Select[UCT Selection<br/>Pick best open node]
    Select --> Expand[Expand: spawn N branches<br/>via subAgent / Facets]
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

## UCT Formula

```
UCT(node) = value + W × √(ln(parent_visits) / node_visits)
```

`value` is the 0-1 reward mean; `W` is
`DEFAULT_CONFIG.mcts.explorationWeight` = `Math.SQRT2` ≈ 1.414; visit terms
are counts.

`mcts/uct.ts` selects the argmax over this tree's open nodes:
```sql
SELECT
  s.*,
  COALESCE(p.visits, max(2, s.visits)) AS parent_visits
FROM search_nodes s
LEFT JOIN search_nodes p ON s.parent_id = p.id
WHERE s.root_id = :rootId AND s.status = 'open' AND s.depth < :maxDepth
ORDER BY (
  s.value + W * sqrt(
    (log(max(2.0, COALESCE(p.visits, max(2, s.visits)))) / log(exp(1.0))) /
    max(1.0, s.visits)
  )
) DESC
LIMIT 1
```

`log()` is log₁₀, hence `log(x) / log(exp(1.0))`. Root visits are the
synthetic parent count, floored at 2: `ln(1)` erases exploration and freezes
breadth at `branches`. `s.depth < :maxDepth` skips capped nodes rather than
aborting on a deep argmax. `root_id` prevents an interrupted tree's open node
from taking the next task's budget.

Defaults (`core/src/config.ts`): `budget: 5`, `branches: 3`, `maxDepth: 5`,
`explorationWeight: Math.SQRT2`, `pruneThreshold: 0.25`,
`minAcceptableScore: 0.3`, `minVisitsForPrune: 2`, `reflectionThreshold: 0.35`,
`judgeSamples: 3`, `maxEvalLLMCalls: 4`, `maxCostUSD: 10`. Lifetime evolution
runs smaller (budget 2, branches 2).

`MctsOverrides` (`core/src/config/store.ts`) keeps exploration weight,
iteration budget, depth cap, branch count, judge ensemble size and eval-call
ceiling in `agent_config`; evolution reads five (`evolution/engine.ts`).
`getMctsConfig` / `setMctsConfig` (`read-models/config-plane.ts`) expose
exploration constant, iteration budget and branch count. Depth cap beside
iteration budget duplicates one limit. Swarm depth comes from its preset.

## Scoring: execution picks the band, and inside the fail band it positions too

`mcts/evaluation.ts` is the sole scorer. Execution selects the band; the judge
positions within it. They never average.

| Branch produced | Score | Range |
|---|---|---|
| Code that ran and **passed** every check | `0.60 + 0.40 · j` | 0.60 – 1.00 |
| Code that ran and failed some, with a check suite | `0.05 + 0.25 · f` | 0.05 – 0.30 |
| Code that ran and failed, no check suite | `0.05 + 0.25 · j` | 0.05 – 0.30 |
| Prose only, no sibling wrote code | `0.75 · j` | 0.00 – 0.75 |
| Prose only, a sibling **did** write code | `0.30 · j` | 0.00 – 0.30 |

`f` is `passedChecks / totalChecks`, LATS's measured reward. `j` is the
`judgeSamples` median. Unparseable samples drop; all-fail reaches the band
floor; empty trajectories score hard 0 without a judge call.

### `judgeSamples` is a request, and `maxEvalLLMCalls` is its ceiling

`maxEvalLLMCalls` is the evaluation pool. Code spends one call on its check
suite; the ensemble gets the rest. `judgeCallBudget`
(`mcts/evaluation.ts`) holds the arithmetic:

| Branch | Realised ensemble | On shipped defaults (3, 4) |
|---|---|---|
| code the executor can run | `min(judgeSamples, maxEvalLLMCalls − 1)` | 3 |
| prose only, or `plan` mode | `min(judgeSamples, maxEvalLLMCalls)` | 3 |
| `maxEvalLLMCalls: 1` | 1, no check suite is bought | 1 |

`judgeSamples: 20` becomes three code-branch samples on shipped defaults.
Each evaluation returns `BranchEvaluation.judgeSamplesAttempted`. Per realised
size per search, MCTS logs `mcts.judge_ensemble_clamped`
(`judgeSamplesRequested` / `judgeSamplesRealised` / `maxEvalLLMCalls`); heads
logs `head.judge_ensemble_clamped`. `mcts_search_runs.config_json` stores
resolved knobs; `mcts_search_runs.judge_samples_realised` stores the smallest
sampled ensemble, folded in SQL. `read-models/fork-params.ts` reports requested
versus realised, never a prediction. Short-circuits can realise less than the
table ceiling. Raising the request alone buys nothing; raise
`maxEvalLLMCalls` too.

Used 0 and attempted 3 means an ensemble answered nothing usable; attempted 0
means it was never asked.

The fail band uses `f`: appended suites stop at the first throw, making
"three of four aspects correct" and "nothing works" the same observation
apart from judge noise. That binary reward degenerates search toward best-of-n
(`test-utils/src/eval-outcome.ts`); FunSearch requires "a 'rich' scoring
feedback … as opposed to a binary signal". The judge stays in the pass band,
where `f` is 1.

One LLM call generates up to `MAX_GENERATED_CHECKS` = 4 independent checks,
matching LATS's four generated tests, only when two or more eval calls remain.
Each executes separately. Executor calls cost no tokens, so `f` costs sandbox
round-trips, not spend. Without a suite, `f` and
`passedChecks`/`totalChecks` are absent, not zero; the judge positions instead.

Prose caps at 0.30 when a sibling produced running code, below
`minAcceptableScore`. `craftExtractionThreshold` 0.80 is the pass midpoint;
`minAcceptableScore` 0.30 the fail ceiling; `reflectionThreshold` 0.35 sits
above it; `pruneThreshold` 0.25 sits inside it.

## Backpropagation

`mcts/backpropagation.ts:38-52` walks leaf-to-root with a `WITH RECURSIVE` CTE:

```sql
WITH RECURSIVE ancestors(id, depth) AS (
  SELECT id, 0 FROM search_nodes WHERE id = ?
  UNION ALL
  SELECT s.parent_id, a.depth + 1
  FROM search_nodes s
  JOIN ancestors a ON s.id = a.id
  WHERE s.parent_id IS NOT NULL
)
UPDATE search_nodes
SET
  visits = visits + 1,
  value  = (value * visits + ?) / (visits + 1)
WHERE id IN (SELECT id FROM ancestors)
```

Rewards clamp to `[0, 1]`. `new_value = (old_value × visits + reward) / (visits + 1)`.

## Branch isolation

Each MCTS branch runs isolated:

| Platform | Mechanism | Isolation |
|----------|-----------|-----------|
| CF Workers | `agent.subAgent(ExplorationAgent, branchId)`, Facets | Separate DO with own SQLite. Proven in Lean: `MCTS/StorageIsolation.lean — transition_preserves_isolation`. |
| CF Workers (fallback) | Inline LLM calls | No storage access at all. Captures only LLM config, never agent reference. |
| CLI | `child_process.fork('branch-worker.ts')` | Separate OS process with its own SQLite file in a `branches/` directory beside the workspace database (`createBranchSpawner`) |

Both backends score through `evaluation.ts`. MCTS-mode `ExplorationAgent` calls
are `explore(priorHistory, craftedTools, languages, mode, siblings)` and
`generateReflection(task, outcome?)`; `setOwner` / `setSharedParent` bootstrap;
`mcts/diversity.ts` gives each index a framing angle.

### The observation loop

Nodes record after evaluation. `session.getHistory(node.msg_id)` gives a child
`[Node id] <proposal>` then `Observation: the proposed code ran against
generated assertions and FAILED: <error>`. Without it, deepening re-reads the
proposal and misses the runtime error. `generateReflection` gets the same
verdict, so `MEMORY.md` records how the attempt ended.
`search_nodes.observation` remains the proposal text compared by
`mcts/takes.ts`. Prose, plan-mode and unrunnable branches get no invented
observation line.

### Why branches are toolless, and where the tool-using ones live

MCTS branches are one model call, no `ToolSet`, no runtime. Paired `heads`
(`core/src/strategy/heads.ts`) runs full loops in the same `ExplorationAgent`,
head mode, scored through `HeadController.scoreHeads` and `evaluation.ts`.

| | `mcts` | `heads` |
|---|---|---|
| Branch | one `generateText`, no tools | multi-step loop, `execute_tools`/`run`/`file`/`web` |
| Isolation | structural: separate DO/process, no filesystem (`StorageIsolation.lean`) | prompt-level: heads share the canonical workspace and are *asked* to make their own git worktree |
| Branches per run | tens (budget × branches, re-expanded by UCT) | a handful, spawned once |
| Relationship | rivals; most are pruned | collaborators; all are merged |

`runAsHead` would put tens of concurrent heads in one shared workspace, where
branch changes cannot be graded. The per-branch workspace that fixes this is
unnecessary here. A swarm node is a full agent, graded on its reported
candidate, never a tree diff. See "A node is an agent" in
[EXPLORATION.md](./EXPLORATION.md). `initHead` / `runAsHead` / `abortHead` are
head-mode `@callable()`s; [ARCHITECTURE.md](./ARCHITECTURE.md) explains the
separate `ActorAgent` hierarchy.

## Pruning and convergence

Pruning requires `value < pruneThreshold` (0.25) and
`visits >= minVisitsForPrune` (2): mark `status = 'pruned'`, clear
`branch_agent_key`, abort, then first write reflection at
`reflectionThreshold` (0.35).

`mcts/convergence.ts` takes the argmax over `terminal` and `open` values.
Rivals within `takesEpsilon` (0.1) run one shared suite and compare satisfied
shares; all-pass and all-fail used to fall back to value order.

It refuses a winner below `minAcceptableScore` (0.3), or Undifferentiated
textually distinct approaches with exactly equal values. Then `ORDER BY value
DESC` is row order while the shared value clears the bar. Equality is exact,
not epsilon: a near-tie belongs in alternate takes; byte-identical scores
mean the scorer is not a function of the proposal. Either refusal sets
`converged: false`, records its reason, and marks open nodes failed rather
than shipping an unearned answer.

## search_nodes Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Node ID (nanoid) |
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
| `branch_agent_key` | TEXT | Maps to the Facet agent key |
| `evaluation_json` | TEXT | Bounded per-branch evaluation facts as JSON; null for a node that was never evaluated |
| `created_at` | INTEGER | Epoch milliseconds |

## Formal properties (Lean 4)

Eleven of the corpus's 470 published theorems live in `lean/Proteus/MCTS/`
(measured 2026-08-27). The model uses exact scaled-integer arithmetic; SQLite
uses IEEE-754 `REAL`. [FORMAL-SPEC.md](./FORMAL-SPEC.md) defines claim status.

| Property | File | Theorem | Claim status |
|----------|------|---------|--------------|
| Budget terminates (well-founded on Nat) | `StorageIsolation.lean` | `budget_well_founded` | by-construction-witness |
| Initial state is storage-isolated | `StorageIsolation.lean` | `init_isolated` | proved-in-abstract-model |
| All 7 MCTS transitions preserve isolation | `StorageIsolation.lean` | `transition_preserves_isolation` | proved-in-abstract-model |
| A reward in [0,S] keeps a node's mean in range | `Backpropagation.lean` | `update_preserves_range` | proved-in-abstract-model |
| …lifted to a whole reward history | `Backpropagation.lean` | `applyRewards_preserves_range` | proved-in-abstract-model |
| `value · visits = Σ rewards` after any history | `Backpropagation.lean` | `applyRewards_sum_invariant`, `sum_invariant` | proved-in-abstract-model |
| At the first visit the init value is erased | `Backpropagation.lean` | `init_values_equal_at_first_step` | by-construction-witness |
| One update yields exactly the running-mean numerator | `Backpropagation.lean` | `update_matches_ts_numerator` | by-construction-witness |
| A fresh node starts in range | `Backpropagation.lean` | `initial_in_range` | by-construction-witness |
| The ancestor walk touches visits/value only, never row IDs | `Backpropagation.lean` | `backprop_preserves_ids` | by-construction-witness |

Two requirements stay `specified-not-modeled`: UCT-bonus monotonicity (global
argmax, visit-count plateaus and root self-parenting defeat a naive
self-antitonic claim) and production-search convergence. A different textbook
model would not be evidence about Kinu.
