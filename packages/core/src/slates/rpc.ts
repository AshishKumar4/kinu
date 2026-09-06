import type { Refusal } from '../obs/index';
import type { JsonValue } from '../utils/json';

const METHOD_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

/** A method the Slate bridge may forward to another Slate. */
export function isSlateMethodName(name: string): boolean {
  return METHOD_RE.test(name) && name !== 'constructor' && !name.startsWith('_');
}

/** A forwarded Slate call's JSON value or refusal. */
export type SlateCallResult =
  | { readonly ok: true; readonly value: JsonValue }
  | ({ readonly ok: false } & Refusal);

export interface SlateSummary {
  readonly id: string;
  readonly title: string;
  readonly bindings: readonly string[];
}

export interface SlateProblem extends Refusal {
  readonly id: string;
}

export const SLATES_CHANGED_EVENT = 'slates_changed';

export interface SlatesChangedEvent {
  readonly type: typeof SLATES_CHANGED_EVENT;
  readonly ids: readonly string[];
}
