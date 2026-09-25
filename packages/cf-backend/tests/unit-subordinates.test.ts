// How this backend hosts core's subordinate module (policy: core/tests/unit-subordinates.test.ts), read
// through the actor's own bootstrap reads, a hosted child's runtime, and the tools each actor is built with.
import './helpers/ui-module-globals';
import { describe, expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import * as v from 'valibot';
import {
  actorConnectionTag, BUILTIN_TOOLS, DEPS_GATED_TOOLS, hostedActorSocketPath,
  observedActionEnum, ORCHESTRATOR_AGENT_SLUG, REPORT_TOOL, TASK_TURN_ENDINGS, terminalTaskReport,
} from '@kinu.run/core';
import type { SubordinateRosterEntry } from '@kinu.run/core/protocol';
import { present } from '@kinu.run/test-utils';
import { ActorAgent } from '../src/actor-agent';
import { SubordinateTabs } from '../src/components/SubordinateTabs';
import { KeptTranscript } from '../src/components/KeptTranscript';
import { mockAgentsSdk } from './helpers/agents-sdk';
import {
  chatSessionTurns, gatewayWorkspace, hostedSubordinateHarness, orchestratorHarness, runDelegatedTask, workspaceFiles,
} from './helpers/actor-harness';
import { socketConnection } from './helpers/bindings';
import { answeringGateway, offeredTools } from './helpers/platform-gateway';

mockAgentsSdk();

describe('subordinate wiring', () => {
  /** The temporary rung's CF wiring; behaviour is core's (core/tests/unit-temporary-agents.test.ts). */
  /** A temporary agent's caller is blocked on one report, so every terminal state must produce one. */
  test('registered task lifetime supplies a terminal report for each non-answer ending', async () => {
    const { agent } = orchestratorHarness();
    const actor = await agent.actorDirectory({ action: 'register', creationId: 'temporary-proof', name: 'temporary-child', kind: 'subordinate', lifetime: 'task' });
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
    const actor = await agent.actorDirectory({ action: 'register', creationId: 'lineage-proof', name: 'lineage-child', kind: 'subordinate', lifetime: 'durable' });
    const identity = await agent.getSubordinateBootstrapIdentity({ name: actor.name, reference: actor.reference });
    expect(identity).toMatchObject({ parentWorkspace: agent.name, ownerUserId: 'harness-owner', depth: 1, name: 'lineage-child' });
    const refused = await agent.getSubordinateBootstrapIdentity({ name: actor.name, reference: { ...actor.reference, parentActorId: 'foreign-parent' } });
    expect(refused).toMatchObject({ reason: 'denied' });
  });

  test('native bootstrap reads disclose lineage without disclosing the capability token', async () => {
    const { agent } = orchestratorHarness();
    const actor = await agent.actorDirectory({ action: 'register', creationId: 'bootstrap-contract', name: 'bootstrap-child', kind: 'subordinate', lifetime: 'durable' });
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
    expect(observedActionEnum(subTools.get('agents'))).not.toContain('reply');
    expect(observedActionEnum(subTools.get('agents'))).toContain('hire');
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

  const ROSTER: SubordinateRosterEntry[] = [
    {
      name: 'busy-mill-01', actorId: 'actor-busy-mill', displayName: 'Busy Mill', role: 'task', createdBy: 'user',
      status: 'working', currentTask: 'Build the chess app', createdAt: 1, dismissedAt: null,
    },
    {
      name: 'quiet-harbor-1a4e20', actorId: 'actor-quiet-harbor', displayName: 'Quiet Harbor', role: 'task', createdBy: 'user',
      status: 'dismissed', currentTask: null, createdAt: 2, dismissedAt: 200,
    },
  ];

  const strip = (activeName?: string) => renderToStaticMarkup(createElement(MemoryRouter, null,
    createElement(SubordinateTabs, {
      workspace: 'hardy-workshop', subordinates: ROSTER, activeName,
      onCreate: async () => {}, creating: false,
      onDismiss: async () => {}, onRename: async () => '',
    })));

  test('the strip announces the dismissed agents it is holding', () => {
    const markup = strip();

    expect(markup).toContain('/workspace/hardy-workshop/agents/busy-mill-01');
    expect(markup).toContain('Dismissed (1)');
    expect(markup).toContain('aria-expanded="false"');
  });

  test('a deep link into a dismissed agent opens the section it lives in', () => {
    const markup = strip('quiet-harbor-1a4e20');

    expect(markup).toContain('/workspace/hardy-workshop/agents/quiet-harbor-1a4e20');
    expect(markup).toContain('aria-expanded="true"');
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

describe('an agent\'s window hears only what it may act on', () => {
  /**
   * One object serves the workspace's windows and each agent's. The workspace's own frames once reached an agent's
   * window too, whose pane answered them with calls that window may not make, and showed "could not be refreshed".
   */
  test('the workspace\'s own frames reach only its windows, and a workspace-wide one reaches every window', async () => {
    const { agent } = orchestratorHarness();
    const heard = new Map<string, string[]>([['workspace', []], ['agent', []]]);
    const windows = [socketConnection({ id: 'workspace', tags: [] })];
    const rosterSent = Promise.withResolvers<void>();

    // The platform's fan-out: every window but the ones named.
    const fanout = spyOn(Object.getPrototypeOf(ActorAgent.prototype), 'broadcast').mockImplementation((message: string, without?: string[]) => {
      const frame = v.safeParse(v.looseObject({ type: v.string() }), JSON.parse(message));
      const type = frame.success ? frame.output.type : '';

      for (const window of windows) if (!(without ?? []).includes(window.id)) heard.get(window.id)?.push(type);

      if (type === 'subordinates_changed' && windows.length === 2) rosterSent.resolve();
    });

    Object.defineProperty(agent, 'getConnections', { configurable: true, value: () => windows });

    try {
      // An added agent inherits the workspace's purpose, so the workspace needs one first.
      await agent.setSoul('# Purpose\n\nAudit the ledger.');
      const { name } = await agent.createSubordinateAgent();
      const tag = present(actorConnectionTag(`/agents/${ORCHESTRATOR_AGENT_SLUG}/ledger/${hostedActorSocketPath(name)}`), 'the window tag');

      windows.push(socketConnection({ id: 'agent', tags: [tag] }));
      await agent.renameSubordinateAgent(name, 'Ledger auditor');
      await rosterSent.promise;
      await agent.announceSubordinatePlan({ path: [name], id: 'plan-1', revision: 1 });
      await agent.cancelCurrentWork();
      await agent.setShellApprovalMode('strict');
      await agent.executeInExecutor('workspace', 'git push --force origin main');
      await agent.listSlates();
      await workspaceFiles(agent).mkdir('/slates/tally', { recursive: true });
      await workspaceFiles(agent).writeFile('/slates/tally/server.ts', 'export default { fetch() { return new Response("ok"); } };');
      await agent.announceDeviceAvailable({ id: 'device-1', label: 'studio' });
    } finally {
      fanout.mockRestore();
    }

    const own = ['subordinates_changed', 'workspace_plan_updated', 'work_cancelled', 'pending_actions_changed', 'slates_changed'];

    expect(heard.get('workspace')).toEqual(expect.arrayContaining([...own, 'device_available']));
    expect(heard.get('agent')?.filter((type) => own.includes(type))).toEqual([]);
    expect(heard.get('agent')).toContain('device_available');
  });
});
