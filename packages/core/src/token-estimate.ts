/** Token estimates from characters, where no tokenizer is at hand. */

/** A blunt chars-per-token average, used only to estimate. */
export const CHARS_PER_TOKEN = 4;

/** Conservative blended fallback (~$3 / 1M tokens) for the character seam and unpriced models;
 *  `ModelInfo.cost` is the real rate. */
const BLENDED_USD_PER_1K_TOKENS = 0.003;

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** The byte ceiling a token allocation implies; one derivation for every prompt-budget file admission. */
export function admissionBytes(tokens: number): number {
  return tokens * CHARS_PER_TOKEN;
}

export function estimateUsdCost(tokens: number): number {
  return (tokens / 1000) * BLENDED_USD_PER_1K_TOKENS;
}
