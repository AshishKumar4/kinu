import { ensureAgentHome, type AgentMode } from '../config';
import { createCliAgent, createLocalPeerAgent } from '../agent-create';
import { ACCENT, DIM, OK, WARN, createSpinner, printCreatedCard, printFailure } from '../display';
import { hold, KinuError, settle } from '@kinu.run/core/obs';
import { Cause, Effect, Exit } from 'effect';
import { findUnusableModel, type LocalModelResolverOptions } from '../local-model-resolver';
import { ask, canPrompt } from '../prompt';

export async function createCommand(name: string | undefined, opts: {
  purpose?: string; model?: string; baseUrl?: string; auth?: string;
  mode?: string; origin?: string;
  join?: boolean;
}): Promise<void> {
  ensureAgentHome();

  // Joining takes nothing: the agent inherits a peer's mission and its first message names it.
  if (opts.join) {
    await joinWorkspace(opts);

    return;
  }

  const interactive = canPrompt() && (!name || !opts.mode);

  const named = name ?? (interactive ? await ask('Workspace name', 'jarvis') : undefined);

  if (named === undefined || named === '') return settle(Effect.fail(new KinuError('bad_input', 'Name the workspace: kinu create <name> --purpose "what it is for"')));

  if (opts.mode && opts.mode !== 'local' && opts.mode !== 'cloud') return settle(Effect.fail(new KinuError('bad_input', '--mode must be local or cloud')));
  const mode = opts.mode === 'local' || opts.mode === 'cloud' ? opts.mode : await askMode(interactive);
  const purpose = opts.purpose ?? `A helpful AI assistant named ${named}.`;

  if (mode === 'cloud') {
    await underSpinner('Creating cloud workspace…', 'Create failed', async (spinner) => {
      await createCliAgent({ ...opts, name: named, purpose, mode, allowInteractiveAuth: true });
      spinner.stop('Cloud workspace created');
      console.log(`\n${OK('✓')} ${ACCENT(named)} ${DIM('cloud workspace')}`);
      console.log(`\n${DIM('Run:')} ${ACCENT(`kinu run ${named}`)} ${DIM('"do something"')}\n`);
    });

    return;
  }

  await underSpinner('Creating workspace...', 'Create failed', async (spinner) => {
    const created = await createCliAgent({ ...opts, name: named, purpose, mode, allowInteractiveAuth: true });
    spinner.stop('Workspace created');
    printCreatedCard(named, purpose, created.model ?? opts.model ?? 'configured provider', created.dbPath ?? '');
    await warnUnusableModel(opts);
  });
}

/** `work` under a spinner; a failure stops it with `failed`, says why, and exits 1. */
async function underSpinner(label: string, failed: string, work: (spinner: ReturnType<typeof createSpinner>) => Promise<void>): Promise<void> {
  const spinner = createSpinner(label);
  spinner.start();
  const ran = await hold(Effect.promise(() => work(spinner)));

  if (Exit.isSuccess(ran)) return;
  spinner.fail(failed);
  printFailure({ cause: Cause.squash(ran.cause) });
  process.exit(1);
}

async function joinWorkspace(opts: { model?: string; baseUrl?: string; auth?: string }): Promise<void> {
  await underSpinner('Adding an agent to this workspace…', 'Could not add an agent', async (spinner) => {
    const created = await createLocalPeerAgent();
    spinner.stop('Agent added');
    console.log(`\n${OK('✓')} ${ACCENT(created.name)} ${DIM(`joined "${created.workspaceId}"`)}`);
    console.log(DIM(`Mission inherited from ${created.peers?.length ?? 0} peer(s). It names itself on your first message.`));
    await warnUnusableModel(opts);
    console.log(`\n${DIM('Run:')} ${ACCENT(`kinu chat ${created.name}`)}\n`);
  });
}

/** Warn now rather than when the first turn dies; the workspace exists either way. */
async function warnUnusableModel(opts: LocalModelResolverOptions): Promise<void> {
  const unusable = await findUnusableModel(opts);

  if (!unusable) return;
  console.log(`\n${WARN('!')} ${unusable.spec} ${DIM('has no connected provider.')} ${unusable.reason}`);
  console.log(DIM(`  Connect one with: kinu provider connect <provider>, then set the model with /model in chat.`));
}

async function askMode(interactive: boolean): Promise<AgentMode> {
  if (!interactive) return 'cloud';
  const answer = (await ask('Mode (cloud/local)', 'cloud')).toLowerCase();

  if (answer === 'local' || answer === 'l') return 'local';

  return 'cloud';
}
