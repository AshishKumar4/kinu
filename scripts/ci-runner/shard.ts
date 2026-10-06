/**
 * CiShard: one container running one piece of a run, either the plan (`ladder.ts --ci-plan` on the commit) or one CI
 * part (`ladder.ts --tier=ci --ci-part=<name>`, the command a GitHub runner runs). It starts from the run's
 * environment snapshot on the `durable_object` policy, as a devbox wakes, takes in the commit's pack, launches the
 * ladder detached, and reads it on an alarm until it exits. Everything its machinery fails at (no container, a lost
 * exec, a ladder that stops writing, an exit with no verdict file) is reported as infrastructure, never as a red row.
 */
import { DurableObject } from 'cloudflare:workers';
import { INSTANCE, LAUNCH, RECEIVE, SHELL_ENV, STATUS, USER, must, run } from './container';
import type { ShardTimes } from './contract';
import { packKey, type Env } from './env';

export interface ShardSpec {
  readonly runId: string;
  /** `plan`, or the CI part's name. */
  readonly name: string;
  readonly attempt: number;
  readonly sha: string;
  /** What the run's pack is relative to (`packKey`). */
  readonly base: string;
  readonly snapshot: string;
  /** The ladder's arguments after `bun scripts/ladder.ts`. */
  readonly argv: readonly string[];
  /** Where the run keeps the costs every piece of it plans from. */
  readonly costsKey: string;
}

type State = 'booting' | 'running' | 'done' | 'failed' | 'stopped';

const POLL_MS = 5_000;

/** A start that has not answered in this long is destroyed, and the run's one retry asks for another. */
const START_MS = 120_000;

const EXEC_MS = 90_000;

/** Three lost status reads in a row are a lost container, not a slow one. */
const POLL_FAILURES = 3;

/** A ladder whose log has not grown in this long has hung past every row's own deadline. */
const SILENT_MS = 20 * 60_000;

/** Longer than any run may take, so only the run's end stops the container. */
const INACTIVITY_MS = 90 * 60_000;

export interface PieceKeys {
  readonly output: string;
  readonly log: string;
}

/** The R2 keys of a piece's output and log. */
export function pieceKeys(runId: string, name: string, attempt: number): PieceKeys {
  const base = `runs/${runId}/${name}/attempt-${String(attempt + 1)}`;

  return { output: `${base}/${name === 'plan' ? 'plan' : 'verdicts'}.json`, log: `${base}/log.txt.gz` };
}

export class CiShard extends DurableObject<Env> {
  async begin(spec: ShardSpec): Promise<void> {
    await this.ctx.storage.put({ spec, state: 'booting' satisfies State, requested: Date.now(), pollFailures: 0, logSize: 0, grewAt: Date.now() });
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** The run ended or gave up on this piece: whatever it is doing stops. */
  async stop(): Promise<void> {
    await this.ctx.storage.put('state', 'stopped' satisfies State);
    await this.ctx.storage.deleteAlarm();
    // Stopping is the run's last word on this piece: a container that will not stop ends at its inactivity timeout.
    await Promise.allSettled([this.ctx.container?.destroy()]);
  }

  override async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<State>('state');
    const spec = await this.ctx.storage.get<ShardSpec>('spec');

    if (spec === undefined || (state !== 'booting' && state !== 'running')) return;
    const runner = this.env.CI_RUN.getByName(spec.runId);

    try {
      if (state === 'booting') await this.boot(spec);
      else if (await this.poll(spec)) return;
      await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
    } catch (cause) {
      if ((await this.ctx.storage.get<State>('state')) === 'stopped') return;
      await this.ctx.storage.put('state', 'failed' satisfies State);
      console.error(JSON.stringify({ shard: `${spec.runId}/${spec.name}/${String(spec.attempt)}`, state, error: String(cause) }));
      await Promise.allSettled([this.ctx.container?.destroy()]);
      await runner.failed(spec.name, spec.attempt, `${spec.name} attempt ${String(spec.attempt + 1)}: ${String(cause)}`);
    }
  }

  private container(): Container {
    if (this.ctx.container === undefined) throw new Error('CiShard has no container binding');

    return this.ctx.container;
  }

  private async boot(spec: ShardSpec): Promise<void> {
    const container = this.container();
    const requested = (await this.ctx.storage.get<number>('requested')) ?? Date.now();

    if (!container.running) container.start({ containerSnapshot: { id: spec.snapshot }, instance: INSTANCE, enableInternet: true, entrypoint: ['sleep', 'infinity'] });
    await container.setInactivityTimeout(INACTIVITY_MS);
    // A restored snapshot's hostname does not resolve until it is set (Dew 6ec7406a5).
    await must(container, 'the first exec', ['/bin/sh', '-c', 'hostname localhost; echo ready'], { ms: START_MS });
    const answered = Date.now();
    const pack = await this.env.ARTIFACTS.get(packKey(spec.sha, spec.base));
    const costs = await this.env.ARTIFACTS.get(spec.costsKey);

    if (pack === null || costs === null) throw new Error(`the pack of ${spec.sha} or the run's costs is not in R2`);
    const asUser = { user: USER, env: SHELL_ENV, ms: EXEC_MS };

    await must(container, 'the checkout', ['/bin/sh', '-c', RECEIVE, 'receive', spec.sha], { ...asUser, stdin: pack.body });
    await must(container, 'the costs', ['/bin/sh', '-c', 'cat > /ci/costs.json'], { ...asUser, stdin: costs.body });
    const received = Date.now();
    const out = spec.name === 'plan' ? '/ci/plan.json' : 'log';

    await must(container, 'the launch', ['/bin/sh', '-c', LAUNCH, 'launch', out, 'bun', 'scripts/ladder.ts', ...spec.argv], asUser);
    const times: ShardTimes = { requested, answered, received, launched: Date.now() };

    await this.ctx.storage.put({ state: 'running' satisfies State, times, grewAt: Date.now() });
    await this.env.CI_RUN.getByName(spec.runId).progress(spec.name, spec.attempt, 'launched');
  }

  /** True once the piece is finished and reported. */
  private async poll(spec: ShardSpec): Promise<boolean> {
    const container = this.container();

    if (!container.running) throw new Error('the container stopped before the ladder exited');
    const [read] = await Promise.allSettled([run(container, ['/bin/sh', '-c', STATUS], { user: USER, ms: EXEC_MS })]);
    const status = read.status === 'fulfilled' && read.value.exitCode === 0 ? read.value : null;

    // One lost exec is not a lost container.
    if (status === null) {
      const failures = ((await this.ctx.storage.get<number>('pollFailures')) ?? 0) + 1;

      if (failures >= POLL_FAILURES) throw new Error(`${String(failures)} status reads failed in a row`);
      await this.ctx.storage.put('pollFailures', failures);

      return false;
    }

    const [exit = '', size = '0', last = ''] = status.stdout.replace(/\n$/u, '').split('\t');

    await this.ctx.storage.put('pollFailures', 0);

    if (exit === '') {
      await this.watchSilence(Number(size));
      await this.env.CI_RUN.getByName(spec.runId).progress(spec.name, spec.attempt, last);

      return false;
    }

    return await this.collect(spec, Number(exit));
  }

  private async watchSilence(size: number): Promise<void> {
    const logSize = (await this.ctx.storage.get<number>('logSize')) ?? 0;
    const grewAt = (await this.ctx.storage.get<number>('grewAt')) ?? Date.now();

    if (size > logSize) await this.ctx.storage.put({ logSize: size, grewAt: Date.now() });
    else if (Date.now() - grewAt > SILENT_MS) throw new Error(`the ladder wrote nothing for ${String(SILENT_MS / 60_000)} min`);
  }

  private async collect(spec: ShardSpec, exitCode: number): Promise<boolean> {
    const container = this.container();
    const keys = pieceKeys(spec.runId, spec.name, spec.attempt);
    const asUser = { user: USER, ms: EXEC_MS };
    const log = await container.exec(['/bin/sh', '-c', 'gzip -c /ci/log'], { user: USER, signal: AbortSignal.timeout(EXEC_MS) });
    const zipped = await log.output();

    await this.env.ARTIFACTS.put(keys.log, zipped.stdout, { httpMetadata: { contentType: 'text/plain; charset=utf-8', contentEncoding: 'gzip' } });
    const output = await run(container, ['cat', spec.name === 'plan' ? '/ci/plan.json' : '/ci/verdicts.json'], asUser);

    // A ladder that exits without its verdict file did not grade the part: a crash, a refused preflight, a drift.
    if (output.exitCode !== 0 || output.stdout.trim() === '') throw new Error(`the ladder exited ${String(exitCode)} and wrote no ${spec.name === 'plan' ? 'plan' : 'verdict file'}`);
    await this.env.ARTIFACTS.put(keys.output, output.stdout, { httpMetadata: { contentType: 'application/json' } });
    const times = await this.ctx.storage.get<ShardTimes>('times');

    if (times === undefined) throw new Error('a launched piece has no boot times');
    await this.ctx.storage.put('state', 'done' satisfies State);
    await Promise.allSettled([container.destroy()]);
    await this.env.CI_RUN.getByName(spec.runId).finished(spec.name, spec.attempt, { exitCode, outputKey: keys.output, logKey: keys.log, times, finishedAt: Date.now() });

    return true;
  }
}
