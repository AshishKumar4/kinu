/**
 * One `AgentClient` for a suite to drive, renderer-free: every member answers as an empty workspace does, and a member
 * only a real one could answer (a take, spend, the evolution config) refuses, naming itself. A scenario passes the
 * members it reads; the chat fixture and the ACP suite build on it, each with its own.
 */
import { missingSubagentHistory } from '@kinu.run/core';
import type { AgentClient, AgentSendResult, AgentTurnResult, LocalSessionControls } from '../../src/agent-client';
import { createCliSession } from '../../src/session';

/** A turn the send opened and finished: the result both a send and a `turn-end` event carry. */
export const TURN: Extract<AgentSendResult, { landed: 'turn' }> & AgentTurnResult = { landed: 'turn', text: '', toolCalls: [], steps: 1, durationMs: 1, hadError: false };

const refuses = (member: string) => async (): Promise<never> => {
  throw new Error(`${member}: not modelled by this fake`);
};

/** A local session's controls as an empty workspace answers them; `overrides` names what a scenario reads. */
export function fakeLocalControls(overrides: Partial<LocalSessionControls> = {}): LocalSessionControls {
  return {
    getAlwaysActiveSkills: () => [],
    setAlwaysActiveSkills: () => {},
    getShellApprovalMode: () => 'strict',
    setShellApprovalMode: (mode) => mode,
    setShellApprovalHandler: () => () => {},
    listModelProviders: async () => [],
    listInstructionApprovals: async () => ({ status: 'end' as const, items: [] }),
    readInstructionApproval: async () => null,
    approveInstruction: async () => ({ ok: true as const, path: '', digest: '' }),
    revokeInstruction: async () => ({ ok: true as const, path: '', digest: '' }),
    clearConversation: async () => null,
    compact: async () => 'folded' as const,
    ...overrides,
  };
}

export function fakeAgentClient(overrides: Partial<AgentClient> = {}): AgentClient {
  const name = overrides.agentName ?? 'test';

  const client: AgentClient = {
    mode: 'local',
    agentName: name,
    cliSession: createCliSession(name, { noTranscript: true }),
    inlineAttachmentLimitBytes: 1024,
    planes: null,
    fileLinks: { roots: [], href: () => null },
    consents: null,
    localControls: null,
    checkpoints: null,
    plans: null,
    questions: null,
    approvals: null,
    connect: async () => {},
    subscribe: () => () => {},
    send: async () => TURN,
    branch: () => false,
    fork: async () => ({ client, label: name }),
    stop: () => [],
    close: async () => {},
    history: async () => [],
    status: async () => ({ name, purpose: name, model: null, reasoningEffort: null }),
    describeTools: async () => ({ builtIn: [], crafted: [] }),
    changelog: async () => ({ entries: [], unseenCount: 0 }),
    refinements: async () => ({ requests: [], debt: { turnIds: [], owed: false, key: '', summary: 'no unresolved corrections — nothing is owed a refinement' } }),
    requestRefinement: async () => ({ id: 'refine-test', trigger: 'explicit' as const, scope: 'workspace' as const, stage: 'refused' as const, turnIds: [], routes: [], detail: 'no outcome-labeled turns yet', createdAt: 0 }),
    revertChangelogEntry: async () => ({ ok: false }),
    readMemory: async () => '',
    searchNodes: async () => [],
    listJobs: async () => [],
    cancelJob: async () => ({ ok: false }),
    latestTakes: async () => null,
    pickTake: refuses('pickTake'),
    getModelSpec: async () => null,
    setModel: async (spec) => ({ spec }),
    setRole: async (role) => ({ role }),
    getReasoningEffort: async () => null,
    setReasoningEffort: async (effort) => ({ effort }),
    getProviderAccounts: async () => ({}),
    setProviderAccount: async () => ({}),
    workspaceSpend: refuses('workspaceSpend'),
    getEvolutionConfig: refuses('getEvolutionConfig'),
    setEvolutionConfig: refuses('setEvolutionConfig'),
    listModels: async () => ({ models: [], failures: [] }),
    testModel: async () => ({ ok: true, firstTokenMs: 0, totalMs: 0 }),
    inspectSubagent: async (request) => missingSubagentHistory(request.path),
    workspaceWork: async () => ({ plans: [], tasks: [] }),
    ...overrides,
  };

  return client;
}
