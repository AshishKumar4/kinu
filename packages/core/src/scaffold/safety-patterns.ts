import { nodesOf, parseEvolvedCode } from '../safety/evolved-code';

const FORBIDDEN_NAMES: ReadonlySet<string> = new Set(['require', 'globalThis', 'eval', 'Function']);

/** Prose list of the forbidden constructs for LLM prompts. */
export const SCAFFOLD_FORBIDDEN_DESCRIPTION =
  'require/import, globalThis, eval(), and Function()';

/** Why `code` is not a scaffold the sandbox may run, or null: it must parse, declare
 *  `async function* run(rt, task)` at the top level, and reach none of the forbidden constructs. */
export function scaffoldRefusal(code: string): string | null {
  const program = parseEvolvedCode(code);

  if (program === null) return 'Does not parse as JavaScript';

  for (const node of nodesOf(program)) {
    if (node.type === 'ImportDeclaration' || node.type === 'ImportExpression') return 'Forbidden construct: import';

    if (node.type === 'Identifier' && FORBIDDEN_NAMES.has(node.name)) return `Forbidden construct: ${node.name}`;
  }

  const declaresRun = program.body.some((statement) => statement.type === 'FunctionDeclaration'
    && statement.id?.name === 'run' && statement.async && statement.generator
    && statement.params.length === 2
    && statement.params[0]?.type === 'Identifier' && statement.params[0].name === 'rt'
    && statement.params[1]?.type === 'Identifier' && statement.params[1].name === 'task');

  return declaresRun ? null : 'Must export async function* run(rt, task)';
}
