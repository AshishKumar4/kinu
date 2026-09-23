/** TOOL_REACH is declared; a table row with nothing built for it must fail here. */

import { unobservedSearchSeams } from '@kinu.run/test-utils';
import { describe, test, expect } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { createTestRuntime, storesFor } from './helpers';
import {
  BUILTIN_TOOLS,
  TOOL_REACH,
  createAgentsCodemodeProvider,
  createAgentSelfProvider,
  createAppDataStore,
  createDbCodemodeProvider,
  createMemoryCodemodeProvider,
  createReleaseCodemodeProvider,
  createReportCodemodeProvider,
  createTasksCodemodeProvider,
  createWebCodemodeProvider,
  MissionGovernor,
  RunEventRecorder,
  TaskListStore,
  type AgentSelfHost,
  type CodemodeProvider,
  type ReleaseToolDeps,
  type ReleaseSource,
  type ReleaseChange,
  type AgentRuntime,
} from '../src/index';
import { refuseHostNode } from './helpers-actor-host';

/** The host is only consumed inside member execute (covered by unit-agent-self.test.ts). */
function agentSelfHost(
  storage: AgentRuntime['storage'], actor: AgentRuntime['actor'],
): AgentSelfHost {
  return {
    proposeCurriculumTasks: async () => [],
    listCurriculumTasks: async () => [],
    setCurriculumTaskStatus: async () => ({ ok: true }),
    proposeScaffold: async () => ({ ok: false, reason: 'not in this test' }),
    listScaffoldVersions: async () => [],
    createTimerTrigger: async () => ({ id: 't1', kind: 'timer_oneshot', nextFireAt: null }),
    budget: new MissionGovernor({ storage, actor }),
    cancelTrigger: () => ({ ok: true, changed: false }),
    jobResult: async () => null,
    listBackgroundJobs: async () => [],
    getReplayEvals: async () => [],
    armCompactNow: () => {},
  };
}

const releaseSource: ReleaseSource = {
  id: 'src-1', kind: 'github', label: 'app', repoUrl: null, defaultBranch: null,
  localDeviceId: null, localRoot: null, deployTarget: null, createdAt: 1, updatedAt: 1,
};

const releaseChange: ReleaseChange = {
  id: 'chg-1', agentName: 'a', bindingId: 'src-1', status: 'draft', userPrompt: 'p',
  plan: null, summary: null, patch: null, previewUrl: null, createdAt: 1, updatedAt: 1,
};

const releaseDeps: ReleaseToolDeps = {
  board: async () => ({ bindings: [], changes: [], checks: [], approvals: [], deployments: [] }),
  bindSource: async () => releaseSource,
  create: async () => releaseChange,
  update: async () => releaseChange,
  transition: async () => releaseChange,
  requestApproval: async () => ({
    id: 'apr-1', changeId: 'chg-1', approvalType: 'apply', decision: 'pending',
    approvedBy: null, note: null, argumentDigest: 'digest', createdAt: 1, decidedAt: null,
  }),
  recordCheck: async () => ({
    id: 'chk-1', changeId: 'chg-1', name: 'tests', status: 'passed',
    stdout: null, stderr: null, durationMs: null, createdAt: 1, updatedAt: 1,
  }),
  recordDeployment: async () => ({
    id: 'dep-1', changeId: 'chg-1', environment: 'local',
    workerVersionId: null, deploymentId: null, rollbackTarget: null, deployedAt: 1,
  }),
};

describe('the reach declaration', () => {
  test('the native surface is exactly the rows declared native, and there are 8', () => {
    const declaredNative = Object.entries(TOOL_REACH)
      .filter(([, reach]) => reach.native)
      .map(([name]) => name);

    expect(declaredNative.sort()).toEqual([...BUILTIN_TOOLS].sort());
    // Owner-set count: declarative reach must not quietly grow the standing surface.
    expect(BUILTIN_TOOLS.length).toBe(8);
    expect(BUILTIN_TOOLS).toEqual(['eval', 'shell', 'file', 'agents', 'memory', 'tasks', 'web', 'report']);
  });

  test('every declared codemode namespace is produced by a real factory', () => {
    const { rt } = createTestRuntime();
    const { history } = storesFor(rt);

    const factories = {
      agents: () => createAgentsCodemodeProvider(() => ({
        mode: 'build',
        swarm: {
          rt, model: new MockLanguageModelV3(),
          hostNode: refuseHostNode('the tool-reach suite builds providers and runs no node'),
          ...unobservedSearchSeams(),
        },
      })),
      memory: () => createMemoryCodemodeProvider(() => ({
        memory: rt.memory, sql: rt.storage.sql, actor: rt.actor,
        transcriptFor: (sessionId) => history.transcript(sessionId),
      })),
      tasks: () => createTasksCodemodeProvider(
        new TaskListStore(rt.storage.sql, rt.actor, rt.storage.transactionSync.bind(rt.storage)),
        rt.actor.config,
      ),
      web: () => createWebCodemodeProvider({
        search: async (query: string) => ({ query, results: [], source: 'duckduckgo' as const }),
        fetch: async (url: string) => ({ url, retrievedAt: new Date(0).toISOString(), markdown: '' }),
      }),
      report: () => createReportCodemodeProvider(() => ({ report: async () => ({ delivered: true }) })),
      release: () => createReleaseCodemodeProvider(() => releaseDeps),
      agent: () => createAgentSelfProvider(agentSelfHost(rt.storage, rt.actor)),
      // Real deps: an unbuildable factory is indistinguishable from an unwired namespace.
      db: () => createDbCodemodeProvider(createAppDataStore({
        sql: rt.storage.sql,
        actor: rt.actor,
        transactionSync: rt.storage.transactionSync.bind(rt.storage),
        events: () => new RunEventRecorder(rt.storage.sql, rt.actor),
        runId: () => 'run-tool-reach',
      })),
    } satisfies Record<string, () => CodemodeProvider>;

    const declared = Object.entries(TOOL_REACH)
      .filter(([name, reach]) => reach.codemode === name)
      .map(([name]) => name);

    expect(Object.keys(factories).sort()).toEqual(declared.sort());

    for (const [namespace, build] of Object.entries(factories)) {
      const provider = build();
      expect(provider.name).toBe(namespace);
      expect(Object.keys(provider.tools).length).toBeGreaterThan(0);
    }
  });

  test('run and file point at a namespace they do not own', () => {
    expect(TOOL_REACH.shell.codemode).toBe('workspace');
    expect(TOOL_REACH.file.codemode).toBe('workspace');
    expect(TOOL_REACH.slate).toEqual({ native: false, codemode: 'workspace', replay: 'claimed' });
    expect(TOOL_REACH.eval.codemode).toBeNull();
  });

  test('no capability is declared with no reach at all', () => {
    for (const [name, reach] of Object.entries(TOOL_REACH)) {
      expect({ name, reachable: reach.native || reach.codemode !== null })
        .toEqual({ name, reachable: true });
    }
  });

  test('report is declared on BOTH surfaces', () => {
    expect(TOOL_REACH.report).toEqual({ native: true, codemode: 'report', replay: 'claimed' });
  });
});
