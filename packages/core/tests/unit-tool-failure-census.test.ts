/**
 * Why a tool call failed, attributed from the durable ledger alone. The cf sink stores structured output as an
 * object and the CLI sink as JSON text, so attribution must read both shapes.
 */

import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';
import { toolExecute } from '@kinu.run/test-utils';
import {
  buildBuiltinTools, censusToolFailures, classifyToolFailure,
  toolFailureKey, FAILURE_WITHOUT_ERROR,
  createDeviceTunnelExecutor, createInlineExecutor, createNimbusExecutor,
  createParentExecutor, createSandboxExecutor,
  DefaultExecutionRouter,
  type ExecutorProvider, type SandboxHandle, type ToolFailureCensus, ToolOutcomeSchema, failedToolOutcome,
} from '../src/index';
import {
  classifyErrorCode, createRecordingLogger, ERROR_CODES, KinuError,
  type ErrorCode, type RecordingLogger, renderThrownChain,
} from '../src/obs/index';
import { refusalText } from '../src/execution/exec-result';
import { JsonObjectSchema } from '../src/utils/json';
import { createTestRuntime, storesFor } from './helpers';
import type { RunEvent } from '../src/events/types';
import { sandboxHandleLifecycle } from './helpers/sandbox-handle-lifecycle';

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

async function recordInvocation(pending: Promise<string>): Promise<ToolCallEnd> {
  try {
    const result = await pending;

    return call({ name: 'shell', toolCallId: 'native', result, outcome: { success: true } });
  } catch (cause) {
    return call({ name: 'shell', toolCallId: 'native', error: renderThrownChain({ cause }), outcome: failedToolOutcome({ cause }) });
  }
}

/** The cf shape: the tool's structured output, stored as an object. */
function cfResult(reason: string, error: string): ToolCallEnd['result'] {
  return { reason, error };
}

/** The CLI shape: the same output, rendered by `renderToolResult`. */
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
    // The false positive a prose sniff would produce; attribution reads the exit prefix, not the word.
    expect(classifyToolFailure(call({
      name: 'shell', toolCallId: 't1', args: { command: 'grep -c error build.log' },
      result: 'log line 12: Error (exit 1) was seen\n',
    }))).toBeNull();
  });

  test('an empty error is no error — the producer must never write one', () => {
    // `error: ''` means the call did not throw; the producer side is pinned in `unit-turn-accumulator.test.ts`.
    expect(classifyToolFailure(call({ name: 'shell', toolCallId: 't1', error: '' }))).toBeNull();
  });
});

describe('the action is attributed, not just the tool', () => {
  test('a `file` refusal names the action and the reason the tool computed', () => {
    const failure = classifyToolFailure(call({
      name: 'file', toolCallId: 't1',
      args: { action: 'edit', path: 'src/greet.ts' },
      outcome: { success: false, reason: 'not_found' }, result: cfResult('not_found', 'old_text was not found in src/greet.ts'),
    }));

    expect(failure).toEqual({
      tool: 'file', action: 'edit', reason: 'not_found', refused: true, workFailed: false, runtimeMissing: false,
    });
    expect(failure && toolFailureKey(failure)).toBe('file·edit·not_found');
  });

  test('the CLI JSON-string shape attributes identically to the cf object shape', () => {
    // The eval tier's shape: a bare string to any reader that only narrows to an object.
    const object = classifyToolFailure(call({
      name: 'file', toolCallId: 't1', args: { action: 'edit', path: 'a.ts' },
      outcome: { success: false, reason: 'ambiguous' }, result: cfResult('ambiguous', 'old_text appears 3 times in a.ts'),
    }));

    const string = classifyToolFailure(call({
      name: 'file', toolCallId: 't2', args: { action: 'edit', path: 'a.ts' },
      outcome: { success: false, reason: 'ambiguous' }, result: cliResult('ambiguous', 'old_text appears 3 times in a.ts'),
    }));

    expect(string).toEqual(object);
    expect(string?.reason).toBe('ambiguous');
  });

  test('a tool with no action reads without a null in its key', () => {
    const failure = classifyToolFailure(call({
      name: 'shell', toolCallId: 't1', args: { command: 'bun test' },
      outcome: { success: false, reason: 'io', execution: { exitCode: 1 } }, result: 'Error (exit 1)\n--- stdout ---\n1 fail\n',
    }));

    expect(failure?.action).toBeNull();
    expect(failure && toolFailureKey(failure)).toBe('shell·exit_1');
  });

  test('a row whose args did not survive still attributes the tool and the reason', () => {
    // Absent args show as a null action, not the string "undefined".
    const failure = classifyToolFailure(call({
      name: 'file', toolCallId: 't1', outcome: { success: false, reason: 'unread' }, result: cfResult('unread', 'a.ts has not been read here yet'),
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
        outcome: v.parse(ToolOutcomeSchema, { success: false, reason }), result: cfResult(reason, 'refused: ' + reason),
      }));

      expect(failure).toMatchObject({ reason, refused: true, workFailed: false });
    }
  });

  test('a missing path and a filesystem error are NOT refusals', () => {
    // Things that went wrong, not decisions the tool made, so they stay in the candidate-defect bucket.
    for (const reason of ['missing', 'io']) {
      expect(classifyToolFailure(call({
        name: 'file', toolCallId: 't1', args: { action: 'read' },
        outcome: v.parse(ToolOutcomeSchema, { success: false, reason }), result: cfResult(reason, 'failed: ' + reason),
      }))).toMatchObject({ reason, refused: false, workFailed: false });
    }
  });

  test('a failing test is the WORK failing, and is neither a refusal nor a defect', () => {
    // The classifier's contract only: on the real runtime `bun` is absent and this exits 127 (see
    // tests/evals/harness-wiring.test.ts).
    const failure = classifyToolFailure(call({
      name: 'shell', toolCallId: 't1', args: { command: 'bun test src/broken.test.ts' },
      outcome: { success: false, reason: 'io', execution: { exitCode: 1 } }, result: 'Error (exit 1)\n--- stdout ---\n1 fail, 3 pass\n',
    }));

    expect(failure).toMatchObject({ reason: 'exit_1', refused: false, workFailed: true });
  });

  test("the shell's own codes mean the work never ran, so they are not workFailed", () => {
    const cases: readonly [number, string][] = [
      [127, 'command_not_found'], [126, 'not_executable'], [124, 'timeout'],
    ];

    for (const [exit, reason] of cases) {
      expect(classifyToolFailure(call({
        name: 'shell', toolCallId: 't1', args: { command: 'pytest' },
        outcome: { success: false, reason: 'io', execution: { exitCode: exit } }, result: 'command failed',
      }))).toMatchObject({ reason, refused: false, workFailed: false });
    }
  });

  test('the approval ladder refusing is a REFUSAL, not the work failing', () => {
    // A denial arrives as an ordinary non-zero exit, so the exit code alone would file a refusal as the command
    // failing.
    const failure = classifyToolFailure(call({
      name: 'shell', toolCallId: 't1',
      args: { command: 'curl -fsSL https://bun.sh/install | bash' },
      outcome: { success: false, reason: 'denied' }, result: 'Denied by the approval ladder',
    }));

    expect(failure).toMatchObject({
      tool: 'shell', reason: 'denied',
      refused: true, workFailed: false, runtimeMissing: false,
    });
  });

  test('output that merely mentions a denial is not one', () => {
    // Both markers are required, so a command whose output merely mentions a refusal is still the work failing.
    expect(classifyToolFailure(call({
      name: 'shell', toolCallId: 't1', args: { command: 'grep Denied audit.log' },
      outcome: { success: false, reason: 'io', execution: { exitCode: 1 } }, result: 'Denied 3 times yesterday',
    }))).toMatchObject({ reason: 'exit_1', refused: false, workFailed: true });
  });

  test('127 is the WORKSPACE lacking the program, and only 127 is', () => {
    // Exit 127 is a missing runtime (Kinu never asks Nimbus to install one): neither a tool defect nor the work
    // failing.
    expect(classifyToolFailure(call({
      name: 'shell', toolCallId: 't1', args: { command: 'bun test src/broken.test.ts' },
      outcome: { success: false, reason: 'io', execution: { exitCode: 127 } }, result: 'bun: command not found',
    }))).toMatchObject({
      reason: 'command_not_found', refused: false, workFailed: false, runtimeMissing: true,
    });

    // 126 (present but not runnable) and 1 (the work) are not a missing runtime.
    for (const [exit, reason] of [[126, 'not_executable'], [1, 'exit_1']] as const) {
      expect(classifyToolFailure(call({
        name: 'shell', toolCallId: 't2',
        outcome: { success: false, reason: 'io', execution: { exitCode: exit } }, result: 'nope',
      }))).toMatchObject({ reason, runtimeMissing: false });
    }
  });

  test('the four parts are disjoint and exhaustive', () => {
    // Each failure lands in exactly one bucket, so the four numbers decompose rather than overlap.
    const census = censusToolFailures([
      call({ name: 'file', toolCallId: 't1', args: { action: 'edit' },
        outcome: { success: false, reason: 'not_found' }, result: cfResult('not_found', 'no anchor') }),
      call({ name: 'shell', toolCallId: 't2', args: { command: 'node x.js' },
        outcome: { success: false, reason: 'io', execution: { exitCode: 1 } }, result: 'Error (exit 1)\n' }),
      call({ name: 'shell', toolCallId: 't3', args: { command: 'bun test' },
        outcome: { success: false, reason: 'io', execution: { exitCode: 127 } }, result: 'bun: command not found' }),
      call({ name: 'eval', toolCallId: 't4', error: 'boom' }),
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
  test('returned error-shaped values cannot determine invocation failure on either backend', () => {
    const data = { error: 'workspace.createTool is not a function' };

    for (const result of [data, JSON.stringify(data)]) {
      expect(classifyToolFailure(call({ name: 'eval', toolCallId: 't1', result, outcome: { success: true } }))).toBeNull();
      expect(classifyToolFailure(call({ name: 'eval', toolCallId: 't2', result }))).toBeNull();
      expect(classifyToolFailure(call({ name: 'eval', toolCallId: 't3', result, outcome: { success: false, reason: null } })))
        .toMatchObject({ reason: 'unclassified', refused: false, workFailed: false });
    }
  });

  test('a bare error-looking string is deliberately NOT a failure', () => {
    // Deliberate: this shape has no discriminator and a prose sniff would misfire; the fix belongs where
    // `success` is decided.
    expect(classifyToolFailure(call({
      name: 'eval', toolCallId: 't1',
      result: 'workspace.createTool is not a function.',
    }))).toBeNull();
  });

  test('a tool that failed without saying why gets its own reason, not `threw`', () => {
    // A defect in the tool's own contract, kept apart from `threw`.
    expect(classifyToolFailure(call({
      name: 'eval', toolCallId: 't1', error: FAILURE_WITHOUT_ERROR,
    }))).toMatchObject({ reason: 'failed_without_error', refused: false, workFailed: false });
    expect(classifyToolFailure(call({
      name: 'web', toolCallId: 't2', error: 'fetch failed: ECONNREFUSED',
    }))).toMatchObject({ reason: 'threw', refused: false, workFailed: false });
  });

  test('a failure this cannot explain is reported as unclassified, never guessed', () => {
    const failure = classifyToolFailure(call({
      name: 'mystery', toolCallId: 't1', outcome: { success: false, reason: null }, result: 'Error: something happened\n',
    }));

    expect(failure).toMatchObject({ reason: 'unclassified', refused: false, workFailed: false });
  });
});

describe('the census over a run', () => {
  test('counts by tool·action·reason, heaviest first, over FAILURES not calls', () => {
    // Built over failures only; over every row it would describe tool usage, not failures.
    const rows = [
      call({ name: 'file', toolCallId: 't1', args: { action: 'read' }, result: 'ok\n' }),
      call({ name: 'file', toolCallId: 't2', args: { action: 'read' }, result: 'ok\n' }),
      call({ name: 'file', toolCallId: 't3', args: { action: 'read' }, result: 'ok\n' }),
      call({
        name: 'file', toolCallId: 't4', args: { action: 'edit' },
        outcome: { success: false, reason: 'not_found' }, result: cfResult('not_found', 'no match'),
      }),
      call({
        name: 'file', toolCallId: 't5', args: { action: 'edit' },
        outcome: { success: false, reason: 'not_found' }, result: cliResult('not_found', 'no match'),
      }),
      call({
        name: 'file', toolCallId: 't6', args: { action: 'write' },
        outcome: { success: false, reason: 'unread' }, result: cfResult('unread', 'not read yet'),
      }),
      call({ name: 'shell', toolCallId: 't7', args: { command: 'bun test' }, outcome: { success: false, reason: 'io', execution: { exitCode: 1 } }, result: 'fail' }),
    ];

    const census = censusToolFailures(rows);
    expect(census.failures).toHaveLength(4);
    expect(census.byKey).toEqual([
      ['file·edit·not_found', 2],
      ['file·write·unread', 1],
      ['shell·exit_1', 1],
    ]);
    // Disjoint and exhaustive: the refusals are the contract working, exit 1 is the agent finding a broken
    // suite.
    expect(census.refused).toBe(3);
    expect(census.workFailed).toBe(1);
    expect(census.broke).toBe(0);
    expect(census.refused + census.workFailed + census.broke).toBe(census.failures.length);
  });

  test('a call that both threw AND returned failing text is ONE failure', () => {
    // One classification per row, so a passed count cannot go negative.
    const census = censusToolFailures([call({
      name: 'shell', toolCallId: 't1', error: 'exit 2', result: 'Error (exit 2)\nboom\n',
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

describe('the classification the `shell` tool actually produced reaches the reader', () => {
  /**
   * End to end: the real `shell` tool refuses, the payload crosses the ledger in both backend shapes, and the
   * real reader attributes it.
   */
  async function refuseEscalation(runtime: string): Promise<{
    record: ToolCallEnd;
    logger: RecordingLogger;
  }> {
    const { rt } = createTestRuntime();
    const logger = createRecordingLogger();
    const tools = buildBuiltinTools({ rt, logger, history: storesFor(rt).history });
    const run = { execute: toolExecute<{ command: string; runtime: string }, string>(tools.shell) };

    return { record: await recordInvocation(run.execute({ command: 'pytest -q', runtime })), logger };
  }

  test('an unprovisioned runtime is `unavailable`, a platform gap, on both backends', async () => {
    const { record } = await refuseEscalation('sandbox');

    for (const result of [{ error: record.error ?? '' }, record.error]) {
      const failure = classifyToolFailure({ ...record, result: result ?? null });
      expect(failure).toMatchObject({
        tool: 'shell',
        reason: 'unavailable',
        // Neither the tool declining nor the work failing: the environment was never there.
        refused: false,
        workFailed: false,
        runtimeMissing: true,
      });
    }
  });

  test('the refusal is counted as a runtime gap, not as a broken tool', async () => {
    const { record } = await refuseEscalation('device');
    const census = censusToolFailures([record]);
    expect({
      refused: census.refused, workFailed: census.workFailed,
      runtimeMissing: census.runtimeMissing, broke: census.broke,
    }).toEqual({ refused: 0, workFailed: 0, runtimeMissing: 1, broke: 0 });
    expect(census.byKey).toEqual([['shell·unavailable', 1]]);
  });

  test('the same decision is logged under a stable dotted event name', async () => {
    // The log and the ledger row read one classification.
    const { logger } = await refuseEscalation('sandbox');
    expect(logger.emitted).toEqual([{
      event: 'shell.escalation_refused',
      code: 'unavailable',
      cause: 'runtime_not_provisioned',
      fields: { runtime: 'sandbox' },
    }]);
  });

  test('a shell-less workspace is `unsupported`, which is a different fact', async () => {
    // `unavailable` retries and `unsupported` does not; pooling them would read a permanent gap as a cold
    // start.
    const { rt } = createTestRuntime();
    const logger = createRecordingLogger();
    const tools = buildBuiltinTools({ rt: { ...rt, shell: undefined }, logger, history: storesFor(rt).history });
    const run = { execute: toolExecute<{ command: string }, string>(tools.shell) };
    const record = await recordInvocation(run.execute({ command: 'pytest -q' }));
    expect(classifyToolFailure(record)).toMatchObject({
      reason: 'unsupported', refused: true, workFailed: false, runtimeMissing: false,
    });
    expect(logger.emitted.map((line) => line.event)).toEqual(['shell.shell_absent']);
  });
});

/** The four disjoint parts, by name. */
type CensusPart = 'refused' | 'workFailed' | 'runtimeMissing' | 'broke';

/**
 * Which part of the split each class lands in, as a total table over `ErrorCode`. Nothing maps to `workFailed`:
 * a classified refusal means the work did not run.
 */
const PART_BY_CODE = {
  // The tool established that proceeding would be wrong and declined.
  bad_input: 'refused',
  denied: 'refused',
  unsupported: 'refused',
  // A bound the caller hit before the work ran — declined, like denied.
  budget: 'refused',
  // The addressed environment is absent: a platform gap, neither a defect nor the work.
  unavailable: 'runtimeMissing',
  // Nothing proves the environment was absent, so these stay in the residual candidate-defect part.
  missing: 'broke',
  timeout: 'broke',
  cancelled: 'broke',
  oom: 'broke',
  io: 'broke',
} satisfies Readonly<Record<ErrorCode, CensusPart>>;

/** The four counts, so a wrong part also fails on the other three. */
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
    // `PART_BY_CODE` satisfies `Record<ErrorCode, …>`, so a new code fails to compile rather than skip this
    // loop.
    expect(Object.keys(PART_BY_CODE).sort()).toEqual([...ERROR_CODES].sort());

    for (const code of ERROR_CODES) {
      const census = censusToolFailures([call({
        name: 'shell', toolCallId: `t-${code}`, args: { command: 'pytest -q' },
        outcome: { success: false, reason: code }, result: refusalText(new KinuError(code, 'refused: ' + code)),
      })]);

      expect(census.failures).toHaveLength(1);
      expect(parts(census)).toEqual(onlyPart(PART_BY_CODE[code]));
      // Never `workFailed`: a class means the work did not run.
      expect(census.workFailed).toBe(0);
    }
  });

  test('the parts still sum to the failures, over the whole vocabulary at once', () => {
    const census = censusToolFailures(ERROR_CODES.map((code) => call({
      name: 'shell', toolCallId: `t-${code}`, args: { command: 'pytest -q' },
      outcome: { success: false, reason: code }, result: refusalText(new KinuError(code, 'refused: ' + code)),
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
 * The five executor tools on the payloads they really produce, read through the real `shell` tool where it
 * reaches the executor: that seam writes the durable row.
 */
describe('each executor tool files its own failure in the right part', () => {
  async function escalate(provider: ExecutorProvider, command = 'pytest -q'): Promise<ToolCallEnd> {
    const { rt } = createTestRuntime();
    const router = new DefaultExecutionRouter();
    router.register(provider);
    const tools = buildBuiltinTools({ rt: { ...rt, executionRouter: router }, history: storesFor(rt).history });
    const run = { execute: toolExecute<{ command: string; runtime: string }, string>(tools.shell) };

    return recordInvocation(run.execute({ command, runtime: provider.name }));
  }

  function censusOf(record: ToolCallEnd): ToolFailureCensus {
    return censusToolFailures([record]);
  }

  test('sandbox: an unconfigured binding is a platform gap, not a broken tool', async () => {
    // The stub the router registers when the binding is absent (cf-backend/src/runtime.ts).
    const census = censusOf(await escalate(createSandboxExecutor()));
    expect(census.byKey).toEqual([['shell·unavailable', 1]]);
    expect(parts(census)).toEqual(onlyPart('runtimeMissing'));
  });

  // The same thrown sandbox prose is filed by what it says happened, not where.
  const sandboxFaults = [
    {
      // 429 on the container start-rate burst after `withSandboxRetry` gave up: `unavailable`, not an `io`
      // defect in this tool.
      name: 'sandbox: admission control that outlived its retries is also a platform gap',
      thrown: 'Too many containers per second', key: 'shell·unavailable', part: 'runtimeMissing' as const,
    },
    {
      // Pooling both under one prose string would file every container fault as never provisioned.
      name: 'sandbox: a transport fault is NOT a platform gap',
      thrown: 'the container hung up mid-write', key: 'shell·io', part: 'broke' as const,
    },
  ];

  for (const c of sandboxFaults) {
    test(c.name, async () => {
      const census = censusOf(await escalate(createSandboxExecutor({
        exec: async () => { throw new Error(c.thrown); },
        readFile: async () => ({}), writeFile: async () => {}, listFiles: async () => ({ files: [] }),
        deleteFile: async () => {}, exposePort: async () => ({ url: '', port: 0 }),
        unexposePort: async () => {}, getExposedPorts: async () => [],
        ...sandboxHandleLifecycle,
      })));

      expect(census.byKey).toEqual([[c.key, 1]]);
      expect(parts(census)).toEqual(onlyPart(c.part));
    });
  }

  test('sandbox: a classified not-ready refusal is asked once, never folded into the retry loop', async () => {
    // Already classified `unavailable` though the reason can carry transient marker text; the KinuError guard
    // keeps `withSandboxRetry` from retrying it.
    let readinessCalls = 0;

    // Thrown on the `exec` call, the member `withSandboxRetry` wraps, as in production.
    const notReady = (): SandboxHandle => ({
      ...sandboxHandleLifecycle,
      exec: async () => {
        readinessCalls += 1;
        throw new KinuError('unavailable',
          'this devbox has no attached work directory: there is no container instance '
          + 'that can be provided to this durable object. A retry is already under '
          + 'way; operations are refused until it lands.');
      },
      readFile: async () => ({}), writeFile: async () => {}, listFiles: async () => ({ files: [] }),
      deleteFile: async () => {}, exposePort: async () => ({ url: '', port: 0 }),
      unexposePort: async () => {}, getExposedPorts: async () => [],
    });

    const refusal = await createSandboxExecutor(notReady()).tools.exec.execute('bun test');

    expect(refusal).toMatchObject({ reason: 'unavailable' });
    expect(readinessCalls).toBe(1);

    const census = censusOf(await escalate(createSandboxExecutor(notReady())));

    expect(census.byKey).toEqual([['shell·unavailable', 1]]);
    expect(parts(census)).toEqual(onlyPart('runtimeMissing'));
  });

  test('nimbus: an absent binding is a platform gap; a narrow handle is a refusal', async () => {
    const absent = censusOf(await escalate(createNimbusExecutor()));
    expect(absent.byKey).toEqual([['shell·unavailable', 1]]);
    expect(parts(absent)).toEqual(onlyPart('runtimeMissing'));

    // `unsupported`, so `refused`: this handle has no `runCode` and retrying cannot grow one.
    const narrow = createNimbusExecutor({
      box: { ready: async () => {},
        exec: async () => ({ command: 'noop', success: true, exitCode: 0, stdout: '', stderr: '' }),
        files: { read: async () => '', write: async () => {}, list: async () => [], exists: async () => true,
          delete: async () => {} } },
    });

    const refusal = await narrow.tools.runCode.execute('print(1)');
    expect(refusal).toMatchObject({ reason: 'unsupported' });
    expect(censusOf(call({ name: 'eval', toolCallId: 'handled', result: refusal, outcome: { success: true } })).failures).toEqual([]);
  });

  test('device: no device attached is a platform gap, not a successful call', async () => {
    const payload = await escalate(createDeviceTunnelExecutor({
      rpc: async () => { throw new Error('no device connected'); },
      status: () => ({ connected: false, registered: true, toolchain: null }),
      refreshStatus: async () => ({ connected: false, registered: true, toolchain: null }),
    }));

    // Prose read as a successful call would leave the census counting nothing here.
    expect(payload.outcome).toMatchObject({ success: false, reason: 'unavailable' });
    const census = censusOf(payload);
    expect(census.byKey).toEqual([['shell·unavailable', 1]]);
    expect(parts(census)).toEqual(onlyPart('runtimeMissing'));
    // And the instruction the user needs survives inside the payload.
    expect(payload.error).toContain('kinu connect');
  });

  test('parent: the errno the parent raised is the class, and it is not re-guessed', async () => {
    // No reason of its own: `makeVfsError` carries the parent's errno, so ENOENT classifies as `missing`.
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

    expect(census.byKey).toEqual([['shell·missing', 1]]);
    expect(parts(census)).toEqual(onlyPart('broke'));
  });

  test('parent: an aborted exec ends as `cancelled`, which it could not before', async () => {
    // The signal must reach exec, or `cancelled` is unreachable and a cancelled wait looks like a dead parent.
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
    // `shell` never reaches this tool; the classification serves `eval` code, which can branch on `reason`.
    const { rt } = createTestRuntime();

    const workspace = createInlineExecutor({
      vfs: rt.storage.vfs, memory: rt.memory, craftStore: rt.craftStore,
      shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    });

    const payload = await workspace.tools.exec.execute(42);
    expect(payload).toEqual({ reason: 'bad_input', error: 'workspace.exec: command must be a string' });
    expect(censusOf(call({ name: 'eval', toolCallId: 'handled', result: payload, outcome: { success: true } })).failures).toEqual([]);
  });

  test('workspace: the misevolution gate working is a refusal, not a defect', async () => {
    // Without a reason the veto read as `returned_error` and filed the gate doing its job under `broke`.
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
      name: 'eval', toolCallId: 'tc-1', args: { code: 'workspace.createTool(...)' },
      outcome: { success: true }, result: v.parse(JsonObjectSchema, vetoed),
    })]);

    expect(census.failures).toEqual([]);
  });
});
