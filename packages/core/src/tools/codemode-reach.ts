/**
 * The program a codemode `eval` call submitted, since tool-name meters only see `eval`.
 */

import * as v from 'valibot';
import type { JsonObject } from '../utils/json';

const CODEMODE_TOOL = 'eval';

/** Same field `craft-cycle.ts` reads to score a crafted call. */
const CodeArgSchema = v.object({ code: v.string() });

/** The program a settled `eval` call submitted, or `''` (malformed `code` counts as no program). */
export function codemodeProgramOf(toolName: string, args: JsonObject): string {
  if (toolName !== CODEMODE_TOOL) return '';
  const parsed = v.safeParse(CodeArgSchema, args);

  return parsed.success ? parsed.output.code : '';
}
