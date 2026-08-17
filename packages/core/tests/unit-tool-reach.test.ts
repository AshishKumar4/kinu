/**
 * The reach axis — TOOL_REACH, and the two directions that keep it honest.
 *
 * How the model reaches a capability used to be emergent rather than declared:
 * native meant "whichever names buildBuiltinTools happened to emit", codemode
 * meant "whichever createXCodemodeProvider some backend actor class happened to
 * call", and the Tools panel guessed `nativeNames.has(name) ? 'native' :
 * 'codemode'` — a binary with no way to say "neither", which is why the one
 * deps-gated builtin (`report`) rendered as codemode-only on an orchestrator,
 * an actor that has it on no surface at all.
 *
 * Every codemode factory now takes its provider `name` straight from the table,
 * so a namespace the table stops declaring fails to COMPILE. What a test still
 * has to catch is the reverse: a row added to the table with nothing built for
 * it — a capability declared reachable that the model can never call, which is
 * this codebase's signature defect shape.
 */

import { describe, test, expect } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { createTestRuntime } from './helpers.js';
import {
  BUILTIN_TOOLS,
  TOOL_REACH,
  createAgentsCodemodeProvider,
  createAgentSelfProvider,
  createMemoryCodemodeProvider,
  createReleaseCodemodeProvider,
  createReportCodemodeProvider,
  createRLMProvider,
  createTasksCodemodeProvider,
  createWebCodemodeProvider,
  createStrategyRegistry,
  createAgentConfigStore,
  MissionGovernor,
  TaskListStore,
  type AgentSelfHost,
  type CodemodeProvider,
  type ReleaseToolDeps,
  type ReleaseSource,
  type ReleaseChange,
  type AgentRuntime,
} from '../src/index.js';

/** `createAgentSelfProvider` reads nothing off the host at construction — the
 *  host is consumed inside each member's execute, which unit-agent-self.test.ts
 *  covers. This exists only so the provider can be built here. */
function agentSelfHost(storage: AgentRuntime['storage']): AgentSelfHost {
  return {
    proposeCurriculumTasks: async () => [],
    listCurriculumTasks: async () => [],
    setCurriculumTaskStatus: async () => ({ ok: true }),
    proposeScaffold: async () => ({ ok: false, reason: 'not in this test' }),
    listScaffoldVersions: () => [],
    createTimerTrigger: () => ({ id: 't1', kind: 'timer_oneshot', nextFireAt: null }),
    budget: new MissionGovernor({ storage }),
    cancelTrigger: () => ({ ok: true, changed: false }),
    jobResult: async () => null,
    listBackgroundJobs: async () => [],
    getReplayEvals: async () => [],
    armCompactNow: () => {},
  };
}

/** The ledger half only — `release.*`'s action set is gated on `engine`, and
 *  which half is present is not what this test is about. */
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
    // The count the owner set deliberately (10 → 8, 2026-08-13). Making reach
    // declarative must not become a quiet way to grow the standing surface, so
    // the number is asserted, not merely the set.
    expect(BUILTIN_TOOLS.length).toBe(8);
  });

  test('every declared codemode namespace is produced by a real factory', () => {
    const { rt } = createTestRuntime();
    const factories = {
      agents: () => createAgentsCodemodeProvider(() => ({
        mode: 'build',
        fork: { registry: createStrategyRegistry(), rt, model: new MockLanguageModelV3() },
      })),
      memory: () => createMemoryCodemodeProvider(() => ({ memory: rt.memory, sql: rt.storage.sql })),
      tasks: () => createTasksCodemodeProvider(
        new TaskListStore(rt.storage.sql),
        createAgentConfigStore(rt.storage.sql),
      ),
      web: () => createWebCodemodeProvider({
        search: async (query: string) => ({ query, results: [], source: 'duckduckgo' as const }),
        fetch: async (url: string) => ({ url, retrievedAt: new Date(0).toISOString(), markdown: '' }),
      }),
      report: () => createReportCodemodeProvider(() => ({ report: async () => ({ delivered: true }) })),
      release: () => createReleaseCodemodeProvider(() => releaseDeps),
      agent: () => createAgentSelfProvider(agentSelfHost(rt.storage)),
      llm: () => createRLMProvider(
        { normalizeSpecSync: () => 'test/model', resolveModel: () => new MockLanguageModelV3() },
        () => 'test/model',
      ),
    } satisfies Record<string, () => CodemodeProvider>;

    const declared = Object.entries(TOOL_REACH)
      .filter(([name, reach]) => reach.codemode === name)
      .map(([name]) => name);
    // Set equality is the exhaustiveness half: a row added to TOOL_REACH with
    // nothing built for it fails here.
    expect(Object.keys(factories).sort()).toEqual(declared.sort());

    for (const [namespace, build] of Object.entries(factories)) {
      const provider = build();
      expect(provider.name).toBe(namespace);
      // A namespace with no members is a declaration the model cannot use.
      expect(Object.keys(provider.tools).length).toBeGreaterThan(0);
    }
  });

  test('run and file point at a namespace they do not own', () => {
    // The reason `codemode` is a namespace string rather than a boolean: these
    // two are reachable in the sandbox through the shared `workspace`
    // primitives they already dispatch into, under a different name.
    expect(TOOL_REACH.run.codemode).toBe('workspace');
    expect(TOOL_REACH.file.codemode).toBe('workspace');
    // execute_tools IS the sandbox, so it owns no namespace inside it.
    expect(TOOL_REACH.execute_tools.codemode).toBeNull();
  });

  test('no capability is declared with no reach at all', () => {
    for (const [name, reach] of Object.entries(TOOL_REACH)) {
      expect({ name, reachable: reach.native || reach.codemode !== null })
        .toEqual({ name, reachable: true });
    }
  });

  test('report is declared on BOTH surfaces', () => {
    // The owner's report: the Tools panel showed `report` as codemode-only. It
    // is native wherever it exists AND owns a codemode namespace; what the panel
    // was actually rendering was absence on that actor, with no third state to
    // say so.
    expect(TOOL_REACH.report).toEqual({ native: true, codemode: 'report' });
  });
});
