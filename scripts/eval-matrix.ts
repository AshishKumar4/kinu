#!/usr/bin/env bun
/**
 * THE MODEL MATRIX for the Kinu task family: the same four episodes, once per
 * model, N trials each, reported as one table.
 *
 * WHY A SCRIPT AND NOT A SECOND ARM. A trial is a PROCESS: the run record, the
 * spend file and the liveness assertion are all written per process
 * (`eval-tier.sh`'s own rule), so "three models × three trials" is nine
 * invocations and the thing that has to exist is the loop plus the reader.
 * Everything inside one invocation is the family's own, unchanged — which is
 * what makes a matrix cell comparable with a `gate:trajectory` cell.
 *
 * ONE CREDENTIAL PATH, AND IT IS THE TIER'S. The eval identity comes from
 * `scripts/eval-credentials.ts`, exactly as `eval-tier.sh` and
 * `trajectory-tier.sh` take it: two lines on stdout, exported as
 * `KINU_ORIGIN` + `KINU_TOKEN`, the pair `resolveLiveModel` reads. A row's
 * model arrives through `LIVE_MODEL_ENV.model` (`AI_GATEWAY_MODEL` /
 * `KINU_MODEL`). No second resolver, and no token is printed, logged or
 * written into the record.
 *
 * WHICH MODEL EACH ROW RUNS IS RESOLVED BEFORE ANYTHING SPENDS. The labels
 * below are the owner's words; the ids are the PROVIDER's. Each row is
 * resolved against its doors' own listings, and the resolved id is recorded in
 * the artifact — so a run cannot report a label whose model nobody confirmed
 * exists. A row no listing answers stays UNRESOLVED and is reported as such
 * rather than guessed.
 *
 * TWO KINDS OF DOOR. A PROVIDER door is a third party (opencode Zen, opencode
 * Go, OpenRouter): its `GET <baseURL>/models` is public, and its chat surface
 * wants that provider's own key. The key is read from names that belong to
 * that provider only, because whatever is read is sent to it as a bearer; a
 * generic name such as `AI_GATEWAY_AUTH` would hand a Cloudflare credential to
 * a third party. The ACCOUNT door is the eval-service account on the
 * deployment: its model menu (`GET /api/user/models`) is what the account
 * serves with no key beyond the eval identity, and its chat surface is the
 * deployment's inference proxy.
 *
 * EVERY RESOLVED MODEL IS ASKED, KEY OR NO KEY. The chat probe sends one
 * request to each resolved id and records the answer verbatim: a keyless
 * refusal (401, or opencode's 403 "free tier can only be used from within
 * OpenCode") is the finding "not reachable without a key". A row whose door
 * answers is then timed with streamed requests — time to the first token and
 * output tokens per second — because non-streaming time-to-first-byte is not
 * first-token latency. Only rows whose door answers are run.
 *
 * WHAT THE DEPLOYMENT NEEDS, AND WHY THIS SCRIPT DOES NOT SET IT. The workspace
 * reaches a non-Workers-AI model through the ACCOUNT's own
 * `openai-compat.default` credential pointed at the provider's
 * openai-compatible base URL (`cf-backend/src/user/user-do.ts:4376-4388`
 * exposes that base URL to the orchestrator). That is an account setting, not
 * a per-run input, so it is a precondition this script CHECKS by asking
 * `GET /api/user/models` and reports rather than a row it writes: a harness
 * that silently rewrote the account's provider credential would change what
 * every other arm measures.
 *
 * DOORS ARE TRIED IN THE OWNER'S ORDER: opencode ZEN first, then GO. A row
 * carries a LIST of doors, each with its own candidate ids, and the first door
 * whose listing answers one of its candidates wins. Muse needed the order: the
 * contributor-FREE tier exists on zen and not on go.
 *
 * MEASURED 2026-09-23T00:50Z, keyless: zen listed 79 ids (the free
 * `muse-spark-1.3-contributor-free`, `deepseek-v4.1-flash`,
 * `nemotron-3-ultra-free`), go 40 (`muse-spark-1.3-contributor`,
 * `deepseek-v4.1-flash`), OpenRouter 454 (`inception/mercury-2.5`,
 * `inclusionai/ling-3.0-flash-vl`, `deepseek/deepseek-v4.1-flash`,
 * `nvidia/nemotron-3-ultra-550b-a55b`). The eval-service account's menu held 18
 * Workers AI models and none of the five named ones; its nearest are
 * `@cf/deepseek-ai/deepseek-v4-flash-0731` (the flash tier's model) and
 * `@cf/nvidia/nemotron-3-120b-a12b` (Nemotron 3 Super), the last two rows.
 *
 * THE RESPONSES API, AND WHY THE MUSE ROW STILL GOES THROUGH
 * `/chat/completions`. opencode's own endpoint table serves Muse Spark on
 * `/v1/responses` with `@ai-sdk/openai`, not on `/v1/chat/completions`. The
 * product DOES hold a responses-capable provider —
 * `packages/core/src/providers/openai.ts:70-96`, whose `createModel` returns
 * `provider.responses(modelId)` at :95 — but it cannot be pointed at a
 * third-party base URL: line 93 builds `createOpenAI({ apiKey: 'placeholder',
 * fetch })` with NO `baseURL`, so it resolves the SDK default
 * `https://api.openai.com/v1`, and its credential is pinned to
 * `OPENAI_CRED_KEY = 'openai.bearer'` (:15). The credential path that DOES
 * carry a base URL is `openai-compat`
 * (`packages/core/src/providers/openai-compat.ts:74-76`), and it builds
 * `createOpenAICompatible`, which speaks `/chat/completions` only — the same
 * surface `packages/core/src/llm.ts:355,370` builds for a workspace turn.
 * `packages/core/src/providers/codex.ts:235` does call `provider.responses`,
 * but that provider is the ChatGPT SUBSCRIPTION backend
 * (`chatgpt.com/backend-api/codex/responses`, its file header line 2), not a
 * base-URL-configurable door. So the Muse row runs over `openai-compat`
 * `/chat/completions`, and the probe records the EXACT HTTP status and body
 * when that surface refuses.
 *
 *   bun scripts/eval-matrix.ts [--trials N] [--row <label>] [--resolve-only]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as v from 'valibot';

import { cloudProxyBaseURL } from '@kinu.run/core';
import {
  EPISODE_TRANSCRIPT_FILES, LIVE_MODEL_ENV, readRunRecord, TASK_OUTCOME,
  type EvalRunRecord, type EvalSubgoal,
} from '@kinu.run/test-utils';
import { tolerate } from '../packages/core/src/obs/index';

/** The OpenAI model-listing shape every provider door answers. */
const ModelListingSchema = v.object({
  data: v.array(v.looseObject({ id: v.pipe(v.string(), v.nonEmpty()) })),
});

/** The account's model menu: one `<provider>/<id>` spec per model it serves. */
const AccountMenuSchema = v.object({
  models: v.array(v.looseObject({ spec: v.pipe(v.string(), v.nonEmpty()) })),
});

/** One streamed chat chunk: a content or reasoning delta, or the closing usage. */
const StreamChunkSchema = v.looseObject({
  choices: v.optional(v.array(v.looseObject({
    delta: v.optional(v.looseObject({
      content: v.optional(v.nullable(v.string())),
      reasoning: v.optional(v.nullable(v.string())),
      reasoning_content: v.optional(v.nullable(v.string())),
    })),
  }))),
  usage: v.optional(v.nullable(v.looseObject({ completion_tokens: v.optional(v.number()) }))),
});

/** One episode's retained verdicts, as `retainEpisodeTranscript` wrote them. */
const RetainedSubgoalsSchema: v.GenericSchema<readonly EvalSubgoal[]> = v.array(v.object({
  what: v.string(), reached: v.boolean(), detail: v.string(),
}));

/** Task id → the verdicts its episode retained. A `Map` because the keys are
 *  the run record's own task ids, discovered at runtime rather than declared
 *  here. */
type RetainedSubgoals = ReadonlyMap<string, readonly EvalSubgoal[]>;

const root = join(import.meta.dirname, '..');

const FAMILY = 'tests/evals/kinu-tasks.eval.ts';

/** N trials per model, the family's own declared figure. */
const DEFAULT_TRIALS = 3;

/** Streamed requests per answering model: the latency figures are medians. */
const STREAM_SAMPLES = 3;

const STREAM_PROMPT = 'Write a 150-word paragraph on how bicycle gears work. Plain prose, no lists.';

/** A third party whose listing is public and whose chat surface wants its own key. */
interface ProviderDoor {
  readonly kind: 'provider';
  /** The door's own name, as the owner says it. */
  readonly door: string;
  /** The openai-compatible base URL the account's credential must point at. */
  readonly baseURL: string;
  /** Env names that carry THIS provider's key, in preference order. */
  readonly keyEnv: readonly string[];
  /** Ids to look for in this door's listing, in preference order. */
  readonly candidates: readonly string[];
}

/** The eval-service account on the deployment: what its menu serves needs no
 *  key beyond the eval identity. */
interface AccountDoor {
  readonly kind: 'account';
  readonly door: string;
  readonly candidates: readonly string[];
}

type MatrixDoor = ProviderDoor | AccountDoor;

interface MatrixRow {
  /** The owner's word for this model. */
  readonly label: string;
  /** Every door, IN THE OWNER'S ORDER. The first one whose listing answers a
   *  candidate is the one the row runs through. */
  readonly doors: readonly MatrixDoor[];
  readonly note: string;
}

const zen = (candidates: readonly string[]): ProviderDoor => ({
  kind: 'provider', door: 'opencode-zen', baseURL: 'https://opencode.ai/zen/v1',
  keyEnv: ['OPENCODE_API_KEY'], candidates,
});

const go = (candidates: readonly string[]): ProviderDoor => ({
  kind: 'provider', door: 'opencode-go', baseURL: 'https://opencode.ai/zen/go/v1',
  keyEnv: ['OPENCODE_API_KEY'], candidates,
});

const openRouter = (candidates: readonly string[]): ProviderDoor => ({
  kind: 'provider', door: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1',
  keyEnv: ['OPENROUTER_API_KEY'], candidates,
});

const account = (candidates: readonly string[]): AccountDoor => ({
  kind: 'account', door: 'eval-service account (Workers AI)', candidates,
});

const MATRIX: readonly MatrixRow[] = [
  {
    label: 'muse-spark-1.3-contributor',
    doors: [
      zen(['muse-spark-1.3-contributor-free', 'muse-spark-1.2-contributor-free', 'muse-spark-1.3']),
      go(['muse-spark-1.3-contributor', 'muse-spark-1.2-contributor']),
    ],
    note: 'zen first per the owner\'s order, and zen is where the contributor-FREE tier lives; '
      + 'go carries the paid contributor tier and no free Muse. Served on /v1/responses per '
      + 'opencode\'s endpoint table; see the header for why this row still uses /chat/completions.',
  },
  {
    label: 'mercury-2.5',
    doors: [openRouter(['inception/mercury-2.5'])],
    note: 'Inception Labs Mercury 2.5.',
  },
  {
    label: 'ling-3.0-flash-vl',
    doors: [openRouter(['inclusionai/ling-3.0-flash-vl', 'inclusionai/ling-3.0-flash-vl:free'])],
    note: 'inclusionAI Ling 3.0 Flash VL.',
  },
  {
    label: 'deepseek-v4.1-flash',
    doors: [
      zen(['deepseek-v4.1-flash']),
      go(['deepseek-v4.1-flash']),
      openRouter(['deepseek/deepseek-v4.1-flash']),
    ],
    note: 'Not on Workers AI; the account serves its predecessor v4-flash-0731.',
  },
  {
    label: 'nemotron-3-ultra',
    doors: [
      zen(['nemotron-3-ultra-free']),
      openRouter(['nvidia/nemotron-3-ultra-550b-a55b', 'nvidia/nemotron-3-ultra-550b-a55b:free']),
    ],
    note: 'Not on Workers AI; the account serves Nemotron 3 Super.',
  },
  {
    label: 'deepseek-v4-flash',
    doors: [account(['@cf/deepseek-ai/deepseek-v4-flash-0731'])],
    note: 'The flash tier\'s model (EVAL_MODELS.flash) and the nearest reachable model to v4.1 flash.',
  },
  {
    label: 'nemotron-3-super',
    doors: [account(['@cf/nvidia/nemotron-3-120b-a12b'])],
    note: 'The nearest reachable model to Nemotron 3 Ultra.',
  },
];

/** What the account door needs: the eval identity for the inference proxy and
 *  the deployment's synthetic-identity secret for the model menu. */
interface AccountAccess {
  readonly origin: string;
  readonly token: string;
  readonly webIdentity: string;
}

/** Where a door's chat surface lives and what it is asked with. */
interface ChatEndpoint {
  readonly baseURL: string;
  readonly headers: Readonly<Record<string, string>>;
}

interface StreamSummary {
  readonly samples: number;
  readonly firstTokenMsMedian: number;
  readonly outputTokensPerSecondMedian: number | null;
}

type RowResolution =
  | {
    readonly kind: 'resolved'; readonly row: MatrixRow; readonly door: MatrixDoor;
    readonly modelId: string; readonly listed: number;
    /** What `POST <chat surface>/chat/completions` answered, verbatim. */
    readonly chatSurface: string;
    /** The door answered a chat request for this model, so a trial can run. */
    readonly answers: boolean;
    readonly stream: StreamSummary | null;
  }
  | { readonly kind: 'unresolved'; readonly row: MatrixRow; readonly reason: string };

/** One provider door's model ids. Every provider door answers the OpenAI listing shape. */
async function listProviderModels(door: ProviderDoor, key: string | undefined): Promise<string[]> {
  const response = await fetch(`${door.baseURL}/models`, {
    headers: key === undefined ? {} : { authorization: `Bearer ${key}` },
  });

  if (!response.ok) {
    throw new Error(`GET ${door.baseURL}/models answered HTTP ${String(response.status)} `
      + `${response.statusText}`);
  }

  // PARSED AT THE BOUNDARY: a provider listing is foreign JSON, so the shape
  // is established once here and every reader below branches on the domain
  // value rather than on a `typeof`.
  const listing = v.safeParse(ModelListingSchema, await response.json());

  if (!listing.success) {
    throw new Error(`GET ${door.baseURL}/models did not answer an OpenAI listing: `
      + listing.issues.map((issue) => issue.message).join('; '));
  }

  return listing.output.data.map((entry) => entry.id);
}

/** The account menu's ids, provider prefix removed: `workers-ai/@cf/x` → `@cf/x`. */
async function listAccountModels(access: AccountAccess): Promise<string[]> {
  const response = await fetch(`${access.origin}/api/user/models`, {
    headers: { 'x-kinu-dev-identity': access.webIdentity },
  });

  if (!response.ok) {
    throw new Error(`GET ${access.origin}/api/user/models answered HTTP ${String(response.status)}`);
  }

  const menu = v.safeParse(AccountMenuSchema, await response.json());

  if (!menu.success) {
    throw new Error(`GET ${access.origin}/api/user/models did not answer a model menu: `
      + menu.issues.map((issue) => issue.message).join('; '));
  }

  return menu.output.models.map((model) => model.spec.slice(model.spec.indexOf('/') + 1));
}

/**
 * Does the door's `POST /chat/completions` serve this model? One token, no
 * streaming, asked with or without a key: the answer is recorded VERBATIM —
 * status line plus the first of the body — so a refusal is a provider fact
 * somebody can act on. The key never appears in the returned string.
 */
async function probeChat(endpoint: ChatEndpoint, modelId: string, keyless: boolean): Promise<{ answers: boolean; said: string }> {
  const response = await fetch(`${endpoint.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { ...endpoint.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
  });

  const body = (await response.text()).slice(0, 400);
  const asked = keyless ? 'keyless ' : '';

  return response.ok
    ? { answers: true, said: `${asked}POST /chat/completions → HTTP ${String(response.status)} (serves this model)` }
    : {
      answers: false,
      said: `${asked}POST /chat/completions REFUSED → HTTP ${String(response.status)} ${response.statusText} — ${body}`,
    };
}

/** The first non-empty content or reasoning delta in one parsed chunk. */
function carriesToken(chunk: v.InferOutput<typeof StreamChunkSchema>): boolean {
  return (chunk.choices ?? []).some((choice) => {
    const delta = choice.delta;

    return delta !== undefined
      && [delta.content, delta.reasoning, delta.reasoning_content].some((text) => (text ?? '') !== '');
  });
}

/** One streamed request: when the first token arrived, when the stream ended,
 *  and the completion tokens the closing usage chunk reported. */
async function streamOnce(endpoint: ChatEndpoint, modelId: string): Promise<{ firstMs: number; totalMs: number; tokens: number | null }> {
  const started = performance.now();

  const response = await fetch(`${endpoint.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { ...endpoint.headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: modelId, stream: true, stream_options: { include_usage: true }, max_tokens: 400,
      messages: [{ role: 'user', content: STREAM_PROMPT }],
    }),
  });

  if (!response.ok || response.body === null) {
    throw new Error(`streamed POST /chat/completions answered HTTP ${String(response.status)}`);
  }

  const decoder = new TextDecoder();
  let buffered = '';
  let firstMs: number | null = null;
  let tokens: number | null = null;

  for await (const bytes of response.body) {
    buffered += decoder.decode(bytes, { stream: true });
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';

    for (const line of lines) {
      const data = line.startsWith('data:') ? line.slice('data:'.length).trim() : '';

      if (data === '' || data === '[DONE]') continue;
      const chunk = v.parse(StreamChunkSchema, JSON.parse(data));

      if (firstMs === null && carriesToken(chunk)) firstMs = performance.now() - started;

      tokens = chunk.usage?.completion_tokens ?? tokens;
    }
  }

  if (firstMs === null) throw new Error('the stream ended without a single token');

  return { firstMs, totalMs: performance.now() - started, tokens };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Streamed latency over {@link STREAM_SAMPLES} sequential requests. Output
 *  speed is completion tokens over the time after the first token, and absent
 *  when the door reported no usage rather than guessed from characters. */
async function measureStream(endpoint: ChatEndpoint, modelId: string): Promise<StreamSummary> {
  const runs: { firstMs: number; totalMs: number; tokens: number | null }[] = [];

  for (let sample = 0; sample < STREAM_SAMPLES; sample += 1) runs.push(await streamOnce(endpoint, modelId));

  const speeds = runs.flatMap((run) => (run.tokens === null || run.totalMs <= run.firstMs
    ? []
    : [run.tokens / ((run.totalMs - run.firstMs) / 1000)]));

  return {
    samples: runs.length,
    firstTokenMsMedian: median(runs.map((run) => run.firstMs)),
    outputTokensPerSecondMedian: speeds.length === runs.length ? median(speeds) : null,
  };
}

/** A door's listing and chat surface, or the reason it has none. */
type OpenedDoor =
  | { readonly listed: string[]; readonly endpoint: ChatEndpoint; readonly keyless: boolean }
  | { readonly refused: string };

async function openDoor(door: MatrixDoor, access: AccountAccess | null): Promise<OpenedDoor> {
  if (door.kind === 'account') {
    if (access === null) return { refused: 'no eval identity (eval-credentials and KINU_EVAL_WEB_IDENTITY)' };

    return {
      listed: await listAccountModels(access),
      endpoint: { baseURL: cloudProxyBaseURL(access.origin), headers: { authorization: `Bearer ${access.token}` } },
      keyless: false,
    };
  }

  const named = door.keyEnv.find((name) => (process.env[name] ?? '').trim() !== '');
  const key = named === undefined ? undefined : process.env[named]?.trim();

  return {
    listed: await listProviderModels(door, key),
    endpoint: { baseURL: door.baseURL, headers: key === undefined ? {} : { authorization: `Bearer ${key}` } },
    keyless: key === undefined,
  };
}

/** Resolve one row against its doors, IN ORDER. A key is read but never
 *  echoed. The first door that lists a candidate AND answers a chat request
 *  wins. A door that cannot be listed, lists none of its candidates, or
 *  refuses the request is not fatal to the row: the next door is still a door,
 *  and every refusal is kept, so a row nobody answers names each one. */
async function resolveRow(row: MatrixRow, access: AccountAccess | null): Promise<RowResolution> {
  const refused: string[] = [];
  let firstListed: { door: MatrixDoor; modelId: string; listed: number } | null = null;

  for (const door of row.doors) {
    let opened: OpenedDoor;

    try {
      opened = await openDoor(door, access);
    } catch (cause) {
      refused.push(`${door.door}: ${cause instanceof Error ? cause.message : String(cause)}`);
      continue;
    }

    if ('refused' in opened) {
      refused.push(`${door.door}: ${opened.refused}`);
      continue;
    }

    const modelId = door.candidates.find((candidate) => opened.listed.includes(candidate));

    if (modelId === undefined) {
      refused.push(`${door.door}: none of ${door.candidates.join(', ')} among the `
        + `${String(opened.listed.length)} ids it listed`);
      continue;
    }

    firstListed ??= { door, modelId, listed: opened.listed.length };
    const probe = await probeChat(opened.endpoint, modelId, opened.keyless);

    if (probe.answers) {
      return {
        kind: 'resolved', row, door, modelId, listed: opened.listed.length,
        chatSurface: probe.said, answers: true, stream: await measureStream(opened.endpoint, modelId),
      };
    }

    refused.push(`${door.door} ${modelId}: ${probe.said}`);
  }

  if (firstListed === null) return { kind: 'unresolved', row, reason: refused.join('; ') };

  return { kind: 'resolved', ...firstListed, row, chatSurface: refused.join('; '), answers: false, stream: null };
}

function describeStream(stream: StreamSummary | null): string {
  if (stream === null) return 'not timed: the door did not answer';

  const speed = stream.outputTokensPerSecondMedian === null
    ? 'no usage reported'
    : `${stream.outputTokensPerSecondMedian.toFixed(1)} output tok/s`;

  return `streamed ×${String(stream.samples)}: first token ${Math.round(stream.firstTokenMsMedian)} ms, ${speed} (medians)`;
}

function describeResolution(resolution: RowResolution): string {
  if (resolution.kind === 'unresolved') {
    return `UNRESOLVED ${resolution.row.label} (doors: `
      + `${resolution.row.doors.map((door) => door.door).join(' → ')}) — ${resolution.reason}`;
  }

  return `${resolution.answers ? 'ANSWERS ' : 'REFUSED '} ${resolution.row.label} → ${resolution.modelId} via `
    + `${resolution.door.door} (${String(resolution.listed)} ids listed); ${resolution.chatSurface}; `
    + `${describeStream(resolution.stream)} — ${resolution.row.note}`;
}

interface TrialResult {
  readonly label: string;
  readonly modelId: string;
  readonly trial: number;
  readonly status: number;
  readonly record: EvalRunRecord | null;
  readonly recordPath: string;
  /** Per task: the subgoals the episode produced, read off the retained
   *  verdicts rather than parsed out of a detail string. */
  readonly subgoals: RetainedSubgoals;
}

/** The eval identity, resolved the way both tiers resolve it. */
function resolveIdentity(): { origin: string; token: string } | null {
  const resolved = spawnSync('bun', ['scripts/eval-credentials.ts'], { cwd: root, encoding: 'utf8' });

  if (resolved.status !== 0) {
    throw new Error(`eval-credentials refused: ${(resolved.stderr ?? '').trim()}`);
  }

  const [origin, token] = (resolved.stdout ?? '').split('\n').map((line) => line.trim());

  if (origin === undefined || token === undefined || origin === '' || token === '') return null;

  return { origin, token };
}

function readSubgoals(transcripts: string, tasks: readonly string[]): RetainedSubgoals {
  const out = new Map<string, readonly EvalSubgoal[]>();

  for (const task of tasks) {
    const path = join(transcripts, task, EPISODE_TRANSCRIPT_FILES.subgoals);

    // A task that never opened an episode retained no verdicts, and that
    // absence is the finding the table's `pass/trials` column reports — so it
    // is a named tolerance rather than a swallowed failure. Anything the read
    // or the parse raises for another reason still throws.
    const raw = tolerate(() => readFileSync(path, 'utf8'), 'enoent');
    const parsed = raw === undefined ? null : v.safeParse(RetainedSubgoalsSchema, JSON.parse(raw));
    out.set(task, parsed !== null && parsed.success ? parsed.output : []);
  }

  return out;
}

function runTrial(resolution: Extract<RowResolution, { kind: 'resolved' }>, trial: number, outDir: string, identity: { origin: string; token: string }): TrialResult {
  const stamp = `${resolution.row.label}-t${String(trial)}`;
  const artifacts = join(outDir, stamp);
  mkdirSync(artifacts, { recursive: true });
  const recordPath = join(artifacts, 'run-record.json');

  // The parent environment plus this trial's own names. `process.env` is
  // already `Record<string, string | undefined>`; spreading it keeps the
  // ambient credential variables `eval-credentials.ts` resolved, and `spawnSync`
  // drops the undefined halves itself.
  const env = {
    ...process.env,
    KINU_EVAL_BACKEND: 'cloud',
    KINU_EVAL_LIVE: '1',
    KINU_ORIGIN: identity.origin,
    KINU_TOKEN: identity.token,
    // The row's model, through the names `resolveLiveModel` already reads.
    [LIVE_MODEL_ENV.model[0]]: resolution.modelId,
    KINU_EVAL_RECORD: recordPath,
    KINU_EVAL_SPEND_FILE: join(artifacts, 'spend.jsonl'),
    BENCH_ARTIFACTS: artifacts,
  };

  console.log(`\n── ${resolution.row.label} · trial ${String(trial)} · ${resolution.modelId} ──`);

  const run = spawnSync('bun', [
    '--bun', './node_modules/.bin/vitest', 'run', '--config', 'vitest.evals.config.ts', FAMILY,
    '--reporter=default', '--reporter=junit', `--outputFile=${join(artifacts, 'junit.xml')}`,
  ], { cwd: root, env, stdio: 'inherit' });

  let record: EvalRunRecord | null = null;

  try {
    record = readRunRecord(recordPath);
  } catch (cause) {
    console.error(`  no run record at ${recordPath}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  return {
    label: resolution.row.label, modelId: resolution.modelId, trial,
    status: run.status ?? 1, record, recordPath,
    subgoals: record === null ? new Map() : readSubgoals(record.transcripts, record.declaredTasks),
  };
}

interface Cell {
  readonly task: string;
  readonly label: string;
  readonly trials: number;
  readonly passes: number;
  readonly meanMs: number | null;
  readonly toolErrorRate: number | null;
  readonly calls: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** Subgoal → how many trials MISSED it. A miss is named, never only counted. */
  readonly misses: Record<string, number>;
}

/** Subgoal → how many of these trials failed to reach it on one task. */
function countMisses(trials: readonly TrialResult[], task: string): Cell['misses'] {
  const misses: Record<string, number> = {};

  for (const trial of trials) {
    for (const subgoal of trial.subgoals.get(task) ?? []) {
      if (subgoal.reached) continue;
      misses[subgoal.what] = (misses[subgoal.what] ?? 0) + 1;
    }
  }

  return misses;
}

function aggregate(results: readonly TrialResult[], tasks: readonly string[]): Cell[] {
  const cells: Cell[] = [];

  for (const label of new Set(results.map((result) => result.label))) {
    const mine = results.filter((result) => result.label === label);

    for (const task of tasks) {
      const observations = mine.flatMap((result) =>
        (result.record?.observations ?? []).filter((observation) => observation.taskId === task));

      const scored = observations.filter((observation) => observation.outcome === 'scored');

      const outcomeRows = scored.flatMap((observation) =>
        (observation.scores ?? []).filter((score) => score.name === TASK_OUTCOME));

      const passes = outcomeRows.filter((score) => score.eligible > 0 && score.passed === score.eligible).length;

      const errorRates = scored.flatMap((observation) =>
        (observation.scores ?? []).filter((score) => score.name === 'tool_outcomes' && score.rate !== null)
          .map((score) => 1 - (score.rate ?? 0)));

      const durations = scored.map((observation) => observation.ms);
      const misses = countMisses(mine, task);

      cells.push({
        task, label, trials: mine.length, passes,
        meanMs: durations.length === 0 ? null : durations.reduce((sum, ms) => sum + ms, 0) / durations.length,
        toolErrorRate: errorRates.length === 0
          ? null
          : errorRates.reduce((sum, rate) => sum + rate, 0) / errorRates.length,
        calls: mine.reduce((sum, result) => sum + (result.record?.spend.calls ?? 0), 0),
        tokensIn: mine.reduce((sum, result) => sum + (result.record?.spend.tokensIn ?? 0), 0),
        tokensOut: mine.reduce((sum, result) => sum + (result.record?.spend.tokensOut ?? 0), 0),
        misses,
      });
    }
  }

  return cells;
}

function printTable(cells: readonly Cell[], resolutions: readonly RowResolution[]): void {
  console.log('\n── kinu-tasks × model ──────────────────────────────────────');
  console.log(['task', 'model', 'pass/trials', 'mean s', 'tool err', 'calls', 'tok in/out', 'misses'].join(' | '));

  for (const cell of cells) {
    const misses = Object.entries(cell.misses)
      .map(([what, count]) => `${what}×${String(count)}`).join(' ');

    console.log([
      cell.task,
      cell.label,
      `${String(cell.passes)}/${String(cell.trials)}`,
      cell.meanMs === null ? '—' : (cell.meanMs / 1000).toFixed(1),
      cell.toolErrorRate === null ? '—' : cell.toolErrorRate.toFixed(2),
      String(cell.calls),
      `${String(cell.tokensIn)}/${String(cell.tokensOut)}`,
      misses === '' ? '—' : misses,
    ].join(' | '));
  }

  console.log('────────────────────────────────────────────────────────────');

  for (const resolution of resolutions) console.log(describeResolution(resolution));
}

function resolutionRecord(resolution: RowResolution) {
  if (resolution.kind === 'unresolved') {
    return {
      label: resolution.row.label, doors: resolution.row.doors.map((door) => door.door),
      unresolved: resolution.reason, note: resolution.row.note,
    };
  }

  return {
    label: resolution.row.label, door: resolution.door.door,
    baseURL: resolution.door.kind === 'provider' ? resolution.door.baseURL : 'the deployment\'s inference proxy',
    modelId: resolution.modelId, listed: resolution.listed, answers: resolution.answers,
    chatSurface: resolution.chatSurface, stream: resolution.stream, note: resolution.row.note,
  };
}

const argv = process.argv.slice(2);

const trials = (() => {
  const at = argv.indexOf('--trials');

  return at < 0 ? DEFAULT_TRIALS : Number(argv[at + 1] ?? DEFAULT_TRIALS);
})();

const only = (() => {
  const at = argv.indexOf('--row');

  return at < 0 ? null : argv[at + 1] ?? null;
})();

const rows = only === null ? MATRIX : MATRIX.filter((row) => row.label === only);

if (rows.length === 0) {
  console.error(`eval-matrix: no row named '${String(only)}'. Rows: ${MATRIX.map((row) => row.label).join(', ')}`);
  process.exit(2);
}

const identity = resolveIdentity();

const webIdentity = (process.env.KINU_EVAL_WEB_IDENTITY ?? '').trim();

const access: AccountAccess | null = identity === null || webIdentity === ''
  ? null
  : { ...identity, webIdentity };

// One row at a time: the streamed timings of two models must not share the line.
const resolutions: RowResolution[] = [];

for (const row of rows) resolutions.push(await resolveRow(row, access));

const stamp = new Date().toISOString().replace(/[:.]/g, '-');

mkdirSync(join(root, 'bench-artifacts', 'evals'), { recursive: true });

const resolutionArtifact = join(root, 'bench-artifacts', 'evals', `model-resolution-${stamp}.json`);

writeFileSync(resolutionArtifact, `${JSON.stringify({
  schema: 1, createdAt: new Date().toISOString(), resolutions: resolutions.map(resolutionRecord),
}, null, 2)}\n`);

for (const resolution of resolutions) console.log(describeResolution(resolution));

console.log(`resolution: ${resolutionArtifact}`);

if (argv.includes('--resolve-only')) process.exit(0);

if (identity === null) {
  console.error('eval-matrix: no eval credential. `scripts/eval-credentials.ts` printed the reason '
    + 'above; the matrix creates workspaces on the deployment and cannot run without one.');
  process.exit(1);
}

if (access === null) {
  console.error('eval-matrix: KINU_EVAL_WEB_IDENTITY is unset. The public plane needs the '
    + "deployment's synthetic-identity secret; `tests/evals/public-session.ts` names the remedy.");
  process.exit(1);
}

const runnable = resolutions.filter((resolution): resolution is Extract<RowResolution, { kind: 'resolved' }> =>
  resolution.kind === 'resolved' && resolution.answers);

if (runnable.length === 0) {
  console.error('eval-matrix: no row\'s door answers a chat request, so no trial can run. '
    + 'The lines above name each refusal.');
  process.exit(1);
}

// A precondition, reported and never rewritten: the workspace pins the model
// through the account's menu, so a model the menu does not name is refused at
// the pin however well its provider answered.
const menu = await listAccountModels(access);

for (const resolution of runnable) {
  console.log(`precondition · ${resolution.row.label}: ${menu.includes(resolution.modelId)
    ? 'the account menu names this model'
    : 'the account menu does NOT name this model — set the openai-compat.default credential to '
      + 'the provider base URL, or the pin will be refused'}`);
}

const outDir = join(root, 'bench-artifacts', 'evals', `kinu-tasks-${stamp}`);

mkdirSync(outDir, { recursive: true });

const results: TrialResult[] = [];

for (const resolution of runnable) {
  for (let trial = 1; trial <= trials; trial += 1) {
    results.push(runTrial(resolution, trial, outDir, identity));
  }
}

const tasks = [...new Set(results.flatMap((result) => result.record?.declaredTasks ?? []))];

const cells = aggregate(results, tasks);

const artifact = join(root, 'bench-artifacts', 'evals', `kinu-tasks-${stamp}.json`);

writeFileSync(artifact, `${JSON.stringify({
  schema: 1,
  family: 'kinu-tasks',
  createdAt: new Date().toISOString(),
  trials,
  resolutions: resolutions.map(resolutionRecord),
  trialRecords: results.map((result) => ({
    label: result.label, modelId: result.modelId, trial: result.trial,
    status: result.status, record: result.recordPath,
  })),
  cells,
}, null, 2)}\n`);

printTable(cells, resolutions);

console.log(`\nartifact: ${artifact}`);

console.log(`trial records: ${outDir}`);

// A trial the runner failed is a finding, not a crash: the table above already
// reports what every trial produced, so the exit code carries whether every
// invocation ran rather than whether every episode passed.
const failed = results.filter((result) => result.record === null);

if (failed.length > 0) {
  console.error(`\n${String(failed.length)} of ${String(results.length)} trial(s) produced no run record`);
  process.exit(1);
}
