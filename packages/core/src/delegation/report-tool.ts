/** Dispatch logic for the `report` tool, shared by the native tool and codemode `report.*`. */

import * as v from 'valibot';
import {
  SUBORDINATE_REPORT_HANDOFF_FIELDS, SUBORDINATE_REPORT_HANDOFF_MAX_CHARS,
  SUBORDINATE_REPORT_STATUSES,
  type SubordinateReportHandoff, type SubordinateReportHandoffField,
} from '../events/hub/types';
import { unknownActionError } from '../tools/registry';
import type { ReportToolDeps } from '../tools/builtins';
import type { JsonValue } from '../utils/json';
import { KinuError } from '../obs/index';

const StatusSchema = v.picklist(SUBORDINATE_REPORT_STATUSES);

const ContentSchema = v.pipe(v.string(), v.trim(), v.minLength(1));

/** One handoff field as it arrives: entries trimmed, blanks dropped. */
const HandoffListSchema = v.pipe(
  v.array(v.pipe(v.string(), v.trim())),
  v.transform((entries) => entries.filter((entry) => entry.length > 0)),
);

/** One handoff field as shown to the provider; all four lists share one budget. */
function handoffField(purpose: string): HandoffProperty {
  return {
    type: 'array',
    items: { type: 'string' },
    description: `${purpose} One short entry each; the four lists share ${SUBORDINATE_REPORT_HANDOFF_MAX_CHARS} characters.`,
  };
}

/** What each handoff field is for, in the model's words; `satisfies` keeps it total. */
const HANDOFF_PROPERTIES = {
  concerns: handoffField('What you are unsure of, and the cost if you are wrong.'),
  deviations: handoffField('Where you departed from the brief, and what you did instead.'),
  findings: handoffField('Decisions and constraints that outlive this assignment.'),
  open_work: handoffField('Unfinished work and follow-ups.'),
} satisfies Record<SubordinateReportHandoffField, HandoffProperty>;

/** Report input as it arrives, unvalidated: the AI SDK skips `Schema.validate` for
 *  `jsonSchema` inputs. {@link dispatchReport} narrows it. */
export interface ReportToolInput extends SubordinateReportHandoff {
  status: string;
  content: string;
}

interface HandoffProperty {
  readonly type: 'array';
  readonly items: { readonly type: 'string' };
  readonly description: string;
}

/** Handoff fields as JSON-schema properties; none for a `bodyOnly` destination. */
export function reportHandoffProperties(deps: ReportToolDeps) {
  return deps.bodyOnly ? {} : HANDOFF_PROPERTIES;
}

/** Narrow the four optional lists. The budget spans all fields; over budget is refused, not truncated. */
function parseHandoff(args: ReportToolInput): SubordinateReportHandoff {
  const handoff: { -readonly [Field in SubordinateReportHandoffField]?: string[] } = {};
  let charged = 0;

  for (const field of SUBORDINATE_REPORT_HANDOFF_FIELDS) {
    const arriving = args[field];

    if (arriving === undefined || arriving === null) continue;
    const entries = v.safeParse(HandoffListSchema, arriving);

    if (!entries.success) {
      throw new KinuError('bad_input', `report \`${field}\` must be an array of strings, one short entry per item`);
    }

    if (entries.output.length === 0) continue;
    handoff[field] = entries.output;

    for (const entry of entries.output) charged += entry.length;
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
 * Dispatch one report. Refusals name the valid statuses; a `bodyOnly` destination is not
 * parsed for handoff, and an empty handoff is omitted rather than sent as `{}`.
 */
export async function dispatchReport(
  deps: ReportToolDeps,
  args: ReportToolInput,
): Promise<ReportToolResult> {
  const status = v.safeParse(StatusSchema, args.status);

  if (!status.success) {
    throw new KinuError('bad_input', unknownActionError('report', 'status', args.status, SUBORDINATE_REPORT_STATUSES));
  }

  const content = v.safeParse(ContentSchema, args.content);

  if (!content.success) throw new KinuError('bad_input', 'report requires non-empty `content`');

  const delivery: Parameters<ReportToolDeps['report']>[0] = {
    status: status.output, content: content.output,
  };

  if (!deps.bodyOnly) {
    const handoff = parseHandoff(args);

    if (Object.keys(handoff).length > 0) delivery.handoff = handoff;
  }

  return await deps.report(delivery);
}
