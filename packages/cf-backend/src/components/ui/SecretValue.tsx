/**
 * The feedback screenshot blanks password inputs and `FEEDBACK_REDACT_ATTR` regions only, so every
 * secret renders through here. `inline-block` is load-bearing: the rasteriser inlines computed
 * geometry, and an inline box resolves to `auto`, collapsing the redaction cover.
 */
import { FEEDBACK_REDACT_ATTR } from "@kinu.run/core";
import type { ReactElement } from 'react';

/** Frozen and shared so the attribute is spelled once: a misspelling fails silently. */
export const SECRET_REGION = Object.freeze({ [FEEDBACK_REDACT_ATTR]: "" });

export function SecretValue({ value, className }: { value: string; className?: string }): ReactElement {
  return (
    <code {...SECRET_REGION} className={className} style={{ display: "inline-block" }}>
      {value}
    </code>
  );
}
