// The pinned tools tarball (D65, D78): an offline apt repository and our binaries, built on armada by block-lower's tools-setup.sh and tools-build.sh.
import { shellPath } from './stream-archive';

export const TOOLS_STAMP = '/usr/local/lib/devbox/tools-installed';

/** The sha256 of every file the installed tools put under /usr, as the tarball ships it (`tools-build.sh`). */
export const TOOLS_MANIFEST = '/usr/local/lib/devbox/tools.sha256';

/** Present from a full install's extraction to its stamp: the extracted manifest names tools apt has not yet installed,
 *  so a refresh that finds it installs whole again. */
export const TOOLS_INSTALLING = '/usr/local/lib/devbox/tools-installing';

const REPO = '/usr/local/lib/devbox/debs';

/** Where a start stages the changed tools files, each under its sha256, and the pin's manifest as `manifest`. */
export const TOOLS_STAGED = '/tmp/devbox-tools-files';

/** A pin's manifest in the store, beside its tarball (one part, as `pipeParts` reads it). */
export const toolsManifestKey = (pin: string): string => `devbox-tools/${pin}.sha256`;

/** One tools file in the store, by its sha256, whichever pin ships it (one part). */
export const toolsFileKey = (sha256: string): string => `devbox-tools/files/${sha256}`;

/** A file the installed manifest and the pin's differ on. */
interface ToolsFile {
  readonly sha256: string;
  /** Under the root, as the manifest names it (`usr/…`). */
  readonly path: string;
}

/** What moving a box's installed tools to a pin takes: each file whose sha256 moved or that is new, and each file the
 *  pin no longer holds. */
export interface ToolsDelta {
  readonly changed: readonly ToolsFile[];
  readonly removed: readonly string[];
}

function manifestEntries(text: string): Map<string, string> {
  const entries = new Map<string, string>();

  for (const row of text.split('\n')) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/u.exec(row.trim());

    if (match !== null) entries.set(match[2] ?? '', match[1] ?? '');
  }

  return entries;
}

/** The delta from the `installed` manifest to the pin's `next` one, both `sha256sum` output. */
export function manifestDelta(installed: string, next: string): ToolsDelta {
  const held = manifestEntries(installed);
  const wanted = manifestEntries(next);

  return {
    changed: [...wanted].filter(([path, sha256]) => held.get(path) !== sha256).map(([path, sha256]) => ({ sha256, path })),
    removed: [...held.keys()].filter((path) => !wanted.has(path)),
  };
}

/**
 * The paths of a delta inside the offline package repository. The repository is the download-only closure of `wanted`
 * against an empty dpkg status (tools-setup.sh), base packages included at the archive's versions, which the full
 * install's apt leaves alone where the box already holds them; installing a changed .deb by itself would downgrade or
 * upgrade what that install never touches. So a pin that changes a package installs whole.
 */
export function packagePaths(delta: ToolsDelta): readonly string[] {
  return [...delta.changed.map(({ path }) => path), ...delta.removed].filter((path) => path.startsWith(`${REPO.slice(1)}/`));
}

/**
 * Moves the installed tools to `pin` by `delta`, which holds no package (`packagePaths`): each changed file staged in
 * `staged` under its sha256 and the pin's manifest as `staged/manifest`. Every file is checked against its sha256 before
 * any is placed; each is placed beside its target and renamed over it, so a running binary keeps its own; a file keeps
 * the mode of the one it replaces (a new one under bin/ is executable). The manifest and the stamp go last, so a start
 * cut short finds the old manifest and moves the same files again. Prints its timing and what it moved.
 */
export function toolsApplyCommand(delta: ToolsDelta, pin: string, { root = '/', staged = TOOLS_STAGED }: { readonly root?: string; readonly staged?: string } = {}): string {
  const at = (path: string) => shellPath(`${root.replace(/\/$/u, '')}/${path}`);

  return [
    'set -e', 't0=$(date +%s%N)',
    ...delta.changed.map(({ sha256 }) => `[ "$(sha256sum < ${shellPath(`${staged}/${sha256}`)} | cut -c1-64)" = ${sha256} ] || { echo ${shellPath(`${staged}/${sha256} is not the pinned file ${sha256}`)}; exit 1; }`),
    `bytes=$(cat ${[...new Set(delta.changed.map(({ sha256 }) => shellPath(`${staged}/${sha256}`)))].join(' ') || '/dev/null'} | wc -c)`,
    // `set -e` passes over a failure inside an && list, so each list exits itself: no manifest or stamp after a file failed.
    ...delta.changed.map(({ sha256, path }) => `mkdir -p "$(dirname ${at(path)})" && install -m "$(stat -c %a ${at(path)} 2>/dev/null || echo ${path.includes('/bin/') ? '755' : '644'})" `
      + `${shellPath(`${staged}/${sha256}`)} ${at(`${path}.devbox-new`)} && mv -f ${at(`${path}.devbox-new`)} ${at(path)} || exit 1`),
    ...delta.removed.map((path) => `rm -f ${at(path)}`),
    `mkdir -p "$(dirname ${at(TOOLS_MANIFEST.slice(1))})" && install -m 644 ${shellPath(`${staged}/manifest`)} ${at(TOOLS_MANIFEST.slice(1))} || exit 1`,
    `printf %s ${shellPath(pin)} > ${at(TOOLS_STAMP.slice(1))}`,
    `rm -rf ${shellPath(staged)}`,
    `echo "filesMs=$(( ($(date +%s%N) - t0) / 1000000 )) files=${String(delta.changed.length)} removed=${String(delta.removed.length)} bytes=$bytes"`,
  ].join('\n');
}

/** Offline; a package already at its version is left alone, so a refresh touches only what changed. */
export function toolsInstallCommand(archive: string, hash: string): string {
  const list = '/tmp/devbox-tools.list';

  const apt = `-o Dir::Etc::sourcelist=${list} -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 -o Acquire::Languages=none `
    + '-o Dpkg::Options::=--force-unsafe-io -o Dpkg::Options::=--force-confold';

  return [
    'set -e', 'export DEBIAN_FRONTEND=noninteractive', 't0=$(date +%s%N)',
    `[ "$(sha256sum < ${shellPath(archive)} | cut -c1-64)" = ${shellPath(hash)} ] || { echo ${shellPath(`${archive} is not the pinned tools ${hash}`)}; exit 1; }`,
    `mkdir -p "$(dirname ${TOOLS_INSTALLING})"`, `: > ${TOOLS_INSTALLING}`,
    `tar -C / -xzf ${shellPath(archive)}`,
    '(cd / && sha256sum -c --quiet usr/local/lib/devbox/tools.sha256)',
    't1=$(date +%s%N)',
    `echo "deb [trusted=yes] file:${REPO} ./" > ${list}`,
    `printf 'path-exclude=/usr/share/man/*\\npath-exclude=/usr/share/doc/*\\npath-exclude=/usr/share/locale/*\\n' > /etc/dpkg/dpkg.cfg.d/devbox-nodoc`,
    `apt-get ${apt} update -qq > /tmp/devbox-tools.log 2>&1 || { cat /tmp/devbox-tools.log; exit 1; }`,
    `apt-get ${apt} install -y -qq --no-install-recommends $(cat ${REPO}/wanted) >> /tmp/devbox-tools.log 2>&1 `
      + '|| { tail -30 /tmp/devbox-tools.log; exit 1; }',
    't2=$(date +%s%N)',
    'mkdir -p /workspace /var/tmp/devbox && ln -sf /usr/bin/fusermount3 /usr/local/bin/fusermount',
    `rm -rf ${REPO} ${shellPath(archive)} /var/lib/apt/lists/* ${list}`,
    `printf %s ${shellPath(hash)} > ${TOOLS_STAMP}`,
    `rm -f ${TOOLS_INSTALLING}`,
    `echo "extractMs=$(( (t1 - t0) / 1000000 )) installMs=$(( (t2 - t1) / 1000000 )) changed=$(grep -c '^Setting up' /tmp/devbox-tools.log || true)"`,
  ].join('\n');
}
