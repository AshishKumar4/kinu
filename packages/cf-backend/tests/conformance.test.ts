// Backend conformance — the cf composition roots, observed for real.
//
// Each observation below comes from the PRODUCTION composition path on a real
// actor instance (tests/helpers/actor-harness.ts): the ToolSet is whatever
// `getRawTools()` built, the action enums are read from the input schemas the
// model would receive, and the tables are `sqlite_master` after the real
// `ensureSchema()` ran. The manifest in core declares what each root wires
// and why the rest is deliberately absent; `compareSurface` fails on any
// disagreement in either direction. See core/src/conformance/manifest.ts.
import { describe, test, expect } from 'bun:test';
import type { ToolSet } from 'ai';
import {
  compareSurface, normalizeObservedTables, observedActionEnum, wiredProducers,
  renderConformanceFindings,
  type AgentRuntime, type ObservedSurface,
} from '@kinu.run/core';
import { Session, type SqlProvider } from 'agents/experimental/memory/session';
import { hostedSubordinateHarness, orchestratorHarness } from './helpers/actor-harness';
import type { ActorHarness, HarnessOrchestratorAgent } from './helpers/actor-harness';

interface RawToolsAgent extends SqlProvider {
  observeRawTools(): ToolSet;
  observeRuntime(): AgentRuntime;
  _kinuTerminalRetryTick(): Promise<void>;
}

/**
 * The transcript read Think's own activation performs — `Session.create(this)`
 * then a session read in Think's `onStart` — which is what creates the SDK's
 * `assistant_*` tables on every wake. The harness boots the actor half of
 * `onStart` alone (actor-harness.ts `ensureActorSchema`), so without this the
 * table plane is observed BEFORE the vendor store exists and a census row for
 * a table Kinu reads in raw SQL could never be checked in either direction.
 */
async function activateSession(agent: SqlProvider): Promise<void> {
  await Session.create(agent).getLatestLeaf();
}

async function observe(workspace: ActorHarness<RawToolsAgent>): Promise<ObservedSurface> {
  const tools = workspace.agent.observeRawTools();
  await workspace.agent.observeRuntime().storage.vfs.exists('SOUL.md');
  await workspace.agent._kinuTerminalRetryTick();
  await activateSession(workspace.agent);

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
  // A hired subordinate owns no database, so its table plane IS the
  // workspace's — observed off the same sqlite_master the root reads. What
  // differs is the model-facing profile: the delegated-turn surface built by
  // the production builder over the child's own runtime, with the report lane
  // the root never wires. Both planes come from the workspace's own wiring,
  // never from a fixture's idea of the subordinate.
  const child = await hostedSubordinateHarness(workspace, {
    name: 'conformance-child',
    displayName: 'Conformance Child',
    nameOrigin: 'user',
    mission: 'prove the subordinate surface',
  });

  const { tools } = await workspace.agent.observeHostedTaskProfile(child.actor, 'prove the subordinate surface');
  await workspace.agent._kinuTerminalRetryTick();
  await activateSession(workspace.agent);

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

  // Guards the guard, once per root rather than once in total. A floor
  // asserted for the orchestrator alone leaves the SUBORDINATE's
  // magnitudes unverified: a harness that drifted to a thin fake there
  // would still fail on capabilities the manifest declares `wired`, but
  // everything it declares `absent` would look conformant against a world
  // that was never built. Same roots as above, so a third root added later is
  // covered without a second place to remember.
  test('cf-orchestrator: the observation sees a real surface at all', async () => {
    const observed = await observe(orchestratorHarness());
    expect(observed.planes.tool!.size).toBeGreaterThanOrEqual(6);
    expect(observed.planes.table!.size).toBeGreaterThanOrEqual(30);
    expect(observed.planes.tool!.has('execute_tools')).toBe(true);
  });

  test('cf-subordinate: the observation sees a real surface at all', async () => {
    const observed = await observeSubordinate(orchestratorHarness());
    expect(observed.planes.tool!.size).toBeGreaterThanOrEqual(6);
    expect(observed.planes.table!.size).toBeGreaterThanOrEqual(30);
    expect(observed.planes.tool!.has('execute_tools')).toBe(true);
  });
});
