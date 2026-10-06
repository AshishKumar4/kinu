/**
 * CiRun: the CI tier of one commit on containers. It waits for the commit's environment (CiEnvironments), has the
 * commit's own ladder cut the plan (a `plan` piece), starts one CiShard per CI part, retries a piece once when the
 * infrastructure failed it and never when a row was red, and settles once every part has an answer. Grading is
 * `scripts/ci-remote.ts`'s, with `scripts/ci-verdicts.ts`, the code GitHub's collect job runs: every planned row
 * exactly once, every file of a split suite exactly once. The state here only says what to fetch and what broke.
 *
 * Concurrency: storage keeps the input gate shut, an RPC or R2 call opens it. So a method decides from storage,
 * writes, then calls out, and reads storage again before writing after a call out.
 */
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import {
  environmentKey, PlanSchema, type Generation, type Phase, type PieceRow, type RunSpec, type RunStatus, type ShardResult, type StartRequest,
} from './contract';
import { SINGLE, type Env } from './env';
import { pieceKeys, type PieceKeys } from './shard';

const WATCHDOG_MS = 10_000;

/** A booting piece includes its container's start and the checkout; a running one reports every few seconds. */
const STALL_MS = { booting: 10 * 60_000, running: 25 * 60_000 } as const;

const RUN_DEADLINE_MS = 75 * 60_000;

const INFRA_ATTEMPTS = 2;

const row = (name: string, attempt: number, errors: string[]): PieceRow => ({
  name, attempt, state: 'booting', updatedAt: Date.now(), errors, progress: '', result: null,
});

const live = (piece: PieceRow | undefined): piece is PieceRow => piece !== undefined && (piece.state === 'booting' || piece.state === 'running');

export class CiRun extends DurableObject<Env> {
  async create(request: StartRequest & { readonly runId: string }): Promise<void> {
    if (await this.ctx.storage.get('spec')) throw new Error(`run ${request.runId} exists`);
    const spec: RunSpec = { ...request, key: await environmentKey(request.manifest), createdAt: Date.now() };

    await this.ctx.storage.put({ spec, phase: 'preparing' satisfies Phase, problems: [], parts: [] });
    await this.ctx.storage.setAlarm(Date.now());
  }

  override async alarm(): Promise<void> {
    const spec = await this.ctx.storage.get<RunSpec>('spec');
    const phase = await this.ctx.storage.get<Phase>('phase');

    if (spec === undefined || phase === undefined || phase === 'settling' || phase === 'done') return;

    if (Date.now() - spec.createdAt > RUN_DEADLINE_MS) return await this.cancel(`the run passed its ${String(RUN_DEADLINE_MS / 60_000)} min deadline`);

    if (phase === 'preparing') await this.awaitEnvironment(spec);
    else await this.watch(spec);

    if (!['settling', 'done'].includes((await this.ctx.storage.get<Phase>('phase')) ?? 'done')) await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
  }

  private async awaitEnvironment(spec: RunSpec): Promise<void> {
    const readiness = await this.env.CI_ENVIRONMENTS.getByName(SINGLE).ensure(spec.key, spec.sha, spec.base);

    if ((await this.ctx.storage.get<Phase>('phase')) !== 'preparing') return;

    if (readiness.kind === 'failed') return await this.cancel(`the environment ${spec.key.slice(0, 12)} could not be prepared: ${readiness.reason}`);

    if (readiness.kind === 'preparing') return;

    if (spec.base !== 'root' && spec.base !== readiness.generation.sha) {
      return await this.cancel(`the environment was rebuilt from ${readiness.generation.sha.slice(0, 10)} after this run was packed against ${spec.base.slice(0, 10)}; run again`);
    }

    const costs = await this.env.CI_TIMINGS.getByName(SINGLE).costs(spec.sha);

    await this.env.ARTIFACTS.put(this.costsKey(spec), JSON.stringify(costs));
    await this.ctx.storage.put({ phase: 'planning' satisfies Phase, environment: readiness.generation, plan: row('plan', 0, []) });
    await this.begin(spec, 'plan', 0);
  }

  private costsKey(spec: RunSpec): string {
    return `runs/${spec.runId}/costs.json`;
  }

  private argv(spec: RunSpec, name: string, width: number): string[] {
    const costs = '--ci-costs=/ci/costs.json';

    return name === 'plan'
      ? ['--ci-plan', `--ci-target=${String(spec.target)}`, costs]
      : ['--tier=ci', `--ci-part=${name}`, `--ci-width=${String(width)}`, costs, '--verdicts=/ci/verdicts.json'];
  }

  /** Start attempt `attempt` of a piece whose row is written already. */
  private async begin(spec: RunSpec, name: string, attempt: number): Promise<void> {
    const environment = await this.ctx.storage.get<Generation>('environment');
    const width = (await this.ctx.storage.get<number>('width')) ?? 0;

    try {
      if (environment === undefined) throw new Error('no environment to start from');
      await this.env.CI_SHARD.getByName(`${spec.runId}/${name}/${String(attempt)}`).begin({
        runId: spec.runId, name, attempt, sha: spec.sha, base: spec.base, snapshot: environment.snapshot.id, argv: this.argv(spec, name, width), costsKey: this.costsKey(spec),
      });
    } catch (cause) {
      await this.failed(name, attempt, `${name} attempt ${String(attempt + 1)} could not start: ${String(cause)}`);
    }
  }

  private async piece(name: string): Promise<PieceRow | undefined> {
    return await this.ctx.storage.get<PieceRow>(name === 'plan' ? 'plan' : `part:${name}`);
  }

  private async putPiece(piece: PieceRow): Promise<void> {
    await this.ctx.storage.put(piece.name === 'plan' ? 'plan' : `part:${piece.name}`, piece);
  }

  /** The piece's row while attempt `attempt` of it may still report, else undefined. */
  private async current(name: string, attempt: number): Promise<PieceRow | undefined> {
    const piece = await this.piece(name);
    const phase = await this.ctx.storage.get<Phase>('phase');

    return live(piece) && piece.attempt === attempt && (phase === 'planning' || phase === 'running') ? piece : undefined;
  }

  async progress(name: string, attempt: number, progress: string): Promise<void> {
    const piece = await this.current(name, attempt);

    if (piece !== undefined) await this.putPiece({ ...piece, state: 'running', progress: progress === '' ? piece.progress : progress, updatedAt: Date.now() });
  }

  async finished(name: string, attempt: number, result: ShardResult): Promise<void> {
    const spec = await this.ctx.storage.get<RunSpec>('spec');
    const piece = await this.current(name, attempt);

    if (spec === undefined || piece === undefined) return;

    if (name !== 'plan') {
      await this.putPiece({ ...piece, state: 'done', result, updatedAt: Date.now() });

      return await this.settle(spec);
    }

    const object = await this.env.ARTIFACTS.get(result.outputKey);
    const plan = object === null ? undefined : v.safeParse(PlanSchema, await object.json());

    if (plan?.success !== true) return await this.failed(name, attempt, 'the plan piece wrote no readable plan');

    // The read let other calls in: the plan may have been retried or the run cancelled meanwhile.
    if ((await this.current(name, attempt)) === undefined) return;
    const names = plan.output.parts.map((part) => part.name);

    await this.ctx.storage.put({ phase: 'running' satisfies Phase, width: plan.output.width, parts: names, planKey: result.outputKey });
    await this.putPiece({ ...piece, state: 'done', result, updatedAt: Date.now() });

    for (const part of names) await this.putPiece(row(part, 0, []));
    await Promise.all(names.map(async (part) => await this.begin(spec, part, 0)));
  }

  async failed(name: string, attempt: number, error: string): Promise<void> {
    const spec = await this.ctx.storage.get<RunSpec>('spec');
    const piece = await this.current(name, attempt);

    if (spec === undefined || piece === undefined) return;
    const errors = [...piece.errors, error];

    if (attempt + 1 < INFRA_ATTEMPTS) {
      await this.putPiece(row(name, attempt + 1, errors));

      return await this.begin(spec, name, attempt + 1);
    }

    await this.putPiece({ ...piece, state: 'infra-failed', errors, updatedAt: Date.now() });

    if (name === 'plan') return await this.cancel(`the plan failed twice: ${errors.join(' | ')}`);
    await this.settle(spec);
  }

  async cancel(reason: string): Promise<void> {
    const spec = await this.ctx.storage.get<RunSpec>('spec');
    const phase = await this.ctx.storage.get<Phase>('phase');

    if (spec === undefined || phase === 'settling' || phase === 'done') return;
    // Every unfinished piece is stopped in storage before anything is called: a report arriving meanwhile finds it so.
    const stopping: PieceRow[] = [];

    for (const piece of [await this.piece('plan'), ...await this.partRows()]) {
      if (!live(piece)) continue;
      await this.putPiece({ ...piece, state: 'stopped', updatedAt: Date.now() });
      stopping.push(piece);
    }

    await this.ctx.storage.put('problems', [...(await this.ctx.storage.get<string[]>('problems')) ?? [], reason]);
    await this.conclude('error');
    // The run is concluded already; a piece that cannot be told ends at its container's inactivity timeout.
    await Promise.allSettled(stopping.map(async (piece) => await this.env.CI_SHARD.getByName(`${spec.runId}/${piece.name}/${String(piece.attempt)}`).stop()));
  }

  private async partRows(): Promise<PieceRow[]> {
    const names = (await this.ctx.storage.get<string[]>('parts')) ?? [];
    const rows = await Promise.all(names.map(async (name) => await this.piece(name)));

    return rows.filter((piece): piece is PieceRow => piece !== undefined);
  }

  private async watch(spec: RunSpec): Promise<void> {
    for (const piece of [await this.piece('plan'), ...await this.partRows()]) {
      if (!live(piece) || Date.now() - piece.updatedAt <= STALL_MS[piece.state === 'booting' ? 'booting' : 'running']) continue;
      await Promise.allSettled([this.env.CI_SHARD.getByName(`${spec.runId}/${piece.name}/${String(piece.attempt)}`).stop()]);
      await this.failed(piece.name, piece.attempt, `${piece.name} attempt ${String(piece.attempt + 1)}: no progress for ${String((Date.now() - piece.updatedAt) / 60_000 | 0)} min while ${piece.state}`);
    }
  }

  /** Once every part has an answer. */
  private async settle(spec: RunSpec): Promise<void> {
    const parts = await this.partRows();

    if ((await this.ctx.storage.get<Phase>('phase')) !== 'running' || parts.some(live)) return;
    const broken = parts.filter((piece) => piece.state !== 'done');

    if (broken.length > 0) {
      const problems = (await this.ctx.storage.get<string[]>('problems')) ?? [];

      await this.ctx.storage.put('problems', [...problems, ...broken.map((piece) => `${piece.name}: ${piece.state}: ${piece.errors.join(' | ')}`)]);
    }

    let verdict: 'pass' | 'fail' | 'error' = parts.some((piece) => piece.result?.exitCode !== 0) ? 'fail' : 'pass';

    if (broken.length > 0) verdict = 'error';
    await this.conclude(verdict);
    await this.ctx.storage.put('reportKey', `runs/${spec.runId}/status.json`);
    await this.env.ARTIFACTS.put(`runs/${spec.runId}/status.json`, JSON.stringify(await this.status()));
  }

  private async conclude(verdict: 'pass' | 'fail' | 'error'): Promise<void> {
    await this.ctx.storage.put({ phase: 'done' satisfies Phase, verdict, finishedAt: Date.now() });
    await this.ctx.storage.deleteAlarm();
  }

  async status(): Promise<RunStatus | null> {
    const spec = await this.ctx.storage.get<RunSpec>('spec');

    if (spec === undefined) return null;

    return {
      spec,
      phase: (await this.ctx.storage.get<Phase>('phase')) ?? 'done',
      verdict: (await this.ctx.storage.get<RunStatus['verdict']>('verdict')) ?? null,
      problems: (await this.ctx.storage.get<string[]>('problems')) ?? [],
      environment: (await this.ctx.storage.get<Generation>('environment')) ?? null,
      plan: (await this.piece('plan')) ?? null,
      parts: await this.partRows(),
      finishedAt: (await this.ctx.storage.get<number>('finishedAt')) ?? null,
    };
  }

  /** The R2 keys a client fetches a part's verdict file and log from. */
  async keys(name: string): Promise<PieceKeys | null> {
    const spec = await this.ctx.storage.get<RunSpec>('spec');
    const piece = await this.piece(name);

    return spec === undefined || piece === undefined ? null : pieceKeys(spec.runId, name, piece.attempt);
  }
}
