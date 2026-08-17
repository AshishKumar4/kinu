/**
 * `report.*` — the subordinate → parent progress spine, projected into the
 * codemode sandbox. One member, mirroring the native `report` tool's one
 * action shape; calls the SAME ReportToolDeps.report the native tool does.
 */
import * as v from 'valibot';
import type { CodemodeProvider } from '../rlm.js';
import type { ReportToolDeps } from './builtins.js';
import { dispatchReport } from './report-tool.js';
import { TOOL_REACH } from './registry.js';

/** Positional args arrive untyped from the sandbox; narrowing them to two
 *  strings is this surface's only job. Which statuses exist, and what an empty
 *  body is refused with, belong to the one dispatcher both surfaces call — not
 *  to a second picklist here, which is what they used to disagree over. */
const PositionalSchema = v.tuple([v.string(), v.string()]);

const TYPES = `export declare const report: {
  /** Report progress, completion, or a blocker on your current assignment
   *  to the workspace orchestrator. completed = the assignment is done;
   *  blocked = you need input to continue; progress = a significant
   *  mid-task update worth surfacing. */
  send(status: "progress" | "completed" | "blocked", content: string): Promise<unknown>;
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
        description: 'Report progress, completion, or a blocker to the workspace orchestrator.',
        execute: async (...args: unknown[]) => {
          const positional = v.safeParse(PositionalSchema, [args[0], args[1]]);
          if (!positional.success) {
            return { error: 'report.send requires a status and content, both strings' };
          }
          const [status, content] = positional.output;
          return await dispatchReport(deps(), { status, content });
        },
      },
    },
  };
}
