/**
 * The shipped-surface driver: the agent under eval is the SPAWNED `kinu`
 * CLI on a real workspace, never an in-process runtime.
 *
 * The precedent is bench/harbor/kinu_agent.py, which calls itself "glue
 * only: installs the CLI, creates a local workspace, and hands the task
 * instruction to `kinu exec`. It changes nothing about how the agent
 * reasons." This module is the same glue for the eval tier: `kinu create
 * --mode local`, then `kinu exec --workspace <name> --json`, in a scratch
 * KINU_HOME, configured the way a user's process is configured — the
 * KINU_BASE_URL/KINU_AUTH/KINU_MODEL direct-endpoint override and, for
 * MCP, the `mcpServers` block of the home's own config.json. Driving
 * `LocalAgentSession` here instead would bypass the CLI's turn assembly, the
 * client seam, consent watching and MCP config resolution, so a judgement over
 * it would certify a component while claiming to certify the product.
 *
 * WHAT A CALLER JUDGES: the OUTPUT — the line-delimited JSON events `exec
 * --json` prints, `message_end` carrying each turn's assistant text — plus the
 * workspace's OWN ledgers, read off `$home/<workspace>/agent.db` after the
 * process exits. The store is also where `recordLiveModelEpisode` reads what
 * the episode spent, so the arm's spend file and liveness verdict work
 * unchanged over a child process.
 *
 * The child env is BUILT, not inherited: an inherited KINU_TOKEN would put
 * the child on the cloud-session path while the eval believes it pinned a
 * direct endpoint, and which of the two answered is exactly what must never be
 * ambiguous in a measurement. PATH crosses over because the workspace shell
 * and the MCP fixture spawn real processes; KINU_SKIP_DAEMON=1 because a
 * one-shot eval that leaves a daemon behind per run is a process leak, not an
 * agent behaviour. The child's CWD is scratch too, for the reason
 * {@link childProjectRoot} records: it is where the child's host executor gets
 * rooted, and it used to be this repository.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';

import type { LLMProviderConfig } from '../../packages/core/src/index';

const REPO_ROOT = join(import.meta.dirname, '../..');
const CLI_BIN = join(REPO_ROOT, 'packages/cli/bin/cli.ts');

/**
 * The spawned agent's own project root, and it is NOT this repository.
 *
 * MEASURED. Both calls below used `cwd: REPO_ROOT`, and
 * `createCLIRuntime` roots the `laptop` executor at `cwd ?? process.cwd()`
 * unless told otherwise (`cli-backend/src/runtime.ts:545`) — so the child's host
 * plane WAS the repository, and an episode reaches every registered provider
 * through `execute_tools`. The eval runs of 2026-08-24 left `reference.mjs`,
 * `solution.mjs` and `test-eval.mjs` (a corpus task's seed files and the agent's
 * own harness) plus core's spill directories `.kinu/tool-output/` and
 * `attachments/` in the repository root.
 *
 * The in-process suites close this with `hostRoot: null`, which a spawned CLI has
 * no flag for; the equivalent is to hand the child a cwd it may own. A
 * subdirectory of the scratch home rather than the home itself, so the agent's
 * files cannot land beside `config.json` and the workspace stores the driver
 * reads its ledgers from — and because `canonicalProjectRoot` derives a project
 * identity from cwd, which should be scratch too.
 */
function childProjectRoot(home: string): string {
  const root = join(home, 'project');
  mkdirSync(root, { recursive: true });
  return root;
}

/** One stdio MCP server entry, as ~/.kinu/config.json spells it. */
export interface CliMcpServer {
  readonly command: string;
  readonly args: readonly string[];
}

export interface CliWorkspaceOptions {
  /** The scratch KINU_HOME this run owns. Created here. */
  readonly home: string;
  readonly workspace: string;
  readonly purpose: string;
  readonly llm: LLMProviderConfig;
  /** Written into the home's config.json — the same file `kinu chat` reads. */
  readonly mcpServers?: Readonly<Record<string, CliMcpServer>>;
}

export interface CliExecOptions extends CliWorkspaceOptions {
  readonly prompt: string;
  readonly noAutoEvolve: boolean;
  /** Hard wall for the child. On expiry the process is killed and the outcome
   *  says so — a hung child must become a named red, never a runner timeout. */
  readonly timeoutMs: number;
}

export interface CliExecOutcome {
  readonly exitCode: number;
  /** Every `message_end` assistant text, in turn order. */
  readonly assistantTexts: readonly string[];
  /** Every `{"type":"error"}` the stream carried. Model and turn errors arrive
   *  on stdout rather than stderr (run.ts:210, :592), so a caller that only
   *  read the exit code would call a failed turn a wrong answer. */
  readonly errors: readonly string[];
  /** Stdout lines that did not parse as a JSON object — kept because a torn
   *  line is evidence about the stream, and dropping it silently would hide it. */
  readonly unparsedLines: readonly string[];
  readonly stderr: string;
  readonly timedOut: boolean;
  /** The workspace's own store, for ledger reads and verification. */
  readonly dbPath: string;
}

/**
 * The two event shapes this driver consumes, parsed at the boundary rather than
 * indexed as an open dictionary. The stream carries many more types; a
 * `looseObject` accepts them and `safeParse` simply does not match, so an
 * unknown event is ignored without ever becoming an untyped value a caller
 * could read a field off.
 */
const AssistantTextSchema = v.looseObject({
  type: v.literal('message_end'),
  role: v.literal('assistant'),
  text: v.string(),
});
const ErrorEventSchema = v.looseObject({
  type: v.literal('error'),
  message: v.string(),
});

export function cliWorkspaceDbPath(home: string, workspace: string): string {
  return join(home, workspace, 'agent.db');
}

function childEnv(opts: CliWorkspaceOptions) {
  const auth = opts.llm.headers['Authorization'] ?? opts.llm.headers['authorization'];
  if (auth === undefined) {
    throw new Error('the resolved LLM config carries no Authorization header, so the spawned '
      + 'CLI would have no credential and every turn would fail as an auth error');
  }
  return {
    PATH: process.env.PATH ?? '',
    HOME: opts.home,
    KINU_HOME: opts.home,
    KINU_SKIP_DAEMON: '1',
    KINU_BASE_URL: opts.llm.baseURL,
    KINU_AUTH: auth,
    KINU_MODEL: opts.llm.model,
  } satisfies Record<string, string>;
}

/** A refusal from a child process, with the reason first and the child's own
 *  words behind it — stderr is what names the actual defect. */
function childFailure(reason: string, exitCode: number | null, stderr: string): Error {
  return new Error(`${reason} (exit ${String(exitCode)})`
    + (stderr.trim().length > 0 ? `\n--- child stderr ---\n${stderr.trim()}` : ''));
}

/**
 * `kinu create <workspace> --mode local`: the shipped birth path, in the
 * scratch home. Also writes the home's config.json when MCP servers are named,
 * BEFORE any CLI process runs, so every invocation sees one configuration.
 *
 * THE CHILD ENV MATTERS AT BIRTH, not only at exec. `create` PERSISTS the
 * resolved provider config into the workspace store, and `exec` prefers what
 * the workspace already carries — so a workspace born under a different
 * endpoint keeps answering from it. Measured 2026-08-20: a workspace created
 * with a wrong base URL then exec'd with the right one still failed every turn
 * with `Your Cloudflare login is no longer valid`, while that same endpoint
 * answered a direct request fine. Both calls take `childEnv(opts)` from the
 * same options for that reason — one configuration, or the measurement is of
 * whichever endpoint won.
 */
export async function createCliWorkspace(opts: CliWorkspaceOptions): Promise<void> {
  mkdirSync(opts.home, { recursive: true });
  if (opts.mcpServers !== undefined) {
    writeFileSync(join(opts.home, 'config.json'),
      `${JSON.stringify({ mcpServers: opts.mcpServers }, null, 2)}\n`);
  }
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_BIN, 'create', opts.workspace,
      '--mode', 'local', '--purpose', opts.purpose, '--no-alias-shim'],
    cwd: childProjectRoot(opts.home),
    env: childEnv(opts),
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw childFailure(`kinu create ${opts.workspace} failed`, exitCode, `${stdout}\n${stderr}`);
  }
}

/**
 * `kinu exec --workspace <name> --json`: one headless task turn through the
 * exact process a user runs. stdin is closed — `exec` folds piped stdin into
 * the prompt — and stdout is parsed as the line-delimited event stream.
 */
export async function execCliTask(opts: CliExecOptions): Promise<CliExecOutcome> {
  // `--` before the prompt, the shape bench/harbor/kinu_agent.py uses: the
  // prompt is variadic (`exec [prompt...]`), so an instruction that happens to
  // begin with a dash would otherwise be parsed as a flag.
  const cmd = [process.execPath, CLI_BIN, 'exec',
    '--workspace', opts.workspace, '--json'];
  if (opts.noAutoEvolve) cmd.push('--no-auto-evolve');
  cmd.push('--', opts.prompt);
  const proc = Bun.spawn({
    cmd,
    cwd: childProjectRoot(opts.home),
    env: childEnv(opts),
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  let timedOut = false;
  const wall = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGKILL');
  }, opts.timeoutMs);
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
  ]);
  clearTimeout(wall);

  const unparsedLines: string[] = [];
  const assistantTexts: string[] = [];
  const errors: string[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      // A non-JSON line on a --json stream is evidence of a torn write, kept
      // for the caller; anything else parsing throws is a real defect.
      if (!(error instanceof SyntaxError)) throw error;
      unparsedLines.push(line);
      continue;
    }
    const text = v.safeParse(AssistantTextSchema, parsed);
    if (text.success) {
      assistantTexts.push(text.output.text);
      continue;
    }
    const failure = v.safeParse(ErrorEventSchema, parsed);
    if (failure.success) errors.push(failure.output.message);
  }
  return {
    exitCode, assistantTexts, errors, unparsedLines, stderr, timedOut,
    dbPath: cliWorkspaceDbPath(opts.home, opts.workspace),
  };
}
