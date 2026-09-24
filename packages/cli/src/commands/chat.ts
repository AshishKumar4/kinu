import { resolveAgentTarget } from '../agent-target';
import { lastUsedLocalRef } from '../config';
import { agentTargetExists, requireAgentTarget } from '../local-target';
import { CloudAgentClient } from '../cloud-agent-client';
import { createLocalPeerAgent } from '../agent-create';
import { createAgentClient } from '../client-factory';
import { runChatLoop } from '../chat-loop';
import { ensureLocalDaemonRunning } from './daemon';
import { printError, ACCENT, DIM } from '../display';
import { installTurnDiagnostics } from '../turn-log';
import { listKnownAgents } from '../agent-list';
import { ask } from '../prompt';

export interface ChatCommandOptions {
  model?: string;
  baseUrl?: string;
  auth?: string;
  classic?: boolean;
  transcript?: boolean;
  transcriptDir?: string;
}

function optionsForWorkspaceSwitch(
  opts: ChatCommandOptions,
  mode: 'local' | 'cloud',
): ChatCommandOptions {
  const selected: ChatCommandOptions = { ...opts };

  if (mode === 'cloud') {
    selected.model = undefined;
    selected.baseUrl = undefined;
    selected.auth = undefined;
  }

  return selected;
}

export async function chatCommand(
  name: string | undefined,
  opts: ChatCommandOptions,
): Promise<void> {
  let chosen = name;

  if (chosen === undefined || chosen === '') {
    // The directory is the workspace: reopen the one used last here.
    const here = lastUsedLocalRef();

    if (here !== null) {
      chosen = here.name;
    } else if (!opts.classic && process.stdin.isTTY && process.stdout.isTTY) {
      // Lazy: opentui captures the terminal and must never load on non-TUI paths.
      const { runHomeTui } = await import('../tui/home-app');
      const action = await runHomeTui(opts);

      if (action.type === 'open-agent') await chatCommand(action.name, opts);

      return;
    }
  }

  if (chosen === undefined || chosen === '') {
    const agents = listKnownAgents();

    if (agents.length === 0) {
      printError('No workspaces yet.', 'Create one with kinu create <name>, or run kinu in a terminal.');
      process.exit(1);
    }

    if (agents.length === 1) {
      chosen = agents[0].name;
    } else {
      console.log(`\n${DIM('Select a workspace:')}`);

      for (const [i, a] of agents.entries()) console.log(`  ${ACCENT(String(i + 1))} ${a.label}`);

      console.log('');
      const answer = await ask('Workspace #');
      const idx = parseInt(answer, 10) - 1;

      if (idx < 0 || idx >= agents.length) {
        printError('Invalid selection.');
        process.exit(1);
      }

      chosen = agents[idx].name;
    }
  }

  const target = requireAgentTarget(chosen);

  if (target.mode === 'local') ensureLocalDaemonRunning();
  installTurnDiagnostics();
  const client = await createAgentClient(target, opts);

  if (opts.classic || !process.stdin.isTTY || !process.stdout.isTTY) {
    await runChatLoop({ client });
  } else {
    const { runTuiChat } = await import('../tui/chat-app');
    await runTuiChat({
      client,
      onWorkspaceSelect: async (selectedName) => {
        const selectedTarget = resolveAgentTarget(selectedName);

        // Mid-session, so this throws for the TUI to show rather than exiting.
        if (!agentTargetExists(selectedTarget)) {
          throw new Error(`Workspace "${selectedName}" is no longer available.`);
        }

        if (selectedTarget.mode === 'local') ensureLocalDaemonRunning();
        const selectedOptions = optionsForWorkspaceSwitch(opts, selectedTarget.mode);

        return createAgentClient(selectedTarget, selectedOptions);
      },
      onNewAgent: async (current) => {
        if (current.mode === 'cloud') {
          if (!(current instanceof CloudAgentClient)) {
            throw new Error('This cloud session cannot create additional agents.');
          }

          const created = await current.createAdditionalAgent();

          return {
            ...created,
            kind: 'cloud-additional' as const,
            client: current.openAdditionalAgent(created.name),
          };
        }

        const created = await createLocalPeerAgent();

        return { name: created.name, displayName: created.displayName ?? '', kind: 'local-peer' as const };
      },
    });
  }
}
