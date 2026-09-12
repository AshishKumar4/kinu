/** The advisor severity contract, declared at the platform layer: the signal
 *  ledger and the config store share one severity vocabulary. */

/** How strongly a note asks to be weighed. ORDERED: a floor is a comparison of
 *  positions in this array, so inserting a severity in the middle re-ranks it. */
export const ADVISOR_SEVERITIES = ['nit', 'concern', 'blocker'] as const;

export type AdvisorSeverity = (typeof ADVISOR_SEVERITIES)[number];

/**
 * The default floor for reaching the conversation.
 *
 * `concern` keeps the conversation quiet by default. A `nit` is still recorded,
 * as a Changelog row, so the owner can read what the advisor thought without
 * the agent being told about it.
 */
export const DEFAULT_ADVISOR_MIN_SEVERITY: AdvisorSeverity = 'concern';
