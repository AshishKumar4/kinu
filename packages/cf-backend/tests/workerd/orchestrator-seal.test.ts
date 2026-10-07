/**
 * The seal against the SDK the product installs, over real stubs: `public-surface-probe` hosts the shipped
 * OrchestratorAgent and UserDO unchanged, so workerd itself refuses each member that would hand a stub-holder the object
 * or its credentials, while every listed name still reaches the callee, which may refuse it by its own rule.
 * `plan-announce-probe` is a production root driving its own facet hops, so a permitted call, a callee's refusal and the
 * denied broadcast and state writer are measured on one root.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import * as v from 'valibot';
import { MUST_STAY_DENIED } from '../helpers/rpc-denied';

/** Keeps every other field, so a payload that grew one fails the equality. */
const FrameSchema = v.looseObject({ type: v.string() });

/** What a call over the stub answered: workerd's refusal, a throw from inside the object, or a value. */
async function answerTo(call: () => Promise<void>): Promise<string> {
  try {
    await call();

    return 'answered';
  } catch (error) {
    return String(error);
  }
}

const refusal = (name: string): string => `The RPC receiver does not implement the method "${name}".`;

/** The names of `calls` whose answer is not workerd's refusal: on a sealed object, each should be. */
async function reached(calls: Record<string, () => Promise<void>>): Promise<string[]> {
  const answers = await Promise.all(Object.entries(calls).map(async ([name, call]) => [name, await answerTo(call)] as const));

  return answers.filter(([name, answer]) => !answer.includes(refusal(name))).map(([name, answer]) => `${name}: ${answer.slice(0, 160)}`);
}

type Denied = Record<(typeof MUST_STAY_DENIED)[number], () => Promise<void>>;

/** One call per denied name, with no arguments; the compiler holds this table to the list. */
function deniedCalls(stub: Denied): Denied {
  return {
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
  };
}

describe('a production OrchestratorAgent stub', () => {
  test('refuses each inherited member that hands over the object, and still answers what getAgentByName calls', async () => {
    const stub = env.SEALED_ORCHESTRATOR.get(env.SEALED_ORCHESTRATOR.idFromName('sealed-root'));

    // A live agents-SDK root behind the binding, its surface open: a refusal below is the seal, not a bare object.
    await stub.__unsafe_ensureInitialized();

    expect(await reached({
      ...deniedCalls(stub),
      // Its own internals: the workspace it hosts, its soul and the profile its next turn resolves.
      hostedWorkspace: () => stub.hostedWorkspace(),
      loadSoulText: () => stub.loadSoulText(),
      currentProfile: () => stub.currentProfile(),
    })).toEqual([]);
  });

  test('answers every method the Worker\'s file and terminal routes call on it, each refusing bad input by its own rule', async () => {
    const stub = env.SEALED_ORCHESTRATOR.get(env.SEALED_ORCHESTRATOR.idFromName('sealed-routes'));

    const routes = {
      startExecutorFileDownload: () => stub.startExecutorFileDownload(),
      readExecutorFileChunk: () => stub.readExecutorFileChunk(),
      abortExecutorFileDownload: () => stub.abortExecutorFileDownload(),
      writeExecutorFileChunk: () => stub.writeExecutorFileChunk(),
      abortExecutorFileWrite: () => stub.abortExecutorFileWrite(),
      prepareTerminal: () => stub.prepareTerminal(),
      openDeviceTerminal: () => stub.openDeviceTerminal(),
    };

    for (const [name, call] of Object.entries(routes)) expect([name, await answerTo(call)]).not.toEqual([name, refusal(name)]);
  });
});

describe('a production UserDO stub', () => {
  test('refuses its credential store and inherited members, and still reaches its gated reads, which refuse a missing caller', async () => {
    const stub = env.SEALED_USER_DO.get(env.SEALED_USER_DO.idFromName('sealed-account'));

    // What getAgentByName calls on the stub answers: the refusals below are the seal, not a bare object.
    await stub.__unsafe_ensureInitialized();

    expect(await reached({
      ...deniedCalls(stub),
      sqlx: () => stub.sqlx(),
      readCredential: () => stub.readCredential(),
      writeCredential: () => stub.writeCredential(),
      requireTier: () => stub.requireTier(),
      ensureInit: () => stub.ensureInit(),
      // Public in TypeScript because the SDK base calls it in process; shadowed over RPC.
      createMcpOAuthProvider: () => stub.createMcpOAuthProvider(),
    })).toEqual([]);

    for (const [name, call] of Object.entries({ listWorkspaces: () => stub.listWorkspaces(), listCredentials: () => stub.listCredentials() })) {
      const answer = await answerTo(call);

      expect([name, answer.includes(refusal(name)), answer === 'answered']).toEqual([name, false, false]);
    }
  });
});

describe('the RPC seal over a real root stub', () => {
  test('carries the listed names, lets the callee refuse one, and rejects the inherited ones', async () => {
    const root = env.PLAN_ANNOUNCE_ROOT.get(env.PLAN_ANNOUNCE_ROOT.idFromName('workspace'));
    const { hops, published } = await root.exercise();

    // Positive control: a listed name over a real hop.
    expect(hops.claim).toEqual({ ok: true, error: null });

    // Refused by the callee's own rule, not the runtime's "does not implement".
    expect(hops.second?.ok).toBe(false);
    expect(hops.second?.error ?? '').not.toMatch(/does not implement/);

    // The runtime never finds these names; no in-process double can produce this.
    expect(hops.broadcast?.ok).toBe(false);
    expect(hops.broadcast?.error ?? '').toMatch(/broadcast/);
    expect(hops.state?.ok).toBe(false);
    expect(hops.state?.error ?? '').toMatch(/setState/);

    // Deep equality, so a field added to the frame fails here.
    const frames = published.map((frame) => v.parse(FrameSchema, JSON.parse(frame)));

    expect(frames.filter((frame) => frame.type === 'head_stream')).toEqual([{
      type: 'head_stream', headId: 'head-wire', kind: 'reasoning', delta: 'kinu-probe-narrow-delta',
    }]);
  });
});
