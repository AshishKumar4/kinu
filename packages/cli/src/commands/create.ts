import { ensureAgentHome, pathHint, type AgentMode } from '../config.js';
import { createCliAgent } from '../agent-create.js';
import { ACCENT, DIM, OK, createSpinner, printCreatedCard, printError } from '../display.js';
import { ask, canPrompt } from '../prompt.js';

export async function createCommand(name: string | undefined, opts: {
  purpose?: string; model?: string; baseUrl?: string; auth?: string;
  mode?: string; alias?: string; aliasShim?: boolean; origin?: string;
}): Promise<void> {
  ensureAgentHome();
  const interactive = canPrompt() && (!name || !opts.mode);
  if (!name) {
    name = interactive
      ? await ask('Workspace name', 'jarvis')
      : undefined;
  }
  if (!name) throw new Error('Workspace name required.');
  const mode = await resolveMode(opts.mode, interactive);
  const purpose = opts.purpose ?? `A helpful AI assistant named ${name}.`;
  const alias = opts.aliasShim === false
    ? undefined
    : opts.alias ?? (interactive ? await ask('Alias command', name) : name);

  if (mode === 'cloud') {
    const spinner = createSpinner('Creating cloud workspace...');
    spinner.start();
    try {
      const created = await createCliAgent({ ...opts, name, purpose, mode, alias, allowInteractiveAuth: true });
      spinner.stop('Cloud workspace created');
      console.log(`\n${OK('✓')} ${ACCENT(name)} ${DIM('cloud workspace')}`);
      if (alias) console.log(`${DIM('Alias:')} ${ACCENT(alias)} ${DIM(created.aliasPath ?? '')}`);
      const hint = pathHint();
      if (hint) console.log(DIM(hint));
      console.log(`\n${DIM('Run:')} ${ACCENT(alias || `proteus run ${name}`)} ${DIM('"do something"')}\n`);
    } catch (err) {
      spinner.stop('Create failed');
      printError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    return;
  }

  const spinner = createSpinner('Creating workspace...');
  spinner.start();
  try {
    const created = await createCliAgent({ ...opts, name, purpose, mode, alias, allowInteractiveAuth: true });
    spinner.stop('Workspace created');
    printCreatedCard(name, purpose, created.model ?? opts.model ?? 'configured provider', created.dbPath ?? '');
    const hint = pathHint();
    if (hint) console.log(DIM(hint));
  } catch (err) {
    spinner.stop('Create failed');
    printError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function resolveMode(raw: string | undefined, interactive: boolean): Promise<AgentMode> {
  if (raw) {
    if (raw === 'local' || raw === 'cloud') return raw;
    throw new Error('--mode must be local or cloud');
  }
  if (!interactive) return 'cloud';
  const answer = (await ask('Mode (cloud/local)', 'cloud')).toLowerCase();
  if (answer === 'local' || answer === 'l') return 'local';
  return 'cloud';
}
