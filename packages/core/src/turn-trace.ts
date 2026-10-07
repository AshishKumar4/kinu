import type { ToolExecutionOptions, ToolSet } from 'ai';
import type { ScopedSpan, TracedToolOptions, TurnTrace, TurnUnitTimer } from './obs/index';

type ToolInput = Parameters<NonNullable<ToolSet[string]['execute']>>[0];

const UNIT_FAILED = new Error('the unit failed');

export interface UnitStamps {
  readonly stamp: (span: ScopedSpan) => void;
  readonly failed: (span: ScopedSpan) => void;
}

/** Records `timer`'s unit when `work` settles, and settles as `work` does. */
export async function endWhenSettled<T>(work: Promise<T>, timer: TurnUnitTimer, stamps: UnitStamps): Promise<T> {
  let settled = false;

  try {
    const value = await work;
    settled = true;

    return value;
  } finally {
    timer.end(settled ? stamps.stamp : stamps.failed);
  }
}

export function traceTools(trace: TurnTrace | undefined, tools: ToolSet): ToolSet {
  if (trace === undefined) return tools;

  return Object.fromEntries(Object.entries(tools).map(([name, entry]) => {
    const execute = entry.execute;

    if (execute === undefined) return [name, entry];

    return [name, {
      ...entry,
      execute: (input: ToolInput, options: ToolExecutionOptions<unknown>) => {
        const timer = trace.begin('turn.tool_call');

        const stamp = (span: ScopedSpan): void => {
          span.setAttribute('gen_ai.operation.name', 'execute_tool');
          span.setAttribute('gen_ai.tool.name', name);
        };

        const traced: TracedToolOptions = { ...options, trace };

        const failed = (span: ScopedSpan): void => {
          stamp(span);
          span.fail(UNIT_FAILED);
        };

        let returned = false;

        try {
          const result = execute(input, traced);
          returned = true;

          if (!(result instanceof Promise)) {
            timer.end(stamp);

            return result;
          }

          return endWhenSettled(result, timer, { stamp, failed });
        } finally {
          if (!returned) timer.end(failed);
        }
      },
    }];
  }));
}

export interface ModelCallFacts {
  readonly spec: string;
  readonly provider: string | undefined;
  readonly index: number;
  readonly fallback: boolean;
}

export interface FinishedStep {
  readonly finishReason: string;
  readonly toolCalls: readonly unknown[];
  readonly usage: { readonly inputTokens?: number | undefined; readonly outputTokens?: number | undefined };
  readonly response: { readonly modelId?: string | undefined };
}

export class StepSpans {
  private open: TurnUnitTimer | null = null;

  constructor(
    private readonly trace: TurnTrace | undefined,
    private readonly facts: ModelCallFacts,
  ) {}

  start(step: number): void {
    if (this.trace === undefined) return;
    this.trace.atStep(step);
    this.close(null, true);
    this.open = this.trace.begin('turn.step');
  }

  finish(step: FinishedStep): void {
    const timer = this.open;

    if (timer === null) return;
    this.open = null;
    timer.end((span) => {
      this.stampModel(span);
      span.setAttribute('gen_ai.response.finish_reasons', step.finishReason);
      span.setAttribute('kinu.step.tool_calls', step.toolCalls.length);

      if (step.response.modelId !== undefined) span.setAttribute('gen_ai.response.model', step.response.modelId);

      if (step.usage.inputTokens !== undefined) span.setAttribute('gen_ai.usage.input_tokens', step.usage.inputTokens);

      if (step.usage.outputTokens !== undefined) span.setAttribute('gen_ai.usage.output_tokens', step.usage.outputTokens);
    });
  }

  close(failure: Error | null, interrupted: boolean): void {
    const timer = this.open;

    if (timer === null) return;
    this.open = null;
    timer.end((span) => {
      this.stampModel(span);
      span.setAttribute('kinu.step.interrupted', interrupted);

      if (failure !== null) span.fail(failure);
    });
  }

  private stampModel(span: ScopedSpan): void {
    span.setAttribute('gen_ai.operation.name', 'chat');
    span.setAttribute('gen_ai.request.model', this.facts.spec);
    span.setAttribute('gen_ai.provider.name', this.facts.provider ?? '');
    span.setAttribute('kinu.model.call', this.facts.index);
    span.setAttribute('kinu.model.fallback', this.facts.fallback);
  }
}
