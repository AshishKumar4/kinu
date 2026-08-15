// Backend conformance — the CLI composition root, observed for real.
//
// This deliberately rides the PRODUCTION chain end to end: the real
// `createAgent` (what `proteus create` runs), the real `openWorkspaceCLI`,
// and a real `LocalAgentSession` constructed exactly as LocalAgentClient
// constructs one — then one turn against a capturing model, so the observed
// tool surface is precisely the tool array the model provider was handed,
// schemas included. No hand-provisioned tables, no harness shortcuts: the
// craft_scores defect lived exactly in the gap between `proteus create` and
// the open path, and only running both closes it.
//
// The manifest lives in core/src/conformance/manifest.ts; compareSurface
// fails on any disagreement between it and what is observed here.
import { describe, test, expect, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { rmSync } from 'node:fs';
import type { LanguageModel } from 'ai';
import type { LanguageModelV2 } from '@ai-sdk/provider';
import {
  BACKGROUND_POLICY,
  compareSurface, normalizeObservedTables, observedActionEnum,
  renderConformanceFindings,
  type ObservedSurface,
} from '@proteus/core';
import { LocalAgentSession, openWorkspaceCLI, type LocalModelResolver } from '@proteus/cli-backend';
import { createCliAgent } from '../src/agent-create';
import { resolveLLMConfig, agentDbPath, agentDir } from '../src/config';
import { TestLanguageModelV2 } from '../../cli-backend/tests/test-language-model.js';

// Dummy provider config so resolveLLMConfig succeeds offline — the capturing
// model below intercepts before any network call could happen.
process.env.PROTEUS_BASE_URL = process.env.PROTEUS_BASE_URL ?? 'http://localhost:0/v1';
process.env.PROTEUS_AUTH = process.env.PROTEUS_AUTH ?? 'Bearer conformance';
process.env.PROTEUS_MODEL = process.env.PROTEUS_MODEL ?? 'conformance-model';

const AGENT_NAME = `conformance-${Date.now()}`;

afterAll(() => {
  rmSync(agentDir(AGENT_NAME), { recursive: true, force: true });
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
    fastModelCandidates: () => [],
    getAuth: async () => null,
  };
}

async function observeCli(): Promise<{ observed: ObservedSurface; captured: CapturedTool[] }> {
  await createCliAgent({ name: AGENT_NAME, mode: 'local', purpose: 'observe the conformance surface' });

  const dbPath = agentDbPath(AGENT_NAME);
  const db = new Database(dbPath);
  const { rt } = await openWorkspaceCLI(db, dbPath, { llm: resolveLLMConfig({}) });

  let captured: CapturedTool[] = [];
  const model = capturingModel((tools) => { captured = tools; });
  const session = new LocalAgentSession({
    rt,
    db,
    model,
    modelResolver: staticResolver(model),
    noAutoEvolve: true,
    backgroundPolicy: BACKGROUND_POLICY.interactive,
    oneShot: false,
    sessionId: 'conformance',
    persistMessages: true,
    onEvent: () => {},
  });
  await session.send('what can you do?');
  await session.end();

  const byName = new Map(captured.map((t) => [t.name, t]));
  const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all().map((row) => row.name);

  return {
    captured,
    observed: {
      root: 'cli',
      planes: {
        tool: new Set(byName.keys()),
        'agents-action': observedActionEnum(byName.get('agents')),
        'memory-action': observedActionEnum(byName.get('memory')),
        table: normalizeObservedTables(tables),
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
  }, 30_000);
});
