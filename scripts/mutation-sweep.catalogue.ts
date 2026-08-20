/**
 * What the sweep changes, and why this surface.
 *
 * SCOPE, CHOSEN ON EVIDENCE. Every confirmed built-but-unwired defect found on
 * 2026-08-19 sat in exploration or delegation: `agentHomeNodeProvisioner`,
 * `SwarmRunDeps.mission`, `AgentsForkDeps.registry`, `FORK_STRATEGY_ID`, merge-back's
 * four policies, `spawnNodeFacet`, the `carry:'artifacts'` threshold, the `models`
 * field, the judge clamp. So the catalogue is `packages/core/src/strategy/` plus
 * `tools/agents-tool.ts` — the swarm engine, the delegation tool that drives it, and
 * the measurement seams they settle by. A wider sweep is affordable in wall clock and
 * would dilute the reading; this one aims where the defects already were.
 *
 * NINE ARE CONTROLS. A sweep reporting only survivors is indistinguishable from a
 * sweep that ran nothing, so nine entries are decisions a named suite already pins.
 * They must come back KILLED. If one of them survives, the harness is broken and no
 * survivor in the same run means anything. The ninth is the defect this sweep found:
 * once fixed and defended, a question becomes a control.
 *
 * WHAT IS NOT HERE, AND WHY — recognising an equivalent mutant is part of the method,
 * because a mutant no suite could ever detect is not evidence about the suite:
 *   - `resolved.caps.branches?.value ?? 0` and `caps.depth?.value ?? 0`
 *     (`swarm-run.ts`). `regionRefusal` runs unconditionally at the top of `runSwarm`
 *     and refuses any resolved call missing either cap, so the `?? 0` arm cannot be
 *     reached. Mutating a dead default proves nothing about the suite.
 *   - `policy: input.policy ?? ''` in `reportVerdict`. Both call sites either pass a
 *     non-null policy or return before the line. Dead for the same reason.
 *   - `home: '.'` in the shared-plane return of `nodeWorkspace`. Nothing reads `home`
 *     on that branch: `isolationDisclosure`'s shared-plane arm ignores it.
 *   - `Math.max(1, …)` → `Math.max(0, …)` on the exec-ratio oracle budget. Separates
 *     the two readings only when a reference spends ZERO oracle calls on an instance.
 *     No shipped `RatioProblem` does, so a survivor would measure the corpus, not the
 *     suite.
 *   - `Date.now() > UNTIL` → `>=` on the exec-ratio deadline. Separates the readings
 *     only when the clock lands on the exact millisecond at a 1024-call boundary. No
 *     test can hold that deterministically, so it is inert in practice.
 *   - `void 0;` and its family. Declined twice already today by two agents
 *     independently, and both were right.
 */

/** One decision, and the other plausible reading of it. */
export interface Mutation {
  readonly id: string;
  /** Repo-relative path of the file to mutate. */
  readonly file: string;
  /** Source text, verbatim. Must occur EXACTLY once or the sweep throws. */
  readonly find: string;
  readonly replace: string;
  /** What the original decides, in one sentence. */
  readonly decision: string;
  /**
   * The name whose production READ makes this line run.
   *
   * Not the enclosing function's name by reflex: for a field that is written and never
   * read, the field itself is the right name, because "who reads this" is the question
   * that separates a missing assertion from dead wiring.
   *
   * IT MUST BE A NAME SPECIFIC TO THE DECISION. Measured 2026-08-19: `mission` as a
   * symbol returned 21 reader files, `use-create-workspace.ts` among them, because the
   * word is common and the classifier matches identifiers rather than meanings. A count
   * like that is noise wearing a number's clothes. `selfMetered` occurs three times in
   * the repository and answers cleanly; a bare `mission` does not.
   */
  readonly symbol: string;
  /** For a control, the suite that must turn red. Absent when the sweep is asking. */
  readonly control?: string;
}

export const CATALOGUE: readonly Mutation[] = [
  /* ── Controls: decisions a named suite already pins ───────────────────────── */
  {
    id: 'converse-capability-union',
    file: 'packages/core/src/tools/agents-tool.ts',
    find: 'const converse = !!deps.team || !!deps.peers;',
    replace: 'const converse = !!deps.team && !!deps.peers;',
    decision: 'hire/ask/send/list are offered when EITHER team or peers is wired',
    symbol: 'agentsActionsFor',
    control: 'unit-agents-tool.test.ts',
  },
  {
    id: 'dispatch-unsupported-guard',
    file: 'packages/core/src/tools/agents-tool.ts',
    find: 'if (!actions.includes(input.action)) {',
    replace: 'if (actions.includes(input.action)) {',
    decision: "an action this actor's deps do not support is refused before the switch",
    symbol: 'dispatchAgentsAction',
    control: 'unit-agents-tool.test.ts',
  },
  // The tokens left this line on 2026-08-19: the mission port now charges every call as
  // it happens, so the seam records the SPAWN and a literal zero rather than a lump that
  // would double-bill what the nodes already debited. The spawn count is still this
  // line's decision, and it is still the one worth inverting.
  {
    id: 'swarm-lump-debit-spawn-count',
    file: 'packages/core/src/tools/agents-tool.ts',
    find: 'mission?.governor.debit(0, { labels: mission.scope.labels, spawns: 1 });',
    replace: 'mission?.governor.debit(0, { labels: mission.scope.labels, spawns: 0 });',
    decision: "a completed swarm call increments the mission ledger's spawns by one",
    symbol: 'dispatchAgentsAction',
    control: 'unit-mission-budget-seams.test.ts',
  },
  {
    id: 'budget-take-clamp-direction',
    file: 'packages/core/src/strategy/swarm-budget.ts',
    find: 'const charged = Math.min(Math.max(0, width), this.left);',
    replace: 'const charged = Math.max(Math.max(0, width), this.left);',
    decision: 'take() charges the smaller of what was asked and what remains',
    symbol: 'SwarmBudget',
    control: 'unit-swarm-budget.test.ts',
  },
  {
    id: 'refusal-class-unavailable',
    file: 'packages/core/src/strategy/swarm-run.ts',
    find: "return refusalOf(new KinuError('unavailable', error));",
    replace: "return refusalOf(new KinuError('unsupported', error));",
    decision: "this file's refusals are transient `unavailable`, not permanent `unsupported`",
    symbol: 'runSwarm',
    control: 'unit-swarm-node-hang.test.ts',
  },
  {
    id: 'aggregate-depth-floor',
    file: 'packages/core/src/strategy/swarm-run.ts',
    find: 'if (depth.value < 2) {',
    replace: 'if (depth.value <= 2) {',
    decision: "expand:'aggregate' needs depth >= 2, one level for the fan-in to consume",
    symbol: 'runSwarm',
    control: 'unit-swarm-depth.test.ts',
  },
  {
    id: 'arbitrate-tool-build-gate',
    file: 'packages/core/src/strategy/swarm-run.ts',
    find: 'arbitrate: isTreeAdvance(resolved.config.advance.kind) && atDepth + 1 <= maxDepth',
    replace: 'arbitrate: isTreeAdvance(resolved.config.advance.kind) && atDepth + 1 < maxDepth',
    decision: 'a node one level below the cap is still built with propose_branch',
    symbol: 'runSwarm',
    control: 'unit-swarm-agent-nodes.test.ts',
  },
  {
    id: 'shared-plane-label-honesty',
    file: 'packages/core/src/strategy/node-workspace.ts',
    find: "  return { home: '.', cred: undefined, isolation: 'shared-origin-plane' };",
    replace: "  return { home: '.', cred: undefined, isolation: 'private-home' };",
    decision: 'a node with no provisioner is told it shares the origin plane',
    symbol: 'nodeWorkspace',
    control: 'unit-swarm-agent-nodes.test.ts',
  },

  /* ── The second search implementation nothing dispatches to ───────────────── */
  // THE FIX FOR THESE FOUR IS DELETION, NOT WIRING, and the distinction is worth
  // stating because the report's own UNREACHED wording ("wire it or delete it") is
  // neutral between them and the wrong branch is expensive.
  //
  // `selfMetered` is not a signal whose consumer was never written. It is a signal
  // whose CALLER was removed. Its docstring names the consumer — "the fork seam then
  // records only the spawn" — and that seam dispatched `ExplorationStrategy.explore()`
  // through `AgentsForkDeps.registry`, which has no production reader. Established
  // 2026-08-19 against source, after this catalogue first proposed the opposite:
  // `selfMetered` sits on `StrategyResult.cost`, `SwarmResult` has no `cost` field at
  // all, and `StrategyResult` appears in no file outside `strategy/{heads,mcts,
  // single-shot,types}.ts` in any backend. So `agents-tool.ts`'s lump could never have
  // read it, and making that lump conditional on a new flag would be the worse
  // instrument anyway: a boolean that has to be right double-bills silently in its
  // false branch, which looks exactly like the cap working. A deleted lump cannot be
  // wrong. Per-call charging through the mission port, asserted as
  // `total == provider-reported usage`, is what replaced it.
  //
  // `FORK_STRATEGY_ID` HAD AN ENTRY HERE AND NO LONGER NEEDS ONE. It was reported
  // UNREACHED by the 2026-08-19 run and then deleted, together with
  // `AgentsForkDeps.registry` and the three `registry.register(...)` calls — the fix
  // this classification prescribes. The entry is retired rather than re-pointed at the
  // `id: 'heads'` literal that replaced it, because a catalogue that keeps mutating a
  // decision after the decision is gone reports on nothing. `createHeadsStrategy` and
  // `createMCTSStrategy` now have no production reader at all, so the two `selfMetered`
  // entries below carry the UNREACHED demonstration on their own.
  {
    id: 'heads-self-metered-write',
    file: 'packages/core/src/strategy/heads.ts',
    find: 'if (ctx.mission) cost.selfMetered = true;',
    replace: 'if (!ctx.mission) cost.selfMetered = true;',
    decision: "a mission's heads run reports its tokens as already charged",
    symbol: 'selfMetered',
  },
  {
    id: 'mcts-self-metered-write',
    file: 'packages/core/src/strategy/mcts.ts',
    find: 'selfMetered: ctx.mission ? true : undefined,',
    replace: 'selfMetered: ctx.mission ? undefined : true,',
    decision: "a mission's MCTS run reports its tokens as already charged",
    symbol: 'selfMetered',
  },
  {
    id: 'mcts-caller-budget-wins',
    file: 'packages/core/src/strategy/mcts.ts',
    find: 'const budget = ctx.budget?.maxIterations ?? o.budget ?? defaults.budget;',
    replace: 'const budget = o.budget ?? ctx.budget?.maxIterations ?? defaults.budget;',
    decision: "an explicit caller budget beats the per-strategy option, as the file's header says",
    symbol: 'createMCTSStrategy',
  },

  /* ── The swarm engine's undefended decisions ──────────────────────────────── */
  {
    id: 'mission-forwarded-to-nodes',
    file: 'packages/core/src/strategy/swarm-run.ts',
    find: 'if (deps.mission !== undefined) nodeDeps.mission = deps.mission;',
    replace: 'if (deps.mission === undefined) nodeDeps.mission = deps.mission;',
    decision: "a caller's mission ledger reaches every node, so each debits its own steps",
    symbol: 'runSwarm',
  },
  {
    id: 'node-steps-zero-honoured',
    file: 'packages/core/src/strategy/swarm-run.ts',
    find: 'const nodeSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;',
    replace: 'const nodeSteps = deps.maxSteps || DEFAULT_MAX_STEPS;',
    decision: 'a caller-supplied step budget of 0 is honoured, not replaced by the default',
    symbol: 'runSwarm',
    control: 'unit-swarm-incomplete-node.test.ts',
  },
  {
    id: 'node-wallclock-zero-honoured',
    file: 'packages/core/src/strategy/swarm-run.ts',
    find: 'maxWallClockMs: deps.maxWallClockMs ?? nodeWallClockEnvelopeMs(nodeSteps),',
    replace: 'maxWallClockMs: deps.maxWallClockMs || nodeWallClockEnvelopeMs(nodeSteps),',
    decision: 'a caller-supplied wall clock of 0 is honoured, not replaced by the envelope',
    symbol: 'runSwarm',
    control: 'unit-swarm-incomplete-node.test.ts',
  },
  {
    id: 'judged-rank-direction',
    file: 'packages/core/src/strategy/swarm-run.ts',
    find: "const rankDirection: ObjectiveDirection = measured?.direction ?? 'maximise';",
    replace: "const rankDirection: ObjectiveDirection = measured?.direction ?? 'minimise';",
    decision: 'a judged run ranks a median score as a quality, so higher wins',
    symbol: 'runSwarm',
    control: 'unit-swarm-depth.test.ts',
  },
  // RETIRED, and not because the decision is unimportant: the branch it mutates cannot
  // be reached, so both readings are observationally identical and a test there could not
  // fail. `VERIFIER_KINDS` has ONE member; `exec-ratio`'s `MeasurementSchema` requires
  // refOps, candOps, refMs and candMs and rejects a non-finite one, so every measurement
  // it returns carries the same four finite quantities; `runSwarm`'s baseline check
  // (swarm-run.ts:1606) refuses any `key` outside the BASELINE's map before a candidate
  // exists; and a candidate with no measurement is skipped earlier at the settle barrier.
  // So `archiveCellOf` at the barrier is always handed a key it can bin, and
  // `cause: 'unwitnessed'` is unreachable while one instrument measures both the baseline
  // and the candidates. Same class as the four equivalent mutants named above.
  // `unit-exec-ratio-budget.test.ts` holds the premise — every quantity the instrument
  // reports is a key an archive can bin — so this becomes measurable again, rather than
  // silently reachable, if a second kind ever reports a quantity for only one of the two.
  // FOUND BY THIS SWEEP AND FIXED, so the entry now runs the other way: it restores the
  // `>=` the tree shipped with, and `unit-swarm-depth.test.ts` must reject it. It is a
  // control rather than a question because the answer is now defended.
  {
    id: 'propose-invitation-cutoff',
    file: 'packages/core/src/strategy/swarm-run.ts',
    find: "if (!isTreeAdvance(input.advance.kind) || input.atDepth + 1 > input.maxDepth) return '';",
    replace: "if (!isTreeAdvance(input.advance.kind) || input.atDepth + 1 >= input.maxDepth) return '';",
    decision: 'the prompt invites a proposal on every level a grant is still legal from',
    symbol: 'runSwarm',
    control: 'unit-swarm-depth.test.ts',
  },
  {
    id: 'aggregate-lands-at-cap',
    file: 'packages/core/src/strategy/swarm-run.ts',
    find: 'if (parents.length < 2 || atDepth + 1 > maxDepth) {',
    replace: 'if (parents.length < 2 || atDepth + 1 >= maxDepth) {',
    decision: 'a fan-in vertex may land exactly at the depth cap',
    symbol: 'runSwarm',
  },

  /* ── The measurement seams the engine settles by ──────────────────────────── */
  {
    id: 'exec-ratio-runaway-multiple',
    file: 'packages/core/src/strategy/exec-ratio.ts',
    find: 'const BUDGET_MULTIPLE = 4;',
    replace: 'const BUDGET_MULTIPLE = 1;',
    decision: "a candidate may spend four times the reference's oracle calls before it is cut off",
    symbol: 'runRatioMeasurement',
    control: 'unit-exec-ratio-budget.test.ts',
  },
  {
    id: 'exec-ratio-limit-strictness',
    file: 'packages/core/src/strategy/exec-ratio.ts',
    find: "if (OPS > LIMIT) throw new Budget('oracle budget of ' + String(LIMIT) "
      + "+ ' calls exhausted');",
    replace: "if (OPS >= LIMIT) throw new Budget('oracle budget of ' + String(LIMIT) "
      + "+ ' calls exhausted');",
    decision: 'the call landing exactly on the oracle budget is the last one allowed',
    symbol: 'runRatioMeasurement',
    control: 'unit-exec-ratio-budget.test.ts',
  },
  {
    id: 'effort-judge-rung',
    file: 'packages/core/src/strategy/effort.ts',
    find: "  judge: 'medium',",
    replace: "  judge: 'low',",
    decision: 'a judge call gets the medium reasoning rung',
    symbol: 'REASONING_EFFORT_FOR_STAGE',
    control: 'unit-strategy.test.ts',
  },
  {
    id: 'provider-options-override-wins',
    file: 'packages/core/src/strategy/effort.ts',
    find: '    merged[provider] = { ...base[provider], ...options };',
    replace: '    merged[provider] = { ...options, ...base[provider] };',
    decision: 'inside one provider namespace the override wins over the base',
    symbol: 'mergeProviderOptions',
    control: 'unit-strategy.test.ts',
  },

  /* ── The node seam ────────────────────────────────────────────────────────── */
  {
    id: 'node-journal-merge-label',
    file: 'packages/core/src/strategy/node-agent.ts',
    find: "    mergeStrategy: input.settle === 'best' ? 'best_of' : 'synthesize',",
    replace: "    mergeStrategy: input.settle === 'best' ? 'synthesize' : 'best_of',",
    decision: "a node's journal row records best_of exactly when the search settles by best",
    symbol: 'runNodeAgent',
    control: 'unit-node-host.test.ts',
  },
  {
    id: 'empty-report-falls-back',
    file: 'packages/core/src/strategy/node-agent.ts',
    find: '  const conclusion = input.reported?.content.trim() || input.report.summary.trim();',
    replace: '  const conclusion = input.reported?.content.trim() ?? input.report.summary.trim();',
    decision: 'a node reporting whitespace has reported nothing, so the loop summary stands',
    symbol: 'runNodeAgent',
    control: 'unit-node-host.test.ts',
  },
  {
    id: 'provisioned-node-runs-as-itself',
    file: 'packages/core/src/strategy/node-workspace.ts',
    find: "    return { home, cred: agentCred(identity), isolation: 'private-home' };",
    replace: "    return { home, cred: undefined, isolation: 'private-home' };",
    decision: "a provisioned node's commands run as its own confined uid",
    symbol: 'agentHomeNodeProvisioner',
  },
];
