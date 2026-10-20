/**
 * The agreement table a chat model must clear before the fast tier answers decisions for an account Clef does not
 * serve (`core/src/providers/structured-decision.ts`, `AGREEMENT`): the same recorded turns rated by Clef and by the
 * chat model answering categories, through the one production rater (`rateTurn`), and the same batches of them
 * triaged (`TRIAGE`, five turns as a cadence dream takes them), compared question by question as the consumer reads
 * each answer. Each share is printed beside the share a constant answer would get (Clef's most common answer).
 *
 *   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… bun scripts/decision-agreement.ts --turns turns.jsonl --model <spec>
 *   … bun scripts/decision-agreement.ts --db workspace.sqlite [--limit 40] --model <spec>
 *
 * `--turns` reads one `{request, actions, answer, followup}` object a line; `--db` reads the rated turns a workspace's
 * `turn_ratings` holds, one per turn. Clef runs on Workers AI with the account's token. `--model` is a fast-tier spec:
 * `workers-ai/@cf/…` on the same account, or `opencode-go/<id>` with the eval key (`eval-provider-keys.json`), each
 * built as the product builds it; or `workers-ai/@cf/cloudflare/clef-flash`, the decision model an owner may pick instead
 * of Clef, whose agreement is the bar (`TRUST_BAR`).
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import type { LanguageModel } from 'ai';
import { rateTurn, renderRating, type RatedTurnInput, type RatingVerdict } from '../packages/core/src/evolution/ratings';
import { TRIAGE } from '../packages/core/src/evolution/refinement-lane';
import {
  createDecisionPort, DECISION_MODELS, DEFAULT_DECISION_MODEL, type DecisionModel, type DecisionPort, type DecisionRun,
} from '../packages/core/src/providers/decision-model';
import { answerStructured } from '../packages/core/src/providers/structured-decision';
import { createWorkersAIProvider } from '../packages/core/src/providers/workers-ai-provider';
import { createWireModel, sdkWire, withModelStack, type WireProtocol } from '../packages/core/src/providers/wire-model';
import { parseModelSpec } from '../packages/core/src/providers/types';
import { routedLlm } from '../packages/core/src/profiles/model-lane';
import type { ModelRouteResolution } from '../packages/core/src/profiles/model-route';
import { JsonObjectSchema, type JsonObject } from '../packages/core/src/utils/json';
import { renderThrownChain } from '../packages/core/src/obs/index';
import { EVAL_PROVIDER_KEYS, keysIn } from './eval-provider-keys';

const TurnSchema = v.object({ request: v.string(), actions: v.optional(v.string(), ''), answer: v.string(), followup: v.string() });

/** One verdict pair for one turn; null where a model left the turn unrated. */
export interface RatedPair {
  readonly clef: RatingVerdict | null;
  readonly structured: RatingVerdict | null;
}

/** One question's agreement over the items both models answered, beside a constant answer's (Clef's commonest). */
export interface Share {
  readonly both: number;
  readonly agrees: number;
  readonly constant: number;
}

/** The rating questions' agreement; keyed as `AGREEMENT` is. */
export interface RatingAgreement {
  readonly satisfaction: Share;
  readonly corrected: Share;
  readonly wrong: Share;
}

/** Each item's answer by Clef and by the chat model, read as the consumer reads it; null where one left it unanswered. */
export type ReadPair = readonly [clef: string | null, structured: string | null];

export function share(pairs: readonly ReadPair[]): Share {
  const both = pairs.flatMap(([clef, structured]) => (clef === null || structured === null ? [] : [[clef, structured] as const]));
  const counts = new Map<string, number>();

  for (const [clef] of both) counts.set(clef, (counts.get(clef) ?? 0) + 1);
  const commonest = Math.max(0, ...counts.values());

  return {
    both: both.length,
    agrees: both.length === 0 ? 0 : both.filter(([clef, structured]) => clef === structured).length / both.length,
    constant: both.length === 0 ? 0 : commonest / both.length,
  };
}

/** The band the ratings are read in: low below 2.5, high from 3.5 (`ratings.ts`). */
function band(score: number): string {
  if (score < 2.5) return 'low';

  return score < 3.5 ? 'mid' : 'high';
}

/** A yes-or-no answer as every consumer reads it: yes from 0.5. */
const yes = (p: number): string => (p >= 0.5 ? 'yes' : 'no');

/** The rating questions' agreement, each read as its consumer reads it: satisfaction by band, corrected at 0.5. */
export function agreement(pairs: readonly RatedPair[]): RatingAgreement {
  const read = (of: (verdict: RatingVerdict) => string): Share => share(pairs.map((pair) => [
    pair.clef === null ? null : of(pair.clef), pair.structured === null ? null : of(pair.structured),
  ]));

  return {
    satisfaction: read((verdict) => band(verdict.score)),
    corrected: read((verdict) => yes(verdict.corrected)),
    wrong: read((verdict) => verdict.wrong ?? 'none'),
  };
}

function turnsFrom(values: { readonly turns?: string; readonly db?: string; readonly limit: number }): RatedTurnInput[] {
  if (values.turns !== undefined) {
    return readFileSync(values.turns, 'utf8').split('\n').filter((line) => line.trim() !== '')
      .map((line) => v.parse(TurnSchema, JSON.parse(line))).slice(0, values.limit);
  }

  if (values.db === undefined) throw new Error('name the recorded turns: --turns <file.jsonl> or --db <workspace.sqlite>');
  const db = new Database(values.db, { readonly: true });

  try {
    return db.query<{ request: string; actions: string | null; answer: string; followup: string }, [number]>(
      `SELECT request, actions, answer, followup FROM turn_ratings WHERE followup IS NOT NULL AND followup != ''
        GROUP BY turn_id ORDER BY MAX(created_at) DESC LIMIT ?`,
    ).all(values.limit).map((row) => ({ ...row, actions: row.actions ?? '' }));
  } finally {
    db.close();
  }
}

function isDecisionModel(spec: string): spec is DecisionModel {
  return DECISION_MODELS.some((model) => model === spec);
}

/** Clef's `/ai/run` on the account. */
function clefRun(account: string, token: string): DecisionRun {
  return async (modelId, body): Promise<JsonObject> => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${modelId}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

    if (!response.ok) throw new Error(`Workers AI answered HTTP ${String(response.status)} for ${modelId}: ${await response.text()}`);

    return v.parse(JsonObjectSchema, await response.json());
  };
}

/** OpenCode Go's endpoint and the API each of its models speaks, as models.dev lists them. */
const OPENCODE_GO = 'https://opencode.ai/inference/go/openai/v1';

async function opencodeGoWire(modelId: string): Promise<WireProtocol> {
  const listed = v.parse(
    v.object({ 'opencode-go': v.object({ models: v.record(v.string(), v.object({ provider: v.optional(v.object({ npm: v.optional(v.string()) })) })) }) }),
    await (await fetch('https://models.dev/api.json')).json(),
  );

  return sdkWire(listed['opencode-go'].models[modelId]?.provider?.npm ?? '@ai-sdk/openai-compatible');
}

function opencodeGoKey(): string {
  const file = keysIn(EVAL_PROVIDER_KEYS);
  const key = 'why' in file ? undefined : file.keys['opencode-go.bearer'];

  if (key === undefined) throw new Error(`no opencode-go key in ${EVAL_PROVIDER_KEYS}`);

  return key;
}

/** `spec`'s client as the product builds it: Workers AI on the account, OpenCode Go on the eval key. */
async function builtModel(spec: string, cloudflare: { readonly account: string; readonly token: string }): Promise<LanguageModel> {
  const { provider, modelId } = parseModelSpec(spec);

  if (provider === 'workers-ai') {
    return createWorkersAIProvider().createModel(modelId, {
      env: {}, sessionAffinity: 'kinu-agreement', workspaceAffinity: 'kinu-agreement', hasCredential: async () => true,
      getAuth: async () => ({ baseURL: `https://api.cloudflare.com/client/v4/accounts/${cloudflare.account}/ai/v1`, headers: { authorization: `Bearer ${cloudflare.token}` } }),
    });
  }

  if (provider !== 'opencode-go') throw new Error(`no route to ${spec}: name a workers-ai/ or opencode-go/ model`);

  return createWireModel({
    name: 'opencode-go', modelId, baseURL: OPENCODE_GO, protocol: await opencodeGoWire(modelId), reasoning: true,
    headers: { authorization: `Bearer ${opencodeGoKey()}`, 'x-opencode-session': 'kinu-agreement' },
  });
}

/** `spec` under the one model stack (retries on a rate limit or an outage), as the registry resolves a model. */
async function chatModel(spec: string, cloudflare: { readonly account: string; readonly token: string }): Promise<LanguageModel> {
  const { provider, modelId } = parseModelSpec(spec);

  return withModelStack(await builtModel(spec, cloudflare), { provider, modelId, lane: provider });
}

/** The chat model answering categories, alone on its route, as the fast tier's decider asks it. */
function structuredPort(spec: string, model: LanguageModel): DecisionPort {
  const lane = { llm: (route: ModelRouteResolution) => routedLlm(() => ({ model }), route, { report: () => {} }) };

  return (request) => answerStructured(lane, { source: 'fast', tier: 'fast', model: spec, reasoningEffort: null, fallbacks: [], retries: 0 }, request);
}

async function rated(decide: DecisionPort, turn: RatedTurnInput): Promise<RatingVerdict | null> {
  try {
    return await rateTurn(decide, turn, turn.actions.split('\n').filter((line) => line !== '').length);
  } catch (cause) {
    console.error(`unrated: ${renderThrownChain({ cause })}`);

    return null;
  }
}

/** Five turns as a cadence dream batches them, in the state triage reads (`refinement-lane.ts`); stride two. */
function triageStates(turns: readonly RatedTurnInput[]): string[] {
  const rendered = turns.map((turn) => renderRating({
    ...turn, id: '', turnId: '', source: 'model', score: 3, corrected: 0, wrong: null, scaffoldVersion: null, artifacts: null, rejects: null, createdAt: 0,
  }));

  return Array.from({ length: Math.max(0, Math.floor((rendered.length - 5) / 2) + 1) }, (_, at) => rendered.slice(at * 2, at * 2 + 5).join('\n\n---\n\n'));
}

async function triaged(decide: DecisionPort, state: string): Promise<string | null> {
  try {
    const worth = (await decide({ state, questions: TRIAGE }))?.answers.worth;

    return worth?.type === 'noul' ? yes(worth.noul) : null;
  } catch (cause) {
    console.error(`untriaged: ${renderThrownChain({ cause })}`);

    return null;
  }
}

/** Four items at a time: a reasoning model takes seconds a call, and the report is a sample, not a load test. */
async function inFours<Item, Pair>(items: readonly Item[], pair: (item: Item) => Promise<Pair>): Promise<Pair[]> {
  const pairs: Pair[] = [];

  for (let at = 0; at < items.length; at += 4) pairs.push(...await Promise.all(items.slice(at, at + 4).map(pair)));

  return pairs;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { turns: { type: 'string' }, db: { type: 'string' }, limit: { type: 'string' }, model: { type: 'string' } },
  });

  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;

  if (account === undefined || token === undefined) throw new Error('set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');

  if (values.model === undefined) throw new Error('name the chat model: --model workers-ai/@cf/… or --model opencode-go/<id>');

  const turns = turnsFrom({ ...values, limit: Number(values.limit ?? '40') });

  const clef = createDecisionPort({
    run: clefRun(account, token), model: async () => DEFAULT_DECISION_MODEL, report: () => {},
    refusals: { changes: () => 0, refused: () => {}, answered: () => {} },
  });

  // Clef-flash, which an owner may pick as the decision model, measures the bar: how far from Clef the product already lets ratings be.
  const measured = values.model;

  const structured = isDecisionModel(measured)
    ? createDecisionPort({ run: clefRun(account, token), model: async () => measured, report: () => {}, refusals: { changes: () => 0, refused: () => {}, answered: () => {} } })
    : structuredPort(measured, await chatModel(measured, { account, token }));

  const ratings = await inFours(turns, async (turn) => ({ clef: await rated(clef, turn), structured: await rated(structured, turn) }));
  const triages = await inFours(triageStates(turns), async (state): Promise<ReadPair> => [await triaged(clef, state), await triaged(structured, state)]);

  console.log(JSON.stringify({ model: parseModelSpec(values.model).modelId, against: DEFAULT_DECISION_MODEL, turns: turns.length, ...agreement(ratings), worth: share(triages) }));
}
