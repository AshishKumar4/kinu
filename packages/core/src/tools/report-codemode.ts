/**
 * `report.*` — the subordinate → parent progress spine, projected into the
 * codemode sandbox. One member, mirroring the native `report` tool's one
 * action shape; calls the SAME ReportToolDeps.report the native tool does.
 */
import type { CodemodeProvider } from '../rlm.js';
import type { ReportToolDeps } from './builtins.js';

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
    name: 'report',
    types: TYPES,
    positionalArgs: true,
    tools: {
      send: {
        description: 'Report progress, completion, or a blocker to the workspace orchestrator.',
        execute: async (...args: unknown[]) => {
          const status = args[0] as 'progress' | 'completed' | 'blocked';
          const content = String(args[1] ?? '');
          if (!content.trim()) return { error: 'report.send requires non-empty content' };
          try {
            return await deps().report({ status, content });
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
      },
    },
  };
}
