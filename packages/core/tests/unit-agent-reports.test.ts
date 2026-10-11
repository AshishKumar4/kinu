/** The workspace's record of what each agent reported (design v3 B): the newest report wins, and the standing it carried
 *  outlives the activation that took it, so a cold read never asks the agent. */
import { expect, test } from 'bun:test';
import { createTestActors, createTestSql } from '@kinu.run/test-utils';
import { AgentReports, initAgentReportsTable } from '../src/subordinates/report-sequence';
import type { AgentStandingReport } from '../src/subordinates/agent-isolate';

const RESTING: AgentStandingReport = {
  messageCount: 4,
  measures: { provider: { tokens: 1_200, at: '2026-10-11T00:00:00Z', seq: 3 }, gate: null },
  latestRun: { status: 'completed', userMessage: 'List the folders.' },
  pendingSteers: [],
};

const TAKEN: AgentStandingReport = { ...RESTING, messageCount: 2, latestRun: { status: null, userMessage: 'List the folders.' } };

test('the newest report stands, and a fresh activation reads it without asking the agent', () => {
  const { sql, execRaw } = createTestSql();
  const { main } = createTestActors(sql, execRaw);

  initAgentReportsTable(execRaw);

  expect(new AgentReports(sql).standing(main.actorId)).toBeNull();
  expect(new AgentReports(sql).accept(main.actorId, 2, RESTING)).toBe(true);
  // Sent before the one already taken: it changes nothing, its standing included.
  expect(new AgentReports(sql).accept(main.actorId, 1, TAKEN)).toBe(false);
  expect(new AgentReports(sql).standing(main.actorId)).toEqual(RESTING);
});
