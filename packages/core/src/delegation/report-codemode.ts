/** `report.*` in the codemode sandbox; calls the same `ReportToolDeps.report` as the native tool. */
import * as v from 'valibot';
import type { CodemodeProvider } from '../tools/sandbox-contract';
import type { ReportToolDeps } from '../tools/builtins';
import { dispatchReport } from './report-tool';
import {
  SUBORDINATE_REPORT_HANDOFF_FIELDS, SUBORDINATE_REPORT_STATUSES,
} from '../events/hub/types';
import { TOOL_REACH } from '../tools/registry';
import { branchableToolCall } from '../tools/outcome';
import { KinuError } from '../obs';

/** Positional sandbox args are untyped; this surface only narrows them. Validation
 *  belongs to the shared dispatcher. */
const PositionalSchema = v.tuple([v.string(), v.string()]);

/** Third argument: handoff fields keyed by the native vocabulary. Shape only; budget
 *  checks stay in the dispatcher. */
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

/** `deps` is a thunk, read per call. */
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
            throw new KinuError('bad_input', 'report.send requires a status and content, both strings');
          }

          const [status, content] = positional.output;
          const handoff = v.safeParse(HandoffSchema, args[2]);

          if (!handoff.success) {
            throw new KinuError('bad_input', `report.send's third argument is an optional object of string arrays, with any of: ${SUBORDINATE_REPORT_HANDOFF_FIELDS.join(', ')}`);
          }

          return await dispatchReport(deps(), { status, content, ...handoff.output });
        }),
      },
    },
  };
}
