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

/** A manifest's files, path to sha256. */
export function manifestEntries(text: string): Map<string, string> {
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
 * against an empty dpkg status (tools-setup.sh), base packages included at the archive's versions; a full install's apt
 * leaves alone what the box already holds at its version, and removes the repository after. So a pin that changes a
 * package runs that same apt over the repository again, with the files apt needs back in it (`toolsPackagePlanCommand`).
 */
export function packagePaths(delta: ToolsDelta): readonly string[] {
  return [...delta.changed.map(({ path }) => path), ...delta.removed].filter(isPackagePath);
}

/** A path inside the offline package repository, as a manifest names it. */
const isPackagePath = (path: string): boolean => path.startsWith(`${REPO.slice(1)}/`);

/** A package in the repository, as a manifest names it. */
export const isPackage = (path: string): boolean => isPackagePath(path) && path.endsWith('.deb');

/** The repository's own files apt reads beside the packages: its index, and the list a full install asks for. */
export const isRepositoryIndex = (path: string): boolean => isPackagePath(path) && !isPackage(path);

/** The repository's index, as the manifest names it. */
export const PACKAGES_INDEX = `${REPO.slice(1)}/Packages`;

/** A repository with no list to install would have apt install nothing and say it succeeded. */
const WANTED_HELD = `[ -s ${REPO}/wanted ] || { echo ${shellPath(`${REPO}/wanted is missing`)}; exit 1; }`;

const APT_LIST = '/tmp/devbox-tools.list';

const APT_LOG = '/tmp/devbox-tools.log';

const APT_PLAN = '/tmp/devbox-tools.plan';

const APT_OPTIONS = `-o Dir::Etc::sourcelist=${APT_LIST} -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 -o Acquire::Languages=none `
  + '-o Dpkg::Options::=--force-unsafe-io -o Dpkg::Options::=--force-confold';

/** The repository as apt's one source, its index read. */
const APT_SOURCE = [
  `echo "deb [trusted=yes] file:${REPO} ./" > ${APT_LIST}`,
  `printf 'path-exclude=/usr/share/man/*\\npath-exclude=/usr/share/doc/*\\npath-exclude=/usr/share/locale/*\\n' > /etc/dpkg/dpkg.cfg.d/devbox-nodoc`,
  `apt-get ${APT_OPTIONS} update -qq > ${APT_LOG} 2>&1 || { cat ${APT_LOG}; exit 1; }`,
];

const APT_WANTED = `--no-install-recommends $(cat ${REPO}/wanted)`;

/** The install every pin's tools end with; a package already at its version is left alone. */
const APT_INSTALL = [
  `apt-get ${APT_OPTIONS} install -y -qq ${APT_WANTED} >> ${APT_LOG} 2>&1 || { tail -30 ${APT_LOG}; exit 1; }`,
  'mkdir -p /workspace /var/tmp/devbox && ln -sf /usr/bin/fusermount3 /usr/local/bin/fusermount',
  `rm -rf ${REPO} /var/lib/apt/lists/* ${APT_LIST}`,
];

const APT_SET_UP = `$(grep -c '^Setting up' ${APT_LOG} || true)`;

const at = (root: string, path: string) => shellPath(`${root.replace(/\/$/u, '')}/${path}`);

/** Each staged file checked against its sha256 before any is placed. */
function verifyLines(files: readonly ToolsFile[], staged: string): string[] {
  return files.map(({ sha256 }) => `[ "$(sha256sum < ${shellPath(`${staged}/${sha256}`)} | cut -c1-64)" = ${sha256} ] || { echo ${shellPath(`${staged}/${sha256} is not the pinned file ${sha256}`)}; exit 1; }`);
}

/** Each file placed beside its target and renamed over it, keeping the mode of the one it replaces (a new one under bin/
 *  is executable). `set -e` passes over a failure inside an && list, so each list exits itself. */
function placeLines(files: readonly ToolsFile[], root: string, staged: string): string[] {
  return files.map(({ sha256, path }) => `mkdir -p "$(dirname ${at(root, path)})" && install -m "$(stat -c %a ${at(root, path)} 2>/dev/null || echo ${path.includes('/bin/') ? '755' : '644'})" `
    + `${shellPath(`${staged}/${sha256}`)} ${at(root, `${path}.devbox-new`)} && mv -f ${at(root, `${path}.devbox-new`)} ${at(root, path)} || exit 1`);
}

/** The pin's manifest and stamp, written last, so a start cut short finds the old ones and moves the same files again. */
function sealLines(pin: string, root: string, staged: string): string[] {
  return [
    `mkdir -p "$(dirname ${at(root, TOOLS_MANIFEST.slice(1))})" && install -m 644 ${shellPath(`${staged}/manifest`)} ${at(root, TOOLS_MANIFEST.slice(1))} || exit 1`,
    `printf %s ${shellPath(pin)} > ${at(root, TOOLS_STAMP.slice(1))}`,
    `rm -rf ${shellPath(staged)}`,
  ];
}

const bytesLine = (files: readonly ToolsFile[], staged: string) =>
  `bytes=$(cat ${[...new Set(files.map(({ sha256 }) => shellPath(`${staged}/${sha256}`)))].join(' ') || '/dev/null'} | wc -c)`;

/**
 * Moves the installed tools to `pin` by `delta`, which holds no package (`packagePaths`): each changed file staged in
 * `staged` under its sha256 and the pin's manifest as `staged/manifest`. Every file is checked against its sha256 before
 * any is placed, and a running binary keeps its own. Prints its timing and what it moved.
 */
export function toolsApplyCommand(delta: ToolsDelta, pin: string, { root = '/', staged = TOOLS_STAGED }: { readonly root?: string; readonly staged?: string } = {}): string {
  return [
    'set -e', 't0=$(date +%s%N)',
    ...verifyLines(delta.changed, staged),
    bytesLine(delta.changed, staged),
    ...placeLines(delta.changed, root, staged),
    ...delta.removed.map((path) => `rm -f ${at(root, path)}`),
    ...sealLines(pin, root, staged),
    `echo "filesMs=$(( ($(date +%s%N) - t0) / 1000000 )) files=${String(delta.changed.length)} removed=${String(delta.removed.length)} bytes=$bytes"`,
  ].join('\n');
}

/**
 * The first half of moving the tools to a pin that changes a package: the box marked as a full install marks it, so a
 * start cut short from here installs whole; each changed file placed, the repository's among them, with its index and
 * list (`isRepositoryIndex`) whether changed or not; and apt asked, over the repository, which packages its install
 * would unpack. Prints `<package> <version>` for each,
 * which `packageFiles` turns into the repository files apt reads.
 */
export function toolsPackagePlanCommand(delta: ToolsDelta, { staged = TOOLS_STAGED }: { readonly staged?: string } = {}): string {
  return [
    'set -e', 'export DEBIAN_FRONTEND=noninteractive',
    ...verifyLines(delta.changed, staged),
    `mkdir -p "$(dirname ${TOOLS_INSTALLING})" ${REPO}`, `: > ${TOOLS_INSTALLING}`,
    ...placeLines(delta.changed, '/', staged),
    ...delta.removed.map((path) => `rm -f ${at('/', path)}`),
    WANTED_HELD,
    ...APT_SOURCE,
    `apt-get ${APT_OPTIONS} -s install ${APT_WANTED} > ${APT_PLAN} 2>>${APT_LOG} || { tail -30 ${APT_LOG}; exit 1; }`,
    `sed -n 's/^Inst \\([^ ]*\\) .*(\\([^ ]*\\) .*/\\1 \\2/p' ${APT_PLAN}`,
  ].join('\n');
}

/** The repository files apt reads for the packages `simulated` names (`toolsPackagePlanCommand`), by `index`, the
 *  repository's Packages file. A package the index does not hold is apt's to refuse, so it is not named here. */
export function packageFiles(simulated: string, index: string): readonly string[] {
  const files = new Map<string, string>();

  for (const stanza of index.split(/\n\s*\n/u)) {
    const field = (name: string) => new RegExp(`^${name}: (.+)$`, 'mu').exec(stanza)?.[1]?.trim();
    const [name, version, file] = [field('Package'), field('Version'), field('Filename')];

    if (name !== undefined && version !== undefined && file !== undefined) files.set(`${name} ${version}`, `${REPO.slice(1)}/${file.replace(/^\.\//u, '')}`);
  }

  return simulated.split('\n').flatMap((row) => {
    const file = files.get(row.trim());

    return file === undefined ? [] : [file];
  });
}

/**
 * The second half: each package apt reads that the first half did not bring, staged under its sha256, checked and
 * placed; apt's install over the repository, as a full install runs it; then the pin's manifest and stamp, and the mark
 * cleared. `placed` is what the first half placed, counted with these. Prints its timing, what it moved and what apt
 * set up.
 */
export function toolsPackageInstallCommand(
  moves: { readonly fetched: readonly ToolsFile[]; readonly placed: readonly ToolsFile[]; readonly removed: number }, pin: string, staged = TOOLS_STAGED,
): string {
  const { fetched, placed, removed } = moves;
  const moved = [...placed, ...fetched];

  return [
    'set -e', 'export DEBIAN_FRONTEND=noninteractive', 't0=$(date +%s%N)',
    ...verifyLines(fetched, staged),
    bytesLine(moved, staged),
    ...placeLines(fetched, '/', staged),
    't1=$(date +%s%N)',
    WANTED_HELD,
    ...APT_INSTALL,
    't2=$(date +%s%N)',
    ...sealLines(pin, '/', staged),
    `rm -f ${TOOLS_INSTALLING}`,
    `echo "filesMs=$(( (t1 - t0) / 1000000 )) installMs=$(( (t2 - t1) / 1000000 )) files=${String(moved.length)} removed=${String(removed)} bytes=$bytes changed=${APT_SET_UP}"`,
  ].join('\n');
}

/** The whole tarball, offline; a package already at its version is left alone. */
export function toolsInstallCommand(archive: string, hash: string): string {
  return [
    'set -e', 'export DEBIAN_FRONTEND=noninteractive', 't0=$(date +%s%N)',
    `[ "$(sha256sum < ${shellPath(archive)} | cut -c1-64)" = ${shellPath(hash)} ] || { echo ${shellPath(`${archive} is not the pinned tools ${hash}`)}; exit 1; }`,
    `mkdir -p "$(dirname ${TOOLS_INSTALLING})"`, `: > ${TOOLS_INSTALLING}`,
    `tar -C / -xzf ${shellPath(archive)}`,
    '(cd / && sha256sum -c --quiet usr/local/lib/devbox/tools.sha256)',
    't1=$(date +%s%N)',
    ...APT_SOURCE,
    ...APT_INSTALL,
    't2=$(date +%s%N)',
    `rm -f ${shellPath(archive)}`,
    `printf %s ${shellPath(hash)} > ${TOOLS_STAMP}`,
    `rm -f ${TOOLS_INSTALLING}`,
    `echo "extractMs=$(( (t1 - t0) / 1000000 )) installMs=$(( (t2 - t1) / 1000000 )) changed=${APT_SET_UP}"`,
  ].join('\n');
}
