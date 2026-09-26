import type { ToolExecutionOptions, ToolSet } from 'ai';
import { KinuError, type ScopedSpan, type TracedInvocation } from './obs/index';

export type TracedToolOptions = ToolExecutionOptions & { readonly trace?: TracedInvocation };

type ToolInput = Parameters<NonNullable<ToolSet[string]['execute']>>[0];

interface Started<T> {
  value?: T;
}

export function traceTools(trace: TracedInvocation | undefined, tools: ToolSet): ToolSet {
  if (trace === undefined) return tools;

  return Object.fromEntries(Object.entries(tools).map(([name, entry]) => {
    const execute = entry.execute;

    if (execute === undefined) return [name, entry];

    return [name, {
      ...entry,
      execute: (input: ToolInput, options: ToolExecutionOptions) => trace.span('turn.tool_call', (span) => {
        span.setAttribute('gen_ai.operation.name', 'execute_tool');
        span.setAttribute('gen_ai.tool.name', name);
        const traced: TracedToolOptions = { ...options, trace };

        return execute(input, traced);
      }),
    }];
  }));
}

export interface ModelCallFacts {
  readonly spec: string;
  readonly provider: string | undefined;
  readonly index: number;
  readonly fallback: boolean;
}

export class ModelCallSpan {
  private settle: () => void = () => {};
  private closed: Promise<void> = Promise.resolve();
  private span: ScopedSpan | null = null;

  constructor(
    private readonly trace: TracedInvocation | undefined,
    private readonly facts: ModelCallFacts,
  ) {}

  launch<T extends object>(start: () => T): T {
    const trace = this.trace;

    if (trace === undefined) return start();
    const done = new Promise<void>((resolve) => { this.settle = resolve; });
    const slot: Started<T> = {};

    this.closed = trace.span('turn.model_call', (span) => {
      this.span = span;
      span.setAttribute('gen_ai.operation.name', 'chat');
      span.setAttribute('gen_ai.request.model', this.facts.spec);
      span.setAttribute('gen_ai.provider.name', this.facts.provider ?? '');
      span.setAttribute('kinu.model.call', this.facts.index);
      span.setAttribute('kinu.model.fallback', this.facts.fallback);
      slot.value = start();

      return done;
    });

    if (slot.value === undefined) throw new KinuError('io', 'the model call returned nothing');

    return slot.value;
  }

  fail(error: Error): void {
    this.span?.fail(error);
  }

  finish(facts: { readonly steps: number; readonly interrupted: boolean }): void {
    this.span?.setAttribute('kinu.model.steps', facts.steps);
    this.span?.setAttribute('kinu.model.interrupted', facts.interrupted);
  }

  async close(): Promise<void> {
    this.settle();
    await this.closed;
  }
}
