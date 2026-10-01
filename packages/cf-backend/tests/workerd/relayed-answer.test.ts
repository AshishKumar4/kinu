/**
 * An entrypoint that returns an object it received over RPC hands the platform the disposer RPC attached to that
 * object, and the platform keeps the call open until its caller disposes the answer. Measured under workerd
 * 1.20260930.2 on 2026-10-01: a relay returning the object it got ended 803 ms after answering, when its caller's own
 * run ended; returning a copy, it ended as it answered (0 ms). On staging f62dfcb9 (2026-10-01 01:07-01:13Z) callers
 * kept those answers, so AgentWorkspaceRPC calls stayed open a median of 82 s (up to 19 min), SlateBinding calls a
 * median of 24 s, and the runtime reported 43 answered AgentWorkspaceRPC calls as hung when it closed them.
 */
import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';

it("an agent's workspace call hands back its answer without the disposer it received", async () => {
  const probe = env.AGENT_FACET_PROBE.get(env.AGENT_FACET_PROBE.idFromName('relayed-agent-answer'));
  const seen = await probe.agentWorkspaceAnswer('relayed-agent-answer-workspace', 'scout');

  expect(seen.answer).toEqual({ Authorization: 'Bearer relay-probe-key' });
  expect(seen.carriesDisposer).toBe(false);
});

// A list arrives with the disposer too. Measured the same day, the platform did not hold a relay open for a list it
// handed on (0 ms against 803 ms for an object); it leaves as a copy anyway, so no relayed answer carries one.
it("an agent's workspace call hands back a list without the disposer it received", async () => {
  const probe = env.AGENT_FACET_PROBE.get(env.AGENT_FACET_PROBE.idFromName('relayed-agent-listing'));
  const seen = await probe.agentWorkspaceListing('relayed-agent-listing-workspace', 'scout');

  expect(seen.answer).toEqual([{ key: 'openai-compat.default', kind: 'openai-compat' }]);
  expect(seen.carriesDisposer).toBe(false);
});

it("a slate's binding call hands back its answer without the disposer it received", async () => {
  const probe = env.AGENT_FACET_PROBE.get(env.AGENT_FACET_PROBE.idFromName('relayed-slate-answer'));
  const seen = await probe.slateBindingAnswer('relayed-slate-answer-workspace');

  expect(seen.answer).toEqual({ ok: true, value: { value: 'kept' } });
  expect(seen.carriesDisposer).toBe(false);
});

// A program's host call is a relay too: the function the launcher calls back answers with what the host got. Measured
// under workerd 1.20260930.2 on 2026-10-01: a swarm node's program whose `host.callTool` answered with an object it
// got over RPC was reported hung after its launcher answered, and answering a string instead was not; on staging
// df49f4cc5 13 CodemodeLauncher calls ended so, all in the three swarm-audit workspaces.
it("a program's host call hands the launcher its answer without the disposer it received", async () => {
  const probe = env.AGENT_FACET_PROBE.get(env.AGENT_FACET_PROBE.idFromName('relayed-program-answer'));
  const seen = await probe.programHostAnswer('relayed-program-answer-workspace');

  expect(seen.answer).toEqual({ Authorization: 'Bearer relay-probe-key' });
  expect(seen.carriesDisposer).toBe(false);
});
