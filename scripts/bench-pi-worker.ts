#!/usr/bin/env bun
// Official Pi coding-agent baseline. It uses Pi's SDK session and native
// read/bash/edit/write tools, with no Kinu runtime or hand-built agent loop.
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createAgentSession, ModelRuntime, SessionManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createBenchInferenceProxy } from './bench-inference-proxy';
import { scoreSandbox } from './bench-sandbox';
import { parsePiWorkerInput, type WorkerOutput } from './bench-worker-protocol';

const PROVIDER_ID = 'bench-workers-ai';

function verifierFeedback(checks: Awaited<ReturnType<typeof scoreSandbox>>['checks']): string {
  const failed = checks.filter((check) => !check.passed);
  const detail = failed.map((check) => [
    `${check.id}: exit ${check.exitCode ?? 'timeout'}`,
    check.output.slice(-1500),
  ].filter(Boolean).join('\n')).join('\n\n');
  return [
    'The machine verifier still fails. Fix the implementation, then stop.',
    'Do not edit tests or verification scripts.',
    detail,
  ].join('\n\n');
}

async function main(): Promise<void> {
  const input = parsePiWorkerInput(await Bun.stdin.text());
  let session: AgentSession | undefined;
  const proxy = createBenchInferenceProxy({
    upstreamBaseURL: input.llm.baseURL,
    maxTokens: input.maxTokens,
    onBreach: () => { void session?.abort(); },
  });

  let error: string | undefined;
  let steps = 0;
  try {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const catalogModel = runtime.getModel('cloudflare-workers-ai', input.llm.model);
    if (!catalogModel) {
      throw new Error(`Pi has no Workers AI catalog entry for ${input.llm.model}`);
    }
    runtime.registerProvider(PROVIDER_ID, {
      name: 'Bench Workers AI',
      baseUrl: proxy.baseURL,
      api: 'openai-completions',
      apiKey: 'bench-request-auth-is-explicit',
      authHeader: false,
      headers: input.llm.headers,
      models: [{
        id: catalogModel.id,
        name: catalogModel.name,
        api: 'openai-completions',
        reasoning: catalogModel.reasoning,
        thinkingLevelMap: catalogModel.thinkingLevelMap,
        input: catalogModel.input,
        cost: catalogModel.cost,
        contextWindow: catalogModel.contextWindow,
        maxTokens: catalogModel.maxTokens,
        samplingParams: catalogModel.samplingParams,
        compat: catalogModel.compat,
      }],
    });
    const model = runtime.getModel(PROVIDER_ID, input.llm.model);
    if (!model) throw new Error(`Pi failed to register ${PROVIDER_ID}/${input.llm.model}`);

    ({ session } = await createAgentSession({
      cwd: process.cwd(),
      agentDir: input.agentDir,
      modelRuntime: runtime,
      model,
      sessionManager: SessionManager.inMemory(process.cwd()),
      tools: ['read', 'bash', 'edit', 'write'],
    }));

    for (const [index, ask] of input.asks.entries()) {
      await session.prompt(ask);
      await proxy.settle();
      steps++;
      const remove = input.removeAfterAsk[index];
      if (remove) rmSync(join(process.cwd(), remove), { recursive: true, force: true });
    }

    if (input.verifierRetry && proxy.usage().tokens <= input.maxTokens) {
      const verification = await scoreSandbox(input.task, {
        dir: process.cwd(),
        kinuHome: dirname(input.agentDir),
        dispose() {},
      }, input.repoRoot);
      if (!verification.passed) {
        await session.prompt(verifierFeedback(verification.checks));
        steps++;
      }
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    if (session) {
      try {
        await session.abort();
      } catch (caught) {
        const abortError = `session abort failed: ${caught instanceof Error ? caught.message : String(caught)}`;
        error = error ? `${error}; ${abortError}` : abortError;
      }
      session.dispose();
    }
    await proxy.settle();
  }

  const usage = proxy.usage();
  proxy.stop(true);
  if (usage.unmeteredResponses > 0) {
    const usageError = `${usage.unmeteredResponses} successful inference response(s) omitted token usage`;
    error = error ? `${error}; ${usageError}` : usageError;
  }
  const out: WorkerOutput = {
    tokens: usage.tokens,
    steps,
    hadError: error !== undefined,
    budgetBreach: usage.tokens > input.maxTokens ? 'tokens' : null,
    peakPromptTokens: usage.peakPromptTokens,
    modelCalls: usage.calls,
  };
  if (error) out.error = error;
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

// A crash before the meter reported carries no token figures at all. Reporting
// zeros here billed a crashed attempt as the cheapest run in the arm and as
// inside its token budget, which is the one thing a budget must never say about
// an attempt it never measured.
main().catch((caught) => {
  const out: WorkerOutput = {
    steps: 0,
    hadError: true,
    budgetBreach: null,
    error: caught instanceof Error ? (caught.stack ?? caught.message) : String(caught),
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(1);
});
