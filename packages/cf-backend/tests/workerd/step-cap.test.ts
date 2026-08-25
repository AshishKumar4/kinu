/**
 * R3 — the behavioural proof of the production defect and its fix, on the one
 * runtime that can host it.
 *
 * THE DEFECT. `@cloudflare/think` sets `this.maxSteps = 10` and composes
 * `[stepCountIs(config.maxSteps ?? this.maxSteps), ...caller]` as an OR-ed stop
 * condition array. So the cloud backend ran hard-capped at ten steps for as long
 * as `core/chat.ts` and `core/config.ts` both documented no per-turn bound, and
 * `actor-agent.ts` asserted in a comment that it ran "the SAME ordering runChat
 * runs on the CLI". Measured on the deployed revision: four of four turns that
 * reached ten steps had a last-step `finishReason` of `'tool-calls'` — the model
 * still working — and every one of them sealed `run_end.reason: 'completed'`.
 *
 * WHY NOTHING CAUGHT IT. The bound lives inside the real inference loop. The bun
 * suites stub the `agents` SDK wholesale, so no test in the repository could enter
 * that loop, and the two assertions that came closest measured a one-clause lambda
 * in isolation and a neighbouring property of the same Think method.
 *
 * So this file runs REAL turns: a model that calls a tool on every step, one
 * Durable Object on the vendor default and one carrying the production actor's
 * override.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { classifyRunEnd, TOOL_CALLS_PENDING } from '@kinu.run/core';
import { TOOL_CALLING_STEPS, type TurnObservation } from './step-cap-probe';
import type { CappedTurnProbeDO, UnboundedTurnProbeDO } from './step-cap-probe';


const DEADLINE_MS = 60_000;
const POLL_MS = 50;

/**
 * One real turn, driven the way `steer-chain.test.ts` drives one: the actual chat
 * frame over an actual socket. `Think.chat()` is not usable here — it reaches a
 * session plane this pool does not stand up (measured: `undefined.appendMessage`).
 */
async function driveTurn(
  ns: DurableObjectNamespace<CappedTurnProbeDO> | DurableObjectNamespace<UnboundedTurnProbeDO>,
  name: string,
): Promise<TurnObservation> {
  const stub = ns.get(ns.idFromName(name));
  const response = await stub.fetch(`https://probe/agents/probe/${name}`, {
    headers: { Upgrade: 'websocket' },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error('no socket on the 101 response');
  socket.accept();
  socket.send(JSON.stringify({
    id: 'req-1',
    type: 'cf_agent_use_chat_request',
    init: {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'keep calling the tool' }] }],
        trigger: 'submit-message',
      }),
    },
  }));
  // Condition-bound: the turn is over once its steps stop advancing and the loop
  // has settled. Real wall-clock, deliberately — this pool has no fake timers and
  // the deadline only bounds a broken run.
  const start = Date.now();
  let last = -1;
  let stable = 0;
  for (;;) {
    const observed = await stub.observeTurn();
    if (observed.steps > 0 && observed.steps === last) {
      stable += 1;
      if (stable >= 6) return observed;
    } else {
      stable = 0;
    }
    last = observed.steps;
    if (Date.now() - start > DEADLINE_MS) return observed;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Think's own instance default. Named as the number under test, not imported:
 *  the point is that a value inside the vendor bundle bounded our turns. */
const THINK_DEFAULT_MAX_STEPS = 10;

describe('a turn whose model keeps calling tools', () => {
  it('is CUT at the vendor cap when the default stands — the control', async () => {
    const observed = await driveTurn(env.CAPPED_TURN_PROBE, 'capped-1');

    // Exactly the production signature, reproduced: stopped at the cap, with the
    // model's last word being that it had more to do.
    expect(observed.steps).toBe(THINK_DEFAULT_MAX_STEPS);
    expect(observed.lastFinishReason).toBe(TOOL_CALLS_PENDING);
    // And it never answered, which is what the owner actually saw: a chat row
    // that trails off mid-work.
    expect(observed.answered).toBe(false);
  });

  it('runs past ten steps when the actor overrides the bound', async () => {
    const observed = await driveTurn(env.UNBOUNDED_TURN_PROBE, 'unbounded-1');

    expect(observed.steps).toBeGreaterThan(THINK_DEFAULT_MAX_STEPS);
    // The model's OWN stopping point, so the turn ended by choice rather than at
    // some further bound: the scripted tool-calling steps, plus the step that
    // answered.
    expect(observed.steps).toBe(TOOL_CALLING_STEPS + 1);
    expect(observed.lastFinishReason).toBe('stop');
    expect(observed.answered).toBe(true);
  });
});

/**
 * The other half: what the seal does with each of those turns.
 *
 * The ledger deliberately gained NO fourth reason for a cut turn — the vendor cap
 * was the only thing that could produce one, so a new word would have been
 * vocabulary no run could carry. What guards the state instead is a classified
 * defect raised inside `classifyRunEnd`, and this is the one place a REAL cut turn
 * exists to aim at it: the capped probe's own observed facts, unmodified.
 */
describe('what the seal makes of each of those turns', () => {
  it('a cut turn still seals as the driver saw it, and the facts reaching the seal are the impossible ones', async () => {
    const observed = await driveTurn(env.CAPPED_TURN_PROBE, 'capped-2');

    // `completed: true` is what Think reports for a turn its own stop condition
    // cut — which is exactly why the last step's finish reason has to travel with
    // it, and exactly what the tripwire in core reads.
    const facts = {
      completed: true,
      interrupted: false,
      lastFinishReason: observed.lastFinishReason ?? undefined,
    };
    expect(facts.lastFinishReason).toBe(TOOL_CALLS_PENDING);
    // The reason is unchanged: the classifier names what the driver observed, and
    // the defect is reported through diagnostics rather than as a user-facing
    // status. `packages/core/tests/unit-core-adapter-seams.test.ts` asserts the
    // diagnostic itself, where the sink is installable.
    expect(classifyRunEnd(facts)).toEqual({ reason: 'completed' });
  });

  it('a turn that reached its own end carries no pending work into the seal', async () => {
    const observed = await driveTurn(env.UNBOUNDED_TURN_PROBE, 'unbounded-2');

    expect(observed.lastFinishReason).not.toBe(TOOL_CALLS_PENDING);
    expect(classifyRunEnd({
      completed: true,
      interrupted: false,
      lastFinishReason: observed.lastFinishReason ?? undefined,
    })).toEqual({ reason: 'completed' });
  });
});
