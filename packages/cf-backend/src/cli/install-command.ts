export interface CliInstallCommandOptions {
  origin: string;
  setup?: boolean;
  connect?: boolean;
  label?: string;
}

export function normalizeCliOrigin(origin: string): string {
  return origin.replace(/\/+$/, '');
}

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
  return `proteus setup --origin ${shellQuote(normalizeCliOrigin(origin))}`;
}

export function buildCliAuthCommand(origin: string): string {
  return `proteus auth --origin ${shellQuote(normalizeCliOrigin(origin))}`;
}

export function shellQuote(value: string): string {
  const escaped = value.replace(/'/g, `'\\''`);
  return `'${escaped}'`;
}
