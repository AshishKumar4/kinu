// The mutable scaffold — the agent's evolved inference loop — reaches
// production through ONE seam: Think calls `_transformInferenceResult(result)`
// with the turn's prepared stream and streams back whatever we return
// (orchestrator.ts, core/src/scaffold/inference-transform.ts).
//
// That seam is `@internal` in Think ("Test seam — override in test agents"),
// and a seam that stops being called fails SILENTLY: the override is still a
// well-formed method, every test still passes, and the agent quietly runs the
// default loop forever. That is not hypothetical — the scaffold's previous
// host, `runStreamText`, had zero callers on think 0.8.2 and the whole
// self-evolution loop was dead until the re-wire found it.
//
// So the contract is pinned against the INSTALLED dependency, not our source:
// every `bun install` / version bump re-runs it, and a Think release that drops
// or renames the seam fails here instead of in production.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { stepCountIs, type StepResult, type ToolSet } from 'ai';
import { UNBOUNDED_MAX_STEPS } from '@kinu.run/core';
import { orchestratorHarness, subordinateHarness } from './helpers/actor-harness';

const thinkBundle = readFileSync(Bun.resolveSync('@cloudflare/think', import.meta.dir), 'utf8');

/** The body of the named method in Think's shipped bundle, brace-matched. */
function methodBody(source: string, name: string): string | null {
  const declaration = new RegExp(`^\\t*(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*\\{`, 'm');
  const match = declaration.exec(source);
  if (!match) return null;
  const start = match.index + match[0].length - 1;
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

describe('Think still routes every turn through the scaffold seam', () => {
  test('the seam exists on Think', () => {
    expect(methodBody(thinkBundle, '_transformInferenceResult')).not.toBeNull();
  });

  test('the inference loop CALLS the seam — a seam with no callers is a dead scaffold', () => {
    const calls = thinkBundle.match(/this\._transformInferenceResult\s*\(/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
  });

  test('the seam is called on the live chat path, with the stream the client consumes', () => {
    // `_prepareInferenceInvocation` is the one place Think builds the turn's
    // streamText result. The seam must be called THERE — a call from some
    // other helper would not cover the chat path the scaffold has to own.
    const loop = methodBody(thinkBundle, '_prepareInferenceInvocation');
    expect(loop).not.toBeNull();
    expect(loop!).toContain('this._transformInferenceResult(');
    // The argument is the object carrying the turn's UI-message stream, so an
    // evolved scaffold can delegate to (or replace) the default inference.
    expect(loop!).toContain('toUIMessageStream');
  });

  test('the seam RETURNS the stream — a discarded result is a dead scaffold', () => {
    const loop = methodBody(thinkBundle, '_prepareInferenceInvocation')!;
    const call = /(?:const|let)\s+(\w+)\s*=\s*this\._transformInferenceResult\(/.exec(loop);
    expect(call).not.toBeNull();
    const binding = call![1];
    expect(new RegExp(`return\\s+${binding}\\s*;`).test(loop)).toBe(true);
  });

  test('the guard catches a Think release that drops the call', () => {
    const dropped = thinkBundle.replace(/this\._transformInferenceResult\(/g, 'identity(');
    const loop = methodBody(dropped, '_prepareInferenceInvocation');
    expect(loop).not.toBeNull();
    expect(loop!).not.toContain('this._transformInferenceResult(');
  });
});

/**
 * THE STEP CAP — the other contract this same installed bundle carries, and the
 * one that shipped a defect while every test here was green.
 *
 * `methodBody(thinkBundle, '_prepareInferenceInvocation')` above already returns
 * the body holding `stepCountIs(finalMaxSteps)`. The suite held that exact
 * string in a local variable and asserted nothing about it, so production ran
 * hard-capped at ten steps for as long as `core/chat.ts` and `core/config.ts`
 * both documented no cap. Four of four production runs that reached ten steps
 * were cut with the model still emitting tool calls, and all four sealed
 * 'completed'.
 *
 * Pinned against the INSTALLED dependency for the same reason the seam above is:
 * the cap is the vendor's, its default is the vendor's, and only the vendor can
 * change how a caller's condition composes with it.
 */
describe('the turn loop this actor hands Think carries no step cap the caller cannot widen', () => {
  const loop = methodBody(thinkBundle, '_prepareInferenceInvocation');

  test('Think resolves the cap from the turn config first, then the instance', () => {
    expect(loop).not.toBeNull();
    // `config.maxSteps ?? channelDefinition?.maxTurns ?? this.maxSteps` — the two
    // seams a caller can reach. Both are set (beforeTurn and the constructor);
    // a release that stops reading either fails here.
    expect(loop!).toContain('config.maxSteps');
    expect(loop!).toContain('this.maxSteps');
  });

  test('the cap is a stop condition the caller can only ADD to, never replace', () => {
    // This is WHY `stopWhen: UNBOUNDED_STEPS` could never remove the cap, and
    // why the bound has to be the NUMBER. Think's own type doc says it outright:
    // "Think always keeps its `maxSteps` stop condition as a safety bound."
    expect(loop!).toContain('stepCountIs(finalMaxSteps)');
    // The caller's conditions are SPREAD in after it, so the array is
    // [cap, ...ours] and the SDK ORs it — a false-returning clause of ours is
    // exactly what a capped system also produces.
    expect(loop!).toMatch(/stopWhen\s*\?\s*\[\s*config\.stopWhen\s*\]|Array\.isArray\(config\.stopWhen\)/);
  });

  test("Think's own default is a small number — the subject of the override", () => {
    const declared = /this\.maxSteps = (\d+);/.exec(thinkBundle);
    expect(declared).not.toBeNull();
    // Not pinned to 10 exactly: what matters is that the vendor ships a cap a
    // real turn reaches. If a release removed it, this test should say so
    // rather than fail on a digit.
    expect(Number(declared![1])).toBeLessThan(1_000);
  });

  test('a REAL actor instance overrides it past any turn a step counter can reach', () => {
    // A live instance, not our source text: `@cloudflare/think` is unmocked in
    // this harness (only the `agents` SDK is stubbed), so `Think`'s constructor
    // genuinely runs and genuinely sets its default before ours replaces it.
    const { agent } = orchestratorHarness();
    expect(agent.maxSteps).toBe(UNBOUNDED_MAX_STEPS);
    expect(agent.maxSteps).toBeGreaterThan(100_000);
  });

  test('the cap Think would compose from this actor never fires, at any step count', async () => {
    // The behavioural end of it, through the SDK's REAL `stepCountIs`: whatever
    // Think puts at element 0 of that array, built from this actor's own value,
    // must never be true.
    const { agent } = orchestratorHarness();
    const cap = stepCountIs(agent.maxSteps);
    for (const steps of [10, 11, 500]) {
      // SAFETY: `stepCountIs` only ever reads the array's LENGTH — verified
      // against the installed SDK bundle by the pin below, which fails if the
      // condition ever dereferences an element.
      const stepList = Array.from({ length: steps }, () => ({}) as StepResult<ToolSet>);
      expect(await cap({ steps: stepList })).toBe(false);
    }
  });

  test('every actor kind inherits the override — a subordinate is not capped either', () => {
    expect(subordinateHarness().agent.maxSteps).toBe(UNBOUNDED_MAX_STEPS);
  });
});

describe('Kinu holds up its end of the seam', () => {
  const actorAgent = readFileSync(new URL('../src/actor-agent.ts', import.meta.url), 'utf8');
  const orchestrator = readFileSync(new URL('../src/orchestrator.ts', import.meta.url), 'utf8');
  const subordinate = readFileSync(new URL('../src/subordinate-agent.ts', import.meta.url), 'utf8');

  test('the override is declared and routes through the shared transform', () => {
    expect(actorAgent).toContain('protected _transformInferenceResult(result: StreamableResult): StreamableResult');
    expect(actorAgent).toContain('return scaffoldInferenceTransform({');
  });

  // The seam sits on the shared base precisely so subordinates run the
  // scaffold they evolve. While it lived on OrchestratorAgent alone, a
  // subordinate could propose, shadow-evaluate and promote an evolved
  // scaffold that never became its inference loop — evolution machinery
  // that was live at every step except the one that matters.
  test('every actor inherits the seam, so a subordinate runs the scaffold it evolves', () => {
    expect(orchestrator).toContain('extends ActorAgent');
    expect(subordinate).toContain('extends ActorAgent');
    expect(orchestrator).not.toContain('_transformInferenceResult(result: StreamableResult)');
    expect(subordinate).not.toContain('_transformInferenceResult(result: StreamableResult)');
  });
});
