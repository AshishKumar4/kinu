/**
 * explainNativeToolReferenceError — the codemode sandbox's undefined-
 * identifier hint (D of the observability audit, 2026-08-12). A model that
 * reaches for a native top-level tool (`run`, `agents`, ...) as if it were a
 * codemode global gets a bare V8 ReferenceError today; this rewrites exactly
 * that shape into an actionable correction and leaves every other error
 * (real bugs, thrown provider errors, timeouts) untouched.
 *
 * Where the capability actually IS is read from TOOL_REACH. It used to be a
 * hardcoded `name === 'run'` branch pointing at `workspace.exec`, with every
 * other native tool told "it is not reachable from inside execute_tools" — a
 * sentence that was FALSE for the six that own a codemode namespace and for
 * `file`, whose bytes are `workspace.readFile`/`writeFile`/`editFile`. The
 * per-tool test below is what makes that impossible to reintroduce: it reads
 * the declaration and demands the message name that tool's own namespace, so a
 * message that hardcodes one tool's answer fails for the other seven.
 */
import { describe, test, expect } from 'bun:test';
import { explainNativeToolReferenceError } from '../src/execution/sandbox-errors';
import { BUILTIN_TOOLS, TOOL_REACH } from '../src/tools/registry';

describe('explainNativeToolReferenceError', () => {
  test('every native tool is pointed at the namespace its reach declares', () => {
    for (const name of BUILTIN_TOOLS) {
      const namespace = TOOL_REACH[name].codemode;
      const out = explainNativeToolReferenceError(`${name} is not defined`);
      if (!namespace) {
        // execute_tools IS the sandbox; it names no other tool to correct toward.
        expect(out).toBe(`${name} is not defined`);
        continue;
      }
      expect(out).toContain(`"${name}" is a native Kinu tool, not a codemode member`);
      expect(out).toContain(`Call \`${name}\` directly as its own top-level tool call`);
      expect(out).toContain(`through the \`${namespace}\` namespace`);
    }
  });

  test('run and file point at workspace; the six namespace owners point at themselves', () => {
    // Spelled out rather than only derived, so the derivation above cannot pass
    // by agreeing with a declaration that is itself wrong.
    expect(explainNativeToolReferenceError('run is not defined')).toContain('`workspace` namespace');
    expect(explainNativeToolReferenceError('file is not defined')).toContain('`workspace` namespace');
    for (const name of ['agents', 'memory', 'tasks', 'web', 'report'] as const) {
      expect(explainNativeToolReferenceError(`${name} is not defined`)).toContain(`\`${name}\` namespace`);
    }
  });

  test('no native tool is told it is unreachable from inside execute_tools', () => {
    // The old message said exactly that for seven of eight.
    for (const name of BUILTIN_TOOLS) {
      expect(explainNativeToolReferenceError(`${name} is not defined`))
        .not.toContain('not reachable from inside execute_tools');
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
