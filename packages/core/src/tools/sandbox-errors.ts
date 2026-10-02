/**
 * Rewrites a bare Kinu tool name's ReferenceError (e.g. `run(...)`) and workerd's refusal of a module `import` inside
 * `eval` into their corrections; every other error passes.
 */

import { isBuiltinToolName, TOOL_REACH } from './registry';
import { CRAFTED_TOOL_NAMESPACE, WORKSPACE_FILE_BINDINGS } from '../types/codemode';

/** Exact V8 message shape, so model-constructed text containing "is not defined" never misfires. */
const UNDEFINED_IDENTIFIER = /^([A-Za-z_$][\w$]*) is not defined$/;

const NO_SUCH_MODULE = /No such module "[^"]+"\.?$/;

export function explainSandboxError(error: string): string {
  if (NO_SUCH_MODULE.test(error)) return `${error} A program imports no modules: ${WORKSPACE_FILE_BINDINGS}.`;
  const name = UNDEFINED_IDENTIFIER.exec(error)?.[1];

  if (!name || !isBuiltinToolName(name)) return error;

  if (name === 'eval') return error;
  const namespace = TOOL_REACH[name].codemode;

  const projection = namespace
    ? ` or through the \`${namespace}\` namespace declared in this sandbox's type block`
    : '';

  return `${error}: "${name}" is a native Kinu tool. In a program call it as \`${CRAFTED_TOOL_NAMESPACE}.${name}(input)\` with the same input object the native call takes${projection}.`;
}
