/**
 * Server-side send admission, executed on the platform.
 *
 * WHY THIS FILE HAS TO EXIST. `unit-send-admission.test.ts` proves the BROWSER
 * fence — one latch, two presses in one tick, one `begin` — and the chromium
 * suite proves the same fence at the real composer. Both live on the client. If
 * the client is bypassed at all (a second tab on the same conversation, a socket
 * that dropped after the request left and replayed it on reconnect, a CLI
 * sending while the web app streams), what has to refuse the duplicate is the
 * Durable Object, and nothing measured that. A route/DO regression admitting two
 * turns for one send kept every latch unit green.
 *
 * WHY `bun test` CANNOT HOST IT. The refusal is a read-then-insert over the
 * object's SQLite, and what makes it safe is the Durable Object INPUT GATE:
 * while a storage operation is outstanding, no other event is delivered. Bun has
 * no gate and no second concurrent caller into one object, so a suite there can
 * only re-state the intent — two sequential submits, which
 * `do-eviction-recovery.test.ts` already covers. Overlapping ones need workerd.
 *
 * Deliberately `Think`, not `ActorAgent`, for the reason `steer-probe.ts`
 * records: a full actor turn needs the hosted workspace plane (NIMBUS_SESSION's
 * wasm subgraph, LOADER's worker_loaders) and this pool loads neither. The
 * subject is the SDK's durable-submission admission, which is the same machinery
 * `ActorAgent.host.enqueueTurn` reaches through `submitMessages`.
 */
import { Think } from '@cloudflare/think';
import type { ModelStreamPart } from '@kinu.run/test-utils/turn-model';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import type { LanguageModel, ToolSet } from 'ai';

const USAGE = {
  inputTokens: { total: 4, noCache: 4, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

/** One durable submission's public receipt, as a caller reads it. */
export interface SubmitReceipt {
  submissionId: string;
  accepted: boolean;
  status: string;
}

/** One row of the object's submission ledger. */
export interface SubmissionRow {
  idempotencyKey: string | undefined;
  submissionId: string;
  status: string;
}

/** Rows the probe keeps for itself. Separate from anything the SDK owns, so a
 *  count here is the probe's own observation and cannot be confused with the
 *  ledger it is used to cross-check. */
const PROBE_TABLE = `CREATE TABLE IF NOT EXISTS probe_counters (
  name TEXT PRIMARY KEY, value INTEGER NOT NULL
)`;

export class SendAdmissionProbeDO extends Think<Cloudflare.Env> {
  /** The two settings `ActorAgent` declares, declared identically here so this
   *  probe measures the shipped configuration. */
  override chatRecovery = true;
  override chatStreamStallTimeoutMs = 0;

  private _model: LanguageModel | null = null;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(PROBE_TABLE);
  }

  /**
   * Every provider request this object has ever issued, counted DURABLY.
   *
   * Durable rather than an instance field because the count has to outlive the
   * activation: a duplicate admitted after an eviction would run its turn in a
   * second isolate, and an in-memory counter would report one.
   */
  private bump(name: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO probe_counters (name, value) VALUES (?, 1)
       ON CONFLICT(name) DO UPDATE SET value = value + 1`,
      name,
    );
  }

  private counter(name: string): number {
    const rows = [...this.ctx.storage.sql.exec<{ value: number }>(
      'SELECT value FROM probe_counters WHERE name = ?', name,
    )];
    return rows[0]?.value ?? 0;
  }

  /**
   * One provider request per turn, counted before it answers.
   *
   * An armed failure arrives as an ERROR PART on the stream rather than as a
   * throw from `doStream`, because that is the failure a live provider actually
   * delivers — the request succeeds, the stream opens, and the endpoint gives up
   * partway. A throw is additionally the one shape the vendor's recovery fiber
   * re-raises with nobody awaiting it, which surfaces as an unhandled rejection
   * and makes every other file in the run suspect.
   */
  override getModel(): LanguageModel {
    this._model ??= new MockLanguageModelV3({
      provider: 'fake',
      modelId: 'send-admission-probe',
      doStream: async () => {
        this.bump('provider_calls');
        const failing = this.counter('armed_failures') > 0;
        if (failing) {
          this.ctx.storage.sql.exec(
            'UPDATE probe_counters SET value = value - 1 WHERE name = ?', 'armed_failures',
          );
        }
        const answer = `answered ${String(this.counter('provider_calls'))}`;
        const parts: ModelStreamPart[] = failing
          ? [
            { type: 'stream-start', warnings: [] },
            { type: 'error', error: new Error('provider refused this turn') },
          ]
          : [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't0' },
            { type: 'text-delta', id: 't0', delta: answer },
            { type: 'text-end', id: 't0' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: USAGE },
          ];
        return { stream: convertArrayToReadableStream(parts) };
      },
    });
    return this._model;
  }

  override getTools(): ToolSet { return {}; }

  override getSystemPrompt(): string { return 'Send-admission probe.'; }

  /** Arm the next `count` provider requests to fail. */
  async armProviderFailures(count: number): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO probe_counters (name, value) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET value = value + excluded.value`,
      'armed_failures', count,
    );
  }

  /** One durable send — the acceptance boundary a client's send reaches. */
  async submit(text: string, idempotencyKey: string): Promise<SubmitReceipt> {
    const result = await this.submitMessages(
      [{ id: `send-${idempotencyKey}`, role: 'user', parts: [{ type: 'text', text }] }],
      { idempotencyKey },
    );
    return { submissionId: result.submissionId, accepted: result.accepted, status: result.status };
  }

  /**
   * Several sends started in ONE tick and settled together.
   *
   * The strongest interleaving this object can be given: no `await` runs between
   * the calls, so every one of them is inside the admission decision before any
   * of them has committed. Two clients arriving over separate HTTP requests are
   * the weaker, more realistic version of the same race; the tests drive both.
   */
  async submitTogether(text: string, keys: readonly string[]): Promise<SubmitReceipt[]> {
    return Promise.all(keys.map((key) => this.submit(text, key)));
  }

  async submissions(): Promise<SubmissionRow[]> {
    return (await this.listSubmissions()).map((row) => ({
      idempotencyKey: row.idempotencyKey,
      submissionId: row.submissionId,
      status: row.status,
    }));
  }

  async providerCalls(): Promise<number> { return this.counter('provider_calls'); }

  /** The stored transcript, one line per message, so a failure says what the
   *  object actually did rather than how many rows it has. */
  async transcript(): Promise<string[]> {
    return this.messages.map((message) => `${message.role}:${message.parts
      .map((part) => (part.type === 'text' ? part.text : part.type)).join('|')}`);
  }

  /**
   * What this conversation was actually told — one entry per turn that answered.
   *
   * Not "assistant messages": a turn the provider failed still leaves an
   * assistant row behind carrying nothing but the step marker, and counting that
   * would make a failed turn read as an answered one.
   */
  async answers(): Promise<string[]> {
    return this.messages.flatMap((message) => (message.role === 'assistant'
      ? message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : []))
      : []));
  }

  /**
   * NEGATIVE CONTROL, on the platform.
   *
   * The admission a durable ledger replaces: read whether this conversation is
   * already claimed, then claim it. The read is I/O, so its answer is stale
   * before it is used — the server-side twin of the reactive guard
   * `unit-send-admission.test.ts` keeps as its own control.
   *
   * It exists to establish that the interleaving {@link submitTogether} produces
   * is REAL on this runtime. If two callers could not be inside one decision at
   * all, every "exactly one" assertion in the suite would be measuring nothing.
   */
  async raceReactiveGuard(callers: number): Promise<number> {
    const claim = async (): Promise<boolean> => {
      if (await this.ctx.storage.get<boolean>('reactive_claim') === true) return false;
      await this.ctx.storage.put('reactive_claim', true);
      return true;
    };
    const outcomes = await Promise.all(Array.from({ length: callers }, () => claim()));
    return outcomes.filter(Boolean).length;
  }
}
