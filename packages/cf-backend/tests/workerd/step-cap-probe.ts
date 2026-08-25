/**
 * The vendor's step cap, executed for real. `Think` under workerd, driving a
 * model that calls a tool on EVERY step, so nothing but a stop condition can end
 * the turn.
 *
 * Why this belongs in this layer rather than in `bun test`. The cap is composed
 * inside `Think._prepareInferenceInvocation` and enforced by the AI SDK's own
 * loop; the bun suites stub the `agents` SDK and cannot run that loop at all, so
 * the one code path carrying the bound was reachable by no test. It shipped a
 * production defect while 1,100 tests passed and while two source files asserted
 * in prose that no bound existed: measured on the deployed revision, four of four
 * turns that reached ten steps were cut with the model still emitting tool calls,
 * and all four sealed `'completed'`.
 *
 * Two classes, identical but for one line — the line `ActorAgent`'s constructor
 * now carries. `CappedTurnProbeDO` leaves `Think`'s default in place and is the
 * CONTROL: it proves the cap is real in this runtime, so the other class is
 * measuring the override rather than a model that stopped early. `UnboundedTurnProbeDO`
 * sets `maxSteps` exactly as the production actor does.
 * a full actor turn needs the hosted workspace plane (NIMBUS_SESSION's wasm
 * subgraph, LOADER's worker_loaders) and this pool loads neither.
 */
import { Think } from '@cloudflare/think';
import { UNBOUNDED_MAX_STEPS } from '@kinu.run/core';
import * as v from 'valibot';
import { scriptedTurnModel } from '@kinu.run/test-utils/turn-model';
import { jsonSchema, tool, type LanguageModel, type ToolSet } from 'ai';

const USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 3, text: 3, reasoning: undefined },
};

/**
 * How many consecutive tool-calling steps the scripted model emits before it
 * answers.
 *
 * Past `Think`'s default of 10 by a clear margin, so "ran past the cap" is not a
 * fence-post reading, and small enough that the unbounded turn is a handful of
 * scripted round trips. The model's own stopping point is what proves the
 * unbounded turn ended by CHOICE rather than by another bound further out.
 */
export const TOOL_CALLING_STEPS = 14;

/** What one probe turn did, as the probe itself observed it through
 *  `onStepFinish` — the same hook the production actor accumulates on. */
export interface TurnObservation {
  /** Steps the SDK actually completed. */
  readonly steps: number;
  /** The `finishReason` of the LAST step. `'tool-calls'` means the loop stopped
   *  with the model still working, which is the whole signature of a cut turn. */
  readonly lastFinishReason: string | null;
  /** Whether the model ever got to answer. */
  readonly answered: boolean;
}

/** The shared probe body. Subclasses differ only in whether they override the
 *  bound, which is exactly the difference under test. */
abstract class TurnProbe extends Think<Cloudflare.Env> {
  private _model: LanguageModel | null = null;
  private steps = 0;
  private lastFinishReason: string | null = null;

  /** A tool call on every step until {@link TOOL_CALLING_STEPS} of them have
   *  landed, then an answer. Keyed off the tool messages already in the prompt,
   *  so the script is a function of the conversation rather than of call order. */
  override getModel(): LanguageModel {
    this._model ??= scriptedTurnModel({
      provider: 'fake', modelId: 'step-cap-probe',
      doGenerate: (options) => {
        const delivered = options.prompt.filter((m) => m.role === 'tool').length;
        return delivered >= TOOL_CALLING_STEPS
          ? {
            content: [{ type: 'text' as const, text: `answered after ${String(delivered)} tool steps` }],
            finishReason: { unified: 'stop' as const, raw: undefined }, usage: USAGE, warnings: [],
          }
          : {
            content: [{
              type: 'tool-call' as const,
              toolCallId: `tick-${String(delivered)}`,
              toolName: 'tick',
              input: '{}',
            }],
            finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage: USAGE, warnings: [],
          };
      },
    });
    return this._model;
  }

  override getTools(): ToolSet {
    return {
      tick: tool({
        description: 'Does nothing, successfully, as many times as it is asked.',
        inputSchema: jsonSchema({ type: 'object', properties: {} }),
        execute: async () => 'ok',
      }),
    };
  }

  override getSystemPrompt(): string { return 'Step-cap probe.'; }

  override onStepFinish(ctx: { finishReason?: unknown }): void {
    this.steps += 1;
    // The vendor hands this hook an untyped finish reason; the string is the
    // only shape this probe records, and anything else is "no reason".
    const parsed = v.safeParse(v.optional(v.string()), ctx.finishReason);
    this.lastFinishReason = parsed.success && parsed.output !== undefined ? parsed.output : null;
  }

  /**
   * What the last turn did, read after the fact.
   *
   * A turn is driven the way `steer-probe.ts` drives one — the real chat frame
   * over a real socket — because `Think.chat()` reaches a session plane this pool
   * does not stand up (measured: `undefined.appendMessage`). So the test opens the
   * turn and then asks for this.
   */
  observeTurn(): TurnObservation {
    const answered = this.messages.some((message) =>
      message.role === 'assistant'
      && message.parts.some((part) => part.type === 'text' && part.text.startsWith('answered after')));
    return { steps: this.steps, lastFinishReason: this.lastFinishReason, answered };
  }
}

/** THE CONTROL — the vendor default, untouched. This is what production was. */
export class CappedTurnProbeDO extends TurnProbe {}

/** THE FIX — the one line `ActorAgent`'s constructor carries. */
export class UnboundedTurnProbeDO extends TurnProbe {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.maxSteps = UNBOUNDED_MAX_STEPS;
  }
}
