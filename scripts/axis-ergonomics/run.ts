/**
 * The axis-ergonomics run: put the rendered surface in front of real models and
 * read back what they configure.
 *
 * Nothing searches. The surface is a docstring plus a schema, so a model's
 * ability to USE it is decided entirely at the moment it emits arguments —
 * which means the whole ergonomics question is answerable for the price of one
 * completion per case per model, before any engine exists to run.
 *
 * Three phases, and the second one is the one nobody usually runs:
 *
 *   1 CONFIGURE   surface + task -> a configuration, plus a per-axis paraphrase
 *                 of what the model thinks each value it set will DO. The
 *                 paraphrase is what separates "reasoned well about the concept,
 *                 lost on our word for it" from "did not understand the concept",
 *                 and without it every naming finding would be a guess.
 *   2 CORRECT     for every configuration the validity table refuses, hand back
 *                 the real `{reason, error}` text and ask again. A refusal that
 *                 carries its reason is worth exactly what its second attempt is
 *                 worth; this phase is the only thing that can price it.
 *   3 NAME        two probes that isolate the WORD from everything else.
 *                 forward: given only an axis name and its value list, say what
 *                 it controls. reverse: given the mechanism in prose and all 28
 *                 values flat, name the one meant. The owner's criterion is that
 *                 a name teaches a model what the thing does, and this is that
 *                 criterion made into a measurement.
 *
 * Two surface variants (bare / glossed) run through phases 1 and 2. The delta is
 * how much work the NAMES are doing once the glosses are taken away.
 *
 * Cost. The local arm is free: ollama on this machine, no metered call. The
 * remote arm is stated before it is spent, by --dry-run, and it is small — the
 * prompt is one docstring.
 *
 *   bun scripts/axis-ergonomics/run.ts --dry-run
 *   bun scripts/axis-ergonomics/run.ts --models gemma4:26b,gpt-5-mini --out results.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { CORPUS, ZOO_EXTRA_CASES, type Case } from './corpus';
import {
  AXIS_NAMES, AXIS_QUESTION, AXIS_VALUES,
  renderSwarmDescription, swarmSchema, valueGloss, type AxisName, type SurfaceVariant,
} from './surface';
import {
  refusalText, validate, type ProposedConfig, type RemedyOrder, type Validation,
} from './validate';
import {
  ProteusConfigSchema, readAnswer, readChatCompletion, readForwardProbe, readOllamaReply,
  readReverseProbe, type ForwardProbeRead, type ReadAnswer, type Reply,
} from './answer';

// ── models ──────────────────────────────────────────────────────────────────

interface ModelSpec {
  readonly id: string;
  readonly via: 'ollama' | 'openrouter';
  /** Which pretraining family it belongs to. A surface that only one family
   *  uses correctly is a surface tuned to that family, and the only way to see
   *  that is to record the family rather than the model. */
  readonly family: string;
  /** USD per million tokens. Zero for local and for OpenRouter's `:free` tier —
   *  the electricity here is not metered, and inventing a figure for it would be
   *  a fabricated number in a study whose whole point is measured ones. */
  readonly usdPerMTokIn: number;
  readonly usdPerMTokOut: number;
}

/**
 * Eight arms, seven families, and only three of them bill anything.
 *
 * The two local Gemmas differ by 2x in parameters on the same weights family,
 * which is the capacity control: it separates "this surface is hard" from "this
 * model is small". The three OpenRouter `:free` arms buy four more families for
 * nothing. The three paid arms are the population that actually matters — a
 * frontier agent is who will type these arguments — and they come to well under
 * a dollar for the whole study.
 */
const MODELS = {
  'gemma4:26b':
    { id: 'gemma4:26b', via: 'ollama', family: 'gemma', usdPerMTokIn: 0, usdPerMTokOut: 0 },
  'gemma4:12b-it-qat':
    { id: 'gemma4:12b-it-qat', via: 'ollama', family: 'gemma', usdPerMTokIn: 0, usdPerMTokOut: 0 },
  'z-ai/glm-5.2:free':
    { id: 'z-ai/glm-5.2:free', via: 'openrouter', family: 'glm', usdPerMTokIn: 0, usdPerMTokOut: 0 },
  // The `:free` GLM pool is shared upstream and walls this study 20 cases in
  // even honouring its own Retry-After, so the paid endpoint is the only way to
  // get a complete GLM arm. 50c/M in, $3.15/M out — about 24 cents for the run.
  'z-ai/glm-5.2':
    { id: 'z-ai/glm-5.2', via: 'openrouter', family: 'glm', usdPerMTokIn: 0.5, usdPerMTokOut: 3.15 },
  'openai/gpt-oss-20b:free':
    { id: 'openai/gpt-oss-20b:free', via: 'openrouter', family: 'gpt-oss', usdPerMTokIn: 0, usdPerMTokOut: 0 },
  'nvidia/nemotron-3-super-120b-a12b:free':
    { id: 'nvidia/nemotron-3-super-120b-a12b:free', via: 'openrouter', family: 'nemotron', usdPerMTokIn: 0, usdPerMTokOut: 0 },
  'anthropic/claude-sonnet-5':
    { id: 'anthropic/claude-sonnet-5', via: 'openrouter', family: 'claude', usdPerMTokIn: 2, usdPerMTokOut: 10 },
  'google/gemini-3-flash-preview':
    { id: 'google/gemini-3-flash-preview', via: 'openrouter', family: 'gemini', usdPerMTokIn: 0.5, usdPerMTokOut: 3 },
  'deepseek/deepseek-v3.2':
    { id: 'deepseek/deepseek-v3.2', via: 'openrouter', family: 'deepseek', usdPerMTokIn: 0.269, usdPerMTokOut: 0.4 },
} as const satisfies Record<string, ModelSpec>;

// ── transport ───────────────────────────────────────────────────────────────

interface OllamaBody {
  model: string;
  messages: { role: string; content: string }[];
  stream: false;
  options: { temperature: number; num_ctx: number; num_predict: number };
  format?: 'json';
}

async function askOllama(model: string, system: string, user: string, json: boolean): Promise<Reply> {
  const body: OllamaBody = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    stream: false,
    options: { temperature: 0, num_ctx: 16384, num_predict: 1600 },
  };
  if (json) body.format = 'json';
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ollama ${model}: ${String(res.status)} ${await res.text()}`);
  return readOllamaReply(await res.text());
}

interface ChatBody {
  model: string;
  messages: { role: string; content: string }[];
  max_tokens: number;
  temperature: number;
  response_format?: { type: 'json_object' };
}

/**
 * A 429 on the free tier is part of the protocol, not a failure: those models
 * sit behind a shared upstream pool and answer `Retry-After` when it is busy.
 * So the wait is the SERVER'S number when it gives one, and exponential
 * backoff only when it does not — a fixed schedule either gives up while the
 * server is still telling us how long to wait, or hammers a pool that asked to
 * be left alone.
 *
 * Bounded all the same. A run that retried forever would turn a dead endpoint
 * into a hang, and a hung arm reports nothing at all.
 */
const RETRY_STATUS: readonly number[] = [408, 429, 500, 502, 503, 504];
const MAX_ATTEMPTS = 10;
const MAX_BACKOFF_MS = 60_000;

const RetryAfterSchema = v.looseObject({
  error: v.fallback(
    v.looseObject({
      metadata: v.fallback(
        v.looseObject({ retry_after_seconds: v.fallback(v.number(), 0) }),
        { retry_after_seconds: 0 },
      ),
    }),
    { metadata: { retry_after_seconds: 0 } },
  ),
});

/** The server's own wait in ms, or 0 when it named none. OpenRouter puts it in
 *  the error body as well as the header, and the body is the one that survives
 *  a provider that forgot the header. */
function retryAfterMs(res: Response, body: string): number {
  const header = Number(res.headers.get('retry-after') ?? '');
  if (Number.isFinite(header) && header > 0) return header * 1000;
  try {
    return v.parse(RetryAfterSchema, JSON.parse(body)).error.metadata.retry_after_seconds * 1000;
  } catch (error) {
    // An unparseable error body simply names no wait; the caller falls back to
    // its own backoff. Reported so a systematically malformed provider shows up.
    process.stderr.write(`    (no retry-after in error body: ${error instanceof Error ? error.message : String(error)})\n`);
    return 0;
  }
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function openRouterKey(): string {
  const fromEnv = process.env['OPENROUTER_API_KEY'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  // The CLI's own resolved config is the same credential the rest of this
  // machine already uses; reading it here avoids asking for a second copy.
  const path = join(homedir(), '.proteus', 'config.json');
  const key = v.parse(ProteusConfigSchema, JSON.parse(readFileSync(path, 'utf8'))).providers.openrouter.apiKey;
  if (key === '') {
    throw new Error(
      'no OpenRouter credential: set OPENROUTER_API_KEY, or sign in so '
      + `${path} carries providers.openrouter.apiKey. The local ollama arms still run without it.`,
    );
  }
  return key;
}

async function askOpenRouter(model: string, system: string, user: string, json: boolean): Promise<Reply> {
  const body: ChatBody = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_tokens: 8000,
    // A study of a surface should not also be sampling its own noise.
    temperature: 0,
  };
  if (json) body.response_format = { type: 'json_object' };
  let lastStatus = 0;
  let lastBody = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${openRouterKey()}`,
        'x-title': 'proteus axis-ergonomics study',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return readChatCompletion(await res.text());
    lastStatus = res.status;
    lastBody = await res.text();
    if (!RETRY_STATUS.some((s) => s === lastStatus)) break;
    const named = retryAfterMs(res, lastBody);
    await sleep(Math.min(named > 0 ? named : 2000 * 2 ** (attempt - 1), MAX_BACKOFF_MS));
  }
  throw new Error(`openrouter ${model}: ${String(lastStatus)} ${lastBody}`);
}

function ask(spec: ModelSpec, system: string, user: string, json = true): Promise<Reply> {
  return spec.via === 'ollama'
    ? askOllama(spec.id, system, user, json)
    : askOpenRouter(spec.id, system, user, json);
}

// ── phase 1: configure ──────────────────────────────────────────────────────

const ANSWER_CONTRACT = `{
  "decision": "swarm" | "no-swarm",
  "no_swarm_because": string or null,
  "preset": one of the preset names, "custom", or null,
  "verify": string or null,
  "key": string or null,
  "axes": { axisName: value } or {},
  "measured": "the quantity that gets measured, or null if nothing is measured",
  "direction": "higher-better" | "lower-better" | null,
  "axis_paraphrase": { axisName: "one clause saying what setting it to the value you chose will DO" },
  "nowhere_to_put": "anything this request needs that the tool gives you no field for, or null"
}`;

/** The zoo variant's contract gains the one field the zoo variant's surface
 *  gains. Without a slot to put it in, a model that WANTED a model zoo could
 *  not tell us — and the resulting silence would read as the docstring working
 *  when it only means the answer shape never asked. */
const ZOO_ANSWER_CONTRACT = ANSWER_CONTRACT.replace(
  '\n}',
  ',\n  "models": ["model id", ...] or null\n}',
);

function configureSystem(variant: SurfaceVariant): string {
  return 'You are a coding agent. One of your tools is `agents.swarm`. This is its '
    + 'description exactly as you receive it:\n\n'
    + '--- tool description ---\n'
    + `${renderSwarmDescription(variant)}\n`
    + '--- json schema ---\n'
    + `${JSON.stringify(swarmSchema(), null, 2)}\n`
    + '--- end ---\n\n'
    + 'You also have ordinary tools for reading and editing files and running commands, '
    + 'so not every request needs this one.\n\n'
    + 'Answer with a single JSON object and nothing else, in this shape:\n'
    + `${variant === 'zoo' ? ZOO_ANSWER_CONTRACT : ANSWER_CONTRACT}\n\n`
    + 'Set `axes` only when preset is "custom". Fill `axis_paraphrase` for every axis you '
    + 'set, in your own words — do not quote the tool description back.';
}

function configureUser(c: Case): string {
  return `The owner says:\n\n"${c.prompt}"\n\nWhat do you do?`;
}

// ── phase 2: correct ────────────────────────────────────────────────────────

function correctUser(v: Validation): string {
  const errors = v.violations.map((x) => `- ${refusalText(x)}`).join('\n');
  return 'That call was refused.\n\n'
    + `{ "reason": "bad_input", "error": "${v.violations.map(refusalText).join(' ').replace(/"/g, "'")}" }\n\n`
    + `${errors}\n\n`
    + 'Answer again, in the same JSON shape, with a call that would be accepted.';
}

// ── phase 3: the naming probes ──────────────────────────────────────────────

function forwardNameUser(axis: AxisName): string {
  return 'A search API has an axis called `' + axis + '`. Its allowed values are: '
    + `${AXIS_VALUES[axis].join(', ')}.\n\n`
    + 'You have not been told what it means. From the name and the values alone, what do '
    + 'you think this axis controls, and what does each value do?\n\n'
    + 'Answer as JSON: { "controls": "one sentence", '
    + '"values": { value: "one clause each" }, "confidence": "high"|"medium"|"low" }';
}

/** The 28 values, flat and unlabelled by axis, so the reverse probe cannot be
 *  answered by elimination within an axis. */
const FLAT_VALUES: readonly string[] = AXIS_NAMES.flatMap(
  (a) => AXIS_VALUES[a].map((v) => `${a}:${v}`),
);

function reverseNameUser(mechanism: string): string {
  return 'Here is a mechanism a search API can be configured to use:\n\n'
    + `"${mechanism}"\n\n`
    + 'The API expresses every such mechanism as exactly one `axis:value` pair, drawn from '
    + 'this flat list:\n'
    + `${FLAT_VALUES.join(', ')}\n\n`
    + 'Which single pair means the mechanism above?\n\n'
    + 'Answer as JSON: { "pair": "axis:value", "confidence": "high"|"medium"|"low" }';
}

/** Every (axis, value) with its mechanism stated WITHOUT the value's own word,
 *  because a mechanism sentence containing the answer measures nothing. */
const REVERSE_PROBES: readonly { axis: AxisName; value: string; mechanism: string }[] =
  AXIS_NAMES.flatMap((axis) =>
    AXIS_VALUES[axis].map((value) => ({ axis, value, mechanism: valueGloss(axis, value) })));

// ── driver ──────────────────────────────────────────────────────────────────

/** One model's attempt at one case, and its correction attempt when the first
 *  was refused. The raw text is kept beside the parse because every naming
 *  finding in this study is read off what the model actually wrote. */
export interface Attempt {
  readonly raw: string;
  readonly read: ReadAnswer;
  readonly config: ProposedConfig;
  readonly validation: Validation;
}

export interface ConfigureResult {
  readonly model: string;
  readonly variant: SurfaceVariant;
  readonly caseId: string;
  readonly first: Attempt;
  /** Present only when `first` was refused — this is the correction measurement. */
  readonly corrected: Attempt | null;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

/** Empty strings and nulls both mean "the model did not set this". Collapsing
 *  them here keeps the validity table from having to know about JSON's two
 *  spellings of absent. */
function set(value: string | null): string | undefined {
  return value !== null && value.trim() !== '' ? value : undefined;
}

function attemptOf(raw: string, remedyOrder: RemedyOrder): Attempt {
  const read = readAnswer(raw);
  const config: ProposedConfig = {
    preset: set(read.answer.preset),
    verify: set(read.answer.verify),
    key: set(read.answer.key),
    axes: read.answer.axes,
    models: read.answer.models,
  };
  return { raw, read, config, validation: validate(config, remedyOrder) };
}

/** The two variants of the study proper. `zoo` is a targeted follow-up probe and
 *  is opted into with --variants, never run by default: mixing it into the main
 *  arms would change the surface under test half way through. */
const VARIANTS: readonly SurfaceVariant[] = ['bare', 'glossed'];
const ALL_VARIANTS: readonly SurfaceVariant[] = ['bare', 'glossed', 'zoo'];

async function runConfigure(
  spec: ModelSpec,
  variants: readonly SurfaceVariant[],
  only: readonly string[],
  remedyOrder: RemedyOrder,
  record: (r: ConfigureResult) => void,
): Promise<void> {
  for (const variant of variants) {
    const system = configureSystem(variant);
    // The zoo variant carries two post-hoc cases the pre-registered 20 cannot
    // answer. They never reach the bare/glossed arms.
    const all = variant === 'zoo' ? [...CORPUS, ...ZOO_EXTRA_CASES] : CORPUS;
    const cases = only.length === 0 ? all : all.filter((c) => only.some((id) => id === c.id));
    for (const c of cases) {
      const reply = await ask(spec, system, configureUser(c));
      const first = attemptOf(reply.text, remedyOrder);
      let corrected: Attempt | null = null;
      if (!first.validation.legal) {
        const second = await ask(
          spec,
          system,
          `${configureUser(c)}\n\nYou answered:\n${reply.text}\n\n${correctUser(first.validation)}`,
        );
        corrected = attemptOf(second.text, remedyOrder);
      }
      record({
        model: spec.id, variant, caseId: c.id, first, corrected,
        tokensIn: reply.tokensIn, tokensOut: reply.tokensOut,
      });
      const verdict = first.validation.legal ? '' : ` [REFUSED -> ${corrected?.validation.legal === true ? 'fixed' : 'still illegal'}]`;
      process.stderr.write(`  ${spec.id} ${variant} ${c.id} -> ${String(first.config.preset)}${verdict}\n`);
    }
  }
}

/** What the two naming probes produce for one model. Named rather than inferred
 *  so the report script imports a contract instead of the runner's shape. */
export interface ForwardName {
  readonly model: string;
  readonly axis: AxisName;
  readonly read: ForwardProbeRead;
}
export interface ReverseName {
  readonly model: string;
  readonly axis: AxisName;
  readonly value: string;
  /** The model named this exact axis:value pair for its own mechanism. */
  readonly correct: boolean;
  /** What it named instead — the whole point when it is wrong. */
  readonly chose: string;
  readonly confidence: string;
  readonly unreadable: string | null;
}
export interface NamingResult {
  readonly forward: readonly ForwardName[];
  readonly reverse: readonly ReverseName[];
}

async function runNaming(spec: ModelSpec): Promise<NamingResult> {
  const forward: ForwardName[] = [];
  const reverse: ReverseName[] = [];
  const bareSystem = 'You answer with a single JSON object and nothing else.';
  for (const axis of AXIS_NAMES) {
    const reply = await ask(spec, bareSystem, forwardNameUser(axis));
    forward.push({ model: spec.id, axis, read: readForwardProbe(reply.text) });
    process.stderr.write(`  ${spec.id} name-forward ${axis}\n`);
  }
  for (const probe of REVERSE_PROBES) {
    const reply = await ask(spec, bareSystem, reverseNameUser(probe.mechanism));
    const read = readReverseProbe(reply.text);
    const pair = read.answer.pair.trim().toLowerCase();
    reverse.push({
      model: spec.id, axis: probe.axis, value: probe.value, chose: pair,
      confidence: read.answer.confidence, unreadable: read.unreadable,
      correct: pair === `${probe.axis}:${probe.value}`.toLowerCase(),
    });
  }
  process.stderr.write(`  ${spec.id} name-reverse ${String(REVERSE_PROBES.length)} probes\n`);
  return { forward, reverse };
}

/** A reasoning model bills its hidden reasoning as OUTPUT, so pricing at the
 *  visible answer length would understate every arm that thinks first — and
 *  half this roster does. 350 tokens is a filled answer contract; the multiplier
 *  is the honest allowance, applied to all of them because an estimate is a
 *  CEILING or it is not worth printing. */
const VISIBLE_OUT_TOK = 350;
const REASONING_MULTIPLIER = 5;

function dryRun(models: readonly ModelSpec[], variants: readonly SurfaceVariant[], skipNaming: boolean): void {
  const promptTok = Math.ceil(configureSystem('glossed').length / 4);
  const cases = CORPUS.length * variants.length;
  const probes = skipNaming ? 0 : AXIS_NAMES.length + REVERSE_PROBES.length;
  console.log('── axis-ergonomics: cost, stated before anything is spent ──');
  console.log(`corpus:        ${String(CORPUS.length)} cases x ${String(variants.length)} variants (${variants.join('+')}) = ${String(cases)} configure calls`);
  console.log(`naming probes: ${String(AXIS_NAMES.length)} forward + ${String(REVERSE_PROBES.length)} reverse = ${String(probes)} calls`);
  console.log(`prompt:        ~${String(promptTok)} tok (glossed surface)`);
  let total = 0;
  for (const m of models) {
    // Correction calls are bounded by the corpus and re-send the whole exchange,
    // so they are priced at 2x an ordinary configure call and assumed for HALF
    // the corpus. An estimate that assumed none would understate.
    const calls = cases + probes;
    const inTok = (cases * promptTok) + (probes * 300) + (cases * 0.5 * promptTok * 2);
    const perOut = VISIBLE_OUT_TOK * REASONING_MULTIPLIER;
    const outTok = (calls + cases * 0.5) * perOut;
    const usd = (inTok / 1e6) * m.usdPerMTokIn + (outTok / 1e6) * m.usdPerMTokOut;
    total += usd;
    console.log(
      `  ${m.id.padEnd(38)} ${m.family.padEnd(9)} ~${String(Math.round(inTok / 1000))}k in / ~${String(Math.round(outTok / 1000))}k out  `
      + (m.via === 'ollama' ? '$0.00 (local, unmetered)' : `$${usd.toFixed(3)}`),
    );
  }
  console.log(`TOTAL METERED SPEND: $${total.toFixed(3)} (ceiling; measured spend is reported at the end of a real run)`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const requested = (arg('--models') ?? 'gemma4:26b,gemma4:12b-it-qat,gpt-5-mini,gpt-4.1-mini').split(',');
  const known: readonly ModelSpec[] = Object.values(MODELS);
  const specs: ModelSpec[] = [];
  for (const id of requested) {
    const key = id.trim();
    const spec = known.find((m) => m.id === key);
    if (spec === undefined) {
      console.error(`REFUSED: unknown model '${key}'. Known: ${known.map((m) => m.id).join(', ')}`);
      process.exit(2);
    }
    specs.push(spec);
  }

  const variants: SurfaceVariant[] = [];
  for (const name of (arg('--variants') ?? VARIANTS.join(',')).split(',')) {
    const found = ALL_VARIANTS.find((x) => x === name.trim());
    if (found === undefined) {
      console.error(`REFUSED: unknown variant '${name.trim()}'. Known: ${ALL_VARIANTS.join(', ')}`);
      process.exit(2);
    }
    variants.push(found);
  }

  // The naming probes are surface-independent, so a follow-up variant must not
  // pay for them twice — and re-running them would also re-sample an answer the
  // study has already recorded.
  const skipNaming = argv.includes('--skip-naming');
  // A case filter, so a follow-up arm testing ONE refusal does not re-buy the
  // other nineteen cases and re-sample answers already on disk.
  const only = (arg('--cases') ?? '').split(',').map((x) => x.trim()).filter((x) => x !== '');
  for (const id of only) {
    if (![...CORPUS, ...ZOO_EXTRA_CASES].some((c) => c.id === id)) {
      console.error(`REFUSED: unknown case '${id}'.`);
      process.exit(2);
    }
  }
  // The refusal's remedy ORDER is a variable under test, not a constant.
  const remedyOrder: RemedyOrder = argv.includes('--keep-first') ? 'keep-first' : 'drop-offered';

  dryRun(specs, variants, skipNaming);
  if (argv.includes('--dry-run')) return;

  const out = arg('--out');
  if (out === undefined) {
    console.error('REFUSED: --out <file> is required for a real run. A study whose results are '
      + 'only on a terminal cannot be re-read, and every claim it produces would be unciteable.');
    process.exit(2);
  }

  // Flushed after EVERY case, not at the end. A shared free-tier pool can wall
  // an arm 20 cases in, and a run that only wrote on success would throw away
  // 20 real measurements to report nothing — absent treated as zero, which is
  // the one thing this study is not allowed to do. A partial file says how far
  // it got and the report scores exactly that.
  const configure: ConfigureResult[] = [];
  const naming: NamingResult[] = [];
  const flush = (): void => {
    writeFileSync(out, JSON.stringify({
      ranAt: new Date().toISOString(),
      models: specs.map((s) => s.id),
      axisQuestion: AXIS_QUESTION,
      remedyOrder,
      configure,
      naming,
      measuredTokens: {
        configureIn: configure.reduce((a, r) => a + Math.max(r.tokensIn, 0), 0),
        configureOut: configure.reduce((a, r) => a + Math.max(r.tokensOut, 0), 0),
      },
    }, null, 2));
  };
  const record = (r: ConfigureResult): void => { configure.push(r); flush(); };

  for (const spec of specs) {
    process.stderr.write(`\n[${spec.id}] configure\n`);
    try {
      await runConfigure(spec, variants, only, remedyOrder, record);
    } catch (error) {
      // One arm dying is a hole in the roster, not the end of the study. Named
      // loudly, and whatever it did measure is already on disk.
      process.stderr.write(`\n[${spec.id}] ARM INCOMPLETE after ${String(configure.filter((r) => r.model === spec.id).length)} cases: ${error instanceof Error ? error.message : String(error)}\n`);
      continue;
    }
    if (skipNaming) { flush(); continue; }
    process.stderr.write(`[${spec.id}] naming\n`);
    try {
      naming.push(await runNaming(spec));
    } catch (error) {
      process.stderr.write(`\n[${spec.id}] NAMING PROBES INCOMPLETE: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    flush();
  }
  flush();
  console.log(`\nwrote ${out} — ${String(configure.length)} configure results, ${String(naming.length)} naming sets`);
}

await main();
