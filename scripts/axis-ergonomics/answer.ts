/**
 * The I/O boundary of the study: everything a model says, parsed once, here.
 *
 * A model reply is external input, so it is parsed into a named domain type at
 * the edge rather than poked at with `typeof` further in. Two parses run over
 * every reply, and the pair is a measurement rather than belt-and-braces:
 *
 *   strict   did the model return the shape it was asked for? A model that
 *            cannot hold the answer contract is a fact about the surface's
 *            demands, and it has to be counted rather than silently repaired.
 *   lenient  what did it say anyway? `v.fallback` makes the read TOTAL, so a
 *            reply with one bad field still yields its good ones instead of
 *            costing the whole case. Discarding a case because `direction` came
 *            back as a number would throw away the preset choice, which is the
 *            thing being measured.
 */
import * as v from 'valibot';
import { extractJsonObject } from '@kinu/core';

const OptText = v.fallback(v.nullable(v.string()), null);
const OptMap = v.fallback(v.record(v.string(), v.string()), {});

/** What a phase-1 / phase-2 reply is asked for. */
const AnswerSchema = v.looseObject({
  decision: v.fallback(v.picklist(['swarm', 'no-swarm']), 'swarm'),
  no_swarm_because: OptText,
  preset: OptText,
  verify: OptText,
  key: OptText,
  axes: OptMap,
  measured: OptText,
  direction: OptText,
  axis_paraphrase: OptMap,
  nowhere_to_put: OptText,
  models: v.fallback(v.array(v.string()), []),
});

/** The same fields with no fallbacks, used only to decide conformance. */
const StrictAnswerSchema = v.looseObject({
  decision: v.picklist(['swarm', 'no-swarm']),
  preset: v.nullable(v.string()),
  axes: v.record(v.string(), v.string()),
});

export type Answer = v.InferOutput<typeof AnswerSchema>;

export interface ReadAnswer {
  /** The reply parsed as JSON at all. */
  readonly parsed: boolean;
  /** The reply matched the requested contract without repair. */
  readonly conformed: boolean;
  /** Why it did not — empty when it did. */
  readonly problems: readonly string[];
  readonly answer: Answer;
}

const EMPTY: Answer = v.parse(AnswerSchema, {});

export function readAnswer(text: string): ReadAnswer {
  let object;
  try {
    object = extractJsonObject(text);
  } catch (error) {
    return {
      parsed: false,
      conformed: false,
      problems: [`no JSON object in reply: ${error instanceof Error ? error.message : String(error)}`],
      answer: EMPTY,
    };
  }
  const strict = v.safeParse(StrictAnswerSchema, object);
  return {
    parsed: true,
    conformed: strict.success,
    problems: strict.success ? [] : strict.issues.map((i) => `${i.path?.map((p) => String(p.key)).join('.') ?? '?'}: ${i.message}`),
    answer: v.parse(AnswerSchema, object),
  };
}

// ── the two providers' own reply envelopes ──────────────────────────────────

/** The CLI's resolved credential file, read for the one field this study needs.
 *  Parsed rather than indexed, because it is a file on disk written by another
 *  program and that is an I/O boundary like any other. */
export const KinuConfigSchema = v.looseObject({
  providers: v.fallback(
    v.looseObject({
      openrouter: v.fallback(v.looseObject({ apiKey: v.fallback(v.string(), '') }), { apiKey: '' }),
    }),
    { openrouter: { apiKey: '' } },
  ),
});

const OllamaReplySchema = v.looseObject({
  message: v.fallback(v.looseObject({ content: v.fallback(v.string(), '') }), { content: '' }),
  prompt_eval_count: v.fallback(v.number(), -1),
  eval_count: v.fallback(v.number(), -1),
});

/** OpenAI-compatible chat-completions envelope — what OpenRouter answers with. */
const ChatCompletionSchema = v.looseObject({
  choices: v.fallback(
    v.array(v.looseObject({
      message: v.fallback(v.looseObject({ content: v.fallback(v.nullable(v.string()), '') }), { content: '' }),
    })),
    [],
  ),
  usage: v.fallback(
    v.looseObject({
      prompt_tokens: v.fallback(v.number(), -1),
      completion_tokens: v.fallback(v.number(), -1),
    }),
    { prompt_tokens: -1, completion_tokens: -1 },
  ),
});

export interface Reply {
  readonly text: string;
  /** -1 means the provider reported none. Absent is not zero: a run that
   *  totalled unreported usage as zero would print a spend line that is a lie. */
  readonly tokensIn: number;
  readonly tokensOut: number;
}

export function readOllamaReply(body: string): Reply {
  const r = v.parse(OllamaReplySchema, JSON.parse(body));
  return { text: r.message.content, tokensIn: r.prompt_eval_count, tokensOut: r.eval_count };
}

export function readChatCompletion(body: string): Reply {
  const r = v.parse(ChatCompletionSchema, JSON.parse(body));
  return {
    text: r.choices[0]?.message.content ?? '',
    tokensIn: r.usage.prompt_tokens,
    tokensOut: r.usage.completion_tokens,
  };
}

// ── the naming probes' replies ──────────────────────────────────────────────

const ForwardProbeSchema = v.looseObject({
  controls: v.fallback(v.string(), ''),
  values: OptMap,
  confidence: v.fallback(v.string(), ''),
});
export type ForwardProbeAnswer = v.InferOutput<typeof ForwardProbeSchema>;

const ReverseProbeSchema = v.looseObject({
  pair: v.fallback(v.string(), ''),
  confidence: v.fallback(v.string(), ''),
});
export type ReverseProbeAnswer = v.InferOutput<typeof ReverseProbeSchema>;

const EMPTY_FORWARD: ForwardProbeAnswer = v.parse(ForwardProbeSchema, {});
const EMPTY_REVERSE: ReverseProbeAnswer = v.parse(ReverseProbeSchema, {});

/** A probe reply plus why it could not be read, when it could not. A probe that
 *  came back as prose is a null datum for that axis, and the reason has to
 *  travel with it — an unreadable reply and a confident wrong reply are
 *  different findings and must never be totalled together. */
export interface ForwardProbeRead {
  readonly answer: ForwardProbeAnswer;
  readonly unreadable: string | null;
}
export interface ReverseProbeRead {
  readonly answer: ReverseProbeAnswer;
  readonly unreadable: string | null;
}

export function readForwardProbe(text: string): ForwardProbeRead {
  try {
    return { answer: v.parse(ForwardProbeSchema, extractJsonObject(text)), unreadable: null };
  } catch (error) {
    return { answer: EMPTY_FORWARD, unreadable: error instanceof Error ? error.message : String(error) };
  }
}

export function readReverseProbe(text: string): ReverseProbeRead {
  try {
    return { answer: v.parse(ReverseProbeSchema, extractJsonObject(text)), unreadable: null };
  } catch (error) {
    return { answer: EMPTY_REVERSE, unreadable: error instanceof Error ? error.message : String(error) };
  }
}
