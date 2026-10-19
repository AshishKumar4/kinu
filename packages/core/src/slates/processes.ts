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
  readonly caller: SlateCaller;
  readonly id: string;
  readonly source: Source;
  readonly process: Process;
  readonly app: DurableAppIdentity | null;
}

/** Answers' pages that keep a process and a reservation at once; drawing another retires the least recently drawn. */
const EPHEMERAL_SLATES_KEPT = 16;

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
  /** The paths changed while each build in flight ran, in one set per build. */
  private readonly building = new Set<Set<string>>();

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

  /**
   * Whether `id` builds for `viewer` as its source stands now: its image built, or its last that built kept and the
   * compiler's words for why the newer one did not. Never a process started or stopped: a write the slate's own call
   * makes into its tree is checked here while that call still waits on the write, so restarting the slate would end
   * the very call that made the edit. Its next call, or its preview's next load, boots the build this one made.
   */
  async built(viewer: SlateCaller, id: string): Promise<{ readonly broken: string | null }> {
    const source = await this.ports.resolve(viewer.cred, id);
    const caller = source.kind === 'message' ? source.author : viewer;
    const { imaged } = await this.imaged(caller, id, source);

    return { broken: imaged.broken };
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
  onPort(port: number): { readonly held: string; readonly id: string; readonly process: Process } | null {
    for (const [held, running] of this.running) {
      if (running.app?.port === port) return { held, id: running.id, process: running.process };
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
    const ids = this.ports.builds.filesChanged(absolute);

    for (const changed of this.building) for (const path of absolute) changed.add(path);

    for (const id of ids) this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);

    return ids;
  }

  /**
   * `id`'s image for `caller` from its source as it stands, built where no build of that source and generation is kept:
   * the source it was read from, its digest, and the image (or the last that built, and why the newer did not). Built
   * again while something it read moves during the compile.
   */
  private async imaged(caller: SlateCaller, id: string, resolved: Source)
    : Promise<{ readonly source: Source; readonly digest: string; readonly imaged: { readonly image: SlateImage; readonly key: string; readonly broken: string | null } }> {
    for (let source = resolved; ; source = await this.ports.resolve(caller.cred, id)) {
      const digest = await this.digestOf(caller, id, source);
      const changed = new Set<string>();

      this.building.add(changed);

      // A source that does not compile ships nothing: the slate keeps the last build that did, and says why.
      const imaged = await slateImage({
        builds: this.ports.builds, slate: id, key: digest, cred: caller.cred, build: () => this.ports.build(caller, id, source),
        changed: () => [...changed],
      }).finally(() => { this.building.delete(changed); });

      // Something it read moved while it compiled: built again, under the generation that move gave it.
      if (imaged !== null) return { source, digest, imaged };
    }
  }

  /**
   * What `id`'s image for `caller` is keyed by: its source's digest and the generation of what its builds looked at. The
   * loader evaluates boot options only on a cache miss, so this identity must not reuse an image created before outbound
   * mediation was supplied; what the build looked at outside its tree moves its generation, durably and per authority.
   */
  private async digestOf(caller: SlateCaller, id: string, source: Source): Promise<string> {
    return `${await this.ports.digest(caller.cred, id, source)}:${String(this.ports.builds.generation(id, slateAuthority(caller.cred)))}`;
  }

  private async boot(caller: SlateCaller, id: string, held: string, resolved: Source): Promise<RunningSlate<Source, Process>> {
    const keyOf = (digest: string) => `slate:mediated:${this.ports.workspace}:${held}:${digest}`;

    for (let read = resolved; ; read = await this.ports.resolve(caller.cred, id)) {
      const revision = this.revisions.get(id) ?? 0;
      const running = this.running.get(held);

      if (running?.key === keyOf(await this.digestOf(caller, id, read)) && await running.process.isRunning()) return running;
      const { source, digest, imaged } = await this.imaged(caller, id, read);
      const key = keyOf(digest);
      const { image, key: built, broken } = imaged;

      if (running !== undefined && running.built === built && await running.process.isRunning()) {
        const kept = { ...running, broken };
        this.running.set(held, kept);

        return kept;
      }

      await this.stopHeld(held);

      if (source.kind === 'message') await this.keepPage(id);

      // Only the root's build process is the durable application; shares and Plan roots are private and must never
      // attach to its facet. A block is only ever seen through its preview, so it always has one.
      const app = source.kind === 'message' || (caller.share === undefined && caller.via === undefined && caller.path.length === 0 && caller.workMode === 'build')
        ? await this.ports.apps.ensure({ owner: id, preferredPort: source.project.slate.port })
        : null;

      const process = await this.ports.launch({ key, id, caller, source, image, app });

      if ((this.revisions.get(id) ?? 0) !== revision) {
        await process.stop();
        continue;
      }

      const started = { key, built, broken, caller, id, source, process, app };
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
