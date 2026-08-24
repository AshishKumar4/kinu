// Backend conformance — the CLI composition root, observed for real.
//
// This deliberately rides the PRODUCTION chain end to end: the real
// `createAgent` (what `kinu create` runs), the real `openWorkspaceCLI`,
// and a real `LocalAgentSession` constructed exactly as LocalAgentClient
// constructs one — then one turn against a capturing model, so the observed
// tool surface is precisely the tool array the model provider was handed,
// schemas included. No hand-provisioned tables, no harness shortcuts: the
// craft_scores defect lived exactly in the gap between `kinu create` and
// the open path, and only running both closes it.
//
// The manifest lives in core/src/conformance/manifest.ts; compareSurface
// fails on any disagreement between it and what is observed here.
import { describe, test, expect, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LanguageModel } from 'ai';
import type { LanguageModelV2 } from '@ai-sdk/provider';
import {
  compareSurface, normalizeObservedTables, observedActionEnum, wiredProducers,
  renderConformanceFindings,
  type ObservedSurface,
} from '@kinu.run/core';
import {
  LocalAgentHost, openWorkspaceCLI,
  type CLIRuntime, type LocalModelResolver,
} from '@kinu.run/cli-backend';
import { createCliAgent } from '../src/agent-create';
import {
  resolveLLMConfig, agentDbPath, agentDir, AGENT_HOME, listLocalRefsAllProjects, updateConfigFile,
} from '../src/config';
import { TestLanguageModelV2 } from '../../cli-backend/tests/test-language-model';

// Dummy provider config so resolveLLMConfig succeeds offline — the capturing
// model below intercepts before any network call could happen. Passed as
// arguments rather than exported into `process.env`: bun runs every file of an
// invocation in ONE process, so a variable assigned at module scope here was
// read by every later file's subprocesses, and `behavior.test.ts` carries a
// hand-written blank of these three names because of this line.
const OFFLINE_PROVIDER = {
  baseUrl: 'http://localhost:0/v1',
  auth: 'Bearer conformance',
  model: 'openai-compatible/conformance-model',
};

// This suite wrote 274 of the 283 `agents` entries in the owner's REAL
// ~/.kinu/config.json before this guard existed. Two independent causes, and
// the assertion answers the one that cannot be fixed from inside this file:
// `AGENT_HOME` is resolved at MODULE LOAD (config.ts:37), so assigning
// KINU_HOME in this body is already too late. The only mechanism that can
// set it is scripts/test-preload.ts, and a hand-run `bun test --cwd packages/cli`
// does not execute a preload — which is exactly how these entries accumulated.
// So prove the home rather than trust it, and fail before creating anything.
// Same rule as the bench harness's assert_throwaway_home and the git fixture's
// toplevel check: state that must not be ambient is asserted at the boundary.
if (resolve(AGENT_HOME) === resolve(join(homedir(), '.kinu'))
  || !resolve(AGENT_HOME).startsWith(resolve(tmpdir()))) {
  throw new Error(
    `conformance suite refuses to run against a real Kinu home (${AGENT_HOME}). `
    + 'Run it as `bun test packages/cli/tests/conformance.test.ts` from the repo root so '
    + 'scripts/test-preload.ts provides a throwaway KINU_HOME.',
  );
}

const AGENT_NAME = `conformance-${Date.now()}`;

afterAll(() => {
  rmSync(agentDir(AGENT_NAME), { recursive: true, force: true });
  // The directory was never the whole footprint. `kinu create` also writes an
  // `agents` entry, and `workspace delete` REFUSES local workspaces
  // ("deletes cloud workspaces only"), so nothing in the product removes one —
  // which is why the row survived every run while the directory was cleaned.
  updateConfigFile((config) => {
    if (config.agents) delete config.agents[AGENT_NAME];
  });
});

type CapturedTool = NonNullable<Parameters<LanguageModelV2['doStream']>[0]['tools']>[number];

/** A v2 model that records the exact tool definitions the SDK hands it, then
 *  streams a one-word answer. */
function capturingModel(sink: (tools: CapturedTool[]) => void): LanguageModel {
  const usage = { inputTokens: 3, outputTokens: 2, totalTokens: 5 };
  return new TestLanguageModelV2({
    provider: 'conformance',
    modelId: 'conformance-model',
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'observed' }], finishReason: 'stop', usage, warnings: [],
    }),
    doStream: async (options: { tools?: CapturedTool[] }) => {
      sink(options.tools ?? []);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'text-start', id: 't' });
            controller.enqueue({ type: 'text-delta', id: 't', delta: 'observed' });
            controller.enqueue({ type: 'text-end', id: 't' });
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
            controller.close();
          },
        }),
      };
    },
  });
}

function staticResolver(model: LanguageModel): LocalModelResolver {
  return {
    normalizeSpecSync: (spec: string | null | undefined) => spec?.trim() || 'conformance/conformance-model',
    resolveModel: () => model,
    listProviders: async () => [],
    listModels: async () => ({ models: [], failures: [] }),
    modelInfo: async () => null,
    judgeCandidates: async () => [],
    getAuth: async () => null,
  };
}

async function observeCli(): Promise<{ observed: ObservedSurface; captured: CapturedTool[] }> {
  await createCliAgent({
    name: AGENT_NAME,
    mode: 'local',
    purpose: 'observe the conformance surface',
    ...OFFLINE_PROVIDER,
  });

  const dbPath = agentDbPath(AGENT_NAME);
  let runtime: CLIRuntime | null = null;
  let captured: CapturedTool[] = [];
  const model = capturingModel((tools) => { captured = tools; });
  const resolver = staticResolver(model);
  const openConfig = { llm: resolveLLMConfig(OFFLINE_PROVIDER) };
  const host = new LocalAgentHost({
    // The real refs `kinu create` just wrote, read through the same roster the
    // daemon iterates: the host binds planes and peer groups from placement,
    // never from the existence of an agent.db.
    roster: () => listLocalRefsAllProjects(),
    dbPath: () => dbPath,
    childDbPath: (_parent, child) => join(agentDir(AGENT_NAME), '.kinu', 'agents', child, 'agent.db'),
    open: async (_ref, db, path) => {
      const opened = await openWorkspaceCLI(db, path, openConfig);
      runtime = opened.rt;
      return {
        rt: opened.rt,
        openConfig,
        modelResolver: resolver,
        staticModel: model,
      };
    },
  });
  const session = await host.acquire(AGENT_NAME);
  await session.send('what can you do?');

  const db = new Database(dbPath, { readonly: true });
  const byName = new Map(captured.map((tool) => [tool.name, tool]));
  const tables = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  ).all().map((row) => row.name);
  db.close();
  await host.close();
  if (!runtime) throw new Error('LocalAgentHost did not open the workspace runtime');

  return {
    captured,
    observed: {
      root: 'cli',
      planes: {
        tool: new Set(byName.keys()),
        'agents-action': observedActionEnum(byName.get('agents')),
        'memory-action': observedActionEnum(byName.get('memory')),
        table: normalizeObservedTables(tables),
        producer: wiredProducers(runtime),
      },
    },
  };
}

describe('cli backend conformance', () => {
  test('the observed surface matches the manifest', async () => {
    const { observed, captured } = await observeCli();

    const report = compareSurface(observed);
    expect(renderConformanceFindings(report)).toBe('');
    expect(report.unmeasured).toEqual([]);

    // Guards the guard: the capture must have seen a real surface — if the
    // model were never called or the tool array went empty, the comparison
    // above would judge an empty world.
    expect(captured.length).toBeGreaterThanOrEqual(5);
    expect(observed.planes.table!.size).toBeGreaterThanOrEqual(25);
    expect(observed.planes.tool!.has('execute_tools')).toBe(true);
    // The peer transport reached the model: `reply` exists only when the host
    // wired peers, so this is the local virtual workspace's mail showing up in
    // the action enum a real model is handed.
    expect(observed.planes['agents-action']!.has('reply')).toBe(true);
  }, 30_000);
});
