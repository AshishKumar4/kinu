import { ensureAgentHome, pathHint, type AgentMode } from '../config';
import { createCliAgent } from '../agent-create';
import { ACCENT, DIM, OK, WARN, createSpinner, printCreatedCard, printFailure } from '../display';
import { findUnusableModel } from '../local-model-resolver';
import { ask, canPrompt } from '../prompt';

interface ModelWarningInput {
  model?: string;
  agentName: string;
}

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
      spinner.fail('Create failed');
      printFailure(err);
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
    const warningInput: ModelWarningInput = { agentName: name };
    if (opts.model) warningInput.model = opts.model;
    await warnUnusableModel(warningInput);
    const hint = pathHint();
    if (hint) console.log(DIM(hint));
  } catch (err) {
    spinner.fail('Create failed');
    printFailure(err);
    process.exit(1);
  }
}

/** The workspace exists either way — this is the difference between learning
 *  the model is unusable now and learning it when the first turn dies. */
async function warnUnusableModel(opts: ModelWarningInput): Promise<void> {
  const unusable = await findUnusableModel(opts);
  if (!unusable) return;
  console.log(`\n${WARN('!')} ${unusable.spec} ${DIM('has no connected provider.')} ${unusable.reason}`);
  console.log(DIM(`  Connect one with: proteus provider connect <provider>, then set the model with /model in chat.`));
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
