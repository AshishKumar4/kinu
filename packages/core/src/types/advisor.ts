/** Ordered: a floor compares positions, so inserting a severity mid-array re-ranks it. */
export const ADVISOR_SEVERITIES = ['nit', 'concern', 'blocker'] as const;

export type AdvisorSeverity = (typeof ADVISOR_SEVERITIES)[number];

export function isAdvisorSeverity<Value>(value: Value): value is Value & AdvisorSeverity {
  return ADVISOR_SEVERITIES.some((severity) => severity === value);
}

/** Below the floor a note is still recorded as a Changelog row, but the agent is not told. */
export const DEFAULT_ADVISOR_MIN_SEVERITY: AdvisorSeverity = 'concern';
