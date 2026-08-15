// The source-slicing helpers. They exist because three wiring tests were live
// with a missing anchor, so every assertion in them ran against the rest of the
// file instead of the member they named — one of them guarding a call that
// could be deleted outright with the test still green. The property that
// prevents a repeat is that a missing anchor THROWS, so it is asserted first.
import { describe, expect, test } from 'bun:test';
import { anchor, between, memberBody } from '../src/index.js';

describe('anchor', () => {
  test('returns the offset when present', () => {
    expect(anchor('abc def', 'def')).toBe(4);
  });

  test('throws — never -1 — naming the file and the needle', () => {
    expect(() => anchor('abc', 'zzz', 'orchestrator.ts'))
      .toThrow(/anchor not found in orchestrator\.ts: "zzz"/);
  });
});

describe('between', () => {
  const src = 'head START middle END tail';

  test('spans from one anchor to the next', () => {
    expect(between(src, 'START', 'END')).toBe('START middle ');
  });

  test('throws when the closing anchor is missing, instead of running to EOF', () => {
    expect(() => between(src, 'START', 'NOPE', 'hook.ts'))
      .toThrow(/closing anchor not found in hook\.ts after "START": "NOPE"/);
  });

  test('finds the closing anchor after the opening one, not before it', () => {
    expect(between('END START x END y', 'START', 'END')).toBe('START x ');
  });
});

describe('memberBody', () => {
  test('extracts a method body without naming whatever follows it', () => {
    const src = 'class A {\n  async onStart() {\n    a();\n  }\n\n  other() { b(); }\n}';
    expect(memberBody(src, 'async onStart()')).toBe('\n    a();\n  ');
  });

  test('handles nesting, so an inner block does not close the member early', () => {
    const src = 'foo() {\n  if (x) { y(); }\n  z();\n}\nafter();';
    const body = memberBody(src, 'foo()');
    expect(body).toContain('z();');
    expect(body).not.toContain('after();');
  });

  test('braces inside strings, template interpolations and comments do not unbalance it', () => {
    const src = [
      'foo() {',
      '  const a = "}";',
      "  const b = '{';",
      '  const c = `x${ { k: "}" } }y`;',
      '  // }',
      '  /* } */',
      '  done();',
      '}',
      'after();',
    ].join('\n');
    const body = memberBody(src, 'foo()');
    expect(body).toContain('done();');
    expect(body).not.toContain('after();');
  });

  test('throws on a missing declaration rather than slicing to EOF', () => {
    expect(() => memberBody('class A {}', 'private gone()', 'orchestrator.ts'))
      .toThrow(/anchor not found in orchestrator\.ts/);
  });

  test('throws when the member never closes', () => {
    expect(() => memberBody('foo() { if (x) {', 'foo()')).toThrow(/unbalanced braces/);
  });
});
