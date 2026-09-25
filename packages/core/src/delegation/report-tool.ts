/** Dispatch logic for the `report` tool, shared by the native tool and codemode `report.*`. */

import { z } from 'zod';
import { oneOf } from '../tools/tool-schema';
import {
  SUBORDINATE_REPORT_HANDOFF_FIELDS, SUBORDINATE_REPORT_HANDOFF_MAX_CHARS,
  SUBORDINATE_REPORT_STATUSES,
  type SubordinateReportHandoff, type SubordinateReportHandoffField,
} from '../events/hub/types';
import type { ReportToolDeps } from '../tools/builtins';
import type { JsonValue } from '../utils/json';
import { KinuError } from '../obs/index';

/** One handoff field: entries trimmed, blanks dropped; all four lists share one budget. */
function handoffField(purpose: string) {
  return z.array(z.string().trim())
    .describe(`${purpose} One short entry each; the four lists share ${SUBORDINATE_REPORT_HANDOFF_MAX_CHARS} characters.`)
    .transform((entries) => entries.filter((entry) => entry.length > 0))
    .optional();
}

/** What a `bodyOnly` destination takes: the status and the body. */
export const ReportBodySchema = z.object({
  status: oneOf(SUBORDINATE_REPORT_STATUSES)
    .describe('completed: the assignment is done. blocked: you need input. progress: a mid-task update.'),
  content: z.string().trim().min(1).meta({ maxLength: 20000 }).describe('The result, or what blocks you.'),
});

export const ReportHandoffFields = {
  concerns: handoffField('What you are unsure of, and the cost if you are wrong.'),
  deviations: handoffField('Where you departed from the brief, and what you did instead.'),
  findings: handoffField('Decisions and constraints that outlive this assignment.'),
  open_work: handoffField('Unfinished work and follow-ups.'),
} satisfies Record<SubordinateReportHandoffField, z.ZodType>;

/** Input of the native tool and of `report.send` in eval. */
export const ReportToolInputSchema = ReportBodySchema.extend(ReportHandoffFields);

export type ReportToolInput = z.infer<typeof ReportToolInputSchema>;

/** The handoff a report carries. The budget spans all fields; over budget is refused, not truncated. */
function handoffOf(args: ReportToolInput): SubordinateReportHandoff {
  const handoff: { -readonly [Field in SubordinateReportHandoffField]?: string[] } = {};
  let charged = 0;

  for (const field of SUBORDINATE_REPORT_HANDOFF_FIELDS) {
    const entries = args[field];

    if (entries === undefined || entries.length === 0) continue;
    handoff[field] = entries;

    for (const entry of entries) charged += entry.length;
  }

  if (charged > SUBORDINATE_REPORT_HANDOFF_MAX_CHARS) {
    throw new KinuError(
      'bad_input',
      `report handoff fields hold ${charged} characters, over the ${SUBORDINATE_REPORT_HANDOFF_MAX_CHARS}-character budget they share — `
      + 'keep each entry to one line and put the detail in `content` or a workspace path.',
    );
  }

  return handoff;
}

/** A successfully delivered report returns the publisher's domain response unchanged. */
export type ReportToolResult = JsonValue | undefined;

/**
 * Dispatch one report, parsed by {@link ReportToolInputSchema} at its entry. A `bodyOnly` destination takes no
 * handoff, and an empty handoff is omitted rather than sent as `{}`.
 */
export async function dispatchReport(deps: ReportToolDeps, args: ReportToolInput): Promise<ReportToolResult> {
  const delivery: Parameters<ReportToolDeps['report']>[0] = { status: args.status, content: args.content };

  if (!deps.bodyOnly) {
    const handoff = handoffOf(args);

    if (Object.keys(handoff).length > 0) delivery.handoff = handoff;
  }

  return await deps.report(delivery);
}
