/** `report.send` served to whoever hired the agent. */
import { Effect } from 'effect';
import {
  SUBORDINATE_REPORT_HANDOFF_FIELDS, SUBORDINATE_REPORT_HANDOFF_MAX_CHARS,
  type SubordinateReportHandoff, type SubordinateReportHandoffField, type SubordinateReportStatus,
} from '../events/hub/types';
import type { JsonValue } from '../utils/json';
import { KinuError, settle } from '../obs/index';
import type { CodemodeProvider } from '../types/codemode';
import { serve, type Served } from '../operations/operation';
import { codemodeNamespace } from './operation-surfaces';
import { REPORT } from '../operations/report';

export interface ReportDeps {
  report(input: {
    status: SubordinateReportStatus;
    content: string;
    /** Absent when the model sent none; never present on a `bodyOnly` destination. */
    handoff?: SubordinateReportHandoff;
  }): Promise<JsonValue | undefined>;
  /** A destination that consumes only the prose body (a search node's report) is offered no handoff. */
  readonly bodyOnly?: boolean;
}

/** Read per call. The handoff budget spans all its fields; over budget is refused, not cut. */
export function serveReport(deps: () => ReportDeps): Served {
  const deliver = async (input: { status: SubordinateReportStatus; content: string; handoff?: SubordinateReportHandoff }) => (await deps().report(input)) ?? null;

  if (deps().bodyOnly === true) return serve(REPORT.sendBody, async ({ status, content }) => await deliver({ status, content }));

  return serve(REPORT.send, async (args) => {
    const handoff: { -readonly [Field in SubordinateReportHandoffField]?: string[] } = {};
    let charged = 0;

    for (const field of SUBORDINATE_REPORT_HANDOFF_FIELDS) {
      const entries = (args[field] ?? []).filter((entry) => entry.length > 0);

      if (entries.length === 0) continue;
      handoff[field] = entries;
      charged += entries.reduce((sum, entry) => sum + entry.length, 0);
    }

    if (charged > SUBORDINATE_REPORT_HANDOFF_MAX_CHARS) {
      return settle(Effect.fail(new KinuError('bad_input', `report handoff fields hold ${charged} characters, over the `
        + `${SUBORDINATE_REPORT_HANDOFF_MAX_CHARS}-character budget they share: keep each entry to one line and put the detail in \`content\` or a workspace path.`)));
    }

    return await deliver({ status: args.status, content: args.content, ...(Object.keys(handoff).length > 0 && { handoff }) });
  });
}

/** `report.*` for a hire's programs. */
export function createReportCodemodeProvider(deps: () => ReportDeps): CodemodeProvider {
  return codemodeNamespace('report', 'Report progress, completion or a blocker on your assignment.', [serveReport(deps)]);
}
