// Fixtures for the PLATFORM AI Gateway provider, whose transport is the Workers
// AI binding (src/providers/gateway-binding-fetch.ts). Availability depends on a
// parseable gateway URL AND a bound `env.AI`, so every suite that wants
// `ai-gateway` usable needs both — one place to say so.
import type { GatewayRunRequest, ProviderEnv, WorkersAIBinding } from '@kinu/core';

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

/** An `env.AI` stub that records every universal request and answers with
 *  `respond`. Only `gateway().run()` exists, so a suite that reaches for another
 *  binding method fails loudly instead of getting a silent no-op. */
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

/** An env in which the platform gateway is genuinely usable. Both halves are
 *  required: a URL without the binding, or a binding without a parseable URL,
 *  leaves the provider unavailable. */
export function platformGatewayEnv(stub: StubbedAiBinding = stubAiBinding()): Partial<ProviderEnv> {
  return { AI_GATEWAY_URL: TEST_GATEWAY_URL, AI: stub.binding };
}
