/** `report.*` in the codemode sandbox; calls the same `ReportToolDeps.report` as the native tool. */
import { z } from 'zod';
import type { CodemodeProvider } from '../tools/sandbox-contract';
import type { ReportToolDeps } from '../tools/builtins';
import { dispatchReport, ReportHandoffFields, ReportToolInputSchema } from './report-tool';
import { refusedInput } from '../obs/index';
import {
  SUBORDINATE_REPORT_HANDOFF_FIELDS, SUBORDINATE_REPORT_STATUSES,
} from '../events/hub/types';
import { TOOL_REACH } from '../tools/registry';
import { branchableToolCall } from '../tools/outcome';

/** Third argument; an unknown field is refused with the known ones. */
const HandoffSchema = z.strictObject(
  ReportHandoffFields,
  { error: (issue) => (issue.code === 'unrecognized_keys'
    ? `the handoff takes only ${SUBORDINATE_REPORT_HANDOFF_FIELDS.join(', ')}; got ${issue.keys.join(', ')}`
    : undefined) },
).optional();

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
          const handoff = HandoffSchema.safeParse(args[2]);

          if (!handoff.success) {
            throw refusedInput('report.send(status, content, handoff)', handoff.error);
          }

          const input = ReportToolInputSchema.safeParse({ ...handoff.data, status: args[0], content: args[1] });

          if (!input.success) {
            throw refusedInput('report.send(status, content)', input.error);
          }

          return await dispatchReport(deps(), input.data);
        }),
      },
    },
  };
}
