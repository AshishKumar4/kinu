export interface CliInstallCommandOptions {
  origin: string;
  setup?: boolean;
  connect?: boolean;
  label?: string;
}

export function normalizeCliOrigin(origin: string): string {
  return origin.replace(/\/+$/, '');
}

/** The one command every surface hands a user. The script owns PATH activation
 *  and prints the export line itself when the calling shell cannot see `kinu`
 *  yet, so nothing here wraps it in an environment prefix or a second command.
 *
 *  The interpreter is `bash`, not `sh`: the script sets `pipefail`, which dash
 *  gained only in 0.5.12, and the launcher it installs traps `RETURN`, which
 *  dash rejects outright. */
export function buildCliInstallCommand(options: CliInstallCommandOptions): string {
  const origin = normalizeCliOrigin(options.origin);
  const args: string[] = [];
  if (options.setup === false) args.push('--no-setup');
  if (options.connect) args.push('--connect');
  if (options.label) args.push('--label', shellQuote(options.label));

  const bashArgs = args.length > 0 ? ` -s -- ${args.join(' ')}` : '';
  return `curl -fsSL ${shellQuote(`${origin}/install.sh`)} | bash${bashArgs}`;
}

export function buildCliSetupCommand(origin: string): string {
  return `kinu setup --origin ${shellQuote(normalizeCliOrigin(origin))}`;
}

export function buildCliAuthCommand(origin: string): string {
  return `kinu auth --origin ${shellQuote(normalizeCliOrigin(origin))}`;
}

export function shellQuote(value: string): string {
  const escaped = value.replace(/'/g, `'\\''`);
  return `'${escaped}'`;
}
