/**
 * A workspace's running slates: one process per authored tree per caller, and one durable application per slate, each
 * keyed by what its build read. Which source a slate is, how it compiles and how a process starts are the backend's
 * ports; which process serves a call, when a build is stale, which image a broken source serves and which processes a
 * change or a removal ends are decided here.
 */
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { Effect } from 'effect';
import { KinuError } from '../obs/error';
import { settle } from '../obs/effect';
import { SLATES_ROOT } from '../vfs/workspace-path';
import { ephemeralSlateAddress } from './ui-blocks';
import { slateImage, type SlateBuildFailure, type SlateBuilds, type SlateImage } from './builds';
import { slateAuthority } from './authority';
import { slateCallerKey, type SlateCaller } from './caller';
import type { DurableAppIdentity, DurableApps } from './durable-app';
import type { EphemeralSlates } from './ephemeral';
import type { SlateProcess } from './process';
import type { SlateProject } from './project';

/** Where a slate comes from, as far as running it goes: its directory, or a stored answer's page run as its author. */
export type RunnableSlateSource =
  | { readonly kind: 'files'; readonly project: SlateProject; readonly root: string }
  | { readonly kind: 'message'; readonly project: SlateProject; readonly root: string; readonly author: SlateCaller; readonly html: string };

/** What a process is started from: the slate, the caller it runs for, its image, and the application it serves. */
export interface SlateLaunch<Source> {
  readonly key: string;
  readonly id: string;
  readonly caller: SlateCaller;
  readonly source: Source;
  readonly image: SlateImage;
  readonly app: DurableAppIdentity | null;
}

export interface SlateProcessPorts<Source extends RunnableSlateSource, Process extends SlateProcess> {
  readonly workspace: string;
  readonly builds: SlateBuilds;
  readonly pages: EphemeralSlates;
  readonly apps: DurableApps;
  resolve(cred: VfsCred, id: string): Promise<Source>;
  /** What tells one build of the source from another: its tree's digest, or its block's. */
  digest(cred: VfsCred, id: string, source: Source): Promise<string>;
  build(caller: SlateCaller, id: string, source: Source): Promise<SlateImage | SlateBuildFailure>;
  launch(launch: SlateLaunch<Source>): Promise<Process>;
  /** A process held under `held` ended: what it held for its callers ends with it. */
  ended?(held: string): void;
}

export interface RunningSlate<Source, Process> {
  readonly key: string;
  /** The source digest its image was built from: the last that built, while `broken` says why a newer one did not. */
  readonly built: string;
  readonly broken: string | null;
  readonly revision: number;
  readonly caller: SlateCaller;
  readonly id: string;
  readonly source: Source;
  readonly process: Process;
  readonly app: DurableAppIdentity | null;
}

/** Answers' pages that keep a process and a reservation at once; drawing another retires the least recently drawn. */
const EPHEMERAL_SLATES_KEPT = 16;

const SLATE_FILE = new RegExp(`^${SLATES_ROOT}/([^/]+)(?:/|$)`);

/**
 * The key a slate's process is held under: one per caller for a directory slate, and one per answer's page, whose
 * author's mode is read at each call rather than fixed by the process.
 */
export function heldSlateKey(caller: SlateCaller, id: string): string {
  return ephemeralSlateAddress(id) === null ? `${slateCallerKey(caller)}#${id}` : `page#${id}`;
}

export class SlateProcesses<Source extends RunnableSlateSource, Process extends SlateProcess> {
  private readonly running = new Map<string, RunningSlate<Source, Process>>();
  private readonly starting = new Map<string, Promise<RunningSlate<Source, Process>>>();
  private readonly revisions = new Map<string, number>();

  constructor(private readonly ports: SlateProcessPorts<Source, Process>) {}

  /** The process serving `viewer`'s calls to `id`: a stored answer's page runs as its author, whoever looks at it. */
  async booted(viewer: SlateCaller, id: string): Promise<RunningSlate<Source, Process>> {
    const source = await this.ports.resolve(viewer.cred, id);
    const caller = source.kind === 'message' ? source.author : viewer;
    const held = heldSlateKey(caller, id);
    const starting = this.starting.get(held);

    if (starting !== undefined) return await starting;
    const boot = this.boot(caller, id, held, source).finally(() => { this.starting.delete(held); });
    this.starting.set(held, boot);

    return await boot;
  }

  /** The slate's durable application, run as the workspace root. */
  served(root: SlateCaller, id: string): Promise<RunningSlate<Source, Process> & { readonly app: DurableAppIdentity }> {
    return settle(Effect.gen({ self: this }, function* () {
      const running = yield* Effect.promise(async () => this.booted(root, id));

      if (running.app === null) return yield* new KinuError('io', `Slate ${id} is running without its durable application`);

      return { ...running, app: running.app };
    }));
  }

  /** The process holding `port`, and the key it is held under. */
  onPort(port: number): { readonly held: string; readonly id: string } | null {
    for (const [held, running] of this.running) {
      if (running.app?.port === port) return { held, id: running.id };
    }

    return null;
  }

  /** Ends every process `ending` names; what their callers hold stays, to be refused as the slate or share now is. */
  async stopWhere(ending: (running: RunningSlate<Source, Process>) => boolean): Promise<void> {
    for (const [held, running] of this.running) {
      if (!ending(running)) continue;
      this.running.delete(held);
      await running.process.stop();
    }
  }

  /**
   * Which slates `paths` changed: their own files, or anything outside their trees a build of theirs looked at, another
   * slate's files among them. Each one's next boot builds again, and its latest failure is no longer known to stand.
   */
  filesChanged(paths: readonly string[]): string[] {
    const absolute = paths.map((path) => (path.startsWith('/') ? path : `/${path}`));
    const own = absolute.flatMap((path) => SLATE_FILE.exec(path)?.[1] ?? []);
    const ids = new Set([...own, ...this.ports.builds.moved(absolute)]);

    for (const id of ids) this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);

    this.ports.builds.changed([...new Set(own)]);

    return [...ids];
  }

  private async boot(caller: SlateCaller, id: string, held: string, resolved: Source): Promise<RunningSlate<Source, Process>> {
    for (let source = resolved; ; source = await this.ports.resolve(caller.cred, id)) {
      const revision = this.revisions.get(id) ?? 0;
      // The loader evaluates boot options only on a cache miss. This identity
      // must not reuse an image created before outbound mediation was supplied.
      // What the build looked at outside its tree moves its generation, durably and per authority.
      const digest = `${await this.ports.digest(caller.cred, id, source)}:${String(this.ports.builds.generation(id, slateAuthority(caller.cred)))}`;
      const key = `slate:mediated:${this.ports.workspace}:${held}:${digest}`;
      const running = this.running.get(held);

      if (running?.key === key && await running.process.isRunning()) {
        const refreshed = { ...running, revision };
        this.running.set(held, refreshed);

        return refreshed;
      }

      // A source that does not compile ships nothing: the slate keeps the last build that did, and says why.
      const { image, key: built, broken } = await slateImage({
        builds: this.ports.builds, slate: id, key: digest, cred: caller.cred, build: () => this.ports.build(caller, id, source),
      });

      if (running !== undefined && running.built === built && await running.process.isRunning()) {
        const kept = { ...running, revision, broken };
        this.running.set(held, kept);

        return kept;
      }

      await this.stopHeld(held);

      if (source.kind === 'message') await this.keepPage(id);

      // Only the root's build process is the durable application; shares and Plan roots are private and must never
      // attach to its facet. A block is only ever seen through its preview, so it always has one.
      const app = source.kind === 'message' || (caller.share === undefined && caller.path.length === 0 && caller.workMode === 'build')
        ? await this.ports.apps.ensure({ owner: id, preferredPort: source.project.slate.port })
        : null;

      const process = await this.ports.launch({ key, id, caller, source, image, app });

      if ((this.revisions.get(id) ?? 0) !== revision) {
        await process.stop();
        continue;
      }

      const started = { key, built, broken, revision, caller, id, source, process, app };
      this.running.set(held, started);

      return started;
    }
  }

  /** Ends a process this host started, and what it held. */
  private async stopHeld(held: string): Promise<void> {
    const running = this.running.get(held);

    if (running === undefined) return;
    this.running.delete(held);
    await running.process.stop();
    this.ports.ended?.(held);
  }

  /** Only the answers' pages drawn most recently keep a process: the rest give up their process and reservation, and are
   *  booted again if drawn again. */
  private async keepPage(id: string): Promise<void> {
    for (const retired of this.ports.pages.drawn(id, Date.now(), EPHEMERAL_SLATES_KEPT)) {
      for (const [held, running] of this.running) {
        if (running.id === retired) await this.stopHeld(held);
      }

      await this.ports.apps.remove(retired);
    }
  }
}
