/**
 * Codemode sandbox error enrichment.
 *
 * Both `execute_tools` sandboxes bind a fixed set of namespaces — `tools`,
 * `state`, `workspace`, plus whatever ExecutionRouter/CodemodeProvider
 * namespaces the actor registers. Kinu's OWN top-level tool NAMES are not bare
 * identifiers in that scope: a native tool is `tools.<name>(input)` there. A
 * model reaching for a bare `run(...)` from inside a program is an easy,
 * recurring mistake — `run` in particular reads as a plausible global because
 * it IS a tool the model can see in its own list.
 *
 * When that happens the sandbox throws a bare V8 ReferenceError
 * (`"run is not defined"`), which both executors propagate verbatim — accurate,
 * and useless: it names the missing identifier but never says what to write
 * instead. This rewrites exactly that one error shape into the correction;
 * every other error (a real bug in the model's code, a thrown provider error)
 * passes through untouched.
 */

import { isBuiltinToolName, TOOL_REACH } from '../tools/registry';
import { CRAFTED_TOOL_NAMESPACE } from '../tools/sandbox-contract';

/** V8's ReferenceError message for a bare undefined identifier — the exact,
 *  stable shape Node/workerd/browsers all emit, so matching it precisely
 *  (rather than loosely on the substring "is not defined") never misfires on
 *  an error a model's own code text happens to construct. */
const UNDEFINED_IDENTIFIER = /^([A-Za-z_$][\w$]*) is not defined$/;

/**
 * If `error` is exactly a ReferenceError naming one of Kinu's own native
 * tools, append the correction; otherwise return it unchanged.
 */
export function explainNativeToolReferenceError(error: string): string {
  const name = UNDEFINED_IDENTIFIER.exec(error)?.[1];
  if (!name || !isBuiltinToolName(name)) return error;
  // execute_tools IS the sandbox; a program cannot call it from inside itself.
  if (name === 'execute_tools') return error;
  const namespace = TOOL_REACH[name].codemode;
  const projection = namespace
    ? ` or through the \`${namespace}\` namespace declared in this sandbox's type block`
    : '';
  return `${error} — "${name}" is a native Kinu tool. In a program call it as \`${CRAFTED_TOOL_NAMESPACE}.${name}(input)\` with the same input object the native call takes${projection}.`;
}
