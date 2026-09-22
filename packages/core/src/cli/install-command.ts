import { shellQuote } from '../utils/shell';

export interface CliInstallCommandOptions {
  origin: string;
  setup?: boolean;
  connect?: boolean;
  label?: string;
}

export function normalizeCliOrigin(origin: string): string {
  return origin.replace(/\/+$/, '');
}

/** The script owns PATH activation, so no env prefix or second command here.
 *  `bash`, not `sh`: the script needs `pipefail` and a `RETURN` trap, which dash lacks. */
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
