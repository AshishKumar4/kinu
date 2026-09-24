/**
 * `stepBoundEvidence` is tested both ways on the production signature: ten `step_finish` rows,
 * the last `tool-calls`, and `run_end: 'completed'`. `probeVerifier` is tested both ways on a
 * shell that answers without printing the marker, as the deployed Nimbus `node` shim does.
 */
import { describe, expect, test } from 'bun:test';
import type { RunEvent, VFS, WorkspaceSpend } from '@kinu.run/core';

import {
  EVAL_BACKEND_ENV, ledgerTotalsFromEvents, probeVerifier, resolveEvalBackend,
  RUN_END_FAILURE_PREFIX, stepBoundEvidence, type EvalTargetWorkspace,
} from '../src/eval-target';
import { liveModelSpend, recordNoModelEpisode, recordWorkspaceSpend, resetLiveModelSpend } from '../src/live-model';

/** The fake target's observable surface: what the probe wrote, what it ran. */
interface FakeWorkspace {
  workspace: EvalTargetWorkspace;
  written: Map<string, string>;
  commands: string[];
}

const RUN = 'run-test';

let nextIndex = 0;

/** Distributed over the union so each variant keeps its own shape. */
type EventBody<Variant = RunEvent> = Variant extends RunEvent
  ? Omit<Variant, 'runId' | 'eventIndex' | 'timestamp'>
  : never;

/** Supplies the base fields every variant shares. */
function event(body: EventBody): RunEvent {
  nextIndex += 1;

  return {
    ...body,
    runId: RUN,
    eventIndex: nextIndex,
    timestamp: new Date(1_700_000_000_000 + nextIndex * 1_000).toISOString(),
  };
}

/** The production trail: ten steps, the last still calling tools, run reported completed. */
function cappedTrail(): RunEvent[] {
  nextIndex = 0;
  const events: RunEvent[] = [event({ type: 'turn_start', turnIndex: 0 })];

  for (let step = 0; step < 10; step += 1) {
    events.push(event({ type: 'tool_call_end', name: 'eval', toolCallId: `tc-${String(step)}` }));
    events.push(event({ type: 'step_finish', stepIndex: step, reason: 'tool-calls' }));
  }

  events.push(event({ type: 'turn_end', turnIndex: 0, usage: { input: 190_979, output: 6_016 } }));
  events.push(event({ type: 'run_end', reason: 'completed' }));

  return events;
}

/** A naturally finished run: five steps, last reason `stop`. */
function naturalTrail(): RunEvent[] {
  nextIndex = 0;
  const events: RunEvent[] = [event({ type: 'turn_start', turnIndex: 0 })];

  for (let step = 0; step < 4; step += 1) {
    events.push(event({ type: 'tool_call_end', name: 'read', toolCallId: `tc-${String(step)}` }));
    events.push(event({ type: 'step_finish', stepIndex: step, reason: 'tool-calls' }));
  }

  events.push(event({ type: 'step_finish', stepIndex: 4, reason: 'stop' }));
  events.push(event({ type: 'turn_end', turnIndex: 0, usage: { input: 100, output: 20 } }));
  events.push(event({ type: 'run_end', reason: 'completed' }));

  return events;
}

describe('stepBoundEvidence — the divergence probe', () => {
  test('the production signature reads as truncated beside a `completed` run_end', () => {
    const evidence = stepBoundEvidence(cappedTrail());
    expect(evidence.steps).toBe(10);
    expect(evidence.lastStepReason).toBe('tool-calls');
    expect(evidence.runEndReasons).toEqual(['completed']);
    // `truncated` beside `completed` is the finding; either alone is unremarkable.
    expect(evidence.truncated).toBe(true);
  });

  test('a turn that finished on its own is NOT flagged', () => {
    // Red direction: a probe calling every run truncated would pass the case above.
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
    expect(totals.toolNames).toEqual(Array<string>(10).fill('eval'));
    expect(totals.failures).toEqual([]);
  });

  test('a failing tool call and a failing run both reach `failures`', () => {
    nextIndex = 0;

    const totals = ledgerTotalsFromEvents([
      event({ type: 'tool_call_end', name: 'shell', toolCallId: 'tc-1', error: 'exit 127' }),
      event({ type: 'run_end', reason: 'error', error: 'provider refused' }),
    ]);

    // Named: "0 tool calls" fits both a declining model and a provider rejecting every request.
    expect(totals.failures).toEqual(['shell: exit 127', 'run_end: provider refused']);
  });

  test('typed outcomes control failure while reported diagnostics stay intact', () => {
    const totals = ledgerTotalsFromEvents([
      event({ type: 'tool_call_end', name: 'shell', toolCallId: 'success', outcome: { success: true }, error: 'stale error' }),
      event({ type: 'tool_call_end', name: 'shell', toolCallId: 'failed', outcome: { success: false, reason: 'io', execution: { exitCode: 7 } }, error: 'test command failed with useful details' }),
      event({ type: 'tool_call_end', name: 'shell', toolCallId: 'untyped', error: 'a bare error string, no outcome' }),
    ]);

    expect(totals.failures).toEqual(['shell: test command failed with useful details', 'shell: a bare error string, no outcome']);
  });

  test('an empty ledger reports zeroes rather than throwing', () => {
    // The zero-denominator case must be readable: a suite decides `inert` from these numbers.
    expect(ledgerTotalsFromEvents([])).toEqual({
      turns: 0, toolCalls: 0, toolNames: [], tokensIn: 0, tokensOut: 0,
      reasoningOut: 0, steps: 0, failures: [],
    });
  });
});

describe('recordWorkspaceSpend — one meter, two readers', () => {
  const spendOf = (calls: number): WorkspaceSpend => ({
    producers: [],
    total: {
      calls, callsWithoutUsage: 0, usage: { input: 10, output: 2 },
      unpricedCalls: 0, floorPricedCalls: 0,
    },
    coverage: { calls, measured: calls, reported: 1, silent: [], partial: [] },
    offTurnShare: null,
    missions: [],
    accounts: [],
  });

  test('a store that accounted for nothing counts as UNMEASURED, never a silent zero', () => {
    resetLiveModelSpend();
    recordWorkspaceSpend(spendOf(0));
    const spend = liveModelSpend();
    expect(spend.calls).toBe(0);
    // An episode that cannot say what it cost reads as unmeasured, not as zero.
    expect(spend.episodesUnmeasured).toBe(1);
    resetLiveModelSpend();
  });

  test('an episode declared to drive no model is a measured zero, and one that spent is refused', () => {
    // Model-free cases declare it, making their zero a measurement; a declaration the store
    // contradicts is the case's own defect.
    resetLiveModelSpend();
    recordNoModelEpisode(spendOf(0));
    expect(liveModelSpend()).toMatchObject({ calls: 0, episodesUnmeasured: 0, episodesWithoutModel: 1 });
    expect(() => recordNoModelEpisode(spendOf(2))).toThrow('declared');
    expect(liveModelSpend().episodesWithoutModel).toBe(1);
    resetLiveModelSpend();
  });

  test('two episodes accumulate into the same meter both arms report through', () => {
    // Local and cloud targets share this accumulator: one definition of workspace spend.
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
    // `callsWithoutUsage` lets the tier print "N call(s), usage unreported" instead of omitting them.
    resetLiveModelSpend();
    recordWorkspaceSpend({
      ...spendOf(4),
      total: {
        calls: 4, callsWithoutUsage: 3, usage: { input: 10 },
        unpricedCalls: 0, floorPricedCalls: 0,
      },
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
    // A typo that ran local would report a local measurement under a cloud banner.
    const refused = resolveEvalBackend({ [EVAL_BACKEND_ENV]: 'Cloud' });
    expect(refused.kind).toBe('refused');

    if (refused.kind !== 'refused') throw new Error('unreachable');
    expect(refused.reason).toContain(EVAL_BACKEND_ENV);
    expect(refused.reason).toContain('cloud');
  });
});

/**
 * Only the members the probe touches are real; the rest throw, so a new read fails instead
 * of passing over a default.
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
    // The evidence is the shell's output, so a reader sees which shell answered.
    expect(probe.evidence).toBe('KINU_VERIFIER_PROBE_OK');
    // `node` on a written module is the smallest instance of `exec-ratio`.
    expect(commands).toEqual(['node _verifier_probe.mjs']);
    expect(written.size, 'the probe module must not outlive the probe').toBe(0);
  });

  test('a shell that answers WITHOUT the marker is unavailable, and says what it said', async () => {
    // Production shape: the Nimbus `node` shim resolves `esbuild-wasm` to its Node entry, which
    // rejects `wasmModule`, so no RESULT line prints.
    const { workspace } = fakeWorkspace({
      stdout: 'error: Cannot use "wasmModule" outside a browser\n', exitCode: 1,
    });

    const probe = await probeVerifier(workspace);
    expect(probe.kind).toBe('unavailable');

    if (probe.kind !== 'unavailable') throw new Error('unreachable');
    expect(probe.reason).toContain('exited 1');
    // The shell's own words survive in the refusal.
    expect(probe.reason).toContain('wasmModule');
    expect(probe.reason).toContain("score:'verify'");
  });

  test('a shell that refuses the command outright is unavailable, never a throw', async () => {
    // No throw: the arm must be able to report why it cannot measure.
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
      event({ type: 'tool_call_end', name: 'shell', toolCallId: 'tc-1', error: 'exit 1' }),
      event({ type: 'run_end', reason: 'error', error: 'Internal Server Error' }),
    ]);

    // Tool failures carry the tool name; the turn's provider error carries this prefix, which the
    // harness's infra-vs-behaviour rule matches.
    expect(totals.failures).toEqual([
      'shell: exit 1',
      `${RUN_END_FAILURE_PREFIX}Internal Server Error`,
    ]);
  });
});
