// Backend conformance over the production `kinu create` + open chain; compareSurface fails on any
// disagreement with core/src/conformance/manifest.ts.
import { describe, test, expect, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';

import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LanguageModel } from 'ai';
import type { LanguageModelV2 } from '@ai-sdk/provider';
import {
  compareSurface, normalizeObservedTables, observedActionEnum, wiredProducers,
  renderConformanceFindings, NO_COUNT_ENDPOINT,
  type ObservedSurface,
} from '@kinu.run/core';
import {
  LocalAgentHost, openWorkspaceCLI,
  type CLIRuntime, type LocalModelResolver,
} from '@kinu.run/cli-backend';
import { createCliAgent } from '../src/agent-create';
import { resolveLLMConfig, agentDbPath, AGENT_HOME, listLocalRefsAllProjects, updateConfigFile } from '../src/config';
import { TestLanguageModelV2 } from '../../cli-backend/tests/test-language-model';
import { present } from '@kinu.run/test-utils';

// Dummy provider config so resolveLLMConfig succeeds offline. Passed as arguments, not `process.env`:
// bun runs every file of an invocation in one process, so env set here leaks into later files.
const OFFLINE_PROVIDER = {
  baseUrl: 'http://localhost:0/v1',
  auth: 'Bearer conformance',
  model: 'openai-compatible/conformance-model',
};

// `AGENT_HOME` binds at module load (config.ts), and a hand-run `bun test --cwd packages/cli` skips
// scripts/test-preload.ts, so prove the home is throwaway before creating anything.
if (resolve(AGENT_HOME) === resolve(join(homedir(), '.kinu'))
  || !resolve(AGENT_HOME).startsWith(resolve(tmpdir()))) {
  throw new Error(
    `conformance suite refuses to run against a real Kinu home (${AGENT_HOME}). `
    + 'Run it as `bun test packages/cli/tests/conformance.test.ts` from the repo root so '
    + 'scripts/test-preload.ts provides a throwaway KINU_HOME.',
  );
}

const AGENT_NAME = `conformance-${Date.now()}`;

afterAll(async () => {
  // `kinu create` also writes an `agents` entry, and no product path removes a local one.
  await updateConfigFile((config) => {
    if (config.agents) delete config.agents[AGENT_NAME];
  });
});

type CapturedTool = NonNullable<Parameters<LanguageModelV2['doStream']>[0]['tools']>[number];

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
    normalizeSpecSync: (spec: string | null | undefined) => {
        const trimmed = spec?.trim();

        return trimmed === undefined || trimmed === '' ? 'conformance/conformance-model' : trimmed;
      },
    resolveModel: () => model,
    credentialFor: async () => null,
    listProviders: async () => [],
    listModels: async () => ({ models: [], failures: [] }),
    modelInfo: async () => null,
    judgeCandidates: async () => [],
    getAuth: async () => null,
    // A conformance model has no count endpoint, so admission runs ungated.
    countInputTokens: async () => ({
      kind: 'unsupported' as const,
      provider: 'conformance',
      reason: NO_COUNT_ENDPOINT,
    }),
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
    // The host binds planes from placement, never from an agent.db.
    roster: () => listLocalRefsAllProjects(),
    dbPath: () => dbPath,
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
  await session.send('what can you do?', { id: crypto.randomUUID() });

  const db = new Database(dbPath, { readonly: true });
  // Only a function tool carries an input schema; provider-defined tools have no Kinu action enum.
  const byName = new Map(captured.flatMap((tool) => tool.type === 'function' ? [[tool.name, tool] as const] : []));

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

    expect(captured.length).toBeGreaterThanOrEqual(5);
    expect(present(observed.planes.table, 'the table plane').size).toBeGreaterThanOrEqual(25);
    expect(present(observed.planes.tool, 'the tool plane').has('eval')).toBe(true);
    // `event_id` is in the advertised schema exactly when the host wired peer transport.
    expect(present(observed.planes['agents-action'], 'the agents-action plane').has('msg')).toBe(true);
    expect(JSON.stringify(captured.find((tool) => tool.name === 'agents') ?? {}))
      .toContain('event_id');
  });
});
