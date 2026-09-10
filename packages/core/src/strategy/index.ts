// This module exports the swarm engine and the pieces its backend and
// agents-tool callers use. The mcts/heads/single-shot adapter contract belongs
// to its sole consumer, the eval harness, at `eval/strategy.ts`.
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
// calls `runNodeLoop` directly: a hosted node's transport is a transport for the
// same body the search runs in-isolate, so the host needs the loop, its spec and
// its result types by name.
export * from './node-host';

export * from './node-agent';

export * from './node-workspace';

// `BranchDecision` and the budget that issues it. On the surface because the
// arbiter is a seam a HOST calls across: a backend that answers
// `nodeArbitrate` has to name the verdict type it returns, and deriving it from
// the arbiter's own signature is how a type stops having a name.
export * from './swarm-budget';
