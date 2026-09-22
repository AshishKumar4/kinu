/** References: `root://path`, naming which plane a path is on. `local` is the CLI's alias of its workspace. */
import { EXECUTOR_MOUNTS, RESERVED_REFERENCE_ROOTS } from './mounts';

export interface ReferenceRoot {
  /** The name before `://`. */
  readonly root: string;
  /** Mount in the composite plane: `/`, `/sandbox`, `/pc/<segment>`. */
  readonly mount: string;
}

/** `local` appears only where the caller says the workspace is the machine (the CLI). */
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

/** Longest prefixing mount wins; `local` is preferred over `vfs` when both are live. */
export function formatReference(mountPath: string, roots: readonly ReferenceRoot[]): string {
  const normalized = mountPath.startsWith('/') ? mountPath : `/${mountPath}`;

  const serving = [...roots]
    .filter((root) => root.mount === '/' || normalized === root.mount || normalized.startsWith(`${root.mount}/`))
    .sort((a, b) => b.mount.length - a.mount.length || Number(b.root === 'local') - Number(a.root === 'local'))[0]
    ?? { root: 'vfs', mount: '/' };

  const rest = serving.mount === '/' ? normalized : normalized.slice(serving.mount.length);

  return `${serving.root}://${rest.replace(/^\/+/u, '')}`;
}
