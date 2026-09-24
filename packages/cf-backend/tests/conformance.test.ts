// cf composition roots observed on real actor instances, compared against
// core/src/conformance/manifest.ts in both directions. Each plane is read where the product
// produces it: the tools a model call carries, the tables the object stores, and the model lanes
// whose calls the object bills when a public operation runs on them.
import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';
import {
  compareSurface, CONFORMANCE_PRODUCERS, normalizeObservedTables, observedActionEnum, renderConformanceFindings,
  wiredProducers, type ObservedSurface,
} from '@kinu.run/core';
import {
  chatSessionTurns, gatewayWorkspace, hostedSubordinateHarness, improvementLanesRan, runDelegatedTask, until,
  workspaceMainActor, type ActorHarness, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import { chatCompletion, offeredTools, stubAiBinding } from './helpers/platform-gateway';
import { present } from '@kinu.run/test-utils';

/** An advisor note and a curriculum proposal the gateway answers with, each in its reader's shape. */
const ADVISOR_NOTE = JSON.stringify({ note: 'the staging cluster was never named', severity: 'nit', class: 'wrong-work' });

const PROPOSALS = JSON.stringify([{ task: 'split the parser', rationale: 'a stretch', predictedSuccess: 0.5, targetsSkills: [] }]);

/** A workspace whose every model lane the platform gateway serves, with advisor reviews on. */
function servedWorkspace() {
  const gateway = stubAiBinding((run) =>
    chatCompletion(run, JSON.stringify(run.query).includes('predictedSuccess') ? PROPOSALS : ADVISOR_NOTE));

  const workspace = gatewayWorkspace(gateway);
  workspaceMainActor(workspace.db).config.setAdvisorEnabled(true);

  return { workspace, runs: gateway.runs };
}

const OperationSchema = v.object({ source: v.string() });

/** The producer lanes this object billed model calls to. */
function producersRecorded(workspace: ActorHarness<HarnessOrchestratorAgent>): Set<string> {
  const producers = new Set<string>(CONFORMANCE_PRODUCERS);

  return new Set(workspace.db.query<{ payload: string }, []>("SELECT payload FROM run_events WHERE type = 'model_call'")
    .all()
    .map((row) => v.parse(OperationSchema, JSON.parse(row.payload)).source)
    .filter((source) => producers.has(source)));
}

async function observe(): Promise<ObservedSurface> {
  const { workspace } = servedWorkspace();
  const turns = chatSessionTurns(workspace.agent);
  const { tools } = await turns.prepare({ messages: [{ role: 'user', content: 'deploy the api' }] });

  // The judge grades curriculum proposals; the advisor reviews a completed build turn.
  await workspace.agent.proposeCurriculumTasks(1);
  const { messageId } = await turns.settle({ messageId: 'a-conformance', text: 'deployed' });
  await until(() => improvementLanesRan(workspace.db, messageId), 'the improvement lanes ran');

  return {
    root: 'cf-orchestrator',
    planes: {
      tool: new Set(Object.keys(tools)),
      'agents-action': observedActionEnum(tools.agents),
      'memory-action': observedActionEnum(tools.memory),
      table: normalizeObservedTables(workspace.tableNames()),
      producer: producersRecorded(workspace),
    },
  };
}

async function observeSubordinate(): Promise<ObservedSurface> {
  // A subordinate owns no database: its table plane is the workspace's. Its tools are what the
  // gateway is asked to offer the model on a delegated turn the parent admitted and the wake ran.
  const { workspace, runs } = servedWorkspace();

  const child = await hostedSubordinateHarness(workspace, {
    name: 'conformance-child',
    displayName: 'Conformance Child',
    nameOrigin: 'user',
    mission: 'prove the subordinate surface',
  });

  await runDelegatedTask(workspace, child.actor, 'prove the subordinate surface');
  const tools = offeredTools(runs);

  return {
    root: 'cf-subordinate',
    planes: {
      tool: new Set(tools.keys()),
      'agents-action': observedActionEnum(tools.get('agents')),
      'memory-action': observedActionEnum(tools.get('memory')),
      table: normalizeObservedTables(workspace.tableNames()),
      producer: wiredProducers(child.actor.runtime),
    },
  };
}

describe('cf backend conformance', () => {
  test('cf-orchestrator: the observed surface matches the manifest', async () => {
    const report = compareSurface(await observe());
    expect(renderConformanceFindings(report)).toBe('');
    expect(report.unmeasured).toEqual([]);
  });

  test('cf-subordinate: the observed surface matches the manifest', async () => {
    const report = compareSurface(await observeSubordinate());
    expect(renderConformanceFindings(report)).toBe('');
    expect(report.unmeasured).toEqual([]);
  });

  // Per root: a thin fake would make everything declared `absent` look conformant.
  test('cf-orchestrator: the observation sees a real surface at all', async () => {
    const observed = await observe();
    expect(present(observed.planes.tool, 'the observed tool plane').size).toBeGreaterThanOrEqual(6);
    expect(present(observed.planes.table, 'the observed table plane').size).toBeGreaterThanOrEqual(30);
    expect(present(observed.planes.tool, 'the observed tool plane').has('eval')).toBe(true);
    expect(present(observed.planes.producer, 'the observed producer plane')).toEqual(new Set(CONFORMANCE_PRODUCERS));
  });

  test('cf-subordinate: the observation sees a real surface at all', async () => {
    const observed = await observeSubordinate();
    expect(present(observed.planes.tool, 'the observed tool plane').size).toBeGreaterThanOrEqual(6);
    expect(present(observed.planes.table, 'the observed table plane').size).toBeGreaterThanOrEqual(30);
    expect(present(observed.planes.tool, 'the observed tool plane').has('eval')).toBe(true);
  });
});
