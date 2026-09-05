import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, jsonSchema, stepCountIs, tool, type ModelMessage } from 'ai';
import { getAgentByName } from 'agents';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { runChat, type ChatEvent } from '../../../packages/core/src/chat';
import type { JsonObject } from '../../../packages/core/src/utils/json';
import { normalizeReplayForDestination } from '../../../packages/core/src/prompting/replay-normalization';
import { createWorkersTracer } from '../../../packages/cf-backend/src/obs/cf-tracer';
import { KinuSandboxExecutor, renderToolsPrelude } from '../../../packages/cf-backend/src/codemode-sandbox';
import { codemodeEgress } from '../../../packages/cf-backend/src/codemode-egress';
import { createDirectWorkersAIFetch } from '../../../packages/cf-backend/src/providers/direct-workers-ai-fetch';
import type { OrchestratorAgent } from '../../../packages/cf-backend/src/orchestrator';
export { CodemodeEgress } from '../../../packages/cf-backend/src/codemode-egress';

interface ProbeEnv {
  PROBE_SECRET: string;
  PROBE_WORKSPACE: string;
  AI: Ai;
  LOADER: WorkerLoader;
  STAGING_AGENT: DurableObjectNamespace<OrchestratorAgent>;
}

function workersModel(env: ProbeEnv, modelId = '@cf/qwen/qwen3-30b-a3b-fp8') {
  return createOpenAICompatible({
    name: 'workers-ai', baseURL: 'https://kinu-direct-workers-ai.invalid',
    fetch: createDirectWorkersAIFetch(env.AI),
  }).chatModel(modelId);
}

async function abortProbe(env: ProbeEnv, ordering: 'abort-first' | 'finish-first') {
  const abort = new AbortController();
  const underlying = workersModel(env);
  const textSeen = Promise.withResolvers<void>();
  let finalChunks = 0;
  const model: LanguageModelV3 = {
    specificationVersion: 'v3', provider: underlying.provider,
    modelId: underlying.modelId, supportedUrls: underlying.supportedUrls,
    doGenerate: (options) => underlying.doGenerate(options),
    async doStream(options) {
      const response = await underlying.doStream(options);
      return { ...response, stream: response.stream.pipeThrough(new TransformStream({
        async transform(part, controller) {
          if (part.type === 'finish') {
            finalChunks++;
            await textSeen.promise;
            if (ordering === 'abort-first') abort.abort();
          }
          controller.enqueue(part);
        },
      })) };
    },
  };
  const events: ChatEvent[] = [];
  let thrown: string | null = null;
  try {
    for await (const event of runChat({
      model, system: 'Answer the arithmetic question in one short sentence.',
      history: [{ role: 'user', content: 'What is 7 plus 5?' }],
      tools: {}, signal: abort.signal,
    })) {
      events.push(event);
      if (event.type === 'text-delta') textSeen.resolve();
      if (event.type === 'done' && ordering === 'finish-first') abort.abort();
    }
  } catch (cause) {
    thrown = cause instanceof Error ? cause.message : String(cause);
  }
  const done = events.filter((event) => event.type === 'done');
  return { ordering, finalChunks, terminalCount: done.length,
    text: done.map((event) => event.text), thrown, eventOrder: events.map((event) => event.type) };
}

async function replayProbe(env: ProbeEnv) {
  const tools = {
    add: tool({ description: 'Add two integers.',
      inputSchema: jsonSchema<{ a: number; b: number }>({
        type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'], additionalProperties: false,
      }), execute: ({ a, b }) => a + b,
    }),
  };
  const prompt: ModelMessage = { role: 'user', content: 'Call add for 142 and 857, then give the sum.' };
  const source = await generateText({
    model: workersModel(env, '@cf/openai/gpt-oss-20b'),
    messages: [prompt], tools, toolChoice: 'required', stopWhen: stepCountIs(1),
  });
  const history = [prompt, ...source.response.messages];
  const request = normalizeReplayForDestination(history, 'workers-ai') ?? history;
  const destination = await generateText({ model: workersModel(env),
    messages: [...request, { role: 'user', content: 'Use the completed tool result. Give only the sum.' }],
    tools, toolChoice: 'none',
  });
  const reasoning = source.content.filter((part) => part.type === 'reasoning');
  return {
    source: { provider: 'workers-ai / OpenAI GPT-OSS', model: '@cf/openai/gpt-oss-20b', responseId: source.response.id,
      finishReason: source.finishReason, reasoningParts: reasoning.length,
      reasoningMetadata: reasoning.map((part) => Object.keys(part.providerMetadata ?? {})),
      toolIds: source.toolCalls.map((part) => part.toolCallId) },
    replayToolIds: request.flatMap((message) => message.role === 'assistant' && Array.isArray(message.content)
      ? message.content.flatMap((part) => part.type === 'tool-call' ? [part.toolCallId] : []) : []),
    destination: { provider: 'workers-ai / Qwen', model: '@cf/qwen/qwen3-30b-a3b-fp8',
      responseId: destination.response.id, finishReason: destination.finishReason, text: destination.text },
  };
}

async function egressProbe(env: ProbeEnv) {
  const executor = new KinuSandboxExecutor({ loader: env.LOADER, egress: codemodeEgress() });
  const urls = ['https://example.com/', 'http://169.254.169.254/latest/meta-data/',
    'http://169.254.169.254.nip.io/latest/meta-data/', 'http://10.0.0.1.nip.io/',
    'http://127.0.0.1.nip.io/'];
  const results = [];
  for (const url of urls) {
    const code = `try { const r = await fetch(${JSON.stringify(url)}); return {status:r.status,body:(await r.text()).slice(0,180)}; } catch (cause) { return {error:cause.message}; }`;
    const result = await executor.execute(code, [{ name: 'tools', fns: {},
      prelude: renderToolsPrelude([], { workspace: 'hardening-probe' }) }]);
    results.push({ url, ...result });
  }
  return results;
}

async function webhookProbe(env: ProbeEnv) {
  const name = env.PROBE_WORKSPACE;
  const victim = `kinu-unsigned-${crypto.randomUUID()}`;
  const victimId = env.STAGING_AGENT.idFromName(victim).toString();
  const agent = await getAgentByName<Env, OrchestratorAgent>(env.STAGING_AGENT, name);
  const owner = crypto.randomUUID().replaceAll('-', '');
  try {
    await agent.claimOwner(owner);
    const webhook = await agent.createDurableWebhook({ label: 'hardening probe', auth_mode: 'bearer' });
    try {
      const signed = await fetch(`https://staging.kinu.run${webhook.url}`, {
        method: 'POST', headers: { authorization: 'Bearer deliberately-incorrect', 'content-type': 'application/json' },
        body: '{}', redirect: 'manual',
      });
      const unsigned = await fetch(`https://staging.kinu.run/api/workspaces/${victim}/webhook/${webhook.trigger_id}`, {
        method: 'POST', body: '{}', redirect: 'manual',
      });
      const forged = await fetch(`https://staging.kinu.run/api/workspaces/${victim}/webhook/${webhook.trigger_id}/v1-${'0'.repeat(32)}`, {
        method: 'POST', body: '{}', redirect: 'manual',
      });
      return { workspace: name, victim, victimId,
        signed: { status: signed.status, body: await signed.text() },
        unsigned: { status: unsigned.status, cache: unsigned.headers.get('cache-control') },
        forged: { status: forged.status, cache: forged.headers.get('cache-control') } };
    } finally { await agent.cancelTrigger(webhook.trigger_id, 'owner'); }
  } finally {
    await destroyProbeAgent(agent, owner);
  }
}

/** Destroying the agent aborts the object that answers the call, so the RPC
 *  itself reports `destroyed`; that is the success signal, not a failure. */
async function destroyProbeAgent(agent: DurableObjectStub<OrchestratorAgent>, owner: string) {
  try {
    await agent.destroyAgent(owner);
  } catch (cause) {
    if (!(cause instanceof Error) || cause.message !== 'destroyed') throw cause;
  }
}

interface WireObservation {
  readonly model: string;
  readonly spelling: string;
  readonly status?: number;
  readonly body?: string;
  readonly answered?: 'stream' | 'object';
  readonly thrown?: string;
}

/** What the binding's own validator accepts for the message spellings an OpenAI
 *  chat request can carry, per model: the schema is the platform's, the same for
 *  every text model, so one refusal here is a refusal for every destination. */
async function wireProbe(env: ProbeEnv): Promise<WireObservation[]> {
  const runner: {
    run(model: string, inputs: JsonObject, options: { returnRawResponse: true }):
      Promise<Response | ReadableStream<Uint8Array> | JsonObject>;
  } = env.AI;
  const tools = [{ type: 'function', function: { name: 'add', description: 'Add two integers.',
    parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } } }];
  const call = { id: 'call_kinu_0', type: 'function', function: { name: 'add', arguments: '{"a":2,"b":3}' } };
  const opener = { role: 'user', content: 'Call add for 2 and 3, then give the sum.' };
  const result = { role: 'tool', tool_call_id: 'call_kinu_0', content: '5' };
  const closer = { role: 'user', content: 'Use the completed tool result. Give only the sum.' };
  const spellings = {
    'user-text-parts': { messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }] }] },
    'assistant-null-content': { tools, messages: [opener, { role: 'assistant', content: null, tool_calls: [call] }, result, closer] },
    'assistant-empty-content': { tools, messages: [opener, { role: 'assistant', content: '', tool_calls: [call] }, result, closer] },
    'assistant-reasoning-content': { tools, messages: [opener,
      { role: 'assistant', content: '', reasoning_content: 'Adding them with the tool.', tool_calls: [call] }, result, closer] },
  } satisfies Record<string, JsonObject>;
  const observations: WireObservation[] = [];
  for (const model of ['@cf/qwen/qwen3-30b-a3b-fp8', '@cf/openai/gpt-oss-20b', '@cf/zai-org/glm-5.3']) {
    for (const [spelling, inputs] of Object.entries(spellings)) {
      try {
        const answer = await runner.run(model, { ...inputs, max_tokens: 64 }, { returnRawResponse: true });
        observations.push(answer instanceof Response
          ? { model, spelling, status: answer.status, body: (await answer.text()).slice(0, 400) }
          : { model, spelling, answered: answer instanceof ReadableStream ? 'stream' : 'object' });
      } catch (cause) {
        observations.push({ model, spelling, thrown: cause instanceof Error ? cause.message : String(cause) });
      }
    }
  }
  return observations;
}

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    if (!env.PROBE_SECRET || request.headers.get('authorization') !== `Bearer ${env.PROBE_SECRET}`) return new Response('Not found', { status: 404 });
    const path = new URL(request.url).pathname;
    if (path === '/trace') {
      const tracer = createWorkersTracer();
      return tracer.span('fetch.hardening_probe', { isolateGen: 1, selfPath: 'HardeningProbe:staging' }, (span) =>
        Response.json({ traced: span.isTraced, date: new Date().toISOString() }));
    }
    if (path === '/abort-first') return Response.json(await abortProbe(env, 'abort-first'));
    if (path === '/finish-first') return Response.json(await abortProbe(env, 'finish-first'));
    if (path === '/replay') return Response.json(await replayProbe(env));
    if (path === '/egress') return Response.json(await egressProbe(env));
    if (path === '/webhook') return Response.json(await webhookProbe(env));
    if (path === '/wire') return Response.json(await wireProbe(env));
    return new Response('Not found', { status: 404 });
  },
};
