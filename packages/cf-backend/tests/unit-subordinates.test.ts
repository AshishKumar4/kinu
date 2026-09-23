// How this backend wires core's subordinate module (behaviour: core/tests/unit-subordinates.test.ts);
// most tests read source, the deps gate runs through each actor's raw ToolSet.
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import {
  BUILTIN_TOOLS, DEPS_GATED_TOOLS, observedActionEnum, REPORT_TOOL, TASK_TURN_ENDINGS, terminalTaskReport,
} from '@kinu.run/core';
import type { SubordinateRosterEntry } from '@kinu.run/core/protocol';
import { SubordinateTabs } from '../src/components/SubordinateTabs';
import { KeptTranscript } from '../src/components/KeptTranscript';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { hostedSubordinateHarness, orchestratorHarness } from './helpers/actor-harness';

const source = (path: string) => readFileSync(join(import.meta.dir, '..', 'src', path), 'utf8');

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
      const report = terminalTaskReport({ lifetime: identity.lifetime, ending, assistantText: ending === 'answered' ? 'The evidence is complete.' : '' });
      expect(report?.status).toBe(ending === 'answered' ? 'completed' : 'blocked');
      expect(report?.content).toBeString();
    }
  });

  /** No deadlines: the wait terminates because the child always reports, so the rung holds no timer. */
  test('the temporary rung carries no timer, deadline or elapsed bound', () => {
    const rung = readFileSync(
      join(import.meta.dir, '..', '..', 'core', 'src', 'subordinates', 'temporary.ts'), 'utf8');

    // Code shapes only: the module's prose explains why there is no deadline.
    for (const banned of ['setTimeout(', 'setInterval(', 'AbortSignal.timeout', 'timeoutMs', 'silenceLimit']) {
      expect({ banned, present: rung.includes(banned) }).toEqual({ banned, present: false });
    }
  });

  test('the temporary rung rides this actor\'s own roster, child runtime and report ingress', () => {
    const actor = source('actor-agent.ts');

    // One memoized child substrate shared by both rungs; two copies would be two `subAgent` paths.
    expect(actor).toContain('protected subordinateRuntime(): SubordinateRuntime {');
    expect(actor).toContain('runtime: this.subordinateRuntime(),');

    // One roster: the port is built over `subordinateRoster`, with no second store.
    expect(actor).toContain('roster: this.subordinateRoster,');
    expect(actor).not.toContain('workspace_temporary_agents');

    // Built once per actor: `shell` parks a waiter and the report ingress resolves it in a different call,
    // so a per-call port would leave every ask hanging.
    expect(actor).toContain('private _temporaryAgentPort: TemporaryAgentPort | null = null;');
    expect(actor).toContain('this._temporaryAgentPort ??= createTemporaryAgentPort({');
    expect(actor).toContain('temporary: this.temporaryAgentPort(),');
    expect(actor.match(/temporary: this\.temporaryAgentPort\(\),/gu)?.length).toBe(2);


    expect(actor).toContain('new SubordinateRosterStore(this.ctx.storage.sql, this.actorHandle())');
  });

  test('no rlm provider, model spec or prompt flag survives in the cf composition', () => {
    const actor = source('actor-agent.ts');
    const execTools = source('codemode-tool.ts');
    const hosting = source('subordinate-hosting.ts');

    for (const [name, text] of [
      ['actor-agent.ts', actor],
      ['codemode-tool.ts', execTools],
      ['subordinate-hosting.ts', hosting],
    ] as const) {
      expect({ name, hit: /createRLMProvider|rlmAvailable|rlm\.query/u.test(text) })
        .toEqual({ name, hit: false });
    }

    // Pinned on the options interface's member list, not a syllable's absence: `modelSpecForSource` and
    // `registry.renderCodemodeDescription` legitimately use those syllables.
    const options = execTools.slice(
      execTools.indexOf('export interface CodemodeFactoryOptions {'),
      execTools.indexOf('export function createCodemodeToolFactory'),
    );

    expect(options.length).toBeGreaterThan(0);
    expect(options).not.toMatch(/^\s*(?:model|registry|rlm)\??:/mu);
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
    const hosting = source('actor-hosting.ts');
    expect(hosting).not.toContain('createParentExecutor');
    expect(hosting).not.toContain('registerParentWorkspace');
    expect(hosting).not.toContain('seedSoul(');
  });

  test('delegated tools are the full-agent surface, with the report lane and without the peer rung', async () => {
    // Asserted on the built ToolSet, which is what ships. `release` is codemode-only, so it needs no gate.
    const workspace = orchestratorHarness();
    const orchTools = workspace.agent.observeRawTools();
    expect(Object.keys(orchTools)).not.toContain(REPORT_TOOL);

    const child = await hostedSubordinateHarness(workspace, {
      name: 'confinement-child',
      displayName: 'Confinement Child',
      nameOrigin: 'user',
      mission: 'prove confinement',
    });

    const { tools: subTools } = await workspace.agent.observeHostedTaskProfile(child.actor, 'prove confinement');
    const subKeys = Object.keys(subTools);
    expect(BUILTIN_TOOLS.filter((name) => !subKeys.includes(name))).toEqual([]);
    expect(subKeys).not.toContain('record_evidence');
    expect(subKeys).not.toContain('record_decision');
    // `hire scope=workspace` mints a fresh tree root, so holding it would let a subordinate escape its depth cap.
    expect(observedActionEnum(subTools.agents)).not.toContain('reply');
    expect(observedActionEnum(subTools.agents)).toContain('hire');
    expect(subTools.eval?.description).toContain('declare const report:');
    expect(orchTools.eval?.description).not.toContain('declare const report:');
  });

  test('every deps-gated tool core declares is answered by this backend', () => {
    // Core types the set as `readonly BuiltinToolName[]`, which cannot key an exhaustive table, so a new
    // DEPS_GATED_TOOLS name with no dep check would stay advertised on every actor.
    const orchToolNames = Object.keys(orchestratorHarness().agent.observeRawTools());
    const ungated = DEPS_GATED_TOOLS.filter((name) => orchToolNames.includes(name));
    expect(ungated).toEqual([]);
    // Non-empty, or the line above passes vacuously.
    expect(DEPS_GATED_TOOLS.length).toBeGreaterThan(0);
  });

  test('browser subordinate callables reuse the team policy and are not inherited by the shared substrate', () => {
    const orchestrator = source('orchestrator.ts');
    expect(orchestrator).toContain('return this.subordinateViews();');
    expect(orchestrator).toContain('const result = await this.getTeamToolDeps().create({});');
    expect(orchestrator).toContain('const result = await this.getTeamToolDeps().rename({ name, displayName });');
    expect(orchestrator).toContain("requestedBy: 'user'");
    // Team callables are the orchestrator's own, so a hosted child never inherits a path around the roster.
    const base = source('actor-agent.ts');
    expect(base).not.toContain('listSubordinates(');
    expect(base).not.toContain('dismissSubordinate(');
  });

  // Ingress ordering is core's; on a DO the admit and roster write must share one storage transaction.
  test('the parent ingress runs core’s sequence inside the DO storage transaction', () => {
    const actor = source('actor-agent.ts');

    const ingress = actor.slice(
      actor.indexOf('async receiveSubordinateEvent('),
      actor.indexOf('override maxSteps'),
    );

    expect(ingress).toContain('return receiveSubordinateEvent({');
    expect(ingress).toContain('transaction: (body) => this.ctx.storage.transactionSync(body),');
  });
  // Policy is core's; backend-specific is that both hops tag the origin and neither can be bypassed.
  test('every upward channel is tagged with the origin the relay policy reads', () => {
    const hosting = source('subordinate-hosting.ts');
    const orchestrator = source('orchestrator.ts');
    expect(orchestrator).toContain("status: input.status, content: input.content, origin: 'report_tool',");
    expect(hosting).toContain("status: relayed.status, content: relayed.content, origin: 'turn_end',");
    expect(orchestrator.match(/origin: 'report_tool'/g)).toHaveLength(1);
    expect(orchestrator).not.toContain("origin: 'turn_end'");
    expect(hosting.match(/origin: '/g)).toHaveLength(1);
    // Sequence and mode travel rather than being re-derived, which is what makes a replayed report recognisable.
    expect(hosting).toContain('mode: task.mode, sequenceId: task.sequenceId,');
  });

  test('a delegated turn is never owner-driven, and settles by core’s closed report map', () => {
    const hosting = source('subordinate-hosting.ts');
    expect(hosting).toContain('reportedThisTurn: reports.spoke, ownerDriven: false, assistantText: report.summary,');
    // A task child answers on every ending because its `agents.hire` caller is blocked; a hire relays only a
    // completed turn; both are suppressed once a report settled the run.
    expect(hosting).toContain('const owed = reports.settled');
    expect(hosting).toContain('terminalTaskReport({ lifetime: hostedLifetime(actor.record), ending, assistantText: report.summary });');
    expect(hosting).toContain('subordinateRelaysTurnEnd({');
    // An interrupted delegated turn leaves its claim unsettled: the record that work is owed.
    expect(hosting).toContain('isAborted: () => false,');
    expect(source('actor-agent.ts')).toContain('origin: SubordinateReportOrigin;');
  });

  test('the live roster stays a push channel; only the report rail is gated', () => {
    const actor = source('actor-agent.ts');
    // subordinates_changed feeds the webUI roster, emitted on every team mutation whether or not a report was admitted.
    expect(actor).toContain('broadcast: (event) => this.broadcastSubordinatesChanged(event),');

    const changed = actor.slice(
      actor.indexOf('protected broadcastSubordinatesChanged('),
      actor.indexOf('protected broadcastSubordinateEvent('),
    );

    expect(changed).not.toContain('parentAdmitsSubordinateReport');
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
