/**
 * Rewrites the one V8 ReferenceError shape for a bare Kinu tool name (e.g. `run(...)`) inside `eval` into the
 * `tools.<name>(input)` correction; every other error passes through untouched.
 */

import { isBuiltinToolName, TOOL_REACH } from '../tools/registry';
import { CRAFTED_TOOL_NAMESPACE } from '../types/codemode';

/** Exact V8 message shape, so model-constructed text containing "is not defined" never misfires. */
const UNDEFINED_IDENTIFIER = /^([A-Za-z_$][\w$]*) is not defined$/;

export function explainNativeToolReferenceError(error: string): string {
  const name = UNDEFINED_IDENTIFIER.exec(error)?.[1];

  if (!name || !isBuiltinToolName(name)) return error;

  if (name === 'eval') return error;
  const namespace = TOOL_REACH[name].codemode;

  const projection = namespace
    ? ` or through the \`${namespace}\` namespace declared in this sandbox's type block`
    : '';

  return `${error} — "${name}" is a native Kinu tool. In a program call it as \`${CRAFTED_TOOL_NAMESPACE}.${name}(input)\` with the same input object the native call takes${projection}.`;
}
