import * as acorn from 'acorn';
import * as v from 'valibot';

/** Evolved code runs as the body of an async function in the sandbox, so a script form comes first. */
const SCRIPT: acorn.Options = {
  ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true,
};

const MODULE: acorn.Options = { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true };

/** The program, or null when the source parses in neither form. */
export function parseEvolvedCode(source: string): acorn.Program | null {
  for (const options of [SCRIPT, MODULE]) {
    try {
      return acorn.parse(source, options);
    } catch (cause) {
      if (!(cause instanceof SyntaxError)) throw cause;
    }
  }

  return null;
}

/** A child of an acorn node that is itself a node: every acorn node carries a type and its span. */
const AcornNodeSchema = v.custom<acorn.AnyNode>((input) => v.is(v.looseObject({ type: v.string(), start: v.number(), end: v.number() }), input));

export function* nodesOf(root: acorn.AnyNode): Generator<acorn.AnyNode> {
  yield root;

  for (const value of Object.values(root)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (v.is(AcornNodeSchema, child)) yield* nodesOf(child);
    }
  }
}

/** The string an expression evaluates to when every part of it is a literal, else null. */
export function constantString(node: acorn.AnyNode): string | null {
  if (node.type === 'Literal') return v.is(v.string(), node.value) ? node.value : null;

  if (node.type === 'TemplateLiteral') {
    if (node.expressions.length > 0) return null;

    return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('');
  }

  if (node.type === 'BinaryExpression' && node.operator === '+' && node.left.type !== 'PrivateIdentifier') {
    const left = constantString(node.left);
    const right = constantString(node.right);

    return left === null || right === null ? null : left + right;
  }

  return null;
}
