/**
 * The `report` tool's dispatch logic — one status, one prose body and an
 * optional structured handoff, published into the parent workspace's EventLog.
 *
 * Factored out for the reason the other three dispatchers were: `report.*` in
 * codemode (delegation/report-codemode.ts) and the native `report` tool are two
 * surfaces of one capability, and they were validating the same two arguments
 * two different ways — codemode valibot-parsed both, while the native tool
 * hand-checked `content` and never checked `status` at all, so a status outside
 * the enum reached the orchestrator's inbox typed as if it were one of the
 * three. One dispatcher, two callers, one vocabulary.
 *
 * WHY THE BODY IS NOT ENOUGH ON ITS OWN. A prose blob makes the parent
 * re-derive what the child already knew: which sentence is a decision it must
 * weigh, which is a departure from the brief it handed down, and which is
 * narration. The four handoff fields
 * ({@link SUBORDINATE_REPORT_HANDOFF_FIELDS}) are the parts a parent acts on,
 * and they are all optional — a caller that sends `{status, content}` is
 * exactly as valid as it was before they existed.
 */

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

/** One handoff field as it arrives: a list of entries, each trimmed, with the
 *  blanks a model leaves behind dropped rather than rendered to the parent as
 *  empty bullets. */
const HandoffListSchema = v.pipe(
  v.array(v.pipe(v.string(), v.trim())),
  v.transform((entries) => entries.filter((entry) => entry.length > 0)),
);

/** One handoff field as the provider is shown it. The budget sentence is
 *  shared because the budget itself is: all four lists spend one. */
function handoffField(purpose: string): HandoffProperty {
  return {
    type: 'array',
    items: { type: 'string' },
    description: `${purpose} One short entry per item — the four lists share a ${SUBORDINATE_REPORT_HANDOFF_MAX_CHARS}-character budget, so put the detail in \`content\` or leave a workspace path.`,
  };
}

/** What each handoff field is FOR, in the words the model reads. The
 *  `satisfies` is TOTAL over the vocabulary, so a field added there cannot
 *  ship undeclared — and an undeclared field is one this file's parse admits
 *  while no model is ever told it exists. */
const HANDOFF_PROPERTIES = {
  concerns: handoffField('Uncertainty the orchestrator has to weigh: what you are not confident in, and what it would cost if you are wrong.'),
  deviations: handoffField('Where the work departed from the brief you were given, and what you did instead.'),
  findings: handoffField('Decisions you took and constraints you discovered that outlive this assignment.'),
  open_work: handoffField('What remains — unfinished work, follow-ups, and what you would do next.'),
} satisfies Record<SubordinateReportHandoffField, HandoffProperty>;

/** The report tool's input as it ARRIVES. The AI SDK leaves `Schema.validate`
 *  undefined for a `jsonSchema`-declared tool input, so NOTHING here is an
 *  established value: the provider-facing enum, the non-empty body and the
 *  four lists are all requests, declared in the shape they are asked for and
 *  believed in none of them. Narrowing them is {@link dispatchReport}'s job,
 *  and the strong types are earned there — which is why they appear on
 *  `ReportToolDeps.report`, not here. */
export interface ReportToolInput extends SubordinateReportHandoff {
  status: string;
  content: string;
}

/** One handoff field as the provider is shown it. A named contract rather
 *  than a dictionary: the four names are the vocabulary's, not a key space. */
interface HandoffProperty {
  readonly type: 'array';
  readonly items: { readonly type: 'string' };
  readonly description: string;
}

/**
 * The handoff fields, as JSON-schema properties for the native tool.
 *
 * Declared here rather than in `builtins.ts` so the shape the model is
 * offered and the parse that admits it are one edit apart. NONE at all for a
 * destination that reads only the prose body: see `ReportToolDeps.bodyOnly`.
 */
export function reportHandoffProperties(deps: ReportToolDeps) {
  return deps.bodyOnly ? {} : HANDOFF_PROPERTIES;
}

/**
 * Narrow the four optional lists, or refuse in words the model can act on.
 *
 * The budget is checked ACROSS the fields rather than per field, because what
 * the parent pays is one brief, and a report that spends the whole of it on
 * concerns is making a legitimate choice. Refused rather than truncated: a
 * silently shortened list of open work is a list the parent believes it has
 * read.
 */
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
 * Dispatch one report, parsing every argument against the one vocabulary.
 *
 * A refusal names the three statuses. A refusal the model cannot act on is how
 * one malformed call becomes a loop — which is exactly what the `tasks` tool's
 * `unknown tasks action 'list">'` was.
 *
 * A `bodyOnly` destination is not offered the handoff fields, so it is not
 * parsed for them either: a value that arrived anyway was never advertised,
 * and passing it to something that drops it is the defect the declaration
 * rule exists for.
 *
 * A report that carries no handoff delivers the object it always delivered —
 * not one with an empty `handoff` beside the body. An optional field is
 * absent when unused, or every destination has to learn to tell `{}` from
 * "the child said nothing".
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
