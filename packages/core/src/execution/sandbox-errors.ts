/**
 * Codemode sandbox error enrichment.
 *
 * Both `execute_tools` sandboxes (CF: PreambleCraftedExecutor over
 * DynamicWorkerExecutor; CLI: the Node `new Function` factory) bind a fixed
 * set of namespaces — `workspace`, `codemode`, `tools`, plus whatever
 * ExecutionRouter/CodemodeProvider namespaces the actor registers. Proteus's
 * OWN top-level tools (`run`, `agents`, `file`, `memory`, `tasks`, `web`,
 * `report`) are NOT in that scope — they are separate tool calls, not
 * codemode members — but a model reaching for one from inside a code block
 * is an easy, recurring mistake: `run` in particular reads as a plausible
 * global because it IS a tool the model can see in its own tool list.
 *
 * When that happens the sandbox throws a bare V8 ReferenceError
 * (`"run is not defined"`), which both executors propagate verbatim as
 * `Code execution failed: run is not defined` — accurate, and useless: it
 * names the missing identifier but never says WHY it's missing or what to do
 * instead. This rewrites exactly that one error shape into an actionable
 * correction; every other error (a real bug in the model's code, a thrown
 * provider error, a timeout) passes through untouched.
 */

import { BUILTIN_TOOL_NAMES } from '../tools/registry.js';

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
  if (!name || name === 'execute_tools' || !BUILTIN_TOOL_NAMES.has(name)) return error;
  const alternative = name === 'run'
    ? ' Call `run` directly as its own top-level tool call, not from inside execute_tools — or, for a command against this sandbox\'s own workspace, use `workspace.exec(...)` here instead.'
    : ` Call \`${name}\` directly as its own top-level tool call — it is not reachable from inside execute_tools.`;
  return `${error} — "${name}" is a native Proteus tool, not a codemode member.${alternative}`;
}
