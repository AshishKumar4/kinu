import type { ContextMeasureRow, ContextMeasures } from '../events/recorder';

export interface ContextFill {
  readonly tokens: number;
  readonly window: number | null;
  readonly source: 'provider' | 'gate';
  readonly at: string;
}

export function contextFill(measures: ContextMeasures, catalogWindow: number | null): ContextFill | null {
  const { provider, gate } = measures;
  // A step records no window of its own.
  const window = gate?.contextWindow ?? catalogWindow;

  if (gate !== null && (provider === null || newer(gate, provider))) {
    return gate.tokens === null ? null : { tokens: gate.tokens, window: gate.contextWindow, source: 'gate', at: gate.at };
  }

  return provider === null ? null : { tokens: provider.tokens, window, source: 'provider', at: provider.at };
}

function newer(a: Pick<ContextMeasureRow, 'at' | 'seq'>, b: Pick<ContextMeasureRow, 'at' | 'seq'>): boolean {
  return a.at === b.at ? a.seq > b.seq : a.at > b.at;
}
