/**
 * The vendor half of the steer chain, executed for real: Think + Session +
 * hibernatable sockets under workerd. ActorAgent's own steer methods are thin
 * orchestration over three seams — the steer buffer, `broadcast`, and
 * `addMessages` — and the bun suite runs THEM for real while stubbing the
 * seams. This probe pins what those stubs assume: a user row appended with
 * `addMessages` from INSIDE a live turn becomes durable, reaches a connected
 * client by turn end, and sits between the turn's user message and the
 * assistant answer (the 2026-08-19 stuck-bubble incident chain).
 *
 * Deliberately Think, not ActorAgent: a full ActorAgent turn requires the
 * hosted workspace plane (NIMBUS_SESSION's wasm subgraph, LOADER's
 * worker_loaders), and this pool loads neither — measured 2026-08-20, wasm
 * import fails as "ESM integration proposal for Wasm is not supported", and
 * hosting any `@callable()`-bearing class additionally needs
 * `oxc: { decorator: { legacy: true } }` in vitest.config (raw decorators are
 * a workerd SyntaxError). The composed chain over the real OrchestratorAgent
 * belongs to the dev-server e2e tier.
 */
import { Think } from '@cloudflare/think';
import { scriptedTurnModel } from '@kinu/test-utils/turn-model';
import { jsonSchema, tool, type LanguageModel, type ToolSet } from 'ai';

const USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 3, text: 3, reasoning: undefined },
};

export class SteerProbeDO extends Think<Cloudflare.Env> {
  private _model: LanguageModel | null = null;
  private waitRelease: ((v: string) => void) | null = null;
  private waitPromise: Promise<string> | null = null;
  /** Set inside the wait tool, read by the test to act mid-turn deterministically. */
  private engaged = false;

  /** Step 1 calls `wait`; step 2 (a tool result is present) answers. */
  override getModel(): LanguageModel {
    this._model ??= scriptedTurnModel({
      provider: 'fake', modelId: 'steer-probe',
      doGenerate: (options) => {
        const stepTwo = options.prompt.some((m) => m.role === 'tool');
        return stepTwo
          ? {
            content: [{ type: 'text' as const, text: 'done after steer' }],
            finishReason: { unified: 'stop' as const, raw: undefined }, usage: USAGE, warnings: [],
          }
          : {
            content: [{ type: 'tool-call' as const, toolCallId: 'wait-1', toolName: 'wait', input: '{}' }],
            finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage: USAGE, warnings: [],
          };
      },
    });
    return this._model;
  }

  override getTools(): ToolSet {
    return {
      wait: tool({
        description: 'Blocks until the test releases it.',
        inputSchema: jsonSchema({ type: 'object', properties: {} }),
        execute: async () => {
          this.engaged = true;
          if (!this.waitPromise) {
            const { promise, resolve } = Promise.withResolvers<string>();
            this.waitPromise = promise;
            this.waitRelease = resolve;
          }
          return this.waitPromise;
        },
      }),
    };
  }

  override getSystemPrompt(): string { return 'Probe actor.'; }

  waitEngaged(): boolean { return this.engaged; }
  releaseWait(): void { this.waitRelease?.('released'); }

  /** Exactly what recordLandedSteers does at this seam: a verbatim user row,
   *  same id as the live chip, appended without enqueuing a turn. */
  async recordSteerRow(steerId: string, text: string): Promise<void> {
    await this.addMessages([{
      id: steerId,
      role: 'user' as const,
      parts: [{ type: 'text' as const, text }],
      metadata: { proteusSteer: true },
    }]);
  }

  /** The DO's own view, for the test's failure messages. */
  debugSnapshot() {
    return { name: this.name, messageCount: this.messages.length };
  }
}
