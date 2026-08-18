/**
 * WHY a tool call failed, attributed from the durable ledger alone.
 *
 * The question this file defends is the owner's: "why do the tool calls fail?"
 * A run reported 33 of 34 failures on the three tasks that mutate files or run a
 * failing test loop, and which tool and which action failed was not recoverable
 * from anything the run wrote down. Three independent causes, and each has a
 * case here:
 *
 *   1. THE ROW NAMED NO ACTION. `tool_call_end` carried no args, so a `file`
 *      failure was `file×1` — read, write and edit indistinguishable, and the
 *      one event that did carry args was emitted by nothing.
 *   2. A FAILED CALL COULD BE RECORDED AS CLEAN. Two independent paths: a tool
 *      reporting `success: false` with a nullish error was written as
 *      `error: ''`, which every reader's predicate treats as no error; and a
 *      tool that RETURNED a structured `{error}` body rather than throwing is a
 *      successful transport whose failure no text sniff could see.
 *   3. THE SPLIT DID NOT EXIST. A refusal the tool was RIGHT to make and a tool
 *      that broke were one number. On a repair task most of that number is the
 *      agent finding the broken test it was sent to find.
 *
 * Every case below is red without its fix and green with it, and the backend
 * asymmetry is pinned explicitly: the cf sink stores a structured tool output as
 * an object, the CLI sink renders it through `JSON.stringify` first, so the same
 * payload reaches the ledger in two shapes and an attribution that reads only
 * one is a per-backend false zero.
 */

import { describe, test, expect } from 'bun:test';
import { toolExecute } from '@proteus/test-utils';
import {
  buildBuiltinTools, censusToolFailures, classifyToolFailure,
  toolFailureKey, FAILURE_WITHOUT_ERROR,
} from '../src/index.js';
import { createRecordingLogger, type RecordingLogger } from '../src/obs/index.js';
import { parseJsonValue } from '../src/utils/json.js';
import { createTestRuntime } from './helpers.js';
import type { RunEvent } from '../src/events/types.js';
type ToolCallEnd = Extract<RunEvent, { type: 'tool_call_end' }>;

let nextIndex = 0;

/** One `tool_call_end` as the recorder stamps it. */
function call(row: Omit<ToolCallEnd, 'type' | 'eventIndex' | 'runId' | 'timestamp'>): ToolCallEnd {
  return {
    type: 'tool_call_end',
    eventIndex: nextIndex++,
    runId: 'run-1',
    timestamp: new Date(nextIndex * 1000).toISOString(),
    ...row,
  };
}

/** The cf shape: the tool's structured output, stored as an object. */
function cfResult(reason: string, error: string): ToolCallEnd['result'] {
  return { reason, error };
}

/** The CLI shape: the SAME output, rendered by `renderToolResult`. */
function cliResult(reason: string, error: string): ToolCallEnd['result'] {
  return JSON.stringify({ reason, error });
}

describe('a clean call is not a failure', () => {
  test('a successful call classifies as null, on both result shapes', () => {
    expect(classifyToolFailure(call({
      name: 'file', toolCallId: 't1', args: { action: 'read', path: 'src/a.ts' },
      result: 'export const a = 1;\n',
    }))).toBeNull();
    expect(classifyToolFailure(call({
      name: 'file', toolCallId: 't2', args: { action: 'write', path: 'src/a.ts' },
      result: { ok: true, path: 'src/a.ts', bytes: 20, action: 'created' },
    }))).toBeNull();
  });

  test('a command that exited zero is not a failure even when its output says "error"', () => {
    // The one false positive a prose sniff would produce, and the reason the
    // attribution reads the exit prefix rather than the word.
    expect(classifyToolFailure(call({
      name: 'run', toolCallId: 't1', args: { command: 'grep -c error build.log' },
      result: 'log line 12: Error (exit 1) was seen\n',
    }))).toBeNull();
  });

  test('an empty error is no error — the producer must never write one', () => {
    // The scorer contract, which is CORRECT: `error: ''` means the call did not
    // throw. The defect it exposed lives in the producer, which manufactured
    // exactly this from a nullish error; `unit-turn-accumulator.test.ts` pins
    // that side.
    expect(classifyToolFailure(call({ name: 'run', toolCallId: 't1', error: '' }))).toBeNull();
  });
});

describe('the action is attributed, not just the tool', () => {
  test('a `file` refusal names the action and the reason the tool computed', () => {
    const failure = classifyToolFailure(call({
      name: 'file', toolCallId: 't1',
      args: { action: 'edit', path: 'src/greet.ts' },
      result: cfResult('not_found', 'old_text was not found in src/greet.ts'),
    }));
    expect(failure).toEqual({
      tool: 'file', action: 'edit', reason: 'not_found', refused: true, workFailed: false, runtimeMissing: false,
    });
    // Before args were on the row this key was `file·not_found` at best and
    // `file×1` in practice — three actions collapsed into one bucket.
    expect(failure && toolFailureKey(failure)).toBe('file·edit·not_found');
  });

  test('the CLI JSON-string shape attributes identically to the cf object shape', () => {
    // The asymmetry that makes an attribution silently backend-specific: this is
    // the shape the eval tier actually produces, and it is a bare string to any
    // reader that only narrows to an object.
    const object = classifyToolFailure(call({
      name: 'file', toolCallId: 't1', args: { action: 'edit', path: 'a.ts' },
      result: cfResult('ambiguous', 'old_text appears 3 times in a.ts'),
    }));
    const string = classifyToolFailure(call({
      name: 'file', toolCallId: 't2', args: { action: 'edit', path: 'a.ts' },
      result: cliResult('ambiguous', 'old_text appears 3 times in a.ts'),
    }));
    expect(string).toEqual(object);
    expect(string?.reason).toBe('ambiguous');
  });

  test('a tool with no action reads without a null in its key', () => {
    const failure = classifyToolFailure(call({
      name: 'run', toolCallId: 't1', args: { command: 'bun test' },
      result: 'Error (exit 1)\n--- stdout ---\n1 fail\n',
    }));
    expect(failure?.action).toBeNull();
    expect(failure && toolFailureKey(failure)).toBe('run·exit_1');
  });

  test('a row whose args did not survive still attributes the tool and the reason', () => {
    // Absent args degrade the key, they do not break it — and the degradation is
    // visible as a null action rather than as the string "undefined".
    const failure = classifyToolFailure(call({
      name: 'file', toolCallId: 't1', result: cfResult('unread', 'a.ts has not been read here yet'),
    }));
    expect(failure).toEqual({
      tool: 'file', action: null, reason: 'unread', refused: true, workFailed: false, runtimeMissing: false,
    });
  });
});

describe('a refusal, a failing job, a missing runtime and a broken tool are four different facts', () => {
  test('every refusal reason the `file` tool can compute counts as refused', () => {
    for (const reason of [
      'empty_anchor', 'not_found', 'ambiguous', 'overlap', 'no_change',
      'unread', 'stale', 'bad_input',
    ]) {
      const failure = classifyToolFailure(call({
        name: 'file', toolCallId: 't1', args: { action: 'edit' },
        result: cfResult(reason, `refused: ${reason}`),
      }));
      expect(failure).toMatchObject({ reason, refused: true, workFailed: false });
    }
  });

  test('a missing path and a filesystem error are NOT refusals', () => {
    // The line that keeps the split honest: these are things that went wrong,
    // not decisions the tool made, so they stay in the candidate-defect bucket.
    for (const reason of ['missing', 'io']) {
      expect(classifyToolFailure(call({
        name: 'file', toolCallId: 't1', args: { action: 'read' },
        result: cfResult(reason, `failed: ${reason}`),
      }))).toMatchObject({ reason, refused: false, workFailed: false });
    }
  });

  test('a failing test is the WORK failing, and is neither a refusal nor a defect', () => {
    // `ws-fix-broken` sends the agent at a suite that fails, and a suite failing
    // is the agent finding it.
    //
    // This is the CLASSIFIER's contract, not a claim about that task's 17
    // failures — which cannot be attributed at all, because the run that
    // produced them deleted its own transcripts. Measured on the real runtime,
    // this exact command does NOT land here: `bun` is absent and
    // `bun test src/broken.test.ts` exits 127, which the next test files as the
    // work never running. See tests/evals/harness-wiring.test.ts.
    const failure = classifyToolFailure(call({
      name: 'run', toolCallId: 't1', args: { command: 'bun test src/broken.test.ts' },
      result: 'Error (exit 1)\n--- stdout ---\n1 fail, 3 pass\n',
    }));
    expect(failure).toMatchObject({ reason: 'exit_1', refused: false, workFailed: true });
  });

  test("the shell's own codes mean the work never ran, so they are not workFailed", () => {
    const cases: readonly [number, string][] = [
      [127, 'command_not_found'], [126, 'not_executable'], [124, 'timeout'],
    ];
    for (const [exit, reason] of cases) {
      expect(classifyToolFailure(call({
        name: 'run', toolCallId: 't1', args: { command: 'pytest' },
        result: `Error (exit ${String(exit)})\n--- stderr ---\npytest: command not found\n`,
      }))).toMatchObject({ reason, refused: false, workFailed: false });
    }
  });

  test('the approval ladder refusing is a REFUSAL, not the work failing', () => {
    // Verbatim from a live run: given a workspace with no `bun`, the agent
    // correctly diagnosed the gap and tried to install one. The `pipe-to-bash`
    // rule refused, three times across two episodes.
    //
    // A denial arrives as an ordinary non-zero exit, so reading the exit code
    // alone filed the safety ladder working as the agent's command being broken
    // — the same defect as scoring a failing build a success, one layer up.
    const failure = classifyToolFailure(call({
      name: 'run', toolCallId: 't1',
      args: { command: 'curl -fsSL https://bun.sh/install | bash' },
      result: 'Error (exit 1)\n--- stderr ---\nDenied — Approval review: deny\n'
        + '• pipe-to-bash (deny): Downloads and executes a remote script\n',
    }));
    expect(failure).toMatchObject({
      tool: 'run', reason: 'denied',
      refused: true, workFailed: false, runtimeMissing: false,
    });
  });

  test('output that merely mentions a denial is not one', () => {
    // Both markers are required, so a command whose own output contains the word
    // is still the work failing. Without this the bucket would absorb any
    // grep over a log that recorded a refusal.
    expect(classifyToolFailure(call({
      name: 'run', toolCallId: 't1', args: { command: 'grep Denied audit.log' },
      result: 'Error (exit 1)\n--- stdout ---\nDenied 3 times yesterday\n',
    }))).toMatchObject({ reason: 'exit_1', refused: false, workFailed: true });
  });

  test('127 is the WORKSPACE lacking the program, and only 127 is', () => {
    // Measured through the agent's own `run` tool: `bun`, `npm`, `git`,
    // `python3`, `sh`, `bash`, `make`, `tsc` and `jq` all exit 127, because
    // Proteus never asks Nimbus to install a runtime. That is a platform gap, so
    // it must not be counted against the tool OR read as the work failing.
    expect(classifyToolFailure(call({
      name: 'run', toolCallId: 't1', args: { command: 'bun test src/broken.test.ts' },
      result: 'Error (exit 127)\n--- stderr ---\nbun: command not found\n',
    }))).toMatchObject({
      reason: 'command_not_found', refused: false, workFailed: false, runtimeMissing: true,
    });

    // 126 is a DIFFERENT fact — the program is there and cannot be run — and 1
    // is the work. Neither is a missing runtime, or the bucket would absorb
    // every execution failure and stop meaning anything.
    for (const [exit, reason] of [[126, 'not_executable'], [1, 'exit_1']] as const) {
      expect(classifyToolFailure(call({
        name: 'run', toolCallId: 't2',
        result: `Error (exit ${String(exit)})\n--- stderr ---\nnope\n`,
      }))).toMatchObject({ reason, runtimeMissing: false });
    }
  });

  test('the four parts are disjoint and exhaustive', () => {
    // The property every published split relies on: a failure lands in exactly
    // one bucket, so the four numbers can be read as a decomposition rather than
    // as four overlapping rates.
    const census = censusToolFailures([
      call({ name: 'file', toolCallId: 't1', args: { action: 'edit' },
        result: cfResult('not_found', 'no anchor') }),
      call({ name: 'run', toolCallId: 't2', args: { command: 'node x.js' },
        result: 'Error (exit 1)\n' }),
      call({ name: 'run', toolCallId: 't3', args: { command: 'bun test' },
        result: 'Error (exit 127)\n--- stderr ---\nbun: command not found\n' }),
      call({ name: 'execute_tools', toolCallId: 't4', error: 'boom' }),
    ]);
    expect(census.failures).toHaveLength(4);
    expect({
      refused: census.refused, workFailed: census.workFailed,
      runtimeMissing: census.runtimeMissing, broke: census.broke,
    }).toEqual({ refused: 1, workFailed: 1, runtimeMissing: 1, broke: 1 });
    for (const f of census.failures) {
      expect([f.refused, f.workFailed, f.runtimeMissing].filter(Boolean).length)
        .toBeLessThanOrEqual(1);
    }
  });
});

describe('a failure cannot hide', () => {
  test('a tool that returned a structured error body is a failure on both backends', () => {
    // Measured: this shape scored a CLEAN 1/1 before the fix. The eval harness
    // ran a runtime with no executionRouter, so every `execute_tools` block
    // touching `workspace.*` failed exactly like this and was counted as a pass
    // — an overestimate of tool health, in the direction that flatters.
    const object = classifyToolFailure(call({
      name: 'execute_tools', toolCallId: 't1', args: { code: 'await workspace.createTool({})' },
      result: { error: 'workspace.createTool is not a function' },
    }));
    expect(object).toEqual({
      tool: 'execute_tools', action: null, reason: 'returned_error',
      refused: false, workFailed: false, runtimeMissing: false,
    });
    const string = classifyToolFailure(call({
      name: 'execute_tools', toolCallId: 't2', args: { code: 'await workspace.createTool({})' },
      result: JSON.stringify({ error: 'workspace.createTool is not a function' }),
    }));
    expect(string).toEqual({
      tool: 'execute_tools', action: null, reason: 'returned_error',
      refused: false, workFailed: false, runtimeMissing: false,
    });
    // `returned_error` and not `unclassified`: WHY is unknown but WHERE is not,
    // and the residual bucket must keep meaning "cannot explain this".
    expect(object?.reason).not.toBe('unclassified');
  });

  test('a bare error-looking string is deliberately NOT a failure', () => {
    // A decision, not an oversight. This shape carries no discriminator anywhere
    // in the system, and sniffing its prose would fire on any command whose
    // stdout mentions a missing function. The fix belongs at the seam that
    // decides what `success` means, not in a downstream sniff.
    expect(classifyToolFailure(call({
      name: 'execute_tools', toolCallId: 't1',
      result: 'workspace.createTool is not a function.',
    }))).toBeNull();
  });

  test('a tool that failed without saying why gets its own reason, not `threw`', () => {
    // The producer writes the sentinel; the census names it. Folded into `threw`
    // it would read as an ordinary exception, when it is a defect in the tool's
    // own contract.
    expect(classifyToolFailure(call({
      name: 'execute_tools', toolCallId: 't1', error: FAILURE_WITHOUT_ERROR,
    }))).toMatchObject({ reason: 'failed_without_error', refused: false, workFailed: false });
    expect(classifyToolFailure(call({
      name: 'web', toolCallId: 't2', error: 'fetch failed: ECONNREFUSED',
    }))).toMatchObject({ reason: 'threw', refused: false, workFailed: false });
  });

  test('a failure this cannot explain is reported as unclassified, never guessed', () => {
    const failure = classifyToolFailure(call({
      name: 'mystery', toolCallId: 't1', result: 'Error: something happened\n',
    }));
    expect(failure).toMatchObject({ reason: 'unclassified', refused: false, workFailed: false });
  });
});

describe('the census over a run', () => {
  test('counts by tool·action·reason, heaviest first, over FAILURES not calls', () => {
    // The histogram bug: built over every row, so the mix summed to the
    // denominator and described tool USAGE while sitting beside a failure rate.
    const rows = [
      call({ name: 'file', toolCallId: 't1', args: { action: 'read' }, result: 'ok\n' }),
      call({ name: 'file', toolCallId: 't2', args: { action: 'read' }, result: 'ok\n' }),
      call({ name: 'file', toolCallId: 't3', args: { action: 'read' }, result: 'ok\n' }),
      call({
        name: 'file', toolCallId: 't4', args: { action: 'edit' },
        result: cfResult('not_found', 'no match'),
      }),
      call({
        name: 'file', toolCallId: 't5', args: { action: 'edit' },
        result: cliResult('not_found', 'no match'),
      }),
      call({
        name: 'file', toolCallId: 't6', args: { action: 'write' },
        result: cfResult('unread', 'not read yet'),
      }),
      call({ name: 'run', toolCallId: 't7', args: { command: 'bun test' }, result: 'Error (exit 1)\nfail\n' }),
    ];
    const census = censusToolFailures(rows);
    expect(census.failures).toHaveLength(4);
    expect(census.byKey).toEqual([
      ['file·edit·not_found', 2],
      ['file·write·unread', 1],
      ['run·exit_1', 1],
    ]);
    // The three parts are disjoint and exhaust the failures: the refusals are
    // the contract working, the exit 1 is the agent finding a broken suite, and
    // nothing here is a defect.
    expect(census.refused).toBe(3);
    expect(census.workFailed).toBe(1);
    expect(census.broke).toBe(0);
    expect(census.refused + census.workFailed + census.broke).toBe(census.failures.length);
  });

  test('a call that both threw AND returned failing text is ONE failure', () => {
    // Summing two predicates double-counted it, which could drive a passed
    // count negative. One classification per row makes that unrepresentable.
    const census = censusToolFailures([call({
      name: 'run', toolCallId: 't1', error: 'exit 2', result: 'Error (exit 2)\nboom\n',
    })]);
    expect(census.failures).toHaveLength(1);
  });

  test('a clean run reports no failures and no mix', () => {
    const census = censusToolFailures([
      call({ name: 'file', toolCallId: 't1', args: { action: 'read' }, result: 'ok\n' }),
    ]);
    expect(census).toMatchObject({ byKey: [], refused: 0, workFailed: 0, broke: 0 });
    expect(census.failures).toHaveLength(0);
  });
});

describe('the classification the `run` tool actually produced reaches the reader', () => {
  /**
   * The vertical slice, end to end and with nothing hand-written in the middle:
   * the real `run` tool computes the refusal, the real payload crosses the ledger
   * in BOTH backend shapes, and the real reader attributes it.
   *
   * Before the classification existed this row was `returned_error` with
   * `refused: false` — filed in `broke`, the one bucket that is a candidate
   * defect. A runtime that Proteus never provisioned is a platform gap the agent
   * did nothing to cause, and it was being counted against the tool.
   */
  async function refuseEscalation(runtime: string): Promise<{
    payload: string;
    logger: RecordingLogger;
  }> {
    const { rt } = createTestRuntime();
    const logger = createRecordingLogger();
    const tools = buildBuiltinTools({ rt, logger });
    const run = { execute: toolExecute<{ command: string; runtime: string }, string>(tools.run) };
    return { payload: await run.execute({ command: 'pytest -q', runtime }), logger };
  }

  test('an unprovisioned runtime is `unavailable`, a platform gap, on both backends', async () => {
    const { payload } = await refuseEscalation('sandbox');
    for (const [backend, result] of [
      // The cf sink stores the tool's structured output as an object; the CLI sink
      // renders the SAME output through `JSON.stringify` first. Both are read, or
      // the attribution is a per-backend false zero.
      ['cf', parseJsonValue(payload)],
      ['cli', payload],
    ] as const) {
      const failure = classifyToolFailure(call({
        name: 'run', toolCallId: `t-${backend}`, args: { command: 'pytest -q' }, result,
      }));
      expect(failure).toMatchObject({
        tool: 'run',
        reason: 'unavailable',
        // Not the tool declining and not the work failing: the environment was
        // never there. Exactly where an exit 127 lands, for the same reason.
        refused: false,
        workFailed: false,
        runtimeMissing: true,
      });
    }
  });

  test('the refusal is counted as a runtime gap, not as a broken tool', async () => {
    const { payload } = await refuseEscalation('laptop');
    const census = censusToolFailures([call({
      name: 'run', toolCallId: 't1', args: { command: 'pytest -q' }, result: payload,
    })]);
    expect({
      refused: census.refused, workFailed: census.workFailed,
      runtimeMissing: census.runtimeMissing, broke: census.broke,
    }).toEqual({ refused: 0, workFailed: 0, runtimeMissing: 1, broke: 0 });
    expect(census.byKey).toEqual([['run·unavailable', 1]]);
  });

  test('the same decision is logged under a stable dotted event name', async () => {
    // The log and the ledger row are two readers of ONE classification. A log line
    // that said something the row did not would be a second source of truth.
    const { logger } = await refuseEscalation('sandbox');
    expect(logger.emitted).toEqual([{
      event: 'run.escalation_refused',
      code: 'unavailable',
      cause: 'runtime_not_provisioned',
      fields: { runtime: 'sandbox' },
    }]);
  });

  test('a shell-less workspace is `unsupported`, which is a different fact', async () => {
    // `unavailable` retries and `unsupported` does not, so pooling them would read
    // a permanent capability gap as a cold start.
    const { rt } = createTestRuntime();
    const logger = createRecordingLogger();
    const tools = buildBuiltinTools({ rt: { ...rt, shell: undefined }, logger });
    const run = { execute: toolExecute<{ command: string }, string>(tools.run) };
    const payload = await run.execute({ command: 'pytest -q' });
    expect(classifyToolFailure(call({
      name: 'run', toolCallId: 't1', args: { command: 'pytest -q' }, result: payload,
    }))).toMatchObject({
      reason: 'unsupported', refused: true, workFailed: false, runtimeMissing: false,
    });
    expect(logger.emitted.map((line) => line.event)).toEqual(['run.shell_absent']);
  });
});
