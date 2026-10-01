import type { PublicSwarmRun } from '../src/session';
import type { EvalCheckOutcome, EvalVerifier } from '../src/verifier';

/**
 * What a swarm run was, as facts a trial keeps whatever its checks say: the preset (a `custom` run's label),
 * how it ended, how many nodes it spawned and how many settled, how deep it went, its wall time from the run's
 * start to the last node's end, and the judge samples it asked for: null when no judge ranked its nodes, absent
 * when the pane holds no search parameters for it.
 */
function facts(swarm: PublicSwarmRun) {
  const nodes = swarm.head?.heads ?? [];
  const search = swarm.params?.search;
  const ended = nodes.length === 0 ? null : Math.max(...nodes.map((node) => node.spawnedAt + node.wallClockMs));

  return {
    preset: swarm.head?.rationale ?? null,
    status: swarm.run.status,
    nodes: nodes.length,
    settled: nodes.filter((node) => node.status === 'completed').length,
    depth: nodes.reduce((deepest, node) => Math.max(deepest, node.depth), 0),
    wallMs: ended === null ? null : ended - swarm.run.startedAt,
    judgeSamples: search === undefined || search === null ? undefined : search.judgeSamplesRequested,
    winnerScore: swarm.run.winnerScore,
  };
}

/**
 * Whether the lead ran a swarm of `asked.preset` that completed with at least two of its nodes settled, and,
 * when `asked.measured`, one its objective's verifier ranked: a named preset called without an objective falls
 * back to a judge ensemble (core `unmeasuredPoint`), and only a judge asks for samples. Read from the Swarms
 * pane, never from the agent's own account. A lead that does the work itself, a swarm of another shape, a judged
 * sweep where a measured search was asked for, or one whose nodes all failed fails it. Every run's facts are
 * the evidence either way.
 */
export async function aSwarmRan(verifier: EvalVerifier, asked: { preset: string; measured?: true }): Promise<EvalCheckOutcome> {
  const runs = (await verifier.swarms()).map(facts);

  return {
    pass: runs.some((run) => run.preset === asked.preset && run.status === 'completed' && run.settled >= 2
      && (asked.measured === undefined || run.judgeSamples === null)),
    evidence: { asked, runs },
  };
}
