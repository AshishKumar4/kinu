import * as readline from 'node:readline';
import { ensureAgentHome, pathHint, type AgentMode } from '../config.js';
import { createCliAgent } from '../agent-create.js';
import { ACCENT, DIM, OK, createSpinner, printCreatedCard, printError } from '../display.js';

export async function createCommand(name: string | undefined, opts: {
  purpose?: string; model?: string; baseUrl?: string; auth?: string;
  mode?: string; alias?: string; aliasAgent?: boolean; origin?: string;
}): Promise<void> {
  ensureAgentHome();
  const interactive = process.stdin.isTTY && (!name || !opts.mode);
  if (!name) {
    name = interactive
      ? await ask('Agent name', 'jarvis')
      : undefined;
  }
  if (!name) throw new Error('Agent name required.');
  const mode = await resolveMode(opts.mode, interactive);
  const purpose = opts.purpose ?? `A helpful AI assistant named ${name}.`;
  const alias = opts.aliasAgent === false
    ? undefined
    : opts.alias ?? (interactive ? await ask('Alias command', name) : name);

  if (mode === 'cloud') {
    const spinner = createSpinner('Creating cloud agent...');
    spinner.start();
    try {
      const created = await createCliAgent({ ...opts, name, purpose, mode, alias, allowInteractiveAuth: true });
      spinner.stop('Cloud agent created');
      console.log(`\n${OK('✓')} ${ACCENT(name)} ${DIM('cloud agent')}`);
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

  const spinner = createSpinner('Creating agent...');
  spinner.start();
  try {
    const created = await createCliAgent({ ...opts, name, purpose, mode, alias, allowInteractiveAuth: true });
    spinner.stop('Agent created');
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

async function ask(label: string, fallback: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(resolve => rl.question(`${DIM(label)} ${DIM(`[${fallback}]`)} ${ACCENT('›')} `, resolve));
  rl.close();
  return answer.trim() || fallback;
}
