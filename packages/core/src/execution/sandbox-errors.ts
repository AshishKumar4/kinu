/**
 * Codemode sandbox error enrichment.
 *
 * Both `execute_tools` sandboxes (CF: PreambleCraftedExecutor over
 * DynamicWorkerExecutor; CLI: the Node `new Function` factory) bind a fixed
 * set of namespaces — `workspace`, `codemode`, `tools`, plus whatever
 * ExecutionRouter/CodemodeProvider namespaces the actor registers. Proteus's
 * OWN top-level tool NAMES are not in that scope: they are separate tool
 * calls, not codemode members. But a model reaching for one from inside a code
 * block is an easy, recurring mistake — `run` in particular reads as a
 * plausible global because it IS a tool the model can see in its own list.
 *
 * When that happens the sandbox throws a bare V8 ReferenceError
 * (`"run is not defined"`), which both executors propagate verbatim as
 * `Code execution failed: run is not defined` — accurate, and useless: it
 * names the missing identifier but never says WHY it's missing or what to do
 * instead. This rewrites exactly that one error shape into an actionable
 * correction; every other error (a real bug in the model's code, a thrown
 * provider error, a timeout) passes through untouched.
 *
 * Where the capability actually IS comes from the registry's declared reach,
 * not from a list here. It used to be a hardcoded `name === 'run'` branch
 * naming `workspace.exec`, with every other native tool told "it is not
 * reachable from inside execute_tools" — false for the six that own a codemode
 * namespace and for `file`, whose bytes are `workspace.readFile`/`writeFile`/
 * `editFile`. One read of TOOL_REACH makes the sentence true for all eight.
 */

import { isBuiltinToolName, TOOL_REACH } from '../tools/registry.js';

/** V8's ReferenceError message for a bare undefined identifier — the exact,
 *  stable shape Node/workerd/browsers all emit, so matching it precisely
 *  (rather than loosely on the substring "is not defined") never misfires on
 *  an error a model's own code text happens to construct. */
const UNDEFINED_IDENTIFIER = /^([A-Za-z_$][\w$]*) is not defined$/;

/**
 * If `error` is exactly a ReferenceError naming one of Proteus's own native
 * tools, append the correction; otherwise return it unchanged.
 */
export function explainNativeToolReferenceError(error: string): string {
  const name = UNDEFINED_IDENTIFIER.exec(error)?.[1];
  if (!name || !isBuiltinToolName(name)) return error;
  const namespace = TOOL_REACH[name].codemode;
  // execute_tools declares no codemode reach because it IS the sandbox; it
  // names no other tool, so there is nothing to correct toward.
  if (!namespace) return error;
  return `${error} — "${name}" is a native Proteus tool, not a codemode member.`
    + ` Call \`${name}\` directly as its own top-level tool call, or reach the same capability from in here through the \`${namespace}\` namespace — its members are declared in this sandbox's type block.`;
}
