/**
 * The shipped chat TUI, on a real terminal, against a DEPLOYED workspace.
 *
 * Everything here is the product: `CloudAgentClient` over the deployment's own
 * socket, and `runTuiChat` — the same function `kinu chat` calls, which builds
 * the renderer, reads the hub and mounts `ChatApp`. Nothing is faked, which is
 * the whole point: the composer's in-process suites fake the agent, and the
 * defect that shipped was in what a real terminal delivers to a real client.
 *
 * The three values it needs arrive in the environment because a pty child gets
 * no arguments from the harness that drove it, and a token must never reach
 * argv. The suite that spawns this is `enter-sends.first-run.ts`.
 */
import { CloudAgentClient } from '../../../packages/cli/src/cloud-agent-client';
import { runTuiChat } from '../../../packages/cli/src/tui/chat-app';

const origin = process.env.KINU_FIRST_RUN_ORIGIN ?? '';
const token = process.env.KINU_FIRST_RUN_TOKEN ?? '';
const workspace = process.env.KINU_FIRST_RUN_WORKSPACE ?? '';
if (!origin || !token || !workspace) {
  throw new Error('the pty chat fixture needs KINU_FIRST_RUN_ORIGIN, KINU_FIRST_RUN_TOKEN and '
    + 'KINU_FIRST_RUN_WORKSPACE; it drives a deployed workspace and will not invent one');
}

// Printed before the client opens, so a harness can wait on a cheap marker
// rather than guessing at first-paint text.
console.log('READY-FR');

await runTuiChat({
  client: new CloudAgentClient({
    origin, token, agentName: workspace, cloudName: workspace,
  }),
  // A cloud workspace keeps its conversation server-side, so opening one
  // replays it — the same flag `chatCommand` passes for a cloud target.
  hydrateHistory: true,
});
