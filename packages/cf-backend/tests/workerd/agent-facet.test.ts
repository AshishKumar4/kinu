/**
 * An agent in its own isolate shares the workspace's one file plane: what it writes in its home through Nimbus's
 * session surface, the workspace reads and `cat`s. Slice 5's check (kinu-logs/design/SUBAGENTS.md).
 */
import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';

it('an agent in its own isolate writes a file the workspace reads and cats', async () => {
  const probe = env.AGENT_FACET_PROBE.get(env.AGENT_FACET_PROBE.idFromName('agent-facet'));
  const seen = await probe.onePlane('agent-facet-workspace', 'scout');

  expect(seen.sameIsolate).toBe(false);
  expect(seen.agentShell.exitCode).toBe(0);
  expect(seen.agentShell.stdout.split('\n')[0]).toBe(seen.home);
  expect(seen.agentShell.stdout.split('\n')[1]).not.toBe('1000');
  expect(seen.mainRead).toBe('written by the agent');
  expect(seen.mainCat).toMatchObject({ exitCode: 0, stdout: 'written by the agent' });
});
