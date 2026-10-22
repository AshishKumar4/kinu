/**
 * Paths in the owner's home that a program OUTSIDE the device sandbox runs later: the one declared list a consented home
 * keeps read-only to sandboxed commands (pc-agent/src/sandbox.js requires this module), each with why it runs later, as
 * a refusal says it after "device path '<path>' is ". Owner decision (2026-10-22): the home stays writable and these
 * known paths are blocked. A list cannot be complete, and the consent text says so once (device-consent.ts). A path
 * that exists is bound read-only; one that does not is blocked by sealing the nearest folder above it, so no new entry
 * can be made directly in that folder. Crontab is not here: `crontab` writes /var/spool/cron through a setuid program,
 * which the sandbox's no-new-privileges and read-only system trees refuse on Linux, and /usr/lib/cron on macOS is
 * outside the profile's writable set. Dependency-free, as the daemon is built with it.
 */

const SHELL_STARTUP = 'a shell startup file, which your shell runs outside the sandbox when it starts';

const ON_PATH = 'a folder on your PATH, whose programs your shell runs outside the sandbox';

const PACKAGE_MANAGER = 'a package manager\'s settings, which can run scripts or redirect what it installs, outside the sandbox';

const EDITOR = 'an editor\'s startup files or plugins, which your editor runs outside the sandbox';

const GIT = 'your git settings, which can name programs git runs outside the sandbox';

export interface RunLaterPath {
  /** Below the owner's home. */
  readonly tail: string;
  readonly why: string;
}

export const RUN_LATER: readonly RunLaterPath[] = [
  ...['.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile', '.zshrc', '.zshenv', '.zprofile', '.zlogin',
    '.zlogout', '.config/fish', '.xprofile', '.xsessionrc', '.xinitrc', '.pam_environment'].map((tail) => ({ tail, why: SHELL_STARTUP })),
  { tail: '.config/environment.d', why: 'environment your session reads when you log in, outside the sandbox' },
  { tail: '.local/bin', why: ON_PATH },
  { tail: 'bin', why: ON_PATH },
  { tail: '.config/autostart', why: 'what your desktop starts when you log in, outside the sandbox' },
  { tail: '.config/systemd/user', why: 'your systemd user services, which run outside the sandbox' },
  { tail: 'Library/LaunchAgents', why: 'what macOS starts for you when you log in, outside the sandbox' },
  { tail: '.ssh', why: 'your SSH settings and keys: ssh runs its rc and config, and lets in every key authorized_keys lists' },
  { tail: '.gitconfig', why: GIT },
  { tail: '.config/git', why: GIT },
  ...['.npmrc', '.yarnrc', '.yarnrc.yml', '.bunfig.toml', '.pypirc', '.config/pip', '.pip', '.condarc', '.cargo/config',
    '.cargo/config.toml'].map((tail) => ({ tail, why: PACKAGE_MANAGER })),
  ...['.vimrc', '.vim', '.config/nvim', '.local/share/nvim', '.emacs', '.emacs.d', '.vscode/extensions', '.config/Code/User']
    .map((tail) => ({ tail, why: EDITOR })),
];

/** Each run-later path as the owner's home spells it. */
export const RUN_LATER_NAMES: readonly string[] = RUN_LATER.map((entry) => `~/${entry.tail}`);

/** The folders a missing run-later path can seal, each named once: the home itself and every folder on the way to one. */
export const SEALABLE_FOLDERS: readonly string[] = [...new Set(RUN_LATER.flatMap((entry) => {
  const parts = entry.tail.split('/').slice(0, -1);

  return ['~', ...parts.map((_, at) => `~/${parts.slice(0, at + 1).join('/')}`)];
}))];
