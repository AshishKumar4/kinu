/**
 * A stopped turn's failure as the chat shows it: the provider's own words, the facts its response body states, and the
 * body itself. Read from the failure text a turn records (`kinuTurnFailure`), the cause chain of the refusal.
 */
import * as v from 'valibot';
import { tolerate } from '../obs/index';
import { providerName } from '../providers/model-test';

export interface TurnFailureFacts {
  /** The provider's name as the chat writes it, when the failure names one. */
  readonly provider: string | null;
  /** What the provider said, in its own words: the body's description or message, else the failure's last clause. */
  readonly words: string;
  /** Label and value, in the order a reader asks: status, code, message (when it says more than `words`), request. */
  readonly facts: readonly (readonly [string, string])[];
  /** The response body pretty-printed when it parses, else the failure as recorded. */
  readonly raw: string;
}

const STATUS_TEXT = new Map<number, string>([
  [400, 'Bad Request'], [401, 'Unauthorized'], [402, 'Payment Required'], [403, 'Forbidden'], [404, 'Not Found'],
  [408, 'Request Timeout'], [413, 'Payload Too Large'], [429, 'Too Many Requests'], [500, 'Internal Server Error'],
  [502, 'Bad Gateway'], [503, 'Service Unavailable'], [504, 'Gateway Timeout'], [529, 'Overloaded'],
]);

/** The tags the refusal's sentence carries: `(HTTP 429, rate_limit_error, workers-ai)`. */
const REFUSAL = /the provider refused the request \(([^)]*)\)/u;

const Said = v.optional(v.union([v.string(), v.number()]));

/** One level of a provider's error body: the fields a reader asks about, under the names providers use. */
const LevelSchema = v.looseObject({
  message: Said, description: Said, detail: Said, internalCode: Said, code: Said, type: Said, requestId: Said, request_id: Said,
});

const BodySchema = v.looseObject({ ...LevelSchema.entries, error: v.optional(v.unknown()), errors: v.optional(v.array(v.unknown())) });

type Body = v.InferOutput<typeof BodySchema>;

function bodyOf(text: string): Body | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');

  if (start < 0 || end <= start) return null;
  const parsed = v.safeParse(BodySchema, tolerate<unknown>(() => JSON.parse(text.slice(start, end + 1)), 'malformed-input'));

  return parsed.success ? parsed.output : null;
}

/** The first answer at any of `keys`, looked for in the body's `error` and its first `errors`, then at its top: an
 *  envelope's own `type` is often only `error`. */
function field(body: Body, keys: readonly (keyof typeof LevelSchema.entries)[]): string | null {
  const levels = [body.error, body.errors?.[0], body].flatMap((level) => {
    const read = v.safeParse(LevelSchema, level);

    return read.success ? [read.output] : [];
  });

  for (const level of levels) {
    for (const key of keys) {
      const value: unknown = level[key];

      if (typeof value === 'number') return String(value);

      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
  }

  return null;
}

/** The failure past its refusal sentence: what the provider said and what Kinu made of it, in the chain's order. */
function afterRefusal(failure: string): string {
  const refusal = REFUSAL.exec(failure);
  const rest = refusal === null ? failure : failure.slice(refusal.index + refusal[0].length).replace(/^\.?:\s*/u, '');

  return rest.trim() === '' ? failure : rest.trim();
}

/** A provider's message without the wrapper it repeats: `AiError: AiError: rate limiting … (c24bf08b-…)`. */
function cleaned(message: string): string {
  return message.replace(/^(?:\w*Error:\s*)+/u, '').replace(/\s*\([\da-f-]{16,}\)$/iu, '').trim();
}

export function turnFailureFacts(failure: string): TurnFailureFacts {
  const tags = REFUSAL.exec(failure)?.[1]?.split(',').map((tag) => tag.trim()).filter((tag) => tag !== '') ?? [];
  const status = tags.map((tag) => /^HTTP (\d{3})$/u.exec(tag)?.[1]).find((code) => code !== undefined);
  const named = tags.filter((tag) => !tag.startsWith('HTTP '));
  const provider = named.length === 0 ? null : providerName(named.at(-1) ?? '');
  const body = bodyOf(failure);
  const message = body === null ? null : field(body, ['message']);
  const described = body === null ? null : field(body, ['description', 'detail']);
  const words = described ?? (message === null ? null : cleaned(message)) ?? afterRefusal(failure);
  const code = body === null ? null : field(body, ['internalCode', 'code', 'type']);
  const request = body === null ? null : field(body, ['requestId', 'request_id']);
  const said = message === null ? null : cleaned(message);
  const facts: (readonly [string, string])[] = [];

  if (status !== undefined) facts.push(['Status', `${status} ${STATUS_TEXT.get(Number(status)) ?? ''}`.trim()]);

  if (code !== null && code !== status) facts.push(['Code', code]);

  if (said !== null && said !== words) facts.push(['Message', said]);

  if (request !== null) facts.push(['Request', request]);

  return { provider, words, facts, raw: body === null ? failure : JSON.stringify(body, null, 2) };
}
