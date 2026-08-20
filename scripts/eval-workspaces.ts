#!/usr/bin/env bun
/**
 * Which workspaces on an account were made by a test run, and the one command
 * that removes them.
 *
 *   bun scripts/eval-workspaces.ts                     # the eval target
 *   bun scripts/eval-workspaces.ts --origin <origin>   # somewhere else
 *   bun scripts/eval-workspaces.ts --all               # every row, classified
 *   bun scripts/eval-workspaces.ts --prefix drill      # claim a name shape too
 *
 * WHY IT EXISTS. On 2026-08-20 the owner's production account held 28
 * workspaces. 23 of them were test debris: twenty-two named `drill*`, created
 * within minutes of each other, and one `settle-probe`. Nothing in the
 * repository creates those names — they were minted by harnesses driving his
 * signed-in session, and the account could not say which. Reading a workspace
 * list and guessing which rows are yours is not a thing a person should have to
 * do on their own account.
 *
 * Three halves, and the split is the whole design:
 *
 *   * EVERY WORKSPACE A HARNESS MAKES FROM NOW ON is named through
 *     `evalWorkspaceName`, so it carries the `eval-` prefix and is matched here
 *     by rule rather than by recognition.
 *   * THE DEBRIS THAT PREDATES THAT RULE cannot be matched by any rule, because
 *     it was named ad hoc. `--all` prints every row so a person can see it.
 *   * `--prefix` IS THAT PERSON'S JUDGEMENT, made explicit. It claims a name
 *     shape for this invocation only and nothing is remembered, so the script
 *     still guesses nothing — it renders the command for a pattern a human
 *     supplied, which is a different act from inventing one.
 *
 * It never deletes, for the same reason it never guesses. A workspace holds an
 * agent's whole history, the list above was 82% debris and 18% real work, and no
 * heuristic is worth the 18%.
 */
import { listCloudAgents, type CloudAgent } from '../packages/cli/src/cloud-api';
import {
  EVAL_WORKSPACE_PREFIX, resolveEvalIdentity, type EvalIdentity,
} from '../packages/test-utils/src/eval-identity';
import { resolveCloudSession } from '../packages/cli/src/config';

interface Options {
  readonly origin: string | null;
  readonly all: boolean;
  /** Name shapes this invocation claims, `eval-` always among them. */
  readonly prefixes: readonly string[];
}

function parseArgs(argv: readonly string[]): Options {
  let origin: string | null = null;
  let all = false;
  const prefixes = [EVAL_WORKSPACE_PREFIX];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') { all = true; continue; }
    if (arg === '--origin' || arg === '--prefix') {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} needs a value`);
      if (arg === '--origin') origin = value;
      else prefixes.push(value);
      i += 1;
      continue;
    }
    throw new Error(`unknown argument ${String(arg)}`);
  }
  return { origin, all, prefixes };
}

/** One account's list endpoint and the credential that reads it, with WHOSE
 *  credential it is — the thing this script exists to keep straight. */
interface AccountAccess {
  readonly origin: string;
  readonly token: string;
  readonly via: string;
}

/**
 * Who to ask, and with what.
 *
 * The eval identity first, because that is the account a harness writes to and
 * so the account this normally cleans. The signed-in session is the FALLBACK and
 * only with an explicit `--origin`: reading a person's own workspace list is the
 * whole job when the debris predates the eval account, but it must be asked for
 * rather than assumed — an unqualified run must not reach into somebody's real
 * account just because a config file was lying around.
 */
function credentials(options: Options): AccountAccess {
  const resolved = resolveEvalIdentity();
  if (resolved.kind === 'ready') {
    const identity: EvalIdentity = resolved.identity;
    if (!options.origin || options.origin === identity.origin) {
      return { origin: identity.origin, token: identity.token, via: identity.account };
    }
  }
  if (!options.origin) {
    throw new Error('no eval credential and no --origin. Set KINU_EVAL_TOKEN to read the eval '
      + "account, or pass --origin to read the signed-in session's account.");
  }
  const session = resolveCloudSession();
  if (!session) {
    throw new Error(`no credential for ${options.origin}: neither KINU_EVAL_TOKEN nor a `
      + 'signed-in CLI session. Run `kinu auth` or export KINU_EVAL_TOKEN.');
  }
  return { origin: options.origin, token: session.token, via: 'signed-in session' };
}

/** Milliseconds since the epoch, as the API reports `createdAt`. */
function when(millis: number): string {
  return new Date(millis).toISOString().replace('T', ' ').slice(0, 16);
}

function render(agents: readonly CloudAgent[], options: Options, origin: string): readonly string[] {
  const claimed = (name: string): boolean => options.prefixes.some((p) => name.startsWith(p));
  const evalRows = agents.filter((a) => claimed(a.name));
  const others = agents.filter((a) => !claimed(a.name));
  const lines: string[] = [];

  lines.push(`${String(evalRows.length)} of ${String(agents.length)} workspace(s) match `
    + `${options.prefixes.map((p) => `\`${p}\``).join(' or ')}:`);
  for (const agent of [...evalRows].sort((a, b) => a.createdAt - b.createdAt)) {
    lines.push(`  ${agent.name}  ${when(agent.createdAt)}  ${agent.displayName}`);
  }
  if (evalRows.length === 0) lines.push('  (none)');

  if (options.all) {
    lines.push('');
    lines.push(`${String(others.length)} workspace(s) do not. A row here that is test debris `
      + 'predates the naming rule, so only its owner can say so — name its shape with '
      + '--prefix to have the delete command rendered for it:');
    for (const agent of [...others].sort((a, b) => a.createdAt - b.createdAt)) {
      lines.push(`  ${agent.name}  ${when(agent.createdAt)}  ${agent.displayName}`);
    }
    if (others.length === 0) lines.push('  (none)');
  }

  lines.push('');
  if (evalRows.length === 0) {
    lines.push('Nothing to clean.');
    return lines;
  }
  // ONE line to approve and run. `kinu workspace delete` rather than a raw
  // DELETE loop because it also prunes the local config reference, which a bare
  // API call leaves behind; it takes one name at a time, hence the loop. The
  // origin is carried explicitly so the command cannot land on a different
  // account than the list above was read from.
  lines.push('To remove them, run:');
  lines.push(`  KINU_ORIGIN=${origin} sh -c 'for w in ${evalRows.map((a) => a.name).join(' ')};`
    + " do kinu workspace delete -y \"$w\"; done'");
  return lines;
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  const { origin, token, via } = credentials(options);
  console.log(`account at ${origin}, read as ${via}`);
  console.log(render(await listCloudAgents(origin, token), options, origin).join('\n'));
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
