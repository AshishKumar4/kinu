// Crafted source is spliced into the sandbox as `tools.<name> = (<source>)`, so it must
// normalize to one expression; whether it is a function is checked per tool at load time.

import * as acorn from 'acorn';
import { Effect, Result } from 'effect';
import { renderThrownChain, settleSync } from '../obs/index';

const ECMA: acorn.Options = { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true };

export type CraftedSourceAdmission =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly error: string };

/** Whether `source` parses as exactly one JavaScript expression. */
export function parsesAsExpression(source: string): string | null {
  return settleSync(Effect.try({ try: () => acorn.parse(`(${source}\n)`, ECMA), catch: (cause) => ({ cause }) }).pipe(
    Effect.map((parsed) => {
      const [statement, extra] = parsed.body;

      return extra !== undefined || statement === undefined || statement.type !== 'ExpressionStatement' ? 'the source is not a single expression' : null;
    }),
    Effect.catch((failed) => Effect.succeed(renderThrownChain(failed))),
  ));
}

function topLevelDeclarations(program: acorn.Program) {
  const functions: string[] = [];
  const variables: string[] = [];

  for (const node of program.body) {
    const declaration = node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration'
      ? node.declaration
      : node;

    if (!declaration) continue;

    if (declaration.type === 'FunctionDeclaration' && declaration.id) {
      functions.push(declaration.id.name);
    } else if (declaration.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations) {
        if (declarator.id.type === 'Identifier') variables.push(declarator.id.name);
      }
    }
  }

  return { functions, variables };
}

/** `module.exports = X` / `exports.default = X` / `export default X` → X, when present. */
function exportedExpression(program: acorn.Program, source: string): string | null {
  for (const node of program.body) {
    if (node.type === 'ExportDefaultDeclaration') {
      const declared = node.declaration;

      if (declared.type === 'FunctionDeclaration' && declared.id) return declared.id.name;

      return source.slice(declared.start, declared.end);
    }

    if (node.type !== 'ExpressionStatement' || node.expression.type !== 'AssignmentExpression') continue;
    const target = node.expression.left;

    if (target.type !== 'MemberExpression' || target.object.type !== 'Identifier') continue;

    if (target.property.type !== 'Identifier') continue;
    const isModuleExports = target.object.name === 'module' && target.property.name === 'exports';
    const isExportsDefault = target.object.name === 'exports' && target.property.name === 'default';

    if (isModuleExports || isExportsDefault) return source.slice(node.expression.right.start, node.expression.right.end);
  }

  return null;
}

/** Strip export statements so the program body can run inside a plain function. */
function stripExports(program: acorn.Program, source: string): string {
  let out = '';
  let cursor = 0;

  for (const node of program.body) {
    if (node.type === 'ExportDefaultDeclaration') {
      const declared = node.declaration;
      out += source.slice(cursor, node.start);

      // A default-exported expression is dropped here and returned by the wrapper instead.
      if (declared.type === 'FunctionDeclaration' || declared.type === 'ClassDeclaration') {
        out += source.slice(declared.start, declared.end);
      }

      cursor = node.end;
    } else if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      out += source.slice(cursor, node.start) + source.slice(node.declaration.start, node.declaration.end);
      cursor = node.end;
    } else if (
      node.type === 'ExpressionStatement'
      && node.expression.type === 'AssignmentExpression'
      && node.expression.left.type === 'MemberExpression'
      && node.expression.left.object.type === 'Identifier'
      && (node.expression.left.object.name === 'module' || node.expression.left.object.name === 'exports')
    ) {
      out += source.slice(cursor, node.start);
      cursor = node.end;
    }
  }

  return out + source.slice(cursor);
}

/** Every refusal names the forms a tool takes, so a model that wrote statements reads how to write one. */
function refused(reason: string): CraftedSourceAdmission {
  return {
    ok: false,
    error: `${reason}. Write the tool as \`async (args) => { ... }\`, \`async function name(args) { ... }\`, `
      + 'or `const name = async (args) => { ... }`',
  };
}

/** Normalize crafted source to one parsed expression; a declaration named `preferredName` wins over later helpers. */
export function admitCraftedSource(source: string, preferredName: string): CraftedSourceAdmission {
  return settleSync(Effect.gen(function* () {
    const trimmed = source.trim().replace(/;+\s*$/, '');

    if (trimmed.length === 0) return refused('the tool source is empty');

    if (parsesAsExpression(trimmed) === null) return { ok: true, code: trimmed };

    const parsed = yield* Effect.result(Effect.try({ try: () => acorn.parse(trimmed, ECMA), catch: (cause) => ({ cause }) }));

    if (Result.isFailure(parsed)) return refused(`the tool source does not parse as JavaScript: ${renderThrownChain(parsed.failure)}`);
    const program = parsed.success;
    const exported = exportedExpression(program, trimmed);
    const { functions, variables } = topLevelDeclarations(program);
    const declared = [...functions, ...variables];

    const returned = exported
      ?? (declared.includes(preferredName) ? preferredName : declared[declared.length - 1] ?? null);

    if (returned === null) return refused('the tool source declares no function');

    const body = stripExports(program, trimmed);
    const code = `(() => {\n${body}\nreturn (${returned});\n})()`;
    const parseError = parsesAsExpression(code);

    if (parseError !== null) return refused(`the tool source could not be wrapped as an expression: ${parseError}`);

    return { ok: true, code };
  }));
}
