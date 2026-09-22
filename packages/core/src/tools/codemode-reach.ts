/**
 * Which builtin capability a codemode `eval` program reached, since tool-name meters only see `eval`.
 * `shell` and `file` share `workspace`, so both report as reached: over-reporting is deliberate.
 */

import * as v from 'valibot';
import { stripNonCode } from '../craft/in-episode';
import type { JsonObject } from '../utils/json';
import { TOOL_REACH, isBuiltinToolName } from './registry';

/** The one tool a codemode program arrives as. */
const CODEMODE_TOOL = 'eval';

/** Same field `craft-cycle.ts` reads to score a crafted call. */
const CodeArgSchema = v.object({ code: v.string() });

/** The program a settled `eval` call submitted, or `''` (malformed `code` counts as no program). */
export function codemodeProgramOf(toolName: string, args: JsonObject): string {
  if (toolName !== CODEMODE_TOOL) return '';
  const parsed = v.safeParse(CodeArgSchema, args);

  return parsed.success ? parsed.output.code : '';
}

/** Did this program call the capability through its codemode namespace (comments and strings ignored)? */
export function codemodeReaches(program: string, capability: string): boolean {
  if (program === '') return false;

  if (!isBuiltinToolName(capability)) return false;
  const namespace = TOOL_REACH[capability].codemode;

  // `eval` is the sandbox and owns no namespace inside it.
  if (namespace === null) return false;

  return new RegExp(`(?:^|[^\\w$.])${namespace}\\.[A-Za-z_$][A-Za-z0-9_$]*\\s*\\(`)
    .test(stripNonCode(program));
}
