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
 */
import { DurableObject } from 'cloudflare:workers';
import { Sandbox } from '@cloudflare/sandbox';

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
}

const EXEC_KEY = 'probe:exec';

export class OnStartExecProbe extends Sandbox<ProbeBindings> {
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
    await this.runProbeExec();
  }

  /** `mode` is 'start' | 'ports'. A reset leaves the row in storage with
   *  `execStarted` set and `execFinished` null. */
  async probeStart(mode: string): Promise<ExecProbeStamp> {
    const row: ExecProbeStamp = {
      mode, startEntered: Date.now(), startReturned: null,
      onstartEntered: null, execStarted: null, execFinished: null, execResult: null,
    };

    await this.ctx.storage.put(EXEC_KEY, row);

    if (mode === 'ports') {
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
