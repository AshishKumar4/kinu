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
import * as v from 'valibot';
import { toolExecute } from '@proteus/test-utils';
import {
  buildBuiltinTools, censusToolFailures, classifyToolFailure,
  toolFailureKey, FAILURE_WITHOUT_ERROR,
  createDeviceTunnelExecutor, createInlineExecutor, createNimbusExecutor,
  createParentExecutor, createSandboxExecutor,
  DefaultExecutionRouter, isFailingResultText,
  type ExecutorProvider, type ToolFailureCensus,
} from '../src/index';
import {
  classifyErrorCode, createRecordingLogger, ERROR_CODES, ProteusError,
  type ErrorCode, type RecordingLogger,
} from '../src/obs/index';
import { refusalText } from '../src/execution/exec-result';
import { JsonObjectSchema, parseJsonValue } from '../src/utils/json';
import { createTestRuntime } from './helpers';
import type { RunEvent } from '../src/events/types';
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

/** The four disjoint parts, by name. */
type CensusPart = 'refused' | 'workFailed' | 'runtimeMissing' | 'broke';

/**
 * WHICH PART OF THE SPLIT EACH CLASS LANDS IN.
 *
 * The five executor tools now classify their own failures, and a code that lands
 * work in the wrong part of this census is worse than no code at all: the census
 * is published as four numbers and somebody quotes them. So the code→part mapping
 * is asserted here as a TOTAL table over `ErrorCode` — a new code cannot be added
 * without a verdict, the same way `CODE_IS_REFUSAL` forces one — and then proven
 * on the payloads the real executors really produce.
 *
 * The invariant behind the table, and the reason nothing maps to `workFailed`: a
 * classified refusal always means the work did NOT run. The work running and
 * failing arrives as an ordinary successful result prefixed `Error (exit N)` and
 * is read off the exit code, never off a class.
 */
const PART_BY_CODE = {
  // The tool established that proceeding would be wrong and declined.
  bad_input: 'refused',
  denied: 'refused',
  unsupported: 'refused',
  // The environment the call addressed is not there. A platform gap: Proteus never
  // provisioned it, so it is neither a defect nor the work.
  unavailable: 'runtimeMissing',
  // Nothing decided these and nothing here proves the environment was absent, so
  // they stay in the residual — the only part that is a candidate defect.
  missing: 'broke',
  timeout: 'broke',
  cancelled: 'broke',
  oom: 'broke',
  io: 'broke',
} satisfies Readonly<Record<ErrorCode, CensusPart>>;

/** The four counts, so a wrong part fails on the OTHER three too rather than on a
 *  single boolean that happened to be false for two different reasons. */
function parts(census: ToolFailureCensus) {
  return {
    refused: census.refused, workFailed: census.workFailed,
    runtimeMissing: census.runtimeMissing, broke: census.broke,
  };
}

function onlyPart(part: CensusPart) {
  return { refused: 0, workFailed: 0, runtimeMissing: 0, broke: 0, [part]: 1 };
}

describe('every error class lands in exactly one part of the census', () => {
  test('the code→part mapping is total, and no class is ever the work failing', () => {
    // Total by construction: `PART_BY_CODE` is `satisfies Record<ErrorCode, …>`, so
    // this loop covers the whole vocabulary and a new code fails to compile above
    // rather than silently skipping the assertion below.
    expect(Object.keys(PART_BY_CODE).sort()).toEqual([...ERROR_CODES].sort());

    for (const code of ERROR_CODES) {
      const census = censusToolFailures([call({
        name: 'run', toolCallId: `t-${code}`, args: { command: 'pytest -q' },
        result: refusalText(new ProteusError(code, `refused: ${code}`)),
      })]);
      expect(census.failures).toHaveLength(1);
      expect(parts(census)).toEqual(onlyPart(PART_BY_CODE[code]));
      // Never `workFailed`: a class means the work did not run. The work failing
      // is an exit code, and conflating them would report a refusal as a finding.
      expect(census.workFailed).toBe(0);
    }
  });

  test('the parts still sum to the failures, over the whole vocabulary at once', () => {
    const census = censusToolFailures(ERROR_CODES.map((code) => call({
      name: 'run', toolCallId: `t-${code}`, args: { command: 'pytest -q' },
      result: refusalText(new ProteusError(code, `refused: ${code}`)),
    })));
    expect(census.failures).toHaveLength(ERROR_CODES.length);
    expect(census.refused + census.workFailed + census.runtimeMissing + census.broke)
      .toBe(census.failures.length);
    for (const f of census.failures) {
      expect([f.refused, f.workFailed, f.runtimeMissing].filter(Boolean).length)
        .toBeLessThanOrEqual(1);
    }
  });
});

/**
 * THE FIVE EXECUTOR TOOLS, on the payloads they really produce.
 *
 * Read through the real `run` tool wherever `run` can reach the executor, because
 * that is the seam that writes the durable row: `run` calls `provider.tools.exec`,
 * decides the escalation outcome from `isFailingResultText`, and hands the text on
 * as the tool result the ledger stores.
 *
 * What every case here would have shown before the conversion: `null`. Prose like
 * `exec error: …` or `No device connected.` is not a failure to
 * `isFailingResultText`, so the escalation was recorded `ok` and the census never
 * saw the call at all. A platform condition read as SUCCESS is worse than one read
 * as a defect, because nobody goes looking for it.
 */
describe('each executor tool files its own failure in the right part', () => {
  async function escalate(provider: ExecutorProvider, command = 'pytest -q'): Promise<string> {
    const { rt } = createTestRuntime();
    const router = new DefaultExecutionRouter();
    router.register(provider);
    const tools = buildBuiltinTools({ rt: { ...rt, executionRouter: router } });
    const run = { execute: toolExecute<{ command: string; runtime: string }, string>(tools.run) };
    return run.execute({ command, runtime: provider.name });
  }

  function censusOf(payload: string): ToolFailureCensus {
    return censusToolFailures([call({
      name: 'run', toolCallId: 'tc-1', args: { command: 'pytest -q' }, result: payload,
    })]);
  }

  test('sandbox: an unconfigured binding is a platform gap, not a broken tool', async () => {
    // The stub the router really registers when the binding is absent
    // (cf-backend/src/runtime.ts:509,512) — so this is the deployed shape, not a
    // hypothetical one.
    const census = censusOf(await escalate(createSandboxExecutor()));
    expect(census.byKey).toEqual([['run·unavailable', 1]]);
    expect(parts(census)).toEqual(onlyPart('runtimeMissing'));
  });

  test('sandbox: admission control that outlived its retries is also a platform gap', async () => {
    // 429 on the container start-rate burst. `withSandboxRetry` has already spent
    // three attempts, so what reaches the census is a container Proteus could not
    // get — `unavailable`. Filed `io` it would have been a candidate defect in
    // this tool, which is the platform's capacity ceiling wearing our name.
    const census = censusOf(await escalate(createSandboxExecutor({
      exec: async () => { throw new Error('Too many containers per second'); },
      readFile: async () => ({}), writeFile: async () => {}, listFiles: async () => ({ files: [] }),
      deleteFile: async () => {}, exposePort: async () => ({ url: '', port: 0 }),
      unexposePort: async () => {}, getExposedPorts: async () => [],
    })));
    expect(census.byKey).toEqual([['run·unavailable', 1]]);
    expect(parts(census)).toEqual(onlyPart('runtimeMissing'));
  }, 10_000);

  test('sandbox: a transport fault is NOT a platform gap', async () => {
    // The contrast that makes the case above mean something. Both used to be one
    // prose string; pooling them would put every container fault in the bucket
    // that says "Proteus never provisioned this".
    const census = censusOf(await escalate(createSandboxExecutor({
      exec: async () => { throw new Error('the container hung up mid-write'); },
      readFile: async () => ({}), writeFile: async () => {}, listFiles: async () => ({ files: [] }),
      deleteFile: async () => {}, exposePort: async () => ({ url: '', port: 0 }),
      unexposePort: async () => {}, getExposedPorts: async () => [],
    })));
    expect(census.byKey).toEqual([['run·io', 1]]);
    expect(parts(census)).toEqual(onlyPart('broke'));
  });

  test('nimbus: an absent binding is a platform gap; a narrow handle is a refusal', async () => {
    const absent = censusOf(await escalate(createNimbusExecutor()));
    expect(absent.byKey).toEqual([['run·unavailable', 1]]);
    expect(parts(absent)).toEqual(onlyPart('runtimeMissing'));

    // `unsupported` and therefore `refused`: this deployment's handle has no
    // `runCode`, retrying cannot grow one, and declining is the correct outcome.
    // The two codes are the retry/permanent line, and the census reads them as
    // two different findings — which is the whole reason both exist.
    const narrow = createNimbusExecutor({
      box: { ready: async () => {},
        exec: async () => ({ command: 'noop', success: true, exitCode: 0, stdout: '', stderr: '' }),
        files: { read: async () => '', write: async () => {}, list: async () => [], exists: async () => true,
          delete: async () => {} } },
    });
    const refusal = String(await narrow.tools.runCode.execute('print(1)'));
    const census = censusOf(refusal);
    expect(census.byKey).toEqual([['run·unsupported', 1]]);
    expect(parts(census)).toEqual(onlyPart('refused'));
  });

  test('laptop: no device attached is a platform gap, and it used to be invisible', async () => {
    const payload = await escalate(createDeviceTunnelExecutor({
      rpc: async () => { throw new Error('no device connected'); },
      status: () => ({ connected: false, registered: true }),
      refreshStatus: async () => ({ connected: false, registered: true }),
    }));
    // The regression this locks: the old prose was read as a SUCCESSFUL call, so
    // the census counted nothing at all here.
    expect(isFailingResultText(payload)).toBe(true);
    const census = censusOf(payload);
    expect(census.byKey).toEqual([['run·unavailable', 1]]);
    expect(parts(census)).toEqual(onlyPart('runtimeMissing'));
    // And the instruction the user needs survives inside the payload.
    expect(payload).toContain('proteus connect');
  });

  test('parent: the errno the parent raised is the class, and it is not re-guessed', async () => {
    // This executor writes no reason of its own, on purpose: `makeVfsError` puts
    // the parent's code on the error and the classifier reads errnos, so ENOENT
    // arrives as `missing` without parent.ts naming anything. Adding a code here
    // would have added one whose value never varies.
    const census = censusOf(await escalate(createParentExecutor({
      handle: {
        read: async () => ({ ok: false, error: { code: 'ENOENT', message: 'no such file', path: '/p' } }),
        write: async () => ({ ok: false, error: { code: 'ENOENT', message: 'no such file', path: '/p' } }),
        list: async () => ({ ok: false, error: { code: 'ENOENT', message: 'no such file', path: '/p' } }),
        stat: async () => ({ ok: false, error: { code: 'ENOENT', message: 'no such file', path: '/p' } }),
        delete: async () => ({ ok: false, error: { code: 'ENOENT', message: 'no such file', path: '/p' } }),
        exec: async () => ({ ok: false, error: { code: 'ENOENT', message: 'no such shell', path: '/p' } }),
      },
    })));
    expect(census.byKey).toEqual([['run·missing', 1]]);
    expect(parts(census)).toEqual(onlyPart('broke'));
  });

  test('parent: an aborted exec ends as `cancelled`, which it could not before', async () => {
    // The signal was parsed and dropped, so this executor's exec had no way to end
    // as `cancelled` at all — one class of the nine was unreachable on one of the
    // five tools, and a caller could not tell a cancelled wait from a dead parent.
    const controller = new AbortController();
    const provider = createParentExecutor({
      handle: {
        read: async () => ({ ok: true, value: new Uint8Array() }),
        write: async () => ({ ok: true, value: null }),
        list: async () => ({ ok: true, value: [] }),
        stat: async () => ({ ok: true, value: null }),
        delete: async () => ({ ok: true, value: null }),
        exec: () => new Promise(() => { /* the parent never answers */ }),
      },
    });
    const pending = provider.tools.exec.execute('sleep 9999', { signal: controller.signal });
    controller.abort();
    let raised: unknown;
    try { await pending; } catch (err) { raised = err; }
    expect(classifyErrorCode({ cause: raised })).toBe('cancelled');
  });

  test('workspace: the inline plane refuses with a class its own caller can read', async () => {
    // `run` never reaches this tool — the workspace branch calls `rt.shell`
    // directly — so what the classification buys here is the OTHER caller:
    // LLM-generated code inside `execute_tools`, which can now branch on `reason`
    // instead of matching prose, and a block reader that can see a failure at all.
    const { rt } = createTestRuntime();
    const workspace = createInlineExecutor({
      vfs: rt.storage.vfs, memory: rt.memory, craftStore: rt.craftStore,
      shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    });
    const payload = String(await workspace.tools.exec.execute(42));
    expect(isFailingResultText(payload)).toBe(true);
    expect(parseJsonValue(payload)).toEqual({
      reason: 'bad_input', error: 'workspace.exec: command must be a string',
    });
    expect(parts(censusOf(payload))).toEqual(onlyPart('refused'));
  });

  test('workspace: the misevolution gate working is a refusal, not a defect', async () => {
    // Measured shape of the bug this class removes: the veto answered
    // `{ ok: false, error }` with no reason, so the census read `returned_error`
    // and filed the gate DOING ITS JOB under `broke`.
    const { rt } = createTestRuntime();
    const workspace = createInlineExecutor({
      vfs: rt.storage.vfs, memory: rt.memory, craftStore: rt.craftStore,
      shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    });
    const vetoed = await workspace.tools.createTool.execute(
      'promote', 'promotes itself', 'async () => sql`UPDATE scaffold_versions SET status = "live"`',
    );
    expect(vetoed).toMatchObject({ ok: false, reason: 'denied' });
    const census = censusToolFailures([call({
      name: 'execute_tools', toolCallId: 'tc-1', args: { code: 'workspace.createTool(...)' },
      result: v.parse(JsonObjectSchema, vetoed),
    })]);
    expect(census.byKey).toEqual([['execute_tools·denied', 1]]);
    expect(parts(census)).toEqual(onlyPart('refused'));
  });
});
