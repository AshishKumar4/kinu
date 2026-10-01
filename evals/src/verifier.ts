import * as v from 'valibot';
import { JsonValueSchema, projectJsonValue, type JsonValue, type SubordinateInspectionRequest } from '@kinu.run/core';
import type { InspectionAnswer, PublicExecutorResult, PublicSwarmRun, WorkBoard } from './session';
import { renderThrownChain } from '@kinu.run/core/obs';
import { INFRA_FAILURE_MARKER, TRANSIENT_PLATFORM_ERRORS } from '@kinu.run/test-utils';
import { redact, redactJson } from './redact';
import type { EvalCheck } from './task';

/** Thrown errors are cut here in the report; a stack trace is not evidence. */
const EVIDENCE_LIMIT = 2_000;

const THREW = 'verifier.threw';

/**
 * Whether a refused call never reached the slate: the host's `io` refusal naming the call and then
 * nothing but one of the platform's own transient failures, as it answered `io: slate
 * exchange.place: Network connection lost.` mid-check on a correct reference build on 2026-09-24.
 * A slate error that merely mentions one, or a refusal the slate chose, is the slate's.
 */
function lostByThePlatform(call: string, answer: { reason: string; error: string }): boolean {
  return answer.reason === 'io' && TRANSIENT_PLATFORM_ERRORS.some((message) =>
    answer.error === `slate ${call}: ${message}` || answer.error === `slate ${call}: ${message}.`);
}

/** The artifact's own surfaces. Checks read what a person could read; never the agent's ledger. */
export type VerifierSession = {
  slateOp(operation: JsonValue): Promise<JsonValue>;
  readFile(path: string, options?: { allowMissing?: boolean }): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  workspaceWork(): Promise<WorkBoard>;
  inspect(request: SubordinateInspectionRequest): Promise<InspectionAnswer>;
  swarmRuns(): Promise<PublicSwarmRun[]>;
  execute(executor: string, command: string): Promise<PublicExecutorResult>;
  exposedPorts(executor: string): Promise<readonly { port: number; url: string }[]>;
};

/** A helper and its runs, as the inspector lists them: how each run ended, and the message that started it. */
export type HelperWork = { name: string; status: string; runs: { status: string | null; userMessage: string | null }[] };

/**
 * The helpers that finished the work naming `subject`: a message naming it started one of their runs, and a run of
 * their own completed. Told is not done: on 2026-10-01 every helper's model call on staging was refused, the lead
 * did the helpers' work itself, and the helpers' transcripts still held the work they were given.
 */
export function finishedWork(helpers: readonly HelperWork[], subject: string): string[] {
  return helpers
    .filter((helper) => helper.runs.some((run) => run.status === 'completed')
      && helper.runs.some((run) => (run.userMessage ?? '').includes(subject)))
    .map((helper) => helper.name);
}

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

export const SlateAnswerSchema = v.variant('ok', [
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

  /**
   * The agent's answer to a question turn: its last reply that `answerPattern` matches whole
   * (anchored, the answer in its first group) once Markdown emphasis, quotes and a closing period
   * are stripped, or null when none does. Narration before the answer and a reply after it (a
   * sign-off, or its answer to the product's own reminder about open tasks) are not answers, so
   * neither replaces it.
   */
  bareAnswer(answerPattern: RegExp): string | null {
    for (const reply of [...this.replies].reverse()) {
      const found = answerPattern.exec(reply.trim().replace(/^[*_`"']+|[*_`"'.]+$/g, '').trim());

      if (found !== null) return found[1] ?? found[0];
    }

    return null;
  }

  /** The last replies, clipped: what a question check shows as its evidence. */
  recentReplies(): string[] {
    return this.replies.slice(-3).map((reply) => reply.length > 500 ? `${reply.slice(0, 500)}...` : reply);
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

  /**
   * One slate call. A refusal throws {@link SlateRefusal}, so the check that made it fails with the
   * product's words, unless the platform lost the call before it reached the slate: that throws as
   * infrastructure and fails the trial, never the check.
   */
  async call(id: string, method: string, args: readonly JsonValue[]): Promise<JsonValue> {
    const answer = v.parse(SlateAnswerSchema, await this.#session.slateOp({ op: 'call', id, method, args: [...args] }));

    if (answer.ok) return answer.value;

    if (lostByThePlatform(`${id}.${method}`, answer)) {
      throw new Error(`${INFRA_FAILURE_MARKER} — the platform lost a call to ${id}.${method}: ${answer.error}`);
    }

    throw new SlateRefusal(answer.reason, answer.error);
  }

  /** A workspace file, or '' when it does not exist. */
  readFile(path: string): Promise<string> {
    return this.#session.readFile(path, { allowMissing: true });
  }

  /** Change the workspace's data mid-check, the way a person drops in a new file. */
  writeFile(path: string, content: string): Promise<void> {
    return this.#session.writeFile(path, content);
  }

  /** Every agent's plans and tasks, as the Work tab shows them. */
  workspaceWork(): Promise<WorkBoard> {
    return this.#session.workspaceWork();
  }

  /** The lead's helpers, retired ones included, as the Agents surface lists them. */
  async helpers(): Promise<{ name: string; status: string; lifetime: string }[]> {
    const helpers: { name: string; status: string; lifetime: string }[] = [];

    for (let cursor: { after: string } | undefined; ;) {
      const answer = await this.#session.inspect({ path: [], view: 'children', page: cursor === undefined ? {} : { cursor } });

      if (answer.view !== 'children') throw new Error(`the lead's helpers could not be listed: ${JSON.stringify(answer)}`);
      helpers.push(...answer.page.items);

      if (answer.page.status === 'end') return helpers;
      cursor = answer.page.next;
    }
  }

  /** Every helper the lead hired, with its runs. */
  async helperWork(): Promise<HelperWork[]> {
    return Promise.all((await this.helpers()).map(async (helper) => ({
      name: helper.name, status: helper.status, runs: await this.runsOf(helper.name),
    })));
  }

  /**
   * The lead's own tasks and their subtasks, in one list. Its board entries are those whose owner's path is empty,
   * or, on a build whose owners carry no path, whose owner is none of its helpers.
   */
  async leadTasks(): Promise<{ title: string; status: string }[]> {
    const [work, helpers] = await Promise.all([this.workspaceWork(), this.helpers()]);
    const helperNames = new Set(helpers.map((helper) => helper.name));

    return [...work.plans, ...work.tasks]
      .filter((entry) => (entry.owner.path === undefined ? !helperNames.has(entry.owner.name) : entry.owner.path === null || entry.owner.path.length === 0))
      .flatMap((entry) => entry.tasks.flatMap((task) => [task, ...task.subtasks]))
      .map(({ title, status }) => ({ title, status }));
  }

  /** One helper's runs as its inspector lists them: how each ended, and the message that started it. */
  async runsOf(helper: string): Promise<HelperWork['runs']> {
    const runs: HelperWork['runs'] = [];

    for (let cursor: { after: string } | undefined; ;) {
      const answer = await this.#session.inspect({ path: [helper], view: 'runs', page: cursor === undefined ? {} : { cursor } });

      if (answer.view !== 'runs') throw new Error(`${helper}'s runs could not be listed: ${JSON.stringify(answer)}`);
      runs.push(...answer.page.items);

      if (answer.page.status === 'end') return runs;
      cursor = answer.page.next;
    }
  }

  /** The swarms the lead ran, newest first, as the Swarms pane draws them. */
  swarms(): Promise<PublicSwarmRun[]> {
    return this.#session.swarmRuns();
  }

  /** One command on an executor, the call the Env pane makes, answered whole: output, exit code and any refusal. */
  run(executor: string, command: string): Promise<PublicExecutorResult> {
    return this.#session.execute(executor, command);
  }

  /** The preview addresses an executor serves, as the ports panel lists them. */
  previews(executor: string): Promise<readonly { port: number; url: string }[]> {
    return this.#session.exposedPorts(executor);
  }

  /**
   * One command on an executor, the call the Env pane makes: what it printed. A refusal, a non-zero exit among
   * them, throws with the product's words, so the check that ran it fails with them.
   */
  async execute(executor: string, command: string): Promise<string> {
    const answer = await this.run(executor, command);
    const refused = answer.refusal?.error ?? answer.error;

    if (refused !== undefined) throw new Error(`${executor} refused the command: ${refused}`);

    return answer.stdout ?? '';
  }

  /** A preview opened the way a person's browser opens it: no credential, the status and the page. */
  async open(url: string): Promise<{ status: number; body: string }> {
    const response = await fetch(url, { redirect: 'follow' });

    return { status: response.status, body: await response.text() };
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

      // Evidence quotes what the agent built and said, which can carry a preview host or an echoed header.
      this.#checks[index] = outcome.evidence === undefined
        ? { id, pass: outcome.pass }
        : { id, pass: outcome.pass, evidence: redactJson(projectJsonValue({ value: outcome.evidence })) };
    } catch (error) {
      // The deployment failing to answer is not the build's failure: the trial fails as infrastructure.
      if (renderThrownChain({ cause: error }).includes(INFRA_FAILURE_MARKER)) throw error;
      // The failure is the check's result: its error is recorded as the evidence.
      this.#checks[index] = { id, pass: false, evidence: truncate(redact(renderThrownChain({ cause: error }))) };
    }
  }
}
