/**
 * Which capability a codemode program REACHED — the attribution every meter
 * that reads a native tool name gets wrong.
 *
 * A builtin called through the sandbox is one native `execute_tools` call whose
 * `code` argument says `agents.swarm({…})`. So a meter keyed on the tool name
 * sees `execute_tools` and nothing else, and reports the capability as unused.
 * Measured in production, on the turn that prompted this file: five `agents.swarm`
 * calls through the sandbox, `turn_steering.converted: false`, and an advisor
 * whose prompt would have listed `agents` among the capabilities the turn "did
 * not use" — sending the agent to do again the one thing it had already done
 * five times.
 *
 * `craftedToolsUsed` already exists for exactly this reason on the crafted side
 * (evolution/types.ts). This is the same treatment owed to BUILTIN tools, and it
 * shares the scanner the crafted side uses so both read one definition of what a
 * call site in submitted code is.
 *
 * WHAT IT CANNOT DO, stated rather than discovered. `run` and `file` share the
 * `workspace` namespace, so a program calling `workspace.exec` reports BOTH as
 * reached. That direction is deliberate: the failure this exists to stop is
 * telling an agent it ignored a capability it used, and over-reporting reach
 * cannot cause it. Under-reporting can.
 */

import * as v from 'valibot';
import { stripNonCode } from '../craft/in-episode';
import type { JsonObject } from '../utils/json';
import { TOOL_REACH, isBuiltinToolName } from './registry';

/** The one tool a codemode program arrives as. */
const EXECUTE_TOOLS = 'execute_tools';

/** The submitted program's argument key, as both backends' sandbox tools name
 *  it — the same field `craft-cycle.ts` reads to score a crafted call. */
const CodeArgSchema = v.object({ code: v.string() });

/**
 * The program a settled `execute_tools` call submitted, or `''` when this was
 * not one — an absent or non-string `code` is no program rather than an error,
 * because a malformed call has no call sites to find either way.
 */
export function codemodeProgramOf(toolName: string, args: JsonObject): string {
  if (toolName !== EXECUTE_TOOLS) return '';
  const parsed = v.safeParse(CodeArgSchema, args);
  return parsed.success ? parsed.output.code : '';
}

/**
 * Did this program call the named capability through its codemode namespace?
 *
 * Read after the same blanking pass the crafted scan uses, so a capability named
 * in a comment or inside a string argument does not count as a call. The
 * namespace comes from `TOOL_REACH`, the single source for where a capability is
 * reachable — a capability whose reach changes cannot fall out of step with this.
 */
export function codemodeReaches(program: string, capability: string): boolean {
  if (program === '') return false;
  if (!isBuiltinToolName(capability)) return false;
  const namespace = TOOL_REACH[capability].codemode;
  // `execute_tools` IS the sandbox and owns no namespace inside it, so there is
  // nothing to match — and a program is never evidence of reaching it, since
  // being the program is what reaching it means.
  if (namespace === null) return false;
  return new RegExp(`(?:^|[^\\w$.])${namespace}\\.[A-Za-z_$][A-Za-z0-9_$]*\\s*\\(`)
    .test(stripNonCode(program));
}
