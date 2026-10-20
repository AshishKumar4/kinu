/**
 * The agreement report a structured-output decision port must pass before any host trusts it: the same recorded
 * turns rated by Clef and by the chat-model port (`core/src/providers/structured-decision.ts`), through the one
 * production rater (`rateTurn`), compared question by question.
 *
 *   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… bun scripts/decision-agreement.ts --turns turns.jsonl
 *   … bun scripts/decision-agreement.ts --db workspace.sqlite [--limit 40] [--model @cf/…]
 *
 * `--turns` reads one `{request, actions, answer, followup}` object a line; `--db` reads the rated turns a workspace's
 * `turn_ratings` holds, one per turn. Both models run on Workers AI with the account's token.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { rateTurn, type RatedTurnInput, type RatingVerdict } from '../packages/core/src/evolution/ratings';
import {
  createDecisionPort, DEFAULT_DECISION_MODEL, type DecisionPort, type DecisionRun,
} from '../packages/core/src/providers/decision-model';
import { createStructuredDecisionPort } from '../packages/core/src/providers/structured-decision';
import { JsonObjectSchema, type JsonObject } from '../packages/core/src/utils/json';
import { renderThrownChain } from '../packages/core/src/obs/index';
import { DEFAULT_WORKERS_AI_MODEL_SPEC } from '../packages/core/src/providers/workers-ai';
import type { LLM } from '../packages/core/src/types/primitives';

const TurnSchema = v.object({ request: v.string(), actions: v.optional(v.string(), ''), answer: v.string(), followup: v.string() });

/** One verdict pair for one turn; null where a model left the turn unrated. */
export interface RatedPair {
  readonly clef: RatingVerdict | null;
  readonly structured: RatingVerdict | null;
}

export interface Agreement {
  readonly turns: number;
  /** Turns both models rated: the denominator of every share below. */
  readonly both: number;
  readonly satisfactionExact: number;
  readonly satisfactionWithinOne: number;
  /** Read as corrected at 0.5 either way. */
  readonly corrected: number;
  readonly wrong: number;
}

/** Shares of the turns both rated, as fractions of `both`. */
export function agreement(pairs: readonly RatedPair[]): Agreement {
  const both = pairs.flatMap((pair) => (pair.clef !== null && pair.structured !== null ? [{ clef: pair.clef, structured: pair.structured }] : []));
  const share = (agrees: (pair: (typeof both)[number]) => boolean): number => (both.length === 0 ? 0 : both.filter(agrees).length / both.length);

  return {
    turns: pairs.length,
    both: both.length,
    satisfactionExact: share((pair) => Math.round(pair.clef.score) === Math.round(pair.structured.score)),
    satisfactionWithinOne: share((pair) => Math.abs(Math.round(pair.clef.score) - Math.round(pair.structured.score)) <= 1),
    corrected: share((pair) => (pair.clef.corrected >= 0.5) === (pair.structured.corrected >= 0.5)),
    wrong: share((pair) => pair.clef.wrong === pair.structured.wrong),
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

function workersAi(account: string, token: string) {
  const call = async (path: string, body: JsonObject): Promise<JsonObject> => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

    if (!response.ok) throw new Error(`Workers AI answered HTTP ${String(response.status)} for ${path}: ${await response.text()}`);

    return v.parse(JsonObjectSchema, await response.json());
  };

  const run: DecisionRun = (modelId, body) => call(`run/${modelId}`, body);

  const chat = (model: string): LLM => ({
    stream: () => { throw new Error('the agreement report never streams'); },
    complete: async (prompt) => {
      const answered = v.parse(
        v.object({ choices: v.tuple([v.object({ message: v.object({ content: v.string() }) })]) }),
        await call('v1/chat/completions', { model, messages: [{ role: 'user', content: prompt }] }),
      );

      return answered.choices[0].message.content;
    },
  });

  return { run, chat };
}

async function rated(decide: DecisionPort, turn: RatedTurnInput): Promise<RatingVerdict | null> {
  try {
    return await rateTurn(decide, turn, turn.actions.split('\n').filter((line) => line !== '').length);
  } catch (cause) {
    console.error(`unrated: ${renderThrownChain({ cause })}`);

    return null;
  }
}

/** Four turns at a time: a reasoning model takes seconds a call, and the report is a sample, not a load test. */
async function ratedAll(turns: readonly RatedTurnInput[], clef: DecisionPort, structured: DecisionPort): Promise<RatedPair[]> {
  const pairs: RatedPair[] = [];

  for (let at = 0; at < turns.length; at += 4) {
    pairs.push(...await Promise.all(turns.slice(at, at + 4).map(async (turn) => ({ clef: await rated(clef, turn), structured: await rated(structured, turn) }))));
  }

  return pairs;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { turns: { type: 'string' }, db: { type: 'string' }, limit: { type: 'string' }, model: { type: 'string' } },
  });

  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;

  if (account === undefined || token === undefined) throw new Error('set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
  const turns = turnsFrom({ ...values, limit: Number(values.limit ?? '40') });
  const model = values.model ?? DEFAULT_WORKERS_AI_MODEL_SPEC.slice('workers-ai/'.length);
  const { run, chat } = workersAi(account, token);

  const clef = createDecisionPort({
    run, model: async () => DEFAULT_DECISION_MODEL, report: () => {},
    refusals: { changes: () => 0, refused: () => {}, answered: () => {} },
  });

  const structured = createStructuredDecisionPort({ llm: () => chat(model) });
  const measured = agreement(await ratedAll(turns, clef, structured));
  const percent = (share: number): string => `${(share * 100).toFixed(0)}%`;

  console.log(`decision agreement, ${DEFAULT_DECISION_MODEL} against ${model} answering categories, over ${String(measured.both)} of ${String(measured.turns)} recorded turns both rated:`);
  console.log(`  satisfaction exact ${percent(measured.satisfactionExact)}, within one ${percent(measured.satisfactionWithinOne)}`);
  console.log(`  corrected ${percent(measured.corrected)}`);
  console.log(`  what went wrong ${percent(measured.wrong)}`);
}
