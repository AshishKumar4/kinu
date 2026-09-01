// The swarm engine and the pieces a backend or the agents tool reaches it
// through. The `ExplorationStrategy` seam that used to head this list is gone:
// no production path built its registry, and its three adapters (mcts, heads,
// single-shot) had no reader outside the eval harness, which now owns the
// contract at `eval/strategy.ts`.
export * from './objective';
export * from './swarm';
export * from './effort';
// The metered-oracle measurement substrate, and the registry `VerifierSpec.kind` is
// closed over. Separate files because one is an instrument and the other is the
// membership rule that makes a kind resolvable at all.
export * from './exec-ratio';
export * from './verifier-registry';
export * from './swarm-run';
// The node runtime and the layout its home comes from. Exported because a BACKEND
// calls `runNodeLoop` directly: an `ExplorationAgent` facet is a transport for the
// same body the search runs in-isolate, so the host needs the loop, its spec and
// its result types by name.
export * from './node-host';
export * from './node-agent';
export * from './node-workspace';
// `BranchDecision` and the budget that issues it. On the surface because the
// arbiter is now a seam a HOST calls across: a backend that answers
// `nodeArbitrate` has to name the verdict type it returns, and deriving it from
// the arbiter's own signature is how a type stops having a name.
export * from './swarm-budget';
