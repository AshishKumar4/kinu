/**
 * The vendor half of eviction durability, executed for real: a durable fiber
 * and a durable submission carried across an activation the object never chose
 * to end, and resumed with NO CLIENT.
 *
 * WHY THIS FILE HAS TO EXIST. `ActorAgent`'s recovery is a decision per lane
 * over `FiberRecoveryContext`, and the bun suite runs those decisions for real.
 * What bun cannot host is the two platform facts the decisions stand on: that a
 * `cf_agents_runs` row survives an isolate reset while the promise behind it does
 * not, and that with nothing connected the persisted keepAlive alarm fires on its
 * own and drives the interrupted-fiber scan. Neither exists outside workerd — the
 * bun stand-in reproduces the SQL by hand precisely because there is no alarm and
 * no reset there — so a green bun suite says nothing about whether recovery ever
 * STARTS in production.
 *
 * Deliberately `Think`, not `ActorAgent`, for the reason `steer-probe.ts` records:
 * a full actor turn needs the hosted workspace plane (NIMBUS_SESSION's wasm
 * subgraph, LOADER's worker_loaders) which this pool loads neither, and hosting
 * any `@callable()`-bearing class additionally needs legacy decorators. The
 * subject here is the SDK's fiber/submission machinery, which is the same
 * machinery under both.
 *
 * THE OBSERVATION IS OUTSIDE THE PROBE, and that is the whole design. Reading
 * anything off this object is a REQUEST, and a request runs `onStart`, which runs
 * the recovery scan eagerly — so a test that concluded "recovery happened" from
 * reading the probe would have caused the thing it measured. Every recovery here
 * reports to a second Durable Object instead, and the test polls only that one.
 * Until the witness answers, nothing has touched the probe since the reset.
 */
import { DurableObject } from 'cloudflare:workers';
import { Think } from '@cloudflare/think';
import { scriptedTurnModel } from '@kinu.run/test-utils/turn-model';
import { jsonSchema, tool, type LanguageModel, type ToolSet } from 'ai';

const USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 3, text: 3, reasoning: undefined },
};

/**
 * Where the probe reports work it completed with nobody watching.
 *
 * A separate object, so the test can ask "did the recovery run" without issuing
 * the request that would make it run.
 */
export class WitnessDO extends DurableObject<Cloudflare.Env> {
  async record(note: string): Promise<void> {
    const seen = (await this.ctx.storage.get<string[]>('seen')) ?? [];
    seen.push(note);
    await this.ctx.storage.put('seen', seen);
  }

  async seen(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>('seen')) ?? [];
  }
}

export class EvictionProbeDO extends Think<Cloudflare.Env> {
  /**
   * A one-second heartbeat instead of the default thirty.
   *
   * The knob is the SDK's own (`AgentStaticOptions.keepAliveIntervalMs`), and it
   * is what makes the no-client path OBSERVABLE rather than merely believed:
   * after a reset, the alarm the previous activation persisted is the only thing
   * that can start recovery, and at the default interval a test would have to
   * wait half a minute for it. Shortening the interval changes when the alarm
   * fires, not what fires it.
   */
  static override options = { keepAliveIntervalMs: 1_000 };

  /** The two settings `ActorAgent` declares, declared identically here so this
   *  probe measures the shipped configuration. */
  override chatRecovery = true;
  override chatStreamStallTimeoutMs = 0;

  private _model: LanguageModel | null = null;

  /** Step one parks; every later step finishes. `park` decides which by reading
   *  DURABLE state, so the turn resumed after a reset does not park again. */
  override getModel(): LanguageModel {
    this._model ??= scriptedTurnModel({
      provider: 'fake',
      modelId: 'eviction-probe',
      doGenerate: (options) => (options.prompt.some((message) => message.role === 'tool')
        ? {
          content: [{ type: 'text' as const, text: 'answered after recovery' }],
          finishReason: { unified: 'stop' as const, raw: undefined }, usage: USAGE, warnings: [],
        }
        : {
          content: [{ type: 'tool-call' as const, toolCallId: 'park-1', toolName: 'park', input: '{}' }],
          finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage: USAGE, warnings: [],
        }),
    });
    return this._model;
  }

  override getTools(): ToolSet {
    return {
      park: tool({
        description: 'Blocks the first time, so the activation can be reset mid-turn.',
        inputSchema: jsonSchema({ type: 'object', properties: {} }),
        execute: async () => {
          const parked = await this.ctx.storage.get<boolean>('parked');
          if (parked === true) {
            // The recovered turn. Reported to the witness, so the test learns
            // the turn continued without ever addressing this object.
            await this.witness().record('turn:resumed');
            return 'resumed';
          }
          await this.ctx.storage.put('parked', true);
          // Never settles. The activation is reset while this is held, which is
          // exactly the eviction a keepAlive heartbeat cannot survive.
          return new Promise<string>(() => undefined);
        },
      }),
    };
  }

  /** This probe's own witness, keyed to its name so two tests sharing the
   *  process cannot read each other's notes and call it a recovery. */
  private witness(): DurableObjectStub<WitnessDO> {
    return this.env.WITNESS.get(this.env.WITNESS.idFromName(this.name));
  }

  /**
   * A durable fiber whose body never settles.
   *
   * `runFiber` writes its `cf_agents_runs` row before running the body and takes
   * a `keepAlive` for the duration, so the reset below leaves exactly the pair
   * production leaves: the row, and no promise.
   */
  async startLostFiber(name: string): Promise<void> {
    void this.runFiber(name, async (ctx) => {
      ctx.stash({ lane: name, phase: 'running' });
      await new Promise<void>(() => undefined);
    });
    // The row is written synchronously inside `runFiber`; returning here means
    // the caller's next read would see it.
  }

  /** Report the recovery to the witness and terminalize, which is the shape
   *  `ActorAgent.onFiberRecovered` returns for every lane it recognises. */
  override async onFiberRecovered(ctx: {
    id: string; name: string; snapshot: unknown; createdAt: number;
  }): Promise<{ status: 'completed'; snapshot: unknown }> {
    await this.witness().record(`fiber:${ctx.name}`);
    return { status: 'completed', snapshot: { lane: ctx.name, recovered: true } };
  }

  /** Durable fiber rows still awaiting recovery. */
  async openFiberRows(): Promise<{ id: string; name: string }[]> {
    return this.sql<{ id: string; name: string }>`SELECT id, name FROM cf_agents_runs ORDER BY created_at`;
  }

  /** One durable submission, the acceptance boundary a programmatic turn uses. */
  async submit(text: string, idempotencyKey: string): Promise<{ submissionId: string; accepted: boolean; status: string }> {
    const result = await this.submitMessages(
      [{ id: `probe-${idempotencyKey}`, role: 'user', parts: [{ type: 'text', text }] }],
      { idempotencyKey },
    );
    return { submissionId: result.submissionId, accepted: result.accepted, status: result.status };
  }

  async submissionStatuses(): Promise<{ idempotencyKey: string | undefined; status: string }[]> {
    return (await this.listSubmissions()).map((row) => ({
      idempotencyKey: row.idempotencyKey, status: row.status,
    }));
  }

  /** The stored transcript, for a failure message that says what the turn did. */
  async transcript(): Promise<string[]> {
    return this.messages.map((message) => `${message.role}:${message.parts
      .map((part) => (part.type === 'text' ? part.text : part.type)).join('|')}`);
  }
}
