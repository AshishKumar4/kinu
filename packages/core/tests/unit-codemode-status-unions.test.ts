// A codemode projection's TYPE text must not restate an enum its native tool
// already owns — it interpolates the shared constant, so a status added there
// arrives here instead of drifting into a second picklist.
import { describe, test, expect } from 'bun:test';
import { SUBORDINATE_REPORT_STATUSES } from '../src/events/hub/types';
import { TASK_STATUSES, TaskListStore } from '../src/tasks/store';
import { createAgentConfigStore } from '../src/config/store';
import { createReportCodemodeProvider } from '../src/tools/report-codemode';
import { createTasksCodemodeProvider } from '../src/tools/tasks-codemode';
import { createTestWorkspace } from './helpers';

const unionOf = (statuses: readonly string[]): string =>
  statuses.map((s) => `"${s}"`).join(' | ');

describe('codemode declared status unions come from the shared constants', () => {
  test('report.send declares every SUBORDINATE_REPORT_STATUS', () => {
    const provider = createReportCodemodeProvider(() => ({
      report: async () => ({ delivered: true }),
    }));
    const types = provider.types ?? '';
    expect(types).toContain(`send(status: ${unionOf(SUBORDINATE_REPORT_STATUSES)}, content: string)`);
  });

  test('tasks.update declares every TASK_STATUS', () => {
    const ws = createTestWorkspace();
    const provider = createTasksCodemodeProvider(
      new TaskListStore(ws.sql),
      createAgentConfigStore(ws.sql),
    );
    const types = provider.types ?? '';
    expect(types).toContain(`update(id: string, status: ${unionOf(TASK_STATUSES)})`);
  });
});
