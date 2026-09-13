import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { createOpenAIProvider, asFetchFunction } from '../packages/core/src/index';
import { summarizeSteps } from '../packages/core/src/events/step-stats';
import { provisionLocalTarget } from '../tests/evals/target-local';
import { LocalAgentSession } from '../packages/cli-backend/src/local-session';
import type { LocalModelResolver } from '../packages/cli-backend/src/model-resolver';

const provider = process.env.CACHE_MUSE_PROVIDER === 'go' ? 'opencode-go' : 'opencode-zen';

const modelId = provider === 'opencode-go' ? 'muse-spark-1.3-contributor' : 'muse-spark-1.3-contributor-free';

const baseURL = provider === 'opencode-go' ? 'https://opencode.ai/zen/go/v1' : 'https://opencode.ai/zen/v1';

const credentials = new Database(join(homedir(), '.omp/agent/agent.db'), { readonly: true });

const row = v.parse(v.object({ data: v.string() }), credentials.query(
  "SELECT data FROM auth_credentials WHERE provider = ? AND credential_type = 'api_key' AND disabled_cause IS NULL ORDER BY id LIMIT 1",
).get(provider));

credentials.close();

const { key } = v.parse(v.object({ key: v.string() }), JSON.parse(row.data));

const root = join(import.meta.dirname, '../bench-artifacts/cache-ema/2026-09-13', `${provider}-routed`);

await mkdir(root, { recursive: true });

const workload = v.parse(v.array(v.object({ id: v.string(), turns: v.array(v.string()) })),
  JSON.parse(await readFile(join(root, '../workload.json'), 'utf8')));

for (const conversation of workload) {
  const captures: Array<Promise<void>> = [];
  const dir = await mkdtemp(join(tmpdir(), 'kinu-cache-muse-'));
  let requestNumber = 0;

  const model = createOpenAIProvider().createModel(modelId, {
    env: {}, hasCredential: async () => true,
    getAuth: async () => ({ headers: {
      authorization: `Bearer ${key}`, 'user-agent': 'kinu/0.2.0',
      'x-opencode-session': `kinu-cache-ema-${conversation.id}-${dir.split('/').at(-1)}`,
    } }),
    fetch: asFetchFunction(async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const body = init?.body ?? await request.text();
      const index = requestNumber++;
      await writeFile(join(root, `${conversation.id}-request-${index}.json`), String(body));
      const response = await fetch(`${baseURL}/responses`, { ...init, body });
      const copy = response.clone();
      captures.push(copy.text().then((text) => writeFile(join(root, `${conversation.id}-response-${index}.txt`), text)));
      console.log(`${conversation.id} request ${index}: HTTP ${response.status}`);

      return response;
    }),
  });

  const target = await provisionLocalTarget({
    dir, workspace: `eval-cache-muse-${conversation.id}`, purpose: 'A concise assistant that follows the requested tool actions precisely.',
    llm: { name: 'openai', model: modelId, baseURL, headers: { authorization: `Bearer ${key}` } },
    model, evolution: false,
  });

  const spec = `openai/${modelId}`;

  const resolver: LocalModelResolver = {
    normalizeSpecSync: () => spec, resolveModel: () => model,
    listProviders: async () => [{ id: 'openai', available: true }],
    listModels: async () => ({ models: [{ provider: 'openai', id: modelId, label: modelId, contextWindow: 1048576 }], failures: [] }),
    modelInfo: async () => ({ id: modelId, contextWindow: 1048576 }),
    judgeCandidates: async () => [spec], getAuth: async () => null,
    countInputTokens: async () => ({ kind: 'unsupported', provider: 'openai', reason: 'OpenCode exposes no input count endpoint' }),
  };

  const session = new LocalAgentSession({ rt: target.runtime, db: target.db, model,
    modelResolver: resolver, cwd: dir, noAutoEvolve: true, onEvent: () => {} });

  try {
    await session.setModel(spec);

    for (const [index, prompt] of conversation.turns.entries()) {
      await session.send(prompt);
      await session.settleBackgroundWork();
      const events = await target.runEvents();
      await writeFile(join(root, `${conversation.id}-events.json`), JSON.stringify(events, null, 2));
      const steps = events.filter((event) => event.type === 'step_finish');
      await writeFile(join(root, `${conversation.id}-summary.json`), JSON.stringify({
        table: steps.map((step) => ({ runId: step.runId, step: step.stepIndex, input: step.usage?.input, cacheRead: step.usage?.cacheRead,
          share: step.usage?.input && step.usage.cacheRead !== undefined ? step.usage.cacheRead / step.usage.input : null })),
        stats: summarizeSteps(steps, { windowLimit: 200 }),
      }, null, 2));
      console.log(`${conversation.id}: turn ${index + 1}, ${steps.length} steps`);

      if (steps.length === 0) throw new Error(`${provider}: no model steps recorded`);
    }
  } finally {
    try {
      await Promise.all(captures);
    } finally {
      await target.teardown();
    }
  }
}
