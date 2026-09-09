/**
 * The reach axis — TOOL_REACH, and the two directions that keep it honest.
 *
 * How the model reaches a capability is DECLARED, not emergent. Left emergent,
 * native means "whichever names buildBuiltinTools happened to emit", codemode
 * means "whichever createXCodemodeProvider some backend actor class happened to
 * call", and the Tools panel guesses `nativeNames.has(name) ? 'native' :
 * 'codemode'` — a binary with no way to say "neither", which is how the one
 * deps-gated builtin (`report`) renders as codemode-only on an orchestrator,
 * an actor that has it on no surface at all.
 *
 * Every codemode factory takes its provider `name` straight from the table,
 * so a namespace the table stops declaring fails to COMPILE. What a test still
 * has to catch is the reverse: a row added to the table with nothing built for
 * it — a capability declared reachable that the model can never call, which is
 * this codebase's signature defect shape.
 */

import { describe, test, expect } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { createTestRuntime } from './helpers';
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

/** `createAgentSelfProvider` reads nothing off the host at construction — the
 *  host is consumed inside each member's execute, which unit-agent-self.test.ts
 *  covers. This exists only so the provider can be built here. */
function agentSelfHost(
  storage: AgentRuntime['storage'], actor: AgentRuntime['actor'],
): AgentSelfHost {
  return {
    proposeCurriculumTasks: async () => [],
    listCurriculumTasks: async () => [],
    setCurriculumTaskStatus: async () => ({ ok: true }),
    proposeScaffold: async () => ({ ok: false, reason: 'not in this test' }),
    listScaffoldVersions: () => [],
    createTimerTrigger: async () => ({ id: 't1', kind: 'timer_oneshot', nextFireAt: null }),
    budget: new MissionGovernor({ storage, actor }),
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
    expect(BUILTIN_TOOLS).toEqual(['execute_tools', 'run', 'file', 'agents', 'memory', 'tasks', 'web', 'report']);
  });

  test('every declared codemode namespace is produced by a real factory', () => {
    const { rt } = createTestRuntime();
    const factories = {
      agents: () => createAgentsCodemodeProvider(() => ({
        mode: 'build',
        // REFUSES to seat a node rather than answering with a stub: this case
        // only builds each provider, so a node hosted here would be a node
        // nothing asked for, running under a fabricated actor.
        fork: {
          rt, model: new MockLanguageModelV3(),
          hostNode: refuseHostNode('the tool-reach suite builds providers and runs no node'),
        },
      })),
      memory: () => createMemoryCodemodeProvider(() => ({ memory: rt.memory, sql: rt.storage.sql, actor: rt.actor })),
      tasks: () => createTasksCodemodeProvider(
        new TaskListStore(rt.storage.sql, rt.actor, rt.storage.transactionSync),
        rt.actor.config,
      ),
      web: () => createWebCodemodeProvider({
        search: async (query: string) => ({ query, results: [], source: 'duckduckgo' as const }),
        fetch: async (url: string) => ({ url, retrievedAt: new Date(0).toISOString(), markdown: '' }),
      }),
      report: () => createReportCodemodeProvider(() => ({ report: async () => ({ delivered: true }) })),
      release: () => createReleaseCodemodeProvider(() => releaseDeps),
      agent: () => createAgentSelfProvider(agentSelfHost(rt.storage, rt.actor)),
      // The agent-data namespace over a REAL store on this runtime's own
      // database. `events` and `runId` are read per mutation, and this case
      // performs none — but they are the actor's real recorder and a named run
      // rather than throwing stubs, because a factory that cannot be built is
      // indistinguishable here from a namespace nobody wired.
      db: () => createDbCodemodeProvider(createAppDataStore({
        sql: rt.storage.sql,
        actor: rt.actor,
        transactionSync: rt.storage.transactionSync,
        events: () => new RunEventRecorder(rt.storage.sql, rt.actor),
        runId: () => 'run-tool-reach',
      })),
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
    expect(TOOL_REACH.slate).toEqual({ native: false, codemode: 'workspace', replay: 'claimed' });
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
    expect(TOOL_REACH.report).toEqual({ native: true, codemode: 'report', replay: 'claimed' });
  });
});
