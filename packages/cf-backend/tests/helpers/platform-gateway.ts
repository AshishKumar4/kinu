// Fixtures for the platform AI Gateway provider: usable only with a parseable gateway URL and a bound `env.AI`.
import type { GatewayRunRequest, ProviderEnv, WorkersAIBinding } from '@kinu.run/core';
import * as v from 'valibot';

/** Shape `AI_GATEWAY_URL` must have: {origin}/v1/{account}/{gateway}/{provider}/... */
export const TEST_GATEWAY_URL =
  'https://gateway.ai.cloudflare.com/v1/testaccount0000000000000000000/test-gateway/workers-ai/v1';

export interface RecordedGatewayRun extends GatewayRunRequest {
  gateway: string;
  signal: AbortSignal | undefined;
}

export interface StubbedAiBinding {
  binding: WorkersAIBinding;
  runs: RecordedGatewayRun[];
}

/** Only `gateway().run()` exists, so a suite reaching for another binding method fails loudly. */
export function stubAiBinding(
  respond: (run: RecordedGatewayRun) => Response | Promise<Response> = () => Response.json({ ok: true }),
): StubbedAiBinding {
  const runs: RecordedGatewayRun[] = [];

  return {
    runs,
    binding: {
      gateway(gateway: string) {
        return {
          run(data: GatewayRunRequest, options?: { signal?: AbortSignal }): Promise<Response> {
            const recorded: RecordedGatewayRun = { gateway, ...data, signal: options?.signal };
            runs.push(recorded);

            return Promise.resolve(respond(recorded));
          },
        };
      },
    },
  };
}

/** URL and binding are both required for the provider to be available. */
export function platformGatewayEnv(stub: StubbedAiBinding = stubAiBinding()): Partial<ProviderEnv> {
  return { AI_GATEWAY_URL: TEST_GATEWAY_URL, AI: stub.binding };
}

const StreamedQuerySchema = v.looseObject({ stream: v.optional(v.boolean()) });

/**
 * The OpenAI-compatible answer the gateway returns for `text`: one chat completion, or the SSE
 * stream a streaming request asks for. The platform shape, so everything above the binding is
 * production's.
 */
export function chatCompletion(run: RecordedGatewayRun, text: string): Response {
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  const head = { id: 'chatcmpl-harness', created: 0, model: 'harness' };

  if (v.parse(StreamedQuerySchema, run.query).stream !== true) {
    return Response.json({
      ...head, object: 'chat.completion', usage,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    });
  }

  const chunks = [
    { ...head, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { ...head, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage },
  ];

  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** A gateway every call of which the model answers with `text`. */
export function answeringGateway(text: string): StubbedAiBinding {
  return stubAiBinding((run) => chatCompletion(run, text));
}

/** A model spec the platform gateway serves: every lane routed to it reaches the stub binding. */
export const GATEWAY_MODEL = 'ai-gateway/workers-ai/@cf/harness/model';
