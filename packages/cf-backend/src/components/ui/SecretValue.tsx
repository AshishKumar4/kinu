/**
 * How a credential is allowed to appear on screen.
 *
 * The feedback dialog photographs the whole page, and the clone it rasterises
 * from blanks two things: password inputs, and any region carrying
 * `FEEDBACK_REDACT_ATTR`. A secret rendered as TEXT is neither, so it lands in
 * the PNG — which is how a webhook secret shown once and a bearer header typed
 * into an MCP form both reached the screenshot bucket.
 *
 * The fix is not "remember the attribute at each site". It is that a secret has
 * exactly ONE rendering, and that rendering carries the marker by construction:
 *
 *   `SecretValue`   a secret's characters on screen — the issued webhook secret,
 *                   and the same secret inside the curl command that tests it.
 *   `SECRET_REGION` the same marker for a region whose CONTENT is a credential
 *                   but is not a bare string: an editor holding request headers,
 *                   or an input that cannot be `type="password"`.
 *
 * `display: inline-block` is load-bearing rather than cosmetic. `redactClone`
 * empties the node's text, and the rasteriser inlines the clone's computed
 * geometry — which resolves to used pixels for an inline-block and to `auto` for
 * an inline box. Without it a redacted secret collapses to nothing, the line
 * reflows, and the block that was supposed to cover it covers a different place.
 */
import { FEEDBACK_REDACT_ATTR } from "@/feedback/contract";

/**
 * Spread onto any element whose rendered content is a credential. Frozen and
 * shared so the attribute is spelled once: a misspelling here is silent, and the
 * secret is already in the image by the time anyone reads the PNG.
 */
export const SECRET_REGION = Object.freeze({ [FEEDBACK_REDACT_ATTR]: "" });

/**
 * A secret's characters, in a region the screenshot blanks.
 *
 * `<code>` because that is what a token is, and because both call sites render
 * it in a monospace block already.
 */
export function SecretValue({ value, className }: { value: string; className?: string }) {
  return (
    <code {...SECRET_REGION} className={className} style={{ display: "inline-block" }}>
      {value}
    </code>
  );
}
