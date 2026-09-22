/**
 * The single answer a free-text response committed to. Substring scoring is not correctness: `42`
 * matches `1042`, and digits echoed from the question would score.
 */

/** Digit runs with thousands grouping as one token: `1,060` is 1060, `1,5,10,25` stays four numbers. */
const INTEGER_TOKEN = /-?\d{1,3}(?:,\d{3})+|-?\d+/g;

/** Fenced code is work, never an answer. */
const FENCED_BLOCK = /```[\s\S]*?```/g;

const WORD_CHAR = /[0-9A-Za-z_]/;

const DIGIT = /[0-9]/;

/**
 * The integer a response answered with, or `null` when it stated none. Fenced code is dropped unless
 * nothing else holds an integer; digit runs touching word characters and fraction parts are ignored;
 * the last integer wins, so an echoed question scores nothing.
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

/** The letters of a text answer, uppercased, so blocking, case and punctuation cannot decide a comparison. */
export function letterKey(text: string): string {
  return text.replace(/[^A-Za-z]/g, '').toUpperCase();
}
