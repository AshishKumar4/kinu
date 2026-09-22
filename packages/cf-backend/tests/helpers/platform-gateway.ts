// Fixtures for the platform AI Gateway provider: usable only with a parseable gateway URL and a bound `env.AI`.
import type { GatewayRunRequest, ProviderEnv, WorkersAIBinding } from '@kinu.run/core';

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
