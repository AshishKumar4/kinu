/**
 * What a free-text response STOOD BEHIND, for a task whose contract is one answer.
 *
 * A suite that scores `response.includes(String(answer))` is not measuring
 * correctness. `42` matches `1042`, and it matched worse than that here: in the
 * eight-problem algorithmic corpus four answers are single digits and the
 * QUESTION carries two of them — the `4` of `4x4 grid` and the `6` of
 * `[3,1,4,1,5,9,2,6,5,3,5,8,9,7,9]` — so a response that echoed its own prompt
 * scored CORRECT, and one echoed digit satisfied the whole suite's floor. The
 * `7` of that corpus was reachable from the `97 cents` in its own question.
 *
 * A model's answer is prose, so there is no structure to read instead of text.
 * These two rules are therefore stated as rules, and guarded by their own tests
 * beside every suite that scores with them.
 */

/**
 * Digit runs, with thousands grouping kept as ONE token.
 *
 * `1,060` reads as 1060 because a model writes a four-digit answer that way,
 * while `1,5,10,25` stays four numbers because `,5` is not a group of three. A
 * blanket comma strip would have joined a denomination list into one number.
 */
const INTEGER_TOKEN = /-?\d{1,3}(?:,\d{3})+|-?\d+/g;

/** Fenced code is work, never an answer. */
const FENCED_BLOCK = /```[\s\S]*?```/g;

/** A digit run touching one of these is part of a word: `4x4`, `v2`, `run_2`. */
const WORD_CHAR = /[0-9A-Za-z_]/;

const DIGIT = /[0-9]/;

/**
 * The integer a response answered with, or `null` when it stated none.
 *
 * THE RULE, in full, because a scorer whose extraction is undefined is the
 * substring test again with more steps:
 *
 *   1. Fenced code blocks are dropped. If dropping them leaves no integer at
 *      all, the whole response is read instead — the model put its answer in
 *      the fence rather than beside it.
 *   2. An integer is a maximal digit run, optionally signed and optionally
 *      grouped in thousands, whose neighbours are not letters, digits or
 *      underscores. So `4x4` yields nothing, and a signed token whose minus
 *      follows a digit (`0-3`) is a range rather than a negative.
 *   3. A decimal point BETWEEN digits belongs to a fraction, so `1.5` yields
 *      neither 1 nor 5. A trailing `1060.` is a sentence ending and yields 1060.
 *   4. The answer is the LAST such integer. Every one of these prompts asks for
 *      only the number, so anything a response states before its answer is
 *      working or echo — which is what makes an echoed question score zero.
 *
 * A response with no integer answered nothing. That is never a pass.
 */
export function finalIntegerAnswer(response: string): number | null {
  return lastStandaloneInteger(response.replace(FENCED_BLOCK, ' '))
    ?? lastStandaloneInteger(response);
}

function lastStandaloneInteger(text: string): number | null {
  let answer: number | null = null;
  for (const match of text.matchAll(INTEGER_TOKEN)) {
    const token = match[0];
    const start = match.index;
    const end = start + token.length;
    const before = text[start - 1] ?? '';
    const after = text[end] ?? '';
    if (WORD_CHAR.test(before) || WORD_CHAR.test(after)) continue;
    if (before === '.' && DIGIT.test(text[start - 2] ?? '')) continue;
    if (after === '.' && DIGIT.test(text[end + 1] ?? '')) continue;
    answer = Number(token.replaceAll(',', ''));
  }
  return answer;
}

/**
 * The letters of a text answer, uppercased.
 *
 * A decoded plaintext is compared on its letters so that the grouping the
 * ciphertext was blocked in, the case the model chose and any punctuation it
 * added cannot decide the comparison. Letters are the whole content of a
 * substitution-cipher answer.
 */
export function letterKey(text: string): string {
  return text.replace(/[^A-Za-z]/g, '').toUpperCase();
}
