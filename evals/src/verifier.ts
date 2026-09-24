import * as v from 'valibot';
import { JsonValueSchema, projectJsonValue, type JsonValue } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { INFRA_FAILURE_MARKER } from '@kinu.run/test-utils';
import { redact } from './redact';
import type { EvalCheck } from './task';

/** Thrown errors are cut here in the report; a stack trace is not evidence. */
const EVIDENCE_LIMIT = 2_000;

const THREW = 'verifier.threw';

/** The artifact's own surfaces. Checks read what a person could read; never the agent's ledger. */
export type VerifierSession = {
  slateOp(operation: JsonValue): Promise<JsonValue>;
  readFile(path: string, options?: { allowMissing?: boolean }): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
};

/** What a check saw: JSON-like data, projected to JSON when it is recorded. */
export type Evidence = string | number | boolean | null | undefined | readonly Evidence[] | { readonly [key: string]: Evidence };

export type EvalCheckOutcome = { pass: boolean; evidence?: Evidence };

/**
 * A slate, or the checker's reference implementing the same contract: `client('lend', input)` is
 * one method call. The answer is unparsed; a check parses what it needs, so a wrong type is evidence.
 */
export type SlateClient<Method extends string> = (method: Method, input?: JsonValue) => Promise<JsonValue>;

/** A fixed sequence of calls. It must not branch on answers: it runs once against each side. */
export type Script<Method extends string> = (client: SlateClient<Method>) => Promise<void>;

/** How a task compares answers: parse each through its contract, dropping fields the contract does not name. */
export type Normalize<Method extends string> = (method: Method, answer: JsonValue) => JsonValue;

type Call<Method extends string> = { method: Method; input: JsonValue | null; answer: JsonValue };

/**
 * Make the same calls on the slate and on the checker's reference, which stands where the slate
 * should stand, and compare every answer in order. Any correct build answers exactly as it does.
 */
export async function matchesReference<Method extends string>(input: {
  slate: SlateClient<Method>;
  reference: SlateClient<Method>;
  script: Script<Method>;
  normalize: Normalize<Method>;
}): Promise<EvalCheckOutcome> {
  const expected: Call<Method>[] = [], actual: Call<Method>[] = [];

  const recording = (client: SlateClient<Method>, calls: Call<Method>[]): SlateClient<Method> => async (method, argument) => {
    const answer = await client(method, argument);
    calls.push({ method, input: argument ?? null, answer });

    return answer;
  };

  await input.script(recording(input.reference, expected));
  await input.script(recording(input.slate, actual));
  const project = (call: Call<Method>) => JSON.stringify(input.normalize(call.method, call.answer));

  const index = expected.findIndex((call, at) => {
    const other = actual[at];

    return other === undefined || project(call) !== project(other);
  });

  if (index === -1) return { pass: true, evidence: { calls: expected.length } };
  const miss = expected[index], got = actual[index];

  return {
    pass: false,
    evidence: {
      call: index + 1, of: expected.length, method: miss?.method, input: miss?.input,
      answered: clipped(got?.answer), expected: clipped(miss?.answer),
    },
  };
}

const SlateAnswerSchema = v.variant('ok', [
  v.object({ ok: v.literal(true), value: JsonValueSchema }),
  v.object({ ok: v.literal(false), reason: v.string(), error: v.string() }),
]);

/** The slate refused a call: its method threw, did not exist, or the slate would not build. */
export class SlateRefusal extends Error {
  constructor(readonly reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = 'SlateRefusal';
  }
}

/** A long answer is evidence by its start: the first difference is usually there. */
function clipped(answer: JsonValue | undefined): JsonValue | undefined {
  const text = JSON.stringify(answer ?? null);

  return text.length > EVIDENCE_LIMIT ? `${text.slice(0, EVIDENCE_LIMIT)}...` : answer;
}

function truncate(text: string): string {
  return text.length > EVIDENCE_LIMIT ? `${text.slice(0, EVIDENCE_LIMIT)}...` : text;
}

/**
 * Runs one turn's functional checks against what the agent built. Checks are independent: one
 * that throws fails alone, with the error as its evidence, and the rest still run.
 */
export class EvalVerifier {
  /** What the agent said in the chat after this turn's prompt, oldest first. */
  readonly replies: readonly string[];
  readonly #session: VerifierSession;
  readonly #checks: EvalCheck[] = [];
  readonly #pending: Promise<void>[] = [];

  constructor(session: VerifierSession, replies: readonly string[]) {
    this.#session = session;
    this.replies = replies;
  }

  async check(id: string, body: () => Promise<EvalCheckOutcome>): Promise<void> {
    if (this.#checks.some((check) => check.id === id)) throw new Error(`Duplicate eval check id ${JSON.stringify(id)} in one turn`);
    const index = this.#checks.length;
    this.#checks.push({ id, pass: false, evidence: 'check did not complete' });
    const settled = this.#run(index, id, body);
    this.#pending.push(settled);
    await settled;
  }

  /**
   * The slate `id` as a client over the methods its contract names: `client('lend', input)` is one
   * call over the slate RPC, the call the slate's own interface makes.
   */
  slate<Method extends string>(id: string, methods: readonly Method[]): SlateClient<Method> {
    return (method, input) => {
      if (!methods.includes(method)) throw new Error(`${method} is not in the ${id} contract`);

      return this.call(id, method, input === undefined ? [] : [input]);
    };
  }

  /** One slate call. A refusal throws {@link SlateRefusal}, so the check that made it fails with the product's words. */
  async call(id: string, method: string, args: readonly JsonValue[]): Promise<JsonValue> {
    const answer = v.parse(SlateAnswerSchema, await this.#session.slateOp({ op: 'call', id, method, args: [...args] }));

    if (!answer.ok) throw new SlateRefusal(answer.reason, answer.error);

    return answer.value;
  }

  /** A workspace file, or '' when it does not exist. */
  readFile(path: string): Promise<string> {
    return this.#session.readFile(path, { allowMissing: true });
  }

  /** Change the workspace's data mid-check, the way a person drops in a new file. */
  writeFile(path: string, content: string): Promise<void> {
    return this.#session.writeFile(path, content);
  }

  async collect(verify: (verifier: EvalVerifier) => Promise<void>): Promise<EvalCheck[]> {
    try {
      await verify(this);
    } catch (error) {
      // The deployment's transport failing (`infraBoundary`, a dropped socket) is nothing the build did.
      if (renderThrownChain({ cause: error }).includes(INFRA_FAILURE_MARKER)) throw error;
      // A throw outside any check is the checker's own failure; it fails the turn and says why.
      this.#checks.push({ id: THREW, pass: false, evidence: truncate(redact(renderThrownChain({ cause: error }))) });
    }

    await Promise.all(this.#pending);

    return this.#checks.map((check) => ({ ...check }));
  }

  async #run(index: number, id: string, body: () => Promise<EvalCheckOutcome>): Promise<void> {
    try {
      const outcome = await body();

      this.#checks[index] = outcome.evidence === undefined
        ? { id, pass: outcome.pass }
        : { id, pass: outcome.pass, evidence: projectJsonValue({ value: outcome.evidence }) };
    } catch (error) {
      // The deployment failing to answer is not the build's failure: the trial fails as infrastructure.
      if (renderThrownChain({ cause: error }).includes(INFRA_FAILURE_MARKER)) throw error;
      // The failure is the check's result: its error is recorded as the evidence.
      this.#checks[index] = { id, pass: false, evidence: truncate(redact(renderThrownChain({ cause: error }))) };
    }
  }
}
