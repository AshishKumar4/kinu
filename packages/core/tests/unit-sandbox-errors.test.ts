/**
 * explainNativeToolReferenceError — the codemode sandbox's undefined-
 * identifier hint (D of the observability audit, 2026-08-12). A model that
 * reaches for a native top-level tool (`shell`, `agents`, ...) as if it were a
 * codemode global gets a bare V8 ReferenceError today; this rewrites exactly
 * that shape into an actionable correction and leaves every other error
 * (real bugs, thrown provider errors, timeouts) untouched.
 *
 * Where the capability actually IS is read from TOOL_REACH, never a hardcoded
 * `name === 'shell'` branch pointing at `workspace.exec` with every other native
 * tool told "it is not reachable from inside eval" — a sentence that
 * is FALSE for the six that own a codemode namespace and for `file`, whose
 * bytes are `workspace.readFile`/`writeFile`/`editFile`. The per-tool test
 * below is what makes that impossible: it reads the declaration and demands
 * the message name that tool's own namespace, so a message that hardcodes one
 * tool's answer fails for the other seven.
 */
import { describe, test, expect } from 'bun:test';
import { explainNativeToolReferenceError } from '../src/execution/sandbox-errors';
import { BUILTIN_TOOLS, TOOL_REACH } from '../src/tools/registry';
import { branchableToolCall, failedToolOutcome, successfulToolOutcome, withCodemodeProgram } from '../src/tools/outcome';
import { codemodeFunction } from '../src/tools/sandbox-contract';
import { censusToolFailures } from '../src/read-models/tool-failures';
import { KinuError } from '../src/obs';

test('a host rejection resolves to the same discriminated refusal as a native failure', async () => {
  const broken = branchableToolCall(async () => { throw new Error('host disconnected'); });
  expect(await broken).toEqual({ success: false, reason: null, error: 'host disconnected' });
  const refused = branchableToolCall(async () => { throw new KinuError('unavailable', 'file plane offline'); });
  expect(await refused).toEqual({ success: false, reason: 'unavailable', error: 'file plane offline' });
});

test('recovered host failures retain each binding in the census without failing the program', async () => {
  const output = await withCodemodeProgram(async () => {
    const file = codemodeFunction('tools', 'file', async () => { throw new KinuError('unavailable', 'offline'); });
    const command = codemodeFunction('workspace', 'exec', async () => ({ reason: 'io', error: 'failed', execution: { exitCode: 1 } }));
    const answers = await Promise.all([file({}), command('check')]);
    expect(answers).toEqual([
      { success: false, reason: 'unavailable', error: 'offline' },
      { success: false, reason: 'io', error: 'failed', execution: { exitCode: 1 } },
    ]);

    return { result: 'recovered' };
  });

  const outcome = successfulToolOutcome('eval', output);
  expect(outcome.success).toBe(true);
  const census = censusToolFailures([{ type: 'tool_call_end', runId: 'shell', eventIndex: 0, timestamp: new Date(0).toISOString(), name: 'eval', toolCallId: 'call', outcome }]);
  expect(census.byKey).toEqual([['file·unavailable', 1], ['shell·exit_1', 1]]);
});

test('throwing the failure value propagates its native reason and a malformed program remains a ReferenceError', async () => {
  let error: unknown;

  try {
    await withCodemodeProgram(async () => {
      const file = codemodeFunction('tools', 'file', async () => { throw new KinuError('denied', 'blocked'); });
      throw await file({ action: 'write' });
    });
  } catch (cause) { error = cause; }

  expect(failedToolOutcome({ cause: error })).toMatchObject({ success: false, reason: 'denied', failures: [{ tool: 'file', action: 'write', reason: 'denied' }] });
  await expect(withCodemodeProgram(async () => { throw new ReferenceError('run is not defined'); })).rejects.toBeInstanceOf(ReferenceError);
});

describe('explainNativeToolReferenceError', () => {
  test('every native tool is pointed at tools.<name>, and at the namespace its reach declares', () => {
    for (const name of BUILTIN_TOOLS) {
      const namespace = TOOL_REACH[name].codemode;
      const out = explainNativeToolReferenceError(`${name} is not defined`);

      if (name === 'eval') {
        // eval IS the sandbox; a program cannot call it from inside itself.
        expect(out).toBe(`${name} is not defined`);
        continue;
      }

      expect(out).toContain(`"${name}" is a native Kinu tool`);
      expect(out).toContain(`call it as \`tools.${name}(input)\``);

      if (namespace) expect(out).toContain(`through the \`${namespace}\` namespace`);
    }
  });

  test('shell and file point at workspace; the six namespace owners point at themselves', () => {
    // Spelled out rather than only derived, so the derivation above cannot pass
    // by agreeing with a declaration that is itself wrong.
    expect(explainNativeToolReferenceError('shell is not defined')).toContain('`workspace` namespace');
    expect(explainNativeToolReferenceError('file is not defined')).toContain('`workspace` namespace');

    for (const name of ['agents', 'memory', 'tasks', 'web', 'report'] as const) {
      expect(explainNativeToolReferenceError(`${name} is not defined`)).toContain(`\`${name}\` namespace`);
    }
  });

  test('no native tool is told it is unreachable from inside eval', () => {
    // A message that hardcodes one tool's answer says exactly that for seven of
    // eight, and it is false for all seven.
    for (const name of BUILTIN_TOOLS) {
      expect(explainNativeToolReferenceError(`${name} is not defined`))
        .not.toContain('not reachable from inside eval');
    }
  });

  test('eval itself is never rewritten — it names no OTHER tool', () => {
    const out = explainNativeToolReferenceError('eval is not defined');
    expect(out).toBe('eval is not defined');
  });

  test('an undefined identifier that is not a native tool name passes through unchanged', () => {
    const out = explainNativeToolReferenceError('fooBarBaz is not defined');
    expect(out).toBe('fooBarBaz is not defined');
  });

  test('an unrelated error message is never touched', () => {
    const messages = [
      'ENOENT: no such file or directory',
      'Execution timed out',
      'TypeError: Cannot read properties of undefined (reading \'foo\')',
      'run failed with exit code 1',
      'is not defined', // no identifier captured — malformed, must not match
    ];

    for (const m of messages) expect(explainNativeToolReferenceError(m)).toBe(m);
  });
});
