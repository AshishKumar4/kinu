/**
 * The `report` tool's dispatch logic — one status + one body, published into
 * the parent workspace's EventLog.
 *
 * Factored out for the reason the other three dispatchers were: `report.*` in
 * codemode (tools/report-codemode.ts) and the native `report` tool are two
 * surfaces of one capability, and they were validating the same two arguments
 * two different ways — codemode valibot-parsed both, while the native tool
 * hand-checked `content` and never checked `status` at all, so a status outside
 * the enum reached the orchestrator's inbox typed as if it were one of the
 * three. One dispatcher, two callers, one vocabulary.
 */

import * as v from 'valibot';
import { SUBORDINATE_REPORT_STATUSES } from '../events/hub/types';
import { unknownActionError } from './registry';
import type { ReportToolDeps } from './builtins';
import type { JsonValue } from '../utils/json';
import { renderThrownChain } from '../obs/index';

const StatusSchema = v.picklist(SUBORDINATE_REPORT_STATUSES);
const ContentSchema = v.pipe(v.string(), v.trim(), v.minLength(1));

/** The report tool's input as it ARRIVES — both fields are strings the model
 *  wrote, not established values. The AI SDK leaves `Schema.validate`
 *  undefined for a `jsonSchema`-declared tool input, so the provider-facing
 *  enum is a request, not a guarantee. Narrowing `status` to one of the three
 *  is {@link dispatchReport}'s job, and the strong type is earned there —
 *  which is why it appears on `ReportToolDeps.report`, not here. */
export interface ReportToolInput {
  status: string;
  content: string;
}

/** What the model gets back: whatever the publish returned, or a refusal. */
export type ReportToolResult = JsonValue | undefined | { error: string };

/**
 * Dispatch one report, parsing both arguments against the one vocabulary.
 *
 * A refusal names the three statuses. A refusal the model cannot act on is how
 * one malformed call becomes a loop — which is exactly what the `tasks` tool's
 * `unknown tasks action 'list">'` was.
 */
export async function dispatchReport(
  deps: ReportToolDeps,
  args: ReportToolInput,
): Promise<ReportToolResult> {
  const status = v.safeParse(StatusSchema, args.status);
  if (!status.success) {
    return { error: unknownActionError('report', 'status', args.status, SUBORDINATE_REPORT_STATUSES) };
  }
  const content = v.safeParse(ContentSchema, args.content);
  if (!content.success) return { error: 'report requires non-empty `content`' };
  try {
    return await deps.report({ status: status.output, content: content.output });
  } catch (err) {
    return { error: renderThrownChain({ cause: err }) };
  }
}
