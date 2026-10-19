/**
 * Rewrites a bare Kinu tool name's ReferenceError (e.g. `run(...)`), a namespace member read through `tools`, and
 * workerd's refusal of a module `import` inside `eval` into their corrections; every other error passes.
 */

import { retiredMember, retiredNamespace } from '../operations/retired';
import { isBuiltinToolName, TOOL_REACH } from './registry';
import { CRAFTED_TOOL_NAMESPACE, WORKSPACE_FILE_BINDINGS } from '../types/codemode';

/** Exact V8 message shape, so model-constructed text containing "is not defined" never misfires. */
const UNDEFINED_IDENTIFIER = /^([A-Za-z_$][\w$]*) is not defined$/;

const NO_SUCH_MODULE = /No such module "[^"]+"\.?$/;

/** A namespace member read through `tools`, as V8 (`tools.a.b is not a function`) and JSC word the miss. */
const THROUGH_TOOLS = /^(?:tools\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*) is not a function\b|undefined is not an object \(evaluating 'tools\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)'\)$)/;

/** What a program that reached `namespace.member` through `tools` is told: the global to call, or what replaced it. */
function throughTools(namespace: string, member: string): string {
  const retired = retiredMember(namespace, member);
  const held = `\`${CRAFTED_TOOL_NAMESPACE}\` holds only native tools and those you save; \`${namespace}\` is a global of the program`;

  return retired === null ? `${held}: call \`${namespace}.${member}(...)\`` : `${held}, and ${retired}`;
}

export function explainSandboxError(error: string): string {
  if (NO_SUCH_MODULE.test(error)) return `${error} A program imports no modules: ${WORKSPACE_FILE_BINDINGS}.`;
  const through = THROUGH_TOOLS.exec(error);
  const reached = through?.[1] ?? through?.[3];
  const member = through?.[2] ?? through?.[4];

  if (reached !== undefined && member !== undefined) return `${error}: ${throughTools(reached, member)}`;
  const name = UNDEFINED_IDENTIFIER.exec(error)?.[1];
  const retired = name === undefined ? null : retiredNamespace(name);

  if (retired !== null) return `${error}: ${retired}`;

  if (!name || !isBuiltinToolName(name)) return error;

  if (name === 'eval') return error;
  const namespace = TOOL_REACH[name].codemode;

  const projection = namespace
    ? ` or through the \`${namespace}\` namespace declared in this sandbox's type block`
    : '';

  return `${error}: "${name}" is a native Kinu tool. In a program call it as \`${CRAFTED_TOOL_NAMESPACE}.${name}(input)\` with the same input object the native call takes${projection}.`;
}
