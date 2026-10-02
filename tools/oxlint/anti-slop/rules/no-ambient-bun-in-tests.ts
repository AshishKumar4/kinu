import { defineRule } from '@oxlint/plugins';
import type { ESTree, SourceCode } from '@oxlint/plugins';
import { resolveVariable } from '../shared/scope.ts';
import { TEST_FILE } from './no-ambient-git-in-tests.ts';

const SPAWNERS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync']);
const CHILD_PROCESS = new Set(['child_process', 'node:child_process']);

type Node = ESTree.Expression | ESTree.Argument;

function member(node: ESTree.MemberExpression): string | undefined {
  return !node.computed && node.property.type === 'Identifier' ? node.property.name
    : node.property.type === 'Literal' && typeof node.property.value === 'string' ? node.property.value : undefined;
}

function moduleName(node: ESTree.ImportDeclaration | ESTree.CallExpression): string | undefined {
  if (node.type === 'ImportDeclaration') return typeof node.source.value === 'string' ? node.source.value : undefined;
  const argument = node.arguments[0];

  return node.callee.type === 'Identifier' && node.callee.name === 'require' && argument?.type === 'Literal' && typeof argument.value === 'string' ? argument.value : undefined;
}

function initial(source: SourceCode, node: Node, seen: Set<string>): Node {
  if (node.type !== 'Identifier' || seen.has(node.name)) return node;
  const variable = resolveVariable(source, node);
  const declaration = variable?.defs[0]?.node;

  if (declaration?.type !== 'VariableDeclarator' || declaration.init === null) return node;
  seen.add(node.name);

  return initial(source, declaration.init, seen);
}

function executable(source: SourceCode, node: Node | undefined): 'bun' | 'other' | 'unknown' {
  if (node === undefined) return 'unknown';
  const value = initial(source, node, new Set());

  if (value.type === 'Literal' && typeof value.value === 'string') return /(?:^|[\\/])bun(?:\.exe)?$/.test(value.value) ? 'bun' : 'other';
  if (value.type === 'MemberExpression' && value.object.type === 'Identifier' && value.object.name === 'process' && member(value) === 'execPath') return 'bun';
  if (value.type === 'ArrayExpression') {
    const first = value.elements[0];

    if (first?.type === 'SpreadElement') return executable(source, first.argument);

    return executable(source, first ?? undefined);
  }

  return 'unknown';
}

function explicitEnv(source: SourceCode, node: Node | undefined): boolean {
  if (node === undefined) return false;
  const value = initial(source, node, new Set());

  if (value.type !== 'ObjectExpression') return false;

  for (let i = value.properties.length - 1; i >= 0; i--) {
    const property = value.properties[i];

    if (property.type === 'SpreadElement') {
      if (explicitEnv(source, property.argument)) return true;
      continue;
    }

    const name = property.key.type === 'Identifier' ? property.key.name
      : property.key.type === 'Literal' && typeof property.key.value === 'string' ? property.key.value : undefined;

    if (name !== 'env') continue;

    return !(property.value.type === 'Identifier' && property.value.name === 'undefined')
      && !(property.value.type === 'UnaryExpression' && property.value.operator === 'void');
  }

  return false;
}

function importedSpawner(source: SourceCode, node: ESTree.IdentifierReference): 'bun' | 'child' | undefined {
  const variable = resolveVariable(source, node);
  const definition = variable?.defs[0];

  if (definition?.node.type === 'VariableDeclarator' && definition.node.init?.type === 'CallExpression' && definition.node.id.type === 'ObjectPattern') {
    const origin = moduleName(definition.node.init);
    const property = definition.node.id.properties.find(property => property.type === 'Property' && property.value.type === 'Identifier' && property.value.name === node.name);
    const imported = property?.type === 'Property' && property.key.type === 'Identifier' ? property.key.name : undefined;

    if (imported === undefined || !SPAWNERS.has(imported)) return undefined;

    return origin === 'bun' ? 'bun' : origin !== undefined && CHILD_PROCESS.has(origin) ? 'child' : undefined;
  }

  if (definition?.type !== 'ImportBinding' || definition.parent?.type !== 'ImportDeclaration') return undefined;
  const name = moduleName(definition.parent);
  const specifier = definition.node;

  if (specifier.type !== 'ImportSpecifier') return undefined;
  const imported = specifier.imported.type === 'Identifier' ? specifier.imported.name : String(specifier.imported.value);

  if (!SPAWNERS.has(imported)) return undefined;

  return name === 'bun' ? 'bun' : name !== undefined && CHILD_PROCESS.has(name) ? 'child' : undefined;
}

function receiverSpawner(source: SourceCode, node: ESTree.MemberExpression): 'bun' | 'child' | undefined {
  const name = member(node);

  if (name === undefined || !SPAWNERS.has(name) || node.object.type !== 'Identifier') return undefined;
  const variable = resolveVariable(source, node.object);

  if (node.object.name === 'Bun' && (variable === null || variable.defs.length === 0)) return 'bun';
  const definition = variable?.defs[0];

  if (definition?.node.type === 'VariableDeclarator' && definition.node.init?.type === 'CallExpression') {
    const origin = moduleName(definition.node.init);

    return origin === 'bun' ? 'bun' : origin !== undefined && CHILD_PROCESS.has(origin) ? 'child' : undefined;
  }

  if (definition?.type !== 'ImportBinding' || definition.parent?.type !== 'ImportDeclaration') return undefined;
  const origin = moduleName(definition.parent);

  return origin === 'bun' ? 'bun' : origin !== undefined && CHILD_PROCESS.has(origin) ? 'child' : undefined;
}

export const noAmbientBunInTestsRule = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Test-spawned Bun must receive the current preload environment, not Bun’s launch snapshot.' },
    schema: [],
    messages: { ambient: 'A test-spawned Bun child without env inherits the launch snapshot, not the preload scratch roots. Use spawnTest() from @kinu.run/test-utils or explicitly name env.' },
  },
  create(context) {
    if (!TEST_FILE.test(context.filename)) return {};
    const reads: ESTree.CallExpression[] = [];

    return {
      CallExpression(node) { reads.push(node); },
      'Program:exit'() {
        for (const node of reads) {
          const kind = node.callee.type === 'Identifier' ? importedSpawner(context.sourceCode, node.callee)
            : node.callee.type === 'MemberExpression' ? receiverSpawner(context.sourceCode, node.callee) : undefined;

          if (kind === undefined) continue;
          const first = node.arguments[0];
          const resolved = first === undefined ? undefined : initial(context.sourceCode, first, new Set());
          const object = kind === 'bun' && resolved?.type === 'ObjectExpression' ? resolved : undefined;
          const cmd = object?.properties.find(property => property.type === 'Property' && property.key.type === 'Identifier' && property.key.name === 'cmd');
          const program = object !== undefined && cmd?.type === 'Property' ? cmd.value : first;
          const target = executable(context.sourceCode, program);

          if (target === 'other' || kind === 'child' && target !== 'bun') continue;
          const options = object ?? (kind === 'bun' ? node.arguments[1] : node.arguments[2]);

          if (!explicitEnv(context.sourceCode, options)) context.report({ node, messageId: 'ambient' });
        }
      },
    };
  },
});
