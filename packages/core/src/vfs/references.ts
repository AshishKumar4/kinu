/**
 * References: `root://path`, the way a file is named in anything a person
 * reads. A path is what a command takes; a reference says which plane the
 * path is on, so a reader with two machines and a container knows which
 * `/home/dev/a.txt` is meant.
 *
 * One grammar over the mount table: the root names a plane, the path is that
 * plane's own absolute path. `vfs` is the workspace filesystem (mounted at
 * `/`), `sandbox` the bound container (`/sandbox`), each machine its mount
 * segment (`/pc/<segment>`), and `local` the CLI's alias of its own workspace
 * — the machine IS the workspace there. The parse/format pair is total over
 * the live table: a root that names no live plane parses to nothing, and a
 * mounted path always formats to the reference of the plane that serves it.
 */
import { EXECUTOR_MOUNTS, RESERVED_REFERENCE_ROOTS } from './mounts';

export interface ReferenceRoot {
  /** The name before `://`. */
  readonly root: string;
  /** Where that plane sits in the composite file plane: `/` for the
   *  workspace, `/sandbox`, `/pc/<segment>`. */
  readonly mount: string;
}

/** The live table's roots, from what is mounted right now. `local` appears
 *  only where the caller says the workspace is the machine (the CLI). */
export function referenceRoots(input: {
  readonly devices: readonly string[];
  readonly sandbox: boolean;
  readonly local: boolean;
}): ReferenceRoot[] {
  const roots: ReferenceRoot[] = [{ root: 'vfs', mount: '/' }];

  if (input.local) roots.push({ root: 'local', mount: '/' });

  if (input.sandbox) roots.push({ root: 'sandbox', mount: EXECUTOR_MOUNTS.sandbox });

  for (const segment of input.devices) {
    if (!RESERVED_REFERENCE_ROOTS.includes(segment)) roots.push({ root: segment, mount: `${EXECUTOR_MOUNTS.device}/${segment}` });
  }

  return roots;
}

/** The reference of a composite-plane path, by the plane that serves it:
 *  the longest mount that prefixes the path wins, so `/pc/studio/x` is the
 *  machine's and `/pc` alone is nobody's file. The workspace root serves
 *  everything else. `local` is preferred over `vfs` where both are live,
 *  because that is the name the CLI's reader knows the directory by. */
export function formatReference(mountPath: string, roots: readonly ReferenceRoot[]): string {
  const normalized = mountPath.startsWith('/') ? mountPath : `/${mountPath}`;

  const serving = [...roots]
    .filter((root) => root.mount === '/' || normalized === root.mount || normalized.startsWith(`${root.mount}/`))
    .sort((a, b) => b.mount.length - a.mount.length || Number(b.root === 'local') - Number(a.root === 'local'))[0]
    ?? { root: 'vfs', mount: '/' };

  const rest = serving.mount === '/' ? normalized : normalized.slice(serving.mount.length);

  return `${serving.root}://${rest.replace(/^\/+/u, '')}`;
}
