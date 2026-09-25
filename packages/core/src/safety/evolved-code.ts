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

/** A codemode program as the sandbox receives it: an LLM often fences it in markdown, which the
 *  sandbox strips before it runs the program, so a fenced program is read inside its fences. */
export function parseCodemodeProgram(program: string): acorn.Program | null {
  const lines = program.trim().split('\n');
  const fenced = lines.length >= 2 && lines[0]?.startsWith('```') === true && lines.at(-1)?.trim() === '```';

  return parseEvolvedCode(fenced ? lines.slice(1, -1).join('\n') : program);
}

/** Every `namespace.method(…)` the program calls, as `namespace.method`; a mention without a call,
 *  a string or a comment naming one, and a call on a deeper object (`a.tools.x()`) are not calls. */
export function namespacedCalls(program: acorn.Program, namespaces: readonly string[]): Set<string> {
  const calls = new Set<string>();

  for (const node of nodesOf(program)) {
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') continue;
    const { object, property, computed } = node.callee;

    if (object.type !== 'Identifier' || !namespaces.includes(object.name)) continue;

    if (!computed && property.type === 'Identifier') calls.add(`${object.name}.${property.name}`);
    else if (computed && property.type !== 'PrivateIdentifier') {
      const method = constantString(property);

      if (method !== null) calls.add(`${object.name}.${method}`);
    }
  }

  return calls;
}
