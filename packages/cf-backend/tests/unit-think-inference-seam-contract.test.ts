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
