/**
 * A Durable Object's thrown error reaches its caller across RPC as its message alone (compat 2025-12-01).
 * A route answers a `KinuError` there with the reason its thrower wrote (`authoredRefusal`); a plain `Error`
 * is unclassified, so the client gets only the route's own words and a 500. So an object, and the `user/`
 * modules its methods run, throw a `KinuError` (or a named class), never a bare built-in error.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse, walk } from '../../../scripts/syntax';

const SRC = join(import.meta.dir, '..', 'src');

const BUILT_IN_ERRORS = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError']);

const OBJECT_BASES = new Set(['Agent', 'ActorAgent', 'DurableObject']);

function declaresObject(path: string): boolean {
  let found = false;

  walk(parse(path, readFileSync(path, 'utf8')).root, (node) => {
    const { raw } = node;

    if (raw.type === 'ClassDeclaration' && raw.superClass?.type === 'Identifier' && OBJECT_BASES.has(raw.superClass.name)) found = true;
  });

  return found;
}

/** Every module that declares a Durable Object class, and every `user/` module the UserDO runs. */
function objectModules(): string[] {
  const files: string[] = [];

  const collect = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);

      if (entry.isDirectory()) collect(path);
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) files.push(path);
    }
  };

  collect(SRC);

  return files.filter((path) => relative(SRC, path).startsWith('user/') || declaresObject(path));
}

function bareThrows(path: string): string[] {
  const parsed = parse(path, readFileSync(path, 'utf8'));
  const found: string[] = [];

  walk(parsed.root, (node) => {
    const { raw } = node;

    if (raw.type === 'ThrowStatement' && raw.argument.type === 'NewExpression'
      && raw.argument.callee.type === 'Identifier' && BUILT_IN_ERRORS.has(raw.argument.callee.name)) {
      found.push(`${relative(SRC, path)}:${String(parsed.lineAt(node.start))}`);
    }
  });

  return found;
}

describe('what a Durable Object throws', () => {
  test('the modules are found', () => {
    const modules = objectModules().map((path) => relative(SRC, path));

    for (const expected of ['user/user-do.ts', 'orchestrator.ts', 'actor-agent.ts', 'deploy/deploy-do.ts']) {
      expect(modules).toContain(expected);
    }
  });

  test('no bare built-in error: a refusal is a KinuError, so its reason survives RPC', () => {
    expect(objectModules().flatMap(bareThrows)).toEqual([]);
  });
});
