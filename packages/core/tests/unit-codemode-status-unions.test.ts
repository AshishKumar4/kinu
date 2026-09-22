// The codemode type text must interpolate the native tool's shared status constant, not restate it.
import { describe, test, expect } from 'bun:test';
import { SUBORDINATE_REPORT_STATUSES } from '../src/events/hub/types';
import { TASK_STATUSES, TaskListStore } from '../src/tasks/store';
import { createReportCodemodeProvider } from '../src/delegation/report-codemode';
import { createTasksCodemodeProvider } from '../src/tools/tasks-codemode';
import { createTestWorkspace, createTestActor } from './helpers';

const unionOf = (statuses: readonly string[]): string =>
  statuses.map((s) => `"${s}"`).join(' | ');

describe('codemode declared status unions come from the shared constants', () => {
  test('report.send declares every SUBORDINATE_REPORT_STATUS', () => {
    const provider = createReportCodemodeProvider(() => ({
      report: async () => ({ delivered: true }),
    }));

    const types = provider.types ?? '';
    // Pins only the status position, so unrelated signature changes do not fail this test.
    expect(types).toContain(`send(status: ${unionOf(SUBORDINATE_REPORT_STATUSES)}, `);
  });

  test('tasks.update declares every TASK_STATUS', () => {
    const ws = createTestWorkspace();
    const actor = createTestActor(ws.sql, ws.execRaw, crypto.randomUUID(), 'status-test');

    const provider = createTasksCodemodeProvider(
      new TaskListStore(ws.sql, actor, write => ws.db.transaction(write)()),
      actor.config,
    );

    const types = provider.types ?? '';
    expect(types).toContain(`update(id: string, status: ${unionOf(TASK_STATUSES)})`);
  });
});
