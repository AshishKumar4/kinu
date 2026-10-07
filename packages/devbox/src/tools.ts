// The pinned tools tarball (D65, D78): an offline apt repository and our binaries, built on armada by block-lower's tools-setup.sh and tools-build.sh.
import { shellPath } from './stream-archive';

export const TOOLS_STAMP = '/usr/local/lib/devbox/tools-installed';

const REPO = '/usr/local/lib/devbox/debs';

/** Offline; a package already at its version is left alone, so a refresh touches only what changed. */
export function toolsInstallCommand(archive: string, hash: string): string {
  const list = '/tmp/devbox-tools.list';

  const apt = `-o Dir::Etc::sourcelist=${list} -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 -o Acquire::Languages=none `
    + '-o Dpkg::Options::=--force-unsafe-io -o Dpkg::Options::=--force-confold';

  return [
    'set -e', 'export DEBIAN_FRONTEND=noninteractive', 't0=$(date +%s%N)',
    `[ "$(sha256sum < ${shellPath(archive)} | cut -c1-64)" = ${shellPath(hash)} ] || { echo ${shellPath(`${archive} is not the pinned tools ${hash}`)}; exit 1; }`,
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
    `echo "extractMs=$(( (t1 - t0) / 1000000 )) installMs=$(( (t2 - t1) / 1000000 )) changed=$(grep -c '^Setting up' /tmp/devbox-tools.log || true)"`,
  ].join('\n');
}
