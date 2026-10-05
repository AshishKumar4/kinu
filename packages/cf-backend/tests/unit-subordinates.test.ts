import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
// How this backend hosts core's subordinate module (policy: core/tests/unit-subordinates.test.ts), read
// through the actor's own bootstrap reads, a hosted child's runtime, and the tools each actor is built with.
import './helpers/ui-module-globals';
import { describe, expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import * as v from 'valibot';
import {
  actorConnectionTag, BUILTIN_TOOLS, DEPS_GATED_TOOLS,
  observedActionEnum, REPORT_TOOL, SubordinateInspectionRequestSchema, type JsonValue, type Rpc, TASK_TURN_ENDINGS, terminalTaskReport,
} from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';
import { KeptTranscript } from '../src/components/KeptTranscript';
import { HelperChatBase, MessageView } from '../src/components/MessageView';
import { nestedAgent } from '@kinu.run/core';
import type { UIMessage } from 'ai';
import { mockAgentsSdk } from './helpers/agents-sdk';
import {
  agentSql, chatSessionTurns, gatewayWorkspace, hostedSubordinateHarness, orchestratorHarness, rosterOver, runDelegatedTask, workspaceFiles,
} from './helpers/actor-harness';
import { socketConnection } from './helpers/bindings';
import { answeringGateway, chatCompletion, offeredTools, openingOf, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

mockAgentsSdk();

// After the mock: a static import would bind the class to the real `agents` Agent.
const { ActorAgent } = await import('../src/actor-agent');

describe('subordinate wiring', () => {
  /** The temporary rung's CF wiring; behaviour is core's (core/tests/unit-temporary-agents.test.ts). */
  /** A temporary agent's caller is blocked on one report, so every terminal state must produce one. */
  test('registered task lifetime supplies a terminal report for each non-answer ending', async () => {
    const { agent } = orchestratorHarness();
    const actor = await agent.actorDirectory({ action: 'register', creationId: 'temporary-proof', name: 'temporary-child', origin: 'agent', lifetime: 'task' });
    const identity = await agent.getSubordinateBootstrapIdentity({ name: actor.name, reference: actor.reference });

    if ('reason' in identity) throw new Error(identity.error);
    expect(identity.lifetime).toBe('task');

    for (const ending of TASK_TURN_ENDINGS) {
      const report = await terminalTaskReport({ lifetime: identity.lifetime, ending, assistantText: ending === 'answered' ? 'The evidence is complete.' : '', narration: async () => [] });
      expect(report?.status).toBe(ending === 'answered' ? 'completed' : 'blocked');
      expect(report?.content).toBeString();
    }
  });

  test('a child bootstrap retains root ownership and refuses a foreign parent reference', async () => {
    const { agent } = orchestratorHarness();
    const actor = await agent.actorDirectory({ action: 'register', creationId: 'lineage-proof', name: 'lineage-child', origin: 'agent', lifetime: 'durable' });
    const identity = await agent.getSubordinateBootstrapIdentity({ name: actor.name, reference: actor.reference });
    expect(identity).toMatchObject({ parentWorkspace: agent.name, ownerUserId: 'harness-owner', depth: 1, name: 'lineage-child' });
    const refused = await agent.getSubordinateBootstrapIdentity({ name: actor.name, reference: { ...actor.reference, parentActorId: 'foreign-parent' } });
    expect(refused).toMatchObject({ reason: 'denied' });
  });

  test('native bootstrap reads disclose lineage without disclosing the capability token', async () => {
    const { agent } = orchestratorHarness();
    const actor = await agent.actorDirectory({ action: 'register', creationId: 'bootstrap-contract', name: 'bootstrap-child', origin: 'agent', lifetime: 'durable' });
    const bootstrap = await agent.getSubordinateBootstrapIdentity({ name: actor.name, reference: actor.reference });
    expect(bootstrap).toMatchObject({ name: 'bootstrap-child', depth: 1, ownerUserId: 'harness-owner' });
    expect(JSON.stringify(bootstrap)).not.toContain('harness-capability');
    expect(bootstrap).not.toHaveProperty('capabilityToken');
  });

  test('a hosted child shares the workspace file plane under its own state root', async () => {
    // A child reading its parent's row would run bytes its own claim cannot verify after the parent promotes, so the per-actor subtree binds.
    const workspace = orchestratorHarness();

    const child = await hostedSubordinateHarness(workspace, {
      name: 'reader-1', displayName: 'Reader', nameOrigin: 'user', mission: 'Read what you may',
    });

    const key = child.actor.handle.storageKey;
    expect(child.actor.runtime.identity.scaffold.path)
      .toBe(`.kinu/agents/${encodeURIComponent(key)}/scaffold/agent.js`);
    expect(child.actor.runtime.identity.scaffold.path).not.toBe('scaffold/agent.js');
  });

  test('delegated tools are the full-agent surface, with the report lane and without the peer rung', async () => {
    // Asserted on what the model is offered. `release` is codemode-only, so it needs no gate.
    const gateway = answeringGateway('done');
    const workspace = gatewayWorkspace(gateway);
    const turns = chatSessionTurns(workspace.agent);
    const orchTools = (await turns.prepare({ messages: [{ role: 'user', content: 'hire someone' }] })).tools;
    await turns.settle({ messageId: 'a-root', text: 'done' });
    expect(Object.keys(orchTools)).not.toContain(REPORT_TOOL);

    const child = await hostedSubordinateHarness(workspace, {
      name: 'confinement-child',
      displayName: 'Confinement Child',
      nameOrigin: 'user',
      mission: 'prove confinement',
    });

    await runDelegatedTask(workspace, child.actor.handle.actorId, 'prove confinement');
    const subTools = offeredTools(gateway.runs);
    const subKeys = [...subTools.keys()];
    expect(BUILTIN_TOOLS.filter((name) => !subKeys.includes(name))).toEqual([]);
    expect(subKeys).not.toContain('record_evidence');
    expect(subKeys).not.toContain('record_decision');
    // `hire scope=workspace` mints a fresh tree root, so holding it would let a subordinate escape its depth cap.
    expect(observedActionEnum(subTools.get('agents')?.inputSchema)).not.toContain('reply');
    expect(observedActionEnum(subTools.get('agents')?.inputSchema)).toContain('hire');
    expect(subTools.get('eval')?.description).toContain('declare const report:');
    expect(orchTools.eval?.description).not.toContain('declare const report:');
  });

  test('every deps-gated tool core declares is answered by this backend', async () => {
    // Core types the set as `readonly BuiltinToolName[]`, which cannot key an exhaustive table, so a new
    // DEPS_GATED_TOOLS name with no dep check would stay advertised on every actor.
    const turns = chatSessionTurns(orchestratorHarness().agent);
    const orchToolNames = Object.keys((await turns.prepare({ messages: [{ role: 'user', content: 'hello' }] })).tools);
    await turns.settle({ messageId: 'a-gated', text: 'done' });
    const ungated = DEPS_GATED_TOOLS.filter((name) => orchToolNames.includes(name));
    expect(ungated).toEqual([]);
    // Non-empty, or the line above passes vacuously.
    expect(DEPS_GATED_TOOLS.length).toBeGreaterThan(0);
  });
});

describe("a delegated run settles its hirer's roster", () => {
  test.each([
    { path: 'with a final answer', answer: 'The evidence is complete.' },
    { path: 'with an empty final answer', answer: '' },
  ])('a durable hire completes after a progress report $path and reads idle', async ({ answer }) => {
    const brief = 'Map the market.';

    const gateway = stubAiBinding((run) => {
      if (!openingOf(run).includes(brief)) return chatCompletion(run, 'Noted.');

      return !requestOf(run).messages.some((message) => message.role === 'tool')
        ? toolCallCompletion(run, { tool: 'report', args: { status: 'progress', content: 'Reading the evidence.' } }, 'call_progress')
        : chatCompletion(run, answer);
    });

    const workspace = gatewayWorkspace(gateway);

    const child = await hostedSubordinateHarness(workspace, {
      name: 'researcher', displayName: 'Researcher', nameOrigin: 'user', mission: brief,
    });

    const roster = rosterOver(workspace.db);

    roster.create({
      name: 'researcher', actorReference: child.actor.reference, birth: null, deleteRequested: false,
      status: 'idle', currentTask: null, taskEventId: null, createdAt: Date.now(), dismissedAt: null,
    });
    roster.assign('researcher', brief);
    await runDelegatedTask(workspace, child.actor.handle.actorId, brief);

    const endings = agentSql(child.actor.handle.actorId)<{ reason: string }>`
      SELECT json_extract(payload, '$.reason') AS reason FROM run_events WHERE type = 'run_end'`;

    expect(endings).toEqual([{ reason: 'completed' }]);
    expect(roster.requireActive('researcher')).toMatchObject({ status: 'idle', currentTask: brief });
    expect((await workspace.agent.listSubordinates()).find((entry) => entry.name === 'researcher'))
      .toMatchObject({ status: 'idle', currentTask: brief });
  });
});

describe('a dismissed agent keeps its conversation reachable', () => {
  /** Dismissal keeps the conversation, so the row a surface reads must survive it. */
  async function dismissedChild() {
    const parent = orchestratorHarness();
    // An added agent inherits the workspace's purpose, so the workspace needs one first.
    await parent.agent.setSoul('# Purpose\n\nBuild the chess app.');

    const { name } = await parent.agent.createSubordinateAgent();

    await parent.agent.dismissSubordinate(name);

    return { parent, name };
  }

  test('the roster a chat surface reads still lists it', async () => {
    const { parent, name } = await dismissedChild();
    const listed = await parent.agent.listSubordinates();

    expect(listed.map((entry) => entry.name)).toContain(name);
    expect(listed.find((entry) => entry.name === name)?.status).toBe('dismissed');
  });

  test('the kept pane draws an entry it could not read in its place, named, between the ones it could', () => {
    const row = (id: string, role: 'user' | 'assistant', text: string) =>
      ({ message: { id, role, parts: [{ type: 'text' as const, text }] }, steers: [] });

    const markup = renderToStaticMarkup(createElement(KeptTranscript, {
      entries: [row('m1', 'user', 'asked before'), row('m2', 'assistant', ''), row('m3', 'user', 'asked after')],
      unavailable: new Set(['m2']),
    }));

    const note = markup.indexOf('role="note"');

    expect(markup.indexOf('asked before')).toBeLessThan(note);
    expect(note).toBeLessThan(markup.indexOf('asked after'));
    expect(markup.slice(note, markup.indexOf('</p>', note))).toContain('unavailable');
  });
});

/** A task-lifetime helper makes no report card and has no tab; the `agents` call that asked it survives a reload. */
describe('the call that asked a one-question helper opens its chat', () => {
  const asked = (output: JsonValue): UIMessage => ({
    id: 'a1', role: 'assistant',
    parts: [{ type: 'tool-agents', toolCallId: 'agents_0', state: 'output-available', input: { action: 'hire', lifetime: 'task' }, output }],
  });

  const markup = (base: string | null, output: JsonValue, parent: string | null = null) => renderToStaticMarkup(createElement(MemoryRouter, null,
    createElement(HelperChatBase.Provider, { value: base === null ? null : { base, parent } }, createElement(MessageView, { message: asked(output) }))));

  test('a task helper\'s name links to its chat below the chat that asked it', () => {
    const answered = { status: 'completed', agent: 'ask-reviewer-a1', lifetime: 'task', role: 'reviewer', answer: 'Fine.', transcript: 'kept' };

    expect(markup('/workspace/ws/agents/', answered)).toContain('href="/workspace/ws/agents/ask-reviewer-a1"');
    // The asking chat's id rides along: a released parent has no path to walk, but its id still finds the helper.
    expect(markup('/workspace/ws/agents/auditor/', JSON.stringify(answered), 'actor-auditor')).toContain('href="/workspace/ws/agents/auditor/ask-reviewer-a1?parent=actor-auditor"');
  });

  test('a durable hire, or a chat with no place to open one, links nothing', () => {
    expect(markup('/workspace/ws/agents/', { ok: true, agent: 'auditor', lifetime: 'durable' })).not.toContain('conversation"');
    expect(markup(null, { agent: 'ask-reviewer-a1', lifetime: 'task' })).not.toContain('conversation"');
  });
});

/** A helper below a direct child has no tab; the Work tab opens its chat by the path the TUI walks. */
describe('a subordinate below a direct child is reached by its path', () => {
  /** The helper's own model hires when its task says so, as a delegated turn does. */
  const hiringGateway = () => stubAiBinding((run) => {
    const asked = requestOf(run).messages.some((message) => message.role === 'user' && JSON.stringify(message.content).includes('Hire ask-checker-a1'));
    const answered = requestOf(run).messages.some((message) => message.role === 'tool');

    return asked && !answered
      ? toolCallCompletion(run, { tool: 'agents', args: { action: 'hire', agent: 'ask-checker-a1', role: 'task', mission: 'Check the ledger.' } }, 'agents_0')
      : chatCompletion(run, 'Done.');
  });

  async function grandchild() {
    const parent = gatewayWorkspace(hiringGateway());
    await parent.agent.setSoul('# Purpose\n\nAudit the ledger.');
    const { name, subordinate } = await parent.agent.createSubordinateAgent();

    await runDelegatedTask(parent, present(subordinate.actorId, 'the helper id'), 'Hire ask-checker-a1 to check the ledger.');
    const children = await parent.agent.inspectSubordinate({ path: [name], view: 'children', page: {} });
    const nested = children.view === 'children' ? children.page.items.find((entry) => entry.name === 'ask-checker-a1') : undefined;

    return { agent: parent.agent, name, parentId: present(subordinate.actorId, 'the helper id'), path: `${name}/ask-checker-a1`, id: nested?.actorReference?.actorId };
  }

  /** The page's own resolver over this object's RPCs, as its socket answers them. */
  const pageRpc = (agent: Awaited<ReturnType<typeof grandchild>>['agent']): Rpc => async <T>(method: string, args: unknown[] = []): Promise<T> => {
    if (method !== 'inspectSubordinate') throw new Error(`the page asked ${method}`);

    return v.parse(v.custom<T>(() => true), await agent.inspectSubordinate(v.parse(SubordinateInspectionRequestSchema, args[0])));
  };

  test('with its parent dismissed, a grandchild still opens kept, found from the id of the chat that asked it or its own', async () => {
    const { agent, name, parentId, path, id } = await grandchild();
    await agent.dismissSubordinate(name);

    const byParent = await nestedAgent(pageRpc(agent), path, { actor: null, parent: parentId });
    const byOwnId = await nestedAgent(pageRpc(agent), path, { actor: present(id, 'the grandchild id'), parent: null });

    expect(byParent).toMatchObject({ live: false, actorId: id });
    expect(byOwnId).toMatchObject({ live: false, actorId: id });
    expect((await agent.getChatHistoryPage({ actor: present(id, 'the grandchild id') })).status).toBe('end');
  });

  test('the edge resolves the path to the grandchild\'s id, and its chat and window reads follow', async () => {
    const { agent, path, id } = await grandchild();
    const resolved = await agent.resolveHostedActorRoute(path);

    expect(resolved).toEqual({ ok: true, actorId: present(id, 'the grandchild id') });
    expect((await agent.getChatHistoryPage({ actor: present(id, 'the grandchild id') })).status).toBe('end');
    expect((await agent.getActorSnapshot(path)).name).toBe('ask-checker-a1');
  });

  test('a name the root does not employ resolves to nothing, even when a grandchild has it', async () => {
    const { agent } = await grandchild();

    expect(await agent.resolveHostedActorRoute('ask-checker-a1')).toMatchObject({ reason: 'missing' });
  });
});

describe('an agent\'s window hears only what it may act on', () => {
  /**
   * One object serves the workspace's windows and each agent's. The workspace's own frames once reached an agent's
   * window too, whose pane answered them with calls that window may not make, and showed "could not be refreshed".
   */
  test('the workspace\'s own frames reach only its windows, and a workspace-wide one reaches every window', async () => {
    const { agent } = orchestratorHarness();
    const heard = new Map<string, string[]>([['workspace', []], ['agent', []]]);
    const windows = [socketConnection({ id: 'workspace', tags: [] })];

    // The platform's fan-out: every window but the ones named.
    const fanout = spyOn(Object.getPrototypeOf(ActorAgent.prototype), 'broadcast').mockImplementation((message: string, without?: string[]) => {
      const frame = v.safeParse(v.looseObject({ type: v.string() }), JSON.parse(message));
      const type = frame.success ? frame.output.type : '';

      for (const window of windows) if (!(without ?? []).includes(window.id)) heard.get(window.id)?.push(type);
    });

    Object.defineProperty(agent, 'getConnections', { configurable: true, value: () => windows });

    try {
      // An added agent inherits the workspace's purpose, so the workspace needs one first.
      await agent.setSoul('# Purpose\n\nAudit the ledger.');
      const { name } = await agent.createSubordinateAgent();
      const resolved = await agent.resolveHostedActorRoute(name);

      if ('reason' in resolved) throw new Error(resolved.error);
      const tag = actorConnectionTag(resolved.actorId);

      windows.push(socketConnection({ id: 'agent', tags: [tag] }));
      await agent.renameSubordinateAgent(name, 'Ledger auditor');
      await agent.announceSubordinatePlan({ path: [name], id: 'plan-1', revision: 1 });
      await agent.cancelCurrentWork();
      await agent.setShellApprovalMode('strict');
      await agent.executeInExecutor('workspace', 'git push --force origin main');
      await agent.listSlates();
      // The workspace's page has read its Changes, so the next write it reviews is news.
      await agent.getExecutorDiff('workspace');
      await workspaceFiles(agent).mkdir('/slates/tally', { recursive: true });
      await writeText(workspaceFiles(agent), '/slates/tally/server.ts', 'export default { fetch() { return new Response("ok"); } };');
      await agent.announceDeviceAvailable({ id: 'device-1', label: 'studio' });

      for (const flush of agent.harnessOwedLiveReads.splice(0)) flush();
    } finally {
      fanout.mockRestore();
    }

    const own = [
      'workspace_plan_updated', 'work_cancelled', 'reads_changed', 'slates_changed', 'changes_moved',
    ];

    expect(heard.get('workspace')).toEqual(expect.arrayContaining([...own, 'device_available']));
    expect(heard.get('agent')?.filter((type) => own.includes(type))).toEqual([]);
    expect(heard.get('agent')).toContain('device_available');
  });
});
