/**
 * The discriminating probes for the onStart restore question, served ONLY by
 * the standalone probe entry (`probe-worker.ts`, `wrangler.probe.jsonc`).
 * Nothing here is imported by the bench worker or any product code.
 *
 * GateProbe answers whether a Durable Object timer delivers inside
 * `blockConcurrencyWhile`, as three independent arms with durable stamps:
 *
 *   timer-inside   — a 50 ms setTimeout awaited inside the block. If timers
 *                    are starved, `completed` is never stamped and the DO
 *                    resets at the platform cap; `entered` alone is the proof.
 *   timer-outside  — the same 50 ms timer awaited BEFORE the block (control:
 *                    outside the gate, timers obviously deliver), so a run
 *                    that returns shows the stamp path itself works on this DO.
 *   storage-inside — one ctx.storage round trip inside the block. Delivered
 *                    I/O is expected to complete; a null `completed` beside a
 *                    working timer-inside would invert every current premise.
 *
 *   Stamps are written eagerly and read back via `probeReport` from a LATER
 *   RPC, so a case that ends in a platform reset still leaves `entered` behind.
 *
 * OnStartExecProbe answers whether the FIRST container command inside the
 * SDK's own onStart block can answer, under both admission shapes the history
 * used:
 *
 *   mode=start  — `this.start()`, which opens the block the moment the
 *                 instance exists, before the control server accepts.
 *   mode=ports  — `this.startAndWaitForPorts({ ports: this.defaultPort })`,
 *                 which polls `getTcpPort(3000).fetch` with real timers BEFORE
 *                 the block opens, so the RPC control listener is proven
 *                 answering first.
 *
 *   The hook then execs one minimal command (`cat /proc/mounts`) and stamps
 *   each phase durably: `onstartEntered`, `execStarted`, `execFinished` or an
 *   error string. `destroyProbe` tears the probe's container identity down
 *   after a run; gate rows are namespaced per `op` and exec rows per `box`,
 *   so runs never share state.
 *
 * `probeReentry` is D8's control (D26): the start block reopens on a running
 * container while one timer set outside it is pending (`pending`): the control
 * connection's own timers after an exec, the alarm loop's wait, or a stray timer.
 * The hook execs once, races the reply against `windowMs`, holds `holdMs`, and
 * stamps each edge.
 */
import { DurableObject } from 'cloudflare:workers';
import { Sandbox } from '@cloudflare/sandbox';
import type { ReentryPending, ReentryStamp } from './reentry';

export interface ProbeBindings {
  GateProbe: DurableObjectNamespace<GateProbe>;
  OnStartExecProbe: DurableObjectNamespace<OnStartExecProbe>;
}

export interface GateProbeStamp {
  entered: number;
  completed: number | null;
  exited: number | null;
  arm: string;
}

const GATE_KEY = 'probe:gate';

export class GateProbe extends DurableObject<ProbeBindings> {
  async probeReport(): Promise<GateProbeStamp | null> {
    return (await this.ctx.storage.get<GateProbeStamp>(GATE_KEY)) ?? null;
  }

  /** `arm` is 'timer-inside' | 'timer-outside' | 'storage-inside'. */
  async probe(arm: string): Promise<GateProbeStamp> {
    const entered = Date.now();
    await this.ctx.storage.put(GATE_KEY, { entered, completed: null, exited: null, arm });

    // The control arm waits its 50 ms OUTSIDE the gate, so the stamp row it
    // leaves proves the record path survives on this object.
    if (arm === 'timer-outside') await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const completed = await this.ctx.blockConcurrencyWhile(async (): Promise<number | null> => {
      if (arm === 'timer-inside') {
        // Awaited INSIDE the gate: if timers cannot deliver here this line is
        // the last thing the object ever does before the platform cap resets it.
        await new Promise<void>((resolve) => setTimeout(resolve, 50));

        return Date.now();
      }

      if (arm === 'storage-inside') {
        await this.ctx.storage.get('probe:gate-tick');
        await this.ctx.storage.put('probe:gate-tick', entered);

        return Date.now();
      }

      return null;
    });

    const row: GateProbeStamp = { entered, completed, exited: Date.now(), arm };
    await this.ctx.storage.put(GATE_KEY, row);

    return row;
  }
}

export interface ExecProbeStamp {
  mode: string;
  startEntered: number;
  startReturned: number | null;
  onstartEntered: number | null;
  execStarted: number | null;
  execFinished: number | null;
  execResult: { exitCode?: number; stdoutHead?: string; error?: string } | null;
  startError?: string;
}

const EXEC_KEY = 'probe:exec';

const REENTRY_KEY = 'probe:reentry';

export class OnStartExecProbe extends Sandbox<ProbeBindings> {
  /** A reply the window missed, stamped once the start returns. */
  #lateReply: Promise<number> | undefined;

  /** The exec the hook runs — the chain's own first command, so the probe
   *  reproduces the shape that measured resets, nothing larger. */
  private async runProbeExec(): Promise<void> {
    const at = Date.now();
    const row = (await this.ctx.storage.get<ExecProbeStamp>(EXEC_KEY)) ?? null;

    if (row === null) return;
    const marked = { ...row, onstartEntered: at, execStarted: at };
    await this.ctx.storage.put(EXEC_KEY, marked);

    try {
      const result = await this.exec('cat /proc/mounts');

      await this.ctx.storage.put(EXEC_KEY, {
        ...marked,
        execFinished: Date.now(),
        execResult: { exitCode: result.exitCode, stdoutHead: (result.stdout ?? '').slice(0, 120) },
      });
    } catch (error) {
      await this.ctx.storage.put(EXEC_KEY, {
        ...marked,
        execFinished: Date.now(),
        execResult: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  override async onStart(): Promise<void> {
    const reentry = await this.ctx.storage.get<ReentryStamp>(REENTRY_KEY);

    if (reentry?.armed === true) {
      await this.runReentryHook(reentry);

      return;
    }

    await this.runProbeExec();
  }

  /** Merges, so concurrent stamps never overwrite each other. */
  private async stampReentry(fields: Partial<ReentryStamp>): Promise<ReentryStamp | null> {
    const current = await this.ctx.storage.get<ReentryStamp>(REENTRY_KEY);

    if (current === undefined) return null;
    const next = { ...current, ...fields };
    await this.ctx.storage.put(REENTRY_KEY, next);

    return next;
  }

  /** Each edge is durable before the next wait, so a platform reset leaves the edge it stopped at. */
  private async runReentryHook(run: ReentryStamp): Promise<void> {
    await this.stampReentry({ armed: false, hookEntered: Date.now() });
    const sent = Date.now();

    const reply = (async () => {
      try {
        await this.exec('cat /proc/uptime');

        return { at: Date.now(), error: null };
      } catch (error) {
        return { at: Date.now(), error: error instanceof Error ? error.message : String(error) };
      }
    })();

    const answered = await Promise.race([
      reply,
      new Promise<null>((resolve) => { setTimeout(() => { resolve(null); }, run.windowMs); }),
    ]);

    if (answered === null) {
      this.#lateReply = reply.then(({ at }) => at);
    } else {
      await this.stampReentry({ hookExecMs: answered.at - sent, hookExecError: answered.error });
    }

    await new Promise<void>((resolve) => { setTimeout(resolve, run.holdMs); });
    await this.stampReentry({ hookExited: Date.now() });
  }

  /** A schedule row for `pending: 'alarm'`: the alarm loop waits between rows. */
  probeNoop(): Promise<void> {
    return Promise.resolve();
  }

  /** Leaves one timer set outside the next start block, due while its hook holds. */
  private async armPending(pending: ReentryPending): Promise<void> {
    if (pending === 'connection') {
      await this.exec('true');

      return;
    }

    if (pending === 'stray') {
      setTimeout(() => undefined, 1_000);

      return;
    }

    // The alarm runs the first row, then waits for the second: that wait is the pending timer.
    await this.schedule(1, 'probeNoop');
    await this.schedule(3, 'probeNoop');
    const rows = () => this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM container_schedules').one().n;

    for (let polls = 0; polls < 50 && rows() > 1; polls += 1) await scheduler.wait(100);
  }

  async probeReentry(windowMs: number, holdMs: number, pending: ReentryPending): Promise<ReentryStamp | null> {
    await this.ctx.storage.put(REENTRY_KEY, {
      windowMs, holdMs, pending, started: Date.now(), armed: false, firstStartMs: null, openerExecMs: null,
      hookEntered: null, hookExecMs: null, hookExecError: null, lateReplyAt: null, hookExited: null,
      reentryReturned: null, error: null,
    } satisfies ReentryStamp);

    try {
      const first = Date.now();
      await this.startAndWaitForPorts({ ports: this.defaultPort });
      const opener = Date.now();
      await this.armPending(pending);
      await this.stampReentry({ firstStartMs: opener - first, openerExecMs: Date.now() - opener, armed: true });
      await this.startAndWaitForPorts({ ports: this.defaultPort });
      const late = this.#lateReply;
      this.#lateReply = undefined;

      if (late !== undefined) await this.stampReentry({ lateReplyAt: await late });

      return await this.stampReentry({ reentryReturned: Date.now() });
    } catch (error) {
      return await this.stampReentry({
        reentryReturned: Date.now(), error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Delivery times during the hook show whether the input gate held. */
  touch(): number {
    return Date.now();
  }

  async reentryReport(): Promise<ReentryStamp | null> {
    return (await this.ctx.storage.get<ReentryStamp>(REENTRY_KEY)) ?? null;
  }

  /** `mode` is 'start' | 'ports' | 'bench'. A reset leaves the row in storage
   *  with `execStarted` set and `execFinished` null. `bench` is the bench
   *  fixture's admission window (`portWaitMs` 6,000, 100 ms polls, abort at
   *  the window); its refusal is returned in `startError` so the caller can
   *  re-drive the way the settlement driver does. */
  async probeStart(mode: string): Promise<ExecProbeStamp> {
    const row: ExecProbeStamp = {
      mode, startEntered: Date.now(), startReturned: null,
      onstartEntered: null, execStarted: null, execFinished: null, execResult: null,
    };

    await this.ctx.storage.put(EXEC_KEY, row);

    if (mode === 'bench') {
      try {
        await this.startAndWaitForPorts({
          ports: this.defaultPort,
          cancellationOptions: {
            instanceGetTimeoutMS: 6_000, portReadyTimeoutMS: 6_000, waitInterval: 100, abort: AbortSignal.timeout(6_000),
          },
        });
      } catch (error) {
        const refused = (await this.ctx.storage.get<ExecProbeStamp>(EXEC_KEY)) ?? row;
        refused.startReturned = Date.now();
        refused.startError = error instanceof Error ? error.message : String(error);
        await this.ctx.storage.put(EXEC_KEY, refused);

        return refused;
      }
    } else if (mode === 'ports') {
      await this.startAndWaitForPorts({ ports: this.defaultPort });
    } else {
      await this.start();
    }

    const done = (await this.ctx.storage.get<ExecProbeStamp>(EXEC_KEY)) ?? row;
    done.startReturned = Date.now();
    await this.ctx.storage.put(EXEC_KEY, done);

    return done;
  }

  async probeReport(): Promise<ExecProbeStamp | null> {
    return (await this.ctx.storage.get<ExecProbeStamp>(EXEC_KEY)) ?? null;
  }

  /** Tear this probe's container identity down after a run. */
  async destroyProbe(): Promise<{ destroyed: boolean }> {
    await this.destroy();

    return { destroyed: true };
  }
}
