/**
 * explainNativeToolReferenceError — the codemode sandbox's undefined-
 * identifier hint (D of the observability audit, 2026-08-12). A model that
 * reaches for a native top-level tool (`run`, `agents`, ...) as if it were a
 * codemode global gets a bare V8 ReferenceError today; this rewrites exactly
 * that shape into an actionable correction and leaves every other error
 * (real bugs, thrown provider errors, timeouts) untouched.
 */
import { describe, test, expect } from 'bun:test';
import { explainNativeToolReferenceError } from '../src/execution/sandbox-errors.js';
import { BUILTIN_TOOLS } from '../src/tools/registry.js';

describe('explainNativeToolReferenceError', () => {
  test('names run, points at both the direct call and workspace.exec', () => {
    const out = explainNativeToolReferenceError('run is not defined');
    expect(out).toContain('run is not defined');
    expect(out).toContain('"run" is a native Proteus tool, not a codemode member');
    expect(out).toContain('workspace.exec(...)');
    expect(out).toContain('Call `run` directly as its own top-level tool call');
  });

  test('every other native tool name gets the general direct-call correction', () => {
    for (const name of BUILTIN_TOOLS) {
      if (name === 'execute_tools' || name === 'run') continue;
      const out = explainNativeToolReferenceError(`${name} is not defined`);
      expect(out).toContain(`"${name}" is a native Proteus tool, not a codemode member`);
      expect(out).toContain(`Call \`${name}\` directly as its own top-level tool call`);
    }
  });

  test('execute_tools itself is never rewritten — it names no OTHER tool', () => {
    const out = explainNativeToolReferenceError('execute_tools is not defined');
    expect(out).toBe('execute_tools is not defined');
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
