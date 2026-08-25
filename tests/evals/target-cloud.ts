/**
 * The CLOUD target: a real workspace on the staging deployment, behind the seam.
 *
 * THIS IS THE ARM THAT WOULD HAVE CAUGHT THE STEP CAP. `agent://SwarmNoopRootCause`
 * established that the ten-step bound lives in `@cloudflare/think`, which the
 * local target never enters, and that the only registered verifier kind cannot
 * execute in a deployed Nimbus shell, which the local target's real `node` hides.
 * Both facts were unreachable from every suite in the tree. They are reachable
 * from here, because here the agent under test is the product.
 *
 * WHAT IT DRIVES, and what it deliberately does not build. The turn goes through
 * `CloudAgentClient` — the SHIPPED client, the one `kinu chat --cloud` uses. Its
 * ~850 lines of chat protocol (connect ticket, `agents/chat` frame types, stream
 * resume, cancel) are not re-spelled here for two reasons: a second client would
 * be a second thing to keep in step with the DO's protocol, and an eval that
 * drives a bespoke transport measures the bespoke transport. Every read is a
 * named method over `POST /api/cli/workspaces/:name/rpc`, whose `AGENT_RPC_ACCESS`
 * table is both the allowlist and the auth policy, so this target can reach
 * exactly what a credentialed operator can reach and nothing more.
 *
 * WHO IT RUNS AS. The `eval-service` account against staging, resolved by
 * `scripts/eval-credentials.ts` through `eval-identity.ts` and handed to a suite
 * process as `KINU_ORIGIN` / `KINU_TOKEN`. Never a person's session: measured on
 * 2026-08-20, production held 28 workspaces of which 23 were test debris and
 * nothing on the account could say which harness had made any of them. The origin
 * is re-checked HERE as well as in the script, because a target that trusts its
 * caller about where it is pointing is a door, and this one creates and deletes.
 *
 * WHAT IT LEAVES BEHIND: nothing. The workspace name carries
 * `EVAL_WORKSPACE_PREFIX` so a survivor is attributable, and `teardown` deletes
 * it. Callers put that call in a `finally`.
 *
 * INFRA VERSUS BEHAVIOUR, at every network boundary. `infraBoundary` labels a
 * failure that belongs to the deployment rather than to the agent, and the label
 * is placed by the code that knows, at the boundary it wraps. Without it a 503
 * during a live run looks exactly like the thing the run was built to detect —
 * and `scripts/skip-ratchet.ts` reads the same marker, so the classification
 * survives into the tier's own report.
 */
import * as v from 'valibot';

import {
  RunEventSchema,
  type JsonValue,
  type LLMProviderConfig, type RunEvent, type WorkspaceSpend,
} from '../../packages/core/src/index';
import { CloudAgentClient } from '../../packages/cli/src/cloud-agent-client';
import {
  ActivitySpendSchema, callAgentRpc, createCloudAgent, deleteCloudAgent,
} from '../../packages/cli/src/cloud-api';
import {
  evalTargetVerdict, evalWorkspaceName, infraBoundary, probeVerifier,
  type AgentEvalTarget, type EvalExecutor, type EvalSearchLedger, type EvalTargetProbe,
  type EvalTargetWorkspace,
} from '@kinu.run/test-utils';

/** Rows read per ledger question — the same bound the local target uses, so a
 *  difference between the arms is a difference in the agent. */
const LEDGER_PAGE = 200;

/** The executor a deployed workspace's own filesystem and shell live on. The
 *  probe and the file plane both address it by name, and `probe()` reports the
 *  whole executor list so a run whose plane is missing says which planes it did
 *  find rather than failing on an id. */
const WORKSPACE_EXECUTOR = 'workspace';

const ExecutorListSchema = v.array(v.object({
  name: v.string(),
  kind: v.string(),
}));
const ExecResultSchema = v.object({
  stdout: v.optional(v.string()),
  stderr: v.optional(v.string()),
  exitCode: v.optional(v.number()),
  error: v.optional(v.string()),
});
const FileReadSchema = v.object({
  content: v.optional(v.string()),
  truncated: v.optional(v.boolean()),
  error: v.optional(v.string()),
});
const DirListSchema = v.object({
  path: v.optional(v.string()),
  entries: v.optional(v.array(v.object({ name: v.string(), isDir: v.optional(v.boolean()) }))),
  error: v.optional(v.string()),
});
/** `listRuns` answers the cursored `Page` contract, so exhaustion is a state
 *  rather than something a caller may infer from a short array. */
const RunPageSchema = v.variant('status', [
  v.object({
    status: v.literal('more'),
    items: v.array(v.object({ runId: v.string() })),
    next: v.object({ after: v.string() }),
  }),
  v.object({
    status: v.literal('end'),
    items: v.array(v.object({ runId: v.string() })),
  }),
]);
const RunEventsSchema = v.array(RunEventSchema);
const CountedPageSchema = v.object({ items: v.array(v.unknown()) });
const RosterSchema = v.array(v.object({ name: v.string() }));
const SearchRunsSchema = v.array(v.object({ rootId: v.optional(v.string()) }));
const JobsSchema = v.array(v.object({ id: v.string() }));

export interface CloudTargetOptions {
  /** The deployment. Re-checked against the eval allowlist before anything is
   *  created, so this target cannot point somewhere the tier's banner did not. */
  readonly origin: string;
  /** The eval-service credential. Never logged, never placed in argv. */
  readonly token: string;
  /** What this workspace is FOR — folded into its `eval-`prefixed name so a row
   *  on the account says which suite made it. */
  readonly subject: string;
  readonly purpose: string;
  readonly llm: LLMProviderConfig;
}

/**
 * Create a staging workspace and hand back the target over it.
 *
 * Throws rather than returning a degraded target, and refuses before it creates:
 * a workspace made against the wrong origin cannot be un-made by discovering the
 * mistake afterwards.
 */
export async function provisionCloudTarget(opts: CloudTargetOptions): Promise<AgentEvalTarget> {
  const verdict = evalTargetVerdict(opts.origin);
  if (verdict.kind === 'refused') {
    throw new Error(`cloud eval target REFUSED — ${verdict.reason}`);
  }
  const workspace = evalWorkspaceName(opts.subject);
  const created = await infraBoundary(`POST ${verdict.origin}/api/cli/workspaces`, () =>
    createCloudAgent(verdict.origin, opts.token, {
      name: workspace,
      purpose: opts.purpose,
      model: opts.llm.model,
    }));
  return new CloudEvalTarget(verdict.origin, opts, created.name, verdict.why);
}

class CloudEvalTarget implements AgentEvalTarget {
  readonly backend = 'cloud' as const;

  private readonly client: CloudAgentClient;

  constructor(
    private readonly origin: string,
    private readonly opts: CloudTargetOptions,
    readonly workspace: string,
    private readonly why: string,
  ) {
    this.client = new CloudAgentClient({
      origin,
      token: opts.token,
      agentName: workspace,
      cloudName: workspace,
      // No JSONL transcript: this client is an instrument, and a diagnostic log
      // written into the developer's home for every eval case is debris the
      // suite never reads. The ledger is the record.
      transcript: { noTranscript: true },
      // The harness's contract, and the same declaration the local target makes:
      // one task handed over, nobody reading the answer. It is also the only
      // thing that arms the completion gate, so an interactive declaration would
      // make `completion_honesty` structurally unscoreable on this arm alone.
      oneShot: true,
    });
  }

  get describe(): string {
    return `cloud staging (${this.why}) · ${this.origin} · workspace ${this.workspace} `
      + `· model ${this.opts.llm.model}`;
  }

  get llm(): LLMProviderConfig {
    return this.opts.llm;
  }

  /**
   * One user turn through the REAL Think loop, awaited to settle.
   *
   * `CloudAgentClient.send` resolves when the DO reports the turn ended, so the
   * ledger rows every reader below depends on are written by the time this
   * returns. There is no `settleBackgroundWork` counterpart and there must not
   * be: a cloud agent's detached jobs settle server-side inside the DO, which
   * outlives the client — `AgentClient.settleBackgroundWork` is documented local
   * only for exactly that reason. A background job's own rows therefore land
   * whether or not this process is still listening, which is a property of the
   * platform and not a gap in the target.
   */
  async sendTurn(text: string): Promise<void> {
    await infraBoundary(`turn on ${this.origin}/${this.workspace}`, () => this.client.send(text));
  }

  /**
   * The whole run-event log, walked run by run over RPC.
   *
   * Two calls per run because that is the deployed surface: `listRuns` pages the
   * run ids and `getRunEvents` returns one run's events. Parsed through
   * `RunEventSchema` — core's canonical union, the same declaration the local
   * recorder validates against — so a field the deployment adds is a parse
   * failure here rather than a silently dropped fact.
   */
  async runEvents(): Promise<readonly RunEvent[]> {
    const events: RunEvent[] = [];
    let cursor: { after: string } | null = null;
    for (;;) {
      const page: v.InferOutput<typeof RunPageSchema> =
        await this.rpc('listRuns', RunPageSchema, [cursor === null ? {} : { cursor }]);
      for (const run of page.items) {
        events.push(...await this.rpc('getRunEvents', RunEventsSchema, [run.runId]));
      }
      if (page.status === 'end') break;
      cursor = page.next;
    }
    events.sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp)
      || a.runId.localeCompare(b.runId)
      || a.eventIndex - b.eventIndex);
    return events;
  }

  /**
   * What this workspace spent, from the deployment's own `workspaceSpend`.
   *
   * `getActivitySnapshot().spend` IS `workspaceSpend({ events, sql })` computed
   * inside the DO, so this arm reports through the same read model as every other
   * arm and the meter has one definition of what a workspace spent. No `steps`
   * argument: it bounds the snapshot's step TELEMETRY, which this does not read,
   * and the spend half is no longer windowed at all.
   * The two figures NOT read here are deliberate: `getRunSummaries`' cost fold
   * answers a narrower question, and `budget.snapshot()` a third — the
   * orchestrator's own comment says two mission figures on one panel teach a
   * reader to distrust both.
   */
  spend(): Promise<WorkspaceSpend> {
    return this.rpc('getActivitySnapshot', ActivitySpendSchema).then((snapshot) => snapshot.spend);
  }

  /**
   * What this deployment can do, and whether an `exec-ratio` measurement harness
   * can RUN on it.
   *
   * The production failure the verifier half reproduces: `exec-ratio` writes a
   * `.mjs` file and runs `node` on it, the Nimbus `node` shim resolves
   * `esbuild-wasm` to its Node entrypoint, and that rejects the `wasmModule`
   * option outright — so the transform fails, no RESULT line is printed, and the
   * instrument reports `unavailable`. A probe that asked whether a shell EXISTS
   * answered yes throughout.
   *
   * THE PROBE IS THE SEAM'S, and that is the load-bearing half: this arm differs
   * from the local one only in the executor pre-check below, so everything after
   * it is `probeVerifier` rather than a second copy of the sequence claiming in a
   * comment that it addresses the same module and marker.
   *
   * A missing executor is reported as unavailable rather than thrown: which
   * planes the deployment offered is the useful half of that answer, and a throw
   * would lose it.
   */
  async probe(): Promise<EvalTargetProbe> {
    const executors: readonly EvalExecutor[] = await this.rpc('getExecutors', ExecutorListSchema);
    if (!executors.some((executor) => executor.name === WORKSPACE_EXECUTOR)) {
      return {
        executors,
        verifier: {
          kind: 'unavailable',
          reason: `this workspace exposes no \`${WORKSPACE_EXECUTOR}\` executor, so no measured `
            + `task can run its harness. It offered: `
            + `${executors.map((e) => `${e.name}(${e.kind})`).join(', ') || 'nothing'}`,
        },
      };
    }
    return { executors, verifier: await probeVerifier(this.workspaceFiles()) };
  }

  /**
   * The workspace filesystem, over the executor RPCs a credentialed operator has.
   *
   * WRITES GO THROUGH THE SHELL because `writeExecutorFile` is not on
   * `AGENT_RPC_ACCESS` — the deployed write path is the web file manager's, not a
   * CLI-plane one. `base64 -d` rather than a heredoc: the bytes a task seeds
   * include quotes and newlines, and a shell-quoted payload is a correctness
   * hazard in the one place a test must not have one.
   */
  workspaceFiles(): EvalTargetWorkspace {
    const exec = async (command: string): Promise<{ stdout: string; exitCode: number }> => {
      const result = await this.rpc('executeInExecutor', ExecResultSchema, [WORKSPACE_EXECUTOR, command]);
      if (result.error !== undefined) {
        return { stdout: result.error, exitCode: result.exitCode ?? 1 };
      }
      return { stdout: result.stdout ?? '', exitCode: result.exitCode ?? 0 };
    };
    const shellQuote = (path: string): string => `'${path.replaceAll("'", `'\\''`)}'`;
    return {
      exec,
      vfs: {
        readFile: async (path) => {
          const read = await this.rpc('readExecutorFile', FileReadSchema, [WORKSPACE_EXECUTOR, path]);
          if (read.error !== undefined) throw new Error(`cloud readFile ${path}: ${read.error}`);
          if (read.truncated === true) {
            throw new Error(`cloud readFile ${path}: the deployment truncated it, so the bytes a `
              + 'verifier would grade are not the bytes on disk');
          }
          return read.content ?? '';
        },
        writeFile: async (path, data) => {
          const bytes = data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(data, 'utf8');
          const quoted = shellQuote(path);
          const run = await exec(
            `mkdir -p "$(dirname ${quoted})" && printf %s ${shellQuote(bytes.toString('base64'))}`
            + ` | base64 -d > ${quoted}`,
          );
          if (run.exitCode !== 0) throw new Error(`cloud writeFile ${path}: ${run.stdout}`);
        },
        readdir: async (path) => {
          const listing = await this.rpc('getExecutorFiles', DirListSchema, [WORKSPACE_EXECUTOR, path]);
          if (listing.error !== undefined) throw new Error(`cloud readdir ${path}: ${listing.error}`);
          return (listing.entries ?? []).map((entry) => entry.name);
        },
        stat: async (path) => {
          const run = await exec(`stat -c '%s %Y %F' ${shellQuote(path)}`);
          if (run.exitCode !== 0) return null;
          const [size, mtime, ...kind] = run.stdout.trim().split(' ');
          return {
            size: Number(size ?? 0),
            mtimeMs: Number(mtime ?? 0) * 1000,
            isDir: kind.join(' ') === 'directory',
          };
        },
        unlink: async (path) => {
          const run = await exec(`rm -f ${shellQuote(path)}`);
          if (run.exitCode !== 0) throw new Error(`cloud unlink ${path}: ${run.stdout}`);
        },
        mkdir: async (path) => {
          const run = await exec(`mkdir -p ${shellQuote(path)}`);
          if (run.exitCode !== 0) throw new Error(`cloud mkdir ${path}: ${run.stdout}`);
        },
        exists: async (path) => (await exec(`test -e ${shellQuote(path)}`)).exitCode === 0,
      },
    };
  }

  /** The same five questions the local target answers, over the five RPCs the
   *  root-cause investigation used to prove no node had spawned. */
  async searchLedger(): Promise<EvalSearchLedger> {
    const [searchRuns, forkRuns, canvas, objectives, jobs] = await Promise.all([
      this.rpc('getMctsSearchRuns', SearchRunsSchema, [LEDGER_PAGE]),
      this.rpc('listForkRuns', CountedPageSchema, [{ limit: LEDGER_PAGE }]),
      this.rpc('getExplorationCanvas', CountedPageSchema, [{ limit: LEDGER_PAGE }]),
      this.rpc('listRecordObjectives', CountedPageSchema, [{ limit: LEDGER_PAGE }]),
      this.rpc('listBackgroundJobs', JobsSchema, [LEDGER_PAGE]),
    ]);
    return {
      searchRuns: searchRuns.length,
      forkRuns: forkRuns.items.length,
      canvasNodes: canvas.items.length,
      recordObjectives: objectives.items.length,
      backgroundJobs: jobs.length,
    };
  }

  async roster(): Promise<readonly string[]> {
    const entries = await this.rpc('listSubordinates', RosterSchema);
    return entries.map((entry) => entry.name).sort();
  }

  /**
   * Delete the workspace, then close the socket.
   *
   * In that order: closing first would leave the deletion to a client that is no
   * longer connected, and a run that threw must not leave a row on the account.
   * The DELETE is an infra boundary like every other network call — a teardown
   * that fails is the deployment failing, not the agent.
   */
  async teardown(): Promise<void> {
    try {
      await infraBoundary(`DELETE ${this.origin}/api/cli/workspaces/${this.workspace}`, () =>
        deleteCloudAgent(this.origin, this.opts.token, this.workspace));
    } finally {
      await this.client.close();
    }
  }

  /** One RPC, labelled as the deployment's boundary. Every read in this class
   *  goes through it, so no call site can forget the classification. */
  private rpc<T>(method: string, schema: v.GenericSchema<T>, args: JsonValue[] = []): Promise<T> {
    return infraBoundary(`${method} on ${this.origin}/${this.workspace}`, () =>
      callAgentRpc(this.origin, this.opts.token, this.workspace, method, schema, args));
  }
}

