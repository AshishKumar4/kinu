/**
 * The seam's own tests — the target-agnostic half, which is the half that has to
 * be right for a two-target suite to mean anything.
 *
 * THE CENTRAL CASE is `stepBoundEvidence` over the production signature.
 * `agent://SwarmNoopRootCause` measured four capped runs across two workspaces:
 * exactly ten `step_finish` rows, the last one's reason `tool-calls`, and
 * `run_end: 'completed'`. Nothing in the ledger distinguished that from a turn
 * that genuinely finished, which is why the defect shipped and why every suite
 * over it stayed green. So the reducer is tested BOTH directions on that exact
 * shape: it must flag the capped trail and must not flag the natural one.
 *
 * `ledgerTotalsFromEvents` is tested on the numbers the local harness's walk
 * produces, because the harness delegates to it and a reducer that quietly
 * counted differently would move every denominator in the corpus.
 *
 * The spend recorder is tested on what it COUNTS, because the thing it used to
 * refuse no longer exists: `workspaceSpend` aggregates over the whole log on both
 * targets, so `complete` and `windowLimit` left the read model and there is no
 * windowed total to refuse. What remains is the accounting a reader depends on —
 * an episode that accounted for nothing counts as UNMEASURED rather than as a
 * silent zero, two episodes accumulate into the one meter both arms report
 * through, and calls the provider never measured are counted apart from the
 * tokens.
 *
 * `probeVerifier` is tested BOTH directions on the shape that shipped broken. It
 * is the one instrument the two arms must run identically, which is why it lives
 * in the seam rather than in either target, and the failure it reproduces is a
 * shell that answers the command without printing the marker — exactly what the
 * deployed Nimbus `node` shim does to an `exec-ratio` harness.
 */
import { describe, expect, test } from 'bun:test';
import type { JsonObject, RunEvent, VFS, WorkspaceSpend } from '@kinu.run/core';

import {
  EVAL_BACKEND_ENV, ledgerTotalsFromEvents, probeVerifier, resolveEvalBackend,
  RUN_END_FAILURE_PREFIX, stepBoundEvidence, type EvalTargetWorkspace,
} from '../src/eval-target';
import { liveModelSpend, recordWorkspaceSpend, resetLiveModelSpend } from '../src/live-model';

/** The fake target's observable surface: what the probe wrote, what it ran. */
interface FakeWorkspace {
  workspace: EvalTargetWorkspace;
  written: Map<string, string>;
  commands: string[];
}

const RUN = 'run-test';
let nextIndex = 0;

/** One stamped event. The union is wide and only a few variants matter here, so
 *  the caller passes the discriminated body and this supplies the base fields
 *  every variant shares. */
function event(body: JsonObject): RunEvent {
  nextIndex += 1;
  // SAFETY: constructed below — each call site passes exactly one variant's own
  // fields beside its `type` discriminator, and this adds the three base fields
  // every `RunEvent` variant carries.
  return {
    ...body,
    runId: RUN,
    eventIndex: nextIndex,
    timestamp: new Date(1_700_000_000_000 + nextIndex * 1_000).toISOString(),
  } as RunEvent;
}

/** The exact production trail: ten steps, the last still calling tools, and a
 *  run that called itself completed. */
function cappedTrail(): RunEvent[] {
  nextIndex = 0;
  const events: RunEvent[] = [event({ type: 'turn_start', turnIndex: 0 })];
  for (let step = 0; step < 10; step += 1) {
    events.push(event({ type: 'tool_call_end', name: 'execute_tools', toolCallId: `tc-${String(step)}` }));
    events.push(event({ type: 'step_finish', stepIndex: step, reason: 'tool-calls' }));
  }
  events.push(event({ type: 'turn_end', usage: { input: 190_979, output: 6_016 } }));
  events.push(event({ type: 'run_end', reason: 'completed' }));
  return events;
}

/** The one naturally-finished run the same investigation found: five steps, last
 *  reason `stop`. */
function naturalTrail(): RunEvent[] {
  nextIndex = 0;
  const events: RunEvent[] = [event({ type: 'turn_start', turnIndex: 0 })];
  for (let step = 0; step < 4; step += 1) {
    events.push(event({ type: 'tool_call_end', name: 'read', toolCallId: `tc-${String(step)}` }));
    events.push(event({ type: 'step_finish', stepIndex: step, reason: 'tool-calls' }));
  }
  events.push(event({ type: 'step_finish', stepIndex: 4, reason: 'stop' }));
  events.push(event({ type: 'turn_end', usage: { input: 100, output: 20 } }));
  events.push(event({ type: 'run_end', reason: 'completed' }));
  return events;
}

describe('stepBoundEvidence — the divergence probe', () => {
  test('the production signature reads as truncated beside a `completed` run_end', () => {
    const evidence = stepBoundEvidence(cappedTrail());
    expect(evidence.steps).toBe(10);
    expect(evidence.lastStepReason).toBe('tool-calls');
    expect(evidence.runEndReasons).toEqual(['completed']);
    // The pair is the whole finding: `truncated` beside `completed` is a cut the
    // ledger reported as a completion. Either half alone is unremarkable.
    expect(evidence.truncated).toBe(true);
  });

  test('a turn that finished on its own is NOT flagged', () => {
    // The red direction. A probe that called every run truncated would pass the
    // case above while proving nothing — precisely how the assertion it replaces
    // (`UNBOUNDED_STEPS(impossibleInput) === false`) stayed true while
    // production was capped at ten.
    const evidence = stepBoundEvidence(naturalTrail());
    expect(evidence.steps).toBe(5);
    expect(evidence.lastStepReason).toBe('stop');
    expect(evidence.truncated).toBe(false);
  });

  test('an episode that closed no step says so rather than reporting a reason', () => {
    nextIndex = 0;
    const evidence = stepBoundEvidence([event({ type: 'run_end', reason: 'interrupted' })]);
    expect(evidence.steps).toBe(0);
    expect(evidence.lastStepReason).toBeNull();
    expect(evidence.truncated).toBe(false);
    expect(evidence.runEndReasons).toEqual(['interrupted']);
  });

  test('a run_end with no reason is named, not dropped', () => {
    nextIndex = 0;
    expect(stepBoundEvidence([event({ type: 'run_end' })]).runEndReasons).toEqual(['unstated']);
  });
});

describe('ledgerTotalsFromEvents — one reducer, both targets', () => {
  test('it counts turns, tool calls, steps and usage off the canonical union', () => {
    const totals = ledgerTotalsFromEvents(cappedTrail());
    expect(totals.turns).toBe(1);
    expect(totals.toolCalls).toBe(10);
    expect(totals.steps).toBe(10);
    expect(totals.tokensIn).toBe(190_979);
    expect(totals.tokensOut).toBe(6_016);
    expect(totals.toolNames).toEqual(Array<string>(10).fill('execute_tools'));
    expect(totals.failures).toEqual([]);
  });

  test('a failing tool call and a failing run both reach `failures`', () => {
    nextIndex = 0;
    const totals = ledgerTotalsFromEvents([
      event({ type: 'tool_call_end', name: 'run', toolCallId: 'tc-1', error: 'exit 127' }),
      event({ type: 'run_end', reason: 'error', error: 'provider refused' }),
    ]);
    // Named, because "0 tool calls" is equally consistent with a model that
    // declined to act and a provider that rejected every request, and a
    // degenerate run that cannot say which is a dead end for whoever reads it.
    expect(totals.failures).toEqual(['run: exit 127', 'run_end: provider refused']);
  });

  test('an empty ledger reports zeroes rather than throwing', () => {
    // The zero-denominator case. It must be reachable and readable: a suite
    // decides `inert` from these numbers, and a reducer that threw here would
    // turn an observation about the agent into a harness fault.
    expect(ledgerTotalsFromEvents([])).toEqual({
      turns: 0, toolCalls: 0, toolNames: [], tokensIn: 0, tokensOut: 0,
      reasoningOut: 0, steps: 0, failures: [],
    });
  });
});

describe('recordWorkspaceSpend — one meter, two readers', () => {
  const spendOf = (calls: number): WorkspaceSpend => ({
    producers: [],
    total: { calls, callsWithoutUsage: 0, usage: { input: 10, output: 2 }, unpricedCalls: 0 },
    coverage: { calls, measured: calls, reported: 1, silent: [], partial: [] },
    offTurnShare: null,
    missions: [],
  });

  test('a store that accounted for nothing counts as UNMEASURED, never a silent zero', () => {
    resetLiveModelSpend();
    recordWorkspaceSpend(spendOf(0));
    const spend = liveModelSpend();
    expect(spend.calls).toBe(0);
    // An episode that ran and cannot say what it cost is a hole in the
    // measurement and has to read as one. A zero recorded as a zero would make
    // "measured nothing" and "cost nothing" the same reading.
    expect(spend.episodesUnmeasured).toBe(1);
    resetLiveModelSpend();
  });

  test('two episodes accumulate into the same meter both arms report through', () => {
    // The local target computes its own `WorkspaceSpend` from the store it owns;
    // the cloud target reads one over RPC. This is the accumulator they share,
    // and sharing it is what stops the cloud arm growing a second definition of
    // what a workspace spent.
    resetLiveModelSpend();
    recordWorkspaceSpend(spendOf(3));
    recordWorkspaceSpend(spendOf(2));
    const spend = liveModelSpend();
    expect(spend.calls).toBe(5);
    expect(spend.usage.input).toBe(20);
    expect(spend.episodesUnmeasured).toBe(0);
    resetLiveModelSpend();
  });

  test('calls the provider never measured are counted apart from the tokens', () => {
    // `callsWithoutUsage` is why the tier can print "N call(s), usage
    // unreported" instead of a total that silently omits them. Unmeasured spend
    // is real spend.
    resetLiveModelSpend();
    recordWorkspaceSpend({
      ...spendOf(4),
      total: { calls: 4, callsWithoutUsage: 3, usage: { input: 10 }, unpricedCalls: 0 },
    });
    const spend = liveModelSpend();
    expect(spend.calls).toBe(4);
    expect(spend.callsWithoutUsage).toBe(3);
    expect(spend.episodesUnmeasured).toBe(0);
    resetLiveModelSpend();
  });
});

describe('resolveEvalBackend — the one knob', () => {
  test('an unset knob is local, because the cloud arm spends money', () => {
    expect(resolveEvalBackend({})).toEqual({ kind: 'ready', backend: 'local' });
    expect(resolveEvalBackend({ [EVAL_BACKEND_ENV]: '  ' })).toEqual({ kind: 'ready', backend: 'local' });
  });

  test('both target names resolve', () => {
    expect(resolveEvalBackend({ [EVAL_BACKEND_ENV]: 'local' })).toEqual({ kind: 'ready', backend: 'local' });
    expect(resolveEvalBackend({ [EVAL_BACKEND_ENV]: 'cloud' })).toEqual({ kind: 'ready', backend: 'cloud' });
  });

  test('a typo is REFUSED, never silently the free arm', () => {
    // A typo that quietly ran local would report a local measurement under a
    // cloud arm's banner, which is the class of error this seam removes.
    const refused = resolveEvalBackend({ [EVAL_BACKEND_ENV]: 'Cloud' });
    expect(refused.kind).toBe('refused');
    if (refused.kind !== 'refused') throw new Error('unreachable');
    expect(refused.reason).toContain(EVAL_BACKEND_ENV);
    expect(refused.reason).toContain('cloud');
  });
});

/**
 * A workspace whose shell answers whatever it is told to, and remembers what the
 * probe left behind.
 *
 * Only the members the probe touches are real; the rest throw, so a probe that
 * started reading something else would fail here rather than pass over a silent
 * default.
 */
function fakeWorkspace(reply: { stdout: string; exitCode: number }): FakeWorkspace {
  const written = new Map<string, string>();
  const commands: string[] = [];
  const unavailable = (member: string) => (): never => {
    throw new Error(`the probe read \`${member}\`, which it is not supposed to need`);
  };
  const vfs: VFS = {
    writeFile: (path, data) => {
      written.set(path, String(data));
      return Promise.resolve();
    },
    unlink: (path) => {
      written.delete(path);
      return Promise.resolve();
    },
    readFile: unavailable('readFile'),
    readdir: unavailable('readdir'),
    stat: unavailable('stat'),
    mkdir: unavailable('mkdir'),
    exists: unavailable('exists'),
  };
  return {
    written,
    commands,
    workspace: {
      vfs,
      exec: (command) => {
        commands.push(command);
        return Promise.resolve(reply);
      },
    },
  };
}

describe('probeVerifier — the one instrument both arms run', () => {
  test('a shell that prints the marker RUNS, and the module is cleaned up', async () => {
    const { workspace, written, commands } = fakeWorkspace({
      stdout: 'KINU_VERIFIER_PROBE_OK\n', exitCode: 0,
    });
    const probe = await probeVerifier(workspace);
    expect(probe.kind).toBe('runs');
    if (probe.kind !== 'runs') throw new Error('unreachable');
    // The evidence is what the shell SAID, so a reader can see which shell
    // answered rather than taking the verdict on trust.
    expect(probe.evidence).toBe('KINU_VERIFIER_PROBE_OK');
    // It writes a module and runs `node` on it, because that is the smallest
    // instance of what `exec-ratio` does.
    expect(commands).toEqual(['node _verifier_probe.mjs']);
    expect(written.size, 'the probe module must not outlive the probe').toBe(0);
  });

  test('a shell that answers WITHOUT the marker is unavailable, and says what it said', async () => {
    // THE PRODUCTION SHAPE. The deployed Nimbus `node` shim resolves
    // `esbuild-wasm` to its Node entrypoint, which rejects the `wasmModule`
    // option, so the transform fails and no RESULT line is printed. A probe that
    // asked whether a shell EXISTS answered yes throughout — this one refuses on
    // the verdict, which is the whole reason it runs the command.
    const { workspace } = fakeWorkspace({
      stdout: 'error: Cannot use "wasmModule" outside a browser\n', exitCode: 1,
    });
    const probe = await probeVerifier(workspace);
    expect(probe.kind).toBe('unavailable');
    if (probe.kind !== 'unavailable') throw new Error('unreachable');
    expect(probe.reason).toContain('exited 1');
    // The shell's own words survive: a refusal that hid the cause would trade one
    // unreadable failure for another.
    expect(probe.reason).toContain('wasmModule');
    expect(probe.reason).toContain("score:'verify'");
  });

  test('a shell that refuses the command outright is unavailable, never a throw', async () => {
    // A throw here would abort the arm before it could report WHY it cannot
    // measure, and "the verifier is unavailable" with no cause is not a remedy.
    const probe = await probeVerifier({
      vfs: fakeWorkspace({ stdout: '', exitCode: 0 }).workspace.vfs,
      exec: () => Promise.reject(new Error('no executor on this target')),
    });
    expect(probe.kind).toBe('unavailable');
    if (probe.kind !== 'unavailable') throw new Error('unreachable');
    expect(probe.reason).toContain('no executor on this target');
  });
});

describe('RUN_END_FAILURE_PREFIX — one spelling, producer and consumer', () => {
  test('the reducer stamps a turn error with the prefix the classifier reads', () => {
    nextIndex = 0;
    const totals = ledgerTotalsFromEvents([
      event({ type: 'tool_call_end', name: 'run', toolCallId: 'tc-1', error: 'exit 1' }),
      event({ type: 'run_end', reason: 'error', error: 'Internal Server Error' }),
    ]);
    // A TOOL failure is the agent's episode and carries the tool's name; the
    // TURN's own provider error carries this prefix, and the eval harness's
    // infra-vs-behaviour rule matches on it. Two literals would agree until one
    // of them changed.
    expect(totals.failures).toEqual([
      'run: exit 1',
      `${RUN_END_FAILURE_PREFIX}Internal Server Error`,
    ]);
  });
});
