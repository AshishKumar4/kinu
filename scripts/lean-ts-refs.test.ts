/**
 * The traceability checker resolves a `tsRef` through `lean/ts-refs.mjs`. Its
 * hand lexer lost `createNimbusWorkspaceExecutor` in
 * `packages/core/src/tools/inline-executor.ts`: a template literal whose `${…}`
 * holds a template with a brace unbalanced the depth count, and every
 * declaration after it vanished.
 */
import { expect, test } from 'bun:test';
import { stringValues, tsDeclarations } from '../lean/ts-refs.mjs';

test('a declaration after a template nested inside a substitution is still declared', () => {
  const source = [
    "const types = `declare namespace workspace ${slate === undefined ? '' : `{ slates: Slate }`}`;",
    'export function createExecutor(opts: { a: string }): void {}',
    '',
  ].join('\n');

  expect([...tsDeclarations('fixture.ts', source).keys()]).toEqual(['types', 'createExecutor']);
});

test('members are the owner\'s own, and a function owns none', () => {
  const declarations = tsDeclarations('fixture.ts', [
    'export class Store { readonly rows = 1; open(): void { const local = 2; } }',
    "export interface Floor { kind: 'min' | 'max'; }",
    "export const KINDS = ['a', 'b'] as const;",
    'export const run = () => { const hidden = 1; };',
    '',
  ].join('\n'));

  expect([...(declarations.get('Store')?.members.keys() ?? [])]).toEqual(['rows', 'open']);
  expect(stringValues(declarations.get('Floor')?.members.get('kind'))).toEqual(['min', 'max']);
  expect(stringValues(declarations.get('KINDS')?.node)).toEqual(['a', 'b']);
  expect(declarations.get('run')?.members.size).toBe(0);
});

test('a file that does not parse resolves nothing', () => {
  expect(() => tsDeclarations('fixture.ts', 'export const x = `unterminated')).toThrow(SyntaxError);
});
