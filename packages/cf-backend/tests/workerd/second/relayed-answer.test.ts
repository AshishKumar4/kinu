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
import * as v from 'valibot';

it("a slate's binding call hands back its answer without the disposer it received", async () => {
  const probe = env.AGENT_FACET_PROBE.get(env.AGENT_FACET_PROBE.idFromName('relayed-slate-answer'));
  const seen = await probe.slateBindingAnswer('relayed-slate-answer-workspace');

  expect(seen.answer).toEqual({ ok: true, value: { value: 'kept' } });
  expect(seen.carriesDisposer).toBe(false);
});

// Production ends a relay's call as hung once a stream it received and answered with ends, though every byte arrived;
// workerd ends it ok, so this pins the binding's side. Measured on cmp-kinu-slate (2026-10-14, compatibility date
// 2026-09-30): SlateBinding handing ai.stream's and agent.ask's received streams to a slate's facet ended hung 13 of 13
// times, as staging 0c7b3ee7's did (2026-10-13, after 8 s with 0 ms CPU); piped through its own isolate, 12 of 12 ok.
it("a slate's binding hands on ai.stream's and agent.ask's streams as its own", async () => {
  const probe = env.AGENT_FACET_PROBE.get(env.AGENT_FACET_PROBE.idFromName('relayed-slate-streams'));

  expect(await probe.slateBindingStreams('relayed-slate-streams-workspace')).toEqual([
    { member: 'ai.stream', stream: 'own', text: 'ai.stream text' },
    { member: 'agent.ask', stream: 'own', text: 'agent.ask text' },
  ]);
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

// 2026-10-09, workerd 2026-09-30, debugger job 20261009190056-d2d7425c: disposing only a
// downstream session method left a rejected factory hung. A fulfilled session must remain usable after a method rejects.
it('a rejected session closes its relay, while fulfilled sessions and streams keep their ownership', async () => {
  const response = await env.RELAY_LIFETIME.fetch('http://relay-lifetime/');
  const seen = v.parse(v.object({ exitCode: v.nullable(v.number()), stdout: v.string(), stderr: v.string() }), await response.json());

  expect(seen.exitCode, seen.stderr || seen.stdout).toBe(0);
  const summary = seen.stdout.split('\n').find(line => line.startsWith('SUMMARY '));

  if (summary === undefined) throw new Error('the real-workerd lifetime oracle returned no observations');
  const observations = v.parse(v.array(v.object({ mode: v.string(), tail: v.object({ outcome: v.string() }) })), JSON.parse(summary.slice('SUMMARY '.length)));

  expect(observations.map(item => [item.mode, item.tail.outcome])).toEqual([
    ['session-factory-rejection', 'ok'], ['session-method-rejection', 'ok'], ['fulfilled-stream', 'ok'],
  ]);
});

// 2026-10-09, staging 44b13e946: a callback-bearing codemode program answered, yet its relay read as hung, its host stub
// never disposed and its capability held once a collection ran inside the program.
it('a program whose host collected under its callbacks closes its relay once it answered', async () => {
  const response = await env.RELAY_HOST.fetch('http://relay-host/');
  const seen = v.parse(v.object({ exitCode: v.nullable(v.number()), stdout: v.string(), stderr: v.string() }), await response.json());

  expect(seen.exitCode, seen.stderr || seen.stdout).toBe(0);
  const summary = seen.stdout.split('\n').find(line => line.startsWith('SUMMARY '));

  if (summary === undefined) throw new Error('the real-workerd relay host oracle returned no observations');
  const observations = v.parse(v.array(v.object({ mode: v.string(), answer: v.object({ result: v.unknown() }), tail: v.object({ outcome: v.string() }) })), JSON.parse(summary.slice('SUMMARY '.length)));

  expect(observations.map(item => [item.mode, item.answer.result, item.tail.outcome])).toEqual([['program-codemode-callback-pressure', 7, 'ok']]);
});
