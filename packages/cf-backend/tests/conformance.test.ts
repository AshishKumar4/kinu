// cf composition roots observed on real actor instances, compared against
// core/src/conformance/manifest.ts in both directions.
import { describe, test, expect } from 'bun:test';
import type { ToolSet } from 'ai';
import {
  compareSurface, normalizeObservedTables, observedActionEnum, wiredProducers,
  renderConformanceFindings,
  type AgentRuntime, type ObservedSurface,
} from '@kinu.run/core';
import { hostedSubordinateHarness, orchestratorHarness } from './helpers/actor-harness';
import type { ActorHarness, HarnessOrchestratorAgent } from './helpers/actor-harness';
import { present } from '@kinu.run/test-utils';

interface RawToolsAgent {
  observeRawTools(): ToolSet;
  observeRuntime(): AgentRuntime;
  terminalRetryPass(): Promise<void>;
}

async function observe(workspace: ActorHarness<RawToolsAgent>): Promise<ObservedSurface> {
  const tools = workspace.agent.observeRawTools();
  await workspace.agent.observeRuntime().storage.vfs.exists('SOUL.md');
  await workspace.agent.terminalRetryPass();

  return {
    root: 'cf-orchestrator',
    planes: {
      tool: new Set(Object.keys(tools)),
      'agents-action': observedActionEnum(tools.agents),
      'memory-action': observedActionEnum(tools.memory),
      table: normalizeObservedTables(workspace.tableNames()),
      producer: wiredProducers(workspace.agent.observeRuntime()),
    },
  };
}

async function observeSubordinate(
  workspace: ActorHarness<HarnessOrchestratorAgent>,
): Promise<ObservedSurface> {
  // A subordinate owns no database: its table plane is the workspace's; its tools are the
  // production delegated-turn profile over the child's own runtime.
  const child = await hostedSubordinateHarness(workspace, {
    name: 'conformance-child',
    displayName: 'Conformance Child',
    nameOrigin: 'user',
    mission: 'prove the subordinate surface',
  });

  const { tools } = await workspace.agent.observeHostedTaskProfile(child.actor, 'prove the subordinate surface');
  await workspace.agent.terminalRetryPass();

  return {
    root: 'cf-subordinate',
    planes: {
      tool: new Set(Object.keys(tools)),
      'agents-action': observedActionEnum(tools.agents),
      'memory-action': observedActionEnum(tools.memory),
      table: normalizeObservedTables(workspace.tableNames()),
      producer: wiredProducers(child.actor.runtime),
    },
  };
}

describe('cf backend conformance', () => {
  test('cf-orchestrator: the observed surface matches the manifest', async () => {
    const report = compareSurface(await observe(orchestratorHarness()));
    expect(renderConformanceFindings(report)).toBe('');
    expect(report.unmeasured).toEqual([]);
  });

  test('cf-subordinate: the observed surface matches the manifest', async () => {
    const report = compareSurface(await observeSubordinate(orchestratorHarness()));
    expect(renderConformanceFindings(report)).toBe('');
    expect(report.unmeasured).toEqual([]);
  });

  // Per root: a thin fake would make everything declared `absent` look conformant.
  test('cf-orchestrator: the observation sees a real surface at all', async () => {
    const observed = await observe(orchestratorHarness());
    expect(present(observed.planes.tool, 'the observed tool plane').size).toBeGreaterThanOrEqual(6);
    expect(present(observed.planes.table, 'the observed table plane').size).toBeGreaterThanOrEqual(30);
    expect(present(observed.planes.tool, 'the observed tool plane').has('eval')).toBe(true);
  });

  test('cf-subordinate: the observation sees a real surface at all', async () => {
    const observed = await observeSubordinate(orchestratorHarness());
    expect(present(observed.planes.tool, 'the observed tool plane').size).toBeGreaterThanOrEqual(6);
    expect(present(observed.planes.table, 'the observed table plane').size).toBeGreaterThanOrEqual(30);
    expect(present(observed.planes.tool, 'the observed tool plane').has('eval')).toBe(true);
  });
});
