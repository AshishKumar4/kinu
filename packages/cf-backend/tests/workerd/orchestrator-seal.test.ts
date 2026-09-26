/**
 * The seal against the SDK the product installs, over a real stub. `unit-rpc-surface.test.ts` holds the surface lists
 * and the reachability rule, but it constructs the orchestrator over the SDK stub, so only here does the shipped
 * OrchestratorAgent meet the `agents` Agent it really inherits: `public-surface-probe` hosts the class unchanged,
 * sealed with no extra name, and workerd itself refuses each member that would hand a stub-holder the object.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { MUST_STAY_DENIED } from '../helpers/rpc-denied';

/** What a call over the stub answered: workerd's refusal, a throw from inside the object, or a value. */
async function answerTo(call: () => Promise<void>): Promise<string> {
  try {
    await call();

    return 'answered';
  } catch (error) {
    return String(error);
  }
}

describe('a production OrchestratorAgent stub', () => {
  test('refuses each inherited member that hands over the object, and still answers what getAgentByName calls', async () => {
    const stub = env.SEALED_ORCHESTRATOR.get(env.SEALED_ORCHESTRATOR.idFromName('sealed-root'));

    // A live agents-SDK root behind the binding, its surface open: a refusal below is the seal, not a bare object.
    await stub.__unsafe_ensureInitialized();

    // One call per denied name, with no arguments; the compiler holds this table to the list.
    const calls = {
      sql: () => stub.sql(),
      destroy: () => stub.destroy(),
      setState: () => stub.setState(),
      stash: () => stub.stash(),
      _cf_invokeSubAgent: () => stub._cf_invokeSubAgent(),
      _cf_invokeSubAgentPath: () => stub._cf_invokeSubAgentPath(),
      _cf_invokeAgentPath: () => stub._cf_invokeAgentPath(),
      _cf_invokeStubMethod: () => stub._cf_invokeStubMethod(),
      schedule: () => stub.schedule(),
      runFiber: () => stub.runFiber(),
      keepAlive: () => stub.keepAlive(),
    } satisfies Record<(typeof MUST_STAY_DENIED)[number], () => Promise<void>>;

    const reached: string[] = [];

    for (const name of MUST_STAY_DENIED) {
      const answer = await answerTo(calls[name]);

      if (!answer.includes(`The RPC receiver does not implement the method "${name}".`)) reached.push(`${name}: ${answer.slice(0, 160)}`);
    }

    expect(reached).toEqual([]);
  });
});
