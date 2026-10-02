import { Effect, Cause } from 'effect';
import { settle } from '@kinu.run/core/obs';
import { ensureAgentHome, pathHint, type AgentMode } from '../config';
import { createCliAgent, createLocalPeerAgent } from '../agent-create';
import { ACCENT, DIM, OK, WARN, createSpinner, printCreatedCard, printFailure } from '../display';
import { findUnusableModel } from '../local-model-resolver';
import { ask, canPrompt } from '../prompt';

interface ModelWarningInput {
  model?: string;
  agentName: string;
}

const createFailed = (spinner: ReturnType<typeof createSpinner>) => (failed: Cause.Cause<unknown>) => Effect.sync(() => {
  spinner.fail('Create failed');
  printFailure({ cause: Cause.squash(failed) });
  process.exit(1);
});

export function createCommand(name: string | undefined, opts: {
  purpose?: string; model?: string; baseUrl?: string; auth?: string;
  mode?: string; alias?: string; aliasShim?: boolean; origin?: string;
  join?: boolean;
}): Promise<void> {
  return settle(Effect.gen(function* () {
    ensureAgentHome();

    // Joining takes nothing: the agent inherits a peer's mission and its first message names it.
    if (opts.join) {
      yield* Effect.promise(async () => joinWorkspace(opts));

      return;
    }

    const interactive = canPrompt() && (!name || !opts.mode);

    const named = name ?? (interactive ? (yield* Effect.promise(async () => ask('Workspace name', 'jarvis'))) : undefined);

    if (named === undefined || named === '') return yield* Effect.die(new Error('Workspace name required.'));
    const mode = yield* resolveMode(opts.mode, interactive);
    const purpose = opts.purpose ?? `A helpful AI assistant named ${named}.`;

    const alias = opts.aliasShim === false
      ? undefined
      : opts.alias ?? (interactive ? (yield* Effect.promise(async () => ask('Alias command', named))) : named);

    if (mode === 'cloud') {
      const spinner = createSpinner('Creating cloud workspace…');
      spinner.start();

      yield* Effect.catchCause(Effect.gen(function* () {
        const created = yield* Effect.promise(async () => createCliAgent({ ...opts, name: named, purpose, mode, alias, allowInteractiveAuth: true }));
        spinner.stop('Cloud workspace created');
        console.log(`\n${OK('✓')} ${ACCENT(named)} ${DIM('cloud workspace')}`);

        if (alias) console.log(`${DIM('Alias:')} ${ACCENT(alias)} ${DIM(created.aliasPath ?? '')}`);
        const hint = pathHint();

        if (hint) console.log(DIM(hint));
        console.log(`\n${DIM('Run:')} ${ACCENT(alias === undefined || alias === '' ? `kinu run ${named}` : alias)} ${DIM('"do something"')}\n`);
      }), createFailed(spinner));

      return;
    }

    const spinner = createSpinner('Creating workspace...');
    spinner.start();

    return yield* Effect.catchCause(Effect.gen(function* () {
      const created = yield* Effect.promise(async () => createCliAgent({ ...opts, name: named, purpose, mode, alias, allowInteractiveAuth: true }));
      spinner.stop('Workspace created');
      printCreatedCard(named, purpose, created.model ?? opts.model ?? 'configured provider', created.dbPath ?? '');
      const warningInput: ModelWarningInput = { agentName: named };

      if (opts.model) warningInput.model = opts.model;
      yield* Effect.promise(async () => warnUnusableModel(warningInput));
      const hint = pathHint();

      if (hint) console.log(DIM(hint));
    }), createFailed(spinner));
  }));
}

async function joinWorkspace(opts: { model?: string; baseUrl?: string; auth?: string }): Promise<void> {
  const spinner = createSpinner('Adding an agent to this workspace…');
  spinner.start();

  try {
    const created = await createLocalPeerAgent();
    spinner.stop('Agent added');
    console.log(`\n${OK('✓')} ${ACCENT(created.name)} ${DIM(`joined "${created.workspaceId}"`)}`);
    console.log(DIM(`Mission inherited from ${created.peers?.length ?? 0} peer(s). It names itself on your first message.`));
    await warnUnusableModel(
      opts.model ? { agentName: created.name, model: opts.model } : { agentName: created.name },
    );
    console.log(`\n${DIM('Run:')} ${ACCENT(`kinu chat ${created.name}`)}\n`);
  } catch (err) {
    spinner.fail('Could not add an agent');
    printFailure({ cause: err });
    process.exit(1);
  }
}

/** Warn now rather than when the first turn dies; the workspace exists either way. */
async function warnUnusableModel(opts: ModelWarningInput): Promise<void> {
  const unusable = await findUnusableModel(opts);

  if (!unusable) return;
  console.log(`\n${WARN('!')} ${unusable.spec} ${DIM('has no connected provider.')} ${unusable.reason}`);
  console.log(DIM(`  Connect one with: kinu provider connect <provider>, then set the model with /model in chat.`));
}

function resolveMode(raw: string | undefined, interactive: boolean): Effect.Effect<AgentMode> {
  return Effect.gen(function* () {
    if (raw) {
      if (raw === 'local' || raw === 'cloud') return raw;

      return yield* Effect.die(new Error('--mode must be local or cloud'));
    }

    if (!interactive) return 'cloud';
    const answer = (yield* Effect.promise(async () => ask('Mode (cloud/local)', 'cloud'))).toLowerCase();

    if (answer === 'local' || answer === 'l') return 'local';

    return 'cloud';
  });
}
