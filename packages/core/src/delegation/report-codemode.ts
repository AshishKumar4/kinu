/**
 * `report.*` — the subordinate → parent progress spine, projected into the
 * codemode sandbox. One member, mirroring the native `report` tool's one
 * action shape; calls the SAME ReportToolDeps.report the native tool does.
 */
import * as v from 'valibot';
import type { CodemodeProvider } from '../tools/sandbox-contract';
import type { ReportToolDeps } from '../tools/builtins';
import { dispatchReport } from './report-tool';
import {
  SUBORDINATE_REPORT_HANDOFF_FIELDS, SUBORDINATE_REPORT_STATUSES,
} from '../events/hub/types';
import { TOOL_REACH } from '../tools/registry';
import { branchableToolCall } from '../tools/outcome';

/** Positional args arrive untyped from the sandbox; narrowing them is this
 *  surface's only job. Which statuses exist, what an empty body is refused
 *  with and how big a handoff may be belong to the one dispatcher both
 *  surfaces call — not to a second picklist here, which is what would let the
 *  two disagree. */
const PositionalSchema = v.tuple([v.string(), v.string()]);

/** The third argument: the handoff fields as one object, keyed by the same
 *  vocabulary the native tool declares, so a name the sandbox invents is
 *  refused here instead of arriving as a field nobody reads. SHAPE only —
 *  which fields exist and that each holds strings. What a handoff may WEIGH,
 *  and what an over-budget one is refused with, stay with the one dispatcher
 *  both surfaces call. */
const HandoffSchema = v.optional(
  v.record(v.picklist(SUBORDINATE_REPORT_HANDOFF_FIELDS), v.array(v.string())),
);

const STATUS_UNION = SUBORDINATE_REPORT_STATUSES.map((s) => `"${s}"`).join(' | ');

const HANDOFF_MEMBERS = SUBORDINATE_REPORT_HANDOFF_FIELDS
  .map((field) => `${field}?: string[]`).join('; ');

const TYPES = `export declare const report: {
  /** Report progress, completion, or a blocker on your current assignment
   *  to the workspace orchestrator. completed = the assignment is done;
   *  blocked = you need input to continue; progress = a significant
   *  mid-task update worth surfacing. \`handoff\` is optional and carries
   *  the parts the orchestrator has to act on: uncertainty it must weigh,
   *  where you left the brief, what you settled, and what remains. */
  send(status: ${STATUS_UNION}, content: string, handoff?: { ${HANDOFF_MEMBERS} }): Promise<unknown>;
};
`;

/** `deps` is a thunk, read per call — subordinate-only, so it never toggles
 *  mid-session, but the convention matches every other provider here. */
export function createReportCodemodeProvider(deps: () => ReportToolDeps): CodemodeProvider {
  return {
    name: TOOL_REACH.report.codemode,
    types: TYPES,
    positionalArgs: true,
    tools: {
      send: {
        planAllowed: true,
        description: 'Report progress, completion, or a blocker to the workspace orchestrator.',
        execute: (...args: unknown[]) => branchableToolCall(async () => {
          const positional = v.safeParse(PositionalSchema, [args[0], args[1]]);

          if (!positional.success) {
            return { error: 'report.send requires a status and content, both strings' };
          }

          const [status, content] = positional.output;
          const handoff = v.safeParse(HandoffSchema, args[2]);

          if (!handoff.success) {
            return { error: `report.send's third argument is an optional object of string arrays, with any of: ${SUBORDINATE_REPORT_HANDOFF_FIELDS.join(', ')}` };
          }

          return await dispatchReport(deps(), { status, content, ...handoff.output });
        }),
      },
    },
  };
}
