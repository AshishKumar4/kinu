/**
 * One environment per set of install inputs (`environmentKey`): a container snapshot of Cloudflare's managed trixie
 * with the GitHub runner's tools, Chrome, and the tree's locked dependencies installed, from which every shard of
 * every run with those inputs starts. CiEnvironments is the account's one registry of them; CiPreparer, one per key,
 * builds one, a phase per alarm, as DEVBOX-DECISIONS D66's golden object builds the devbox's.
 */
import { DurableObject } from 'cloudflare:workers';
import { INSTALL, INSTANCE, LEAVE_INSTALLED, RECEIVE, SHELL_ENV, SYSTEM, USER, must } from './container';
import type { Generation } from './contract';
import { packKey, SINGLE, type Env } from './env';

type Entry =
  | { readonly state: 'preparing'; readonly sha: string; readonly since: number }
  | { readonly state: 'ready'; readonly generation: Generation; readonly lastUsed: number }
  | { readonly state: 'failed'; readonly sha: string; readonly at: number; readonly reason: string };

export type Readiness =
  | { readonly kind: 'ready'; readonly generation: Generation }
  | { readonly kind: 'preparing'; readonly since: number }
  | { readonly kind: 'failed'; readonly reason: string };

/** A preparation still unfinished after this was lost: the next run asks again. */
const LEASE_MS = 45 * 60_000;

/** A failed preparation is the answer for this long, so the runs waiting on it end; then it may be asked again. */
const FAILURE_HOLD_MS = 5 * 60_000;

export class CiEnvironments extends DurableObject<Env> {
  /** What a client packs a commit against: the environment's commit once there is one, else the commit's whole history. */
  async base(key: string): Promise<string> {
    const entry = await this.ctx.storage.get<Entry>(`env:${key}`);

    if (entry?.state === 'ready') return entry.generation.sha;

    return entry?.state === 'preparing' && Date.now() - entry.since < LEASE_MS ? entry.sha : 'root';
  }

  /** The key's environment, or its preparation begun from `sha`'s whole history, which only a `root` pack carries. */
  async ensure(key: string, sha: string, base: string, now = Date.now()): Promise<Readiness> {
    const entry = await this.ctx.storage.get<Entry>(`env:${key}`);

    if (entry?.state === 'ready') {
      await this.ctx.storage.put(`env:${key}`, { ...entry, lastUsed: now } satisfies Entry);

      return { kind: 'ready', generation: entry.generation };
    }

    if (entry?.state === 'preparing' && now - entry.since < LEASE_MS) return { kind: 'preparing', since: entry.since };

    if (entry?.state === 'failed' && now - entry.at < FAILURE_HOLD_MS) return { kind: 'failed', reason: entry.reason };

    if (base !== 'root') return { kind: 'failed', reason: 'the environment this run was packed against is gone; run again, which packs the whole history' };
    await this.ctx.storage.put(`env:${key}`, { state: 'preparing', sha, since: now } satisfies Entry);
    await this.env.CI_PREPARER.getByName(key).begin(key, sha);

    return { kind: 'preparing', since: now };
  }

  async prepared(generation: Generation): Promise<void> {
    await this.ctx.storage.put(`env:${generation.key}`, { state: 'ready', generation, lastUsed: Date.now() } satisfies Entry);
  }

  async preparationFailed(key: string, sha: string, reason: string): Promise<void> {
    await this.ctx.storage.put(`env:${key}`, { state: 'failed', sha, at: Date.now(), reason } satisfies Entry);
  }

  async list(): Promise<{ key: string; entry: Entry }[]> {
    const entries = await this.ctx.storage.list<Entry>({ prefix: 'env:' });

    return [...entries].map(([name, entry]) => ({ key: name.slice('env:'.length), entry }));
  }

  /** After `ci-remote.ts --prune` deleted its snapshot: the next run with these inputs prepares again. */
  async forget(key: string): Promise<void> {
    await this.ctx.storage.delete(`env:${key}`);
  }
}

type Phase = 'system' | 'install' | 'snapshot' | 'verify';

interface Preparation {
  readonly key: string;
  readonly sha: string;
  readonly phase: Phase;
  readonly seconds: Record<string, number>;
  readonly versions: string;
  readonly snapshot: Generation['snapshot'] | null;
}

/** An exec's bound inside one alarm, which the platform ends at 15 minutes. */
const STEP_MS = 12 * 60_000;

export class CiPreparer extends DurableObject<Env> {
  async begin(key: string, sha: string): Promise<void> {
    if (this.ctx.container?.running) await this.ctx.container.destroy();
    await this.ctx.storage.put('preparation', { key, sha, phase: 'system', seconds: {}, versions: '', snapshot: null } satisfies Preparation);
    await this.ctx.storage.setAlarm(Date.now());
  }

  override async alarm(): Promise<void> {
    const preparation = await this.ctx.storage.get<Preparation>('preparation');

    if (preparation === undefined) return;
    const began = Date.now();

    try {
      const next = await this.step(preparation);
      const seconds = { ...preparation.seconds, [preparation.phase]: (Date.now() - began) / 1000 };

      if (next === null) return;
      await this.ctx.storage.put('preparation', { ...preparation, ...next, seconds } satisfies Preparation);
      await this.ctx.storage.setAlarm(Date.now());
    } catch (cause) {
      await this.ctx.storage.delete('preparation');
      // The preparation failed already; a container that will not stop either ends at its inactivity timeout.
      await Promise.allSettled([this.ctx.container?.destroy()]);
      console.error(JSON.stringify({ preparation: preparation.key, phase: preparation.phase, error: String(cause) }));
      await this.registry().preparationFailed(preparation.key, preparation.sha, `${preparation.phase}: ${String(cause)}`);
    }
  }

  /** One phase; the next phase's changes, or null once the registry holds the environment. */
  private async step(preparation: Preparation): Promise<Partial<Preparation> | null> {
    const container = this.container();
    const asUser = { user: USER, env: SHELL_ENV, ms: STEP_MS };

    if (preparation.phase === 'system') {
      container.start({ image: 'cloudflare/debian-trixie', instance: INSTANCE, enableInternet: true, entrypoint: ['sleep', 'infinity'] });
      await container.setInactivityTimeout(LEASE_MS);
      await must(container, 'the system tools', ['/bin/sh', '-c', SYSTEM], { ms: STEP_MS });

      return { phase: 'install' };
    }

    if (preparation.phase === 'install') {
      const pack = await this.env.ARTIFACTS.get(packKey(preparation.sha, 'root'));

      if (pack === null) throw new Error(`the pack of ${preparation.sha} is not in R2`);
      await must(container, 'the checkout', ['/bin/sh', '-c', RECEIVE, 'receive', preparation.sha], { ...asUser, stdin: pack.body });
      const installed = await must(container, 'the install', ['/bin/sh', '-c', INSTALL], asUser);

      await must(container, 'clearing the tree', ['/bin/sh', '-c', LEAVE_INSTALLED], asUser);

      return { phase: 'snapshot', versions: installed.stdout.split('\n').filter((line) => line.trim() !== '').slice(-4).join('; ') };
    }

    if (preparation.phase === 'snapshot') {
      const snapshot = await container.snapshotContainer({ name: `kinu-ci-${preparation.key.slice(0, 24)}` });

      await container.destroy();

      return { phase: 'verify', snapshot };
    }

    if (preparation.snapshot === null) throw new Error('verifying a preparation that has no snapshot');
    // A snapshot that does not start, or starts without its install, is no environment.
    container.start({ containerSnapshot: { id: preparation.snapshot.id }, instance: INSTANCE, enableInternet: true, entrypoint: ['sleep', 'infinity'] });
    await must(container, 'the restored install', ['/bin/sh', '-c', 'cd /work && git rev-parse HEAD && node_modules/.bin/bun --version && google-chrome --version'], asUser);
    await container.destroy();
    await this.ctx.storage.delete('preparation');
    await this.registry().prepared({
      key: preparation.key, snapshot: preparation.snapshot, sha: preparation.sha, created: Date.now(), seconds: preparation.seconds, versions: preparation.versions,
    });

    return null;
  }

  private container(): Container {
    if (this.ctx.container === undefined) throw new Error('CiPreparer has no container binding');

    return this.ctx.container;
  }

  private registry() {
    return this.env.CI_ENVIRONMENTS.getByName(SINGLE);
  }
}
