/**
 * One arm of the OMP measurement (variant 1, replay as evidence), on this machine behind the inert boundary, in two
 * phases:
 *
 *   bun evals/omp/run.ts --phase prepare --data <dataset> --snapshot <worktree> --arm dreaming|off --spec <model> --out <dir>
 *   bun evals/omp/run.ts --phase answer --copy 0 --of 4 …the same…
 *
 * `prepare` opens the arm's workspace under `<out>/<model>/<arm>/base`: `dreaming` rates the last `--train-last`
 * training turns from the person's real next messages and dreams over them as the lane would; `off` learns nothing.
 * `answer` answers every `--of`-th frozen held-out request from `--copy`, each on its own copy of that workspace, removed
 * once its answer is written: nothing a request leaves running or writes reaches the next. A request's answer is its
 * root's last turn once the whole tree has settled, its hires' turns and the turns their reports wake included; the jobs
 * still running then stop without a wake. Answering rates nothing, so no request learns from another. Every call Plan would refuse
 * is kept and recorded, and a kept shell command is answered from the held-out turn's own record where it ran the same
 * one. The only way out is the model's host. No request is cut short: it ends on completion or failure, and where its
 * time went (model calls, rate-limit waits, tool calls) is written beside its answer.
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import * as v from 'valibot';
import { EvolutionEngine, historyTurnPairs, type AgentRuntime, type CompletedTurn, type JobRetirement, type JsonValue, type LLMProviderConfig } from '../../packages/core/src/index';
import { createConsoleLogger, renderThrownChain, setDiagnosticsSink, type Logger } from '../../packages/core/src/obs/index';
import { createWorkspace } from '../../packages/core/src/workspace-birth';
import { createRefinementStore } from '../../packages/core/src/evolution/refinement';
import { createLocalModelResolver, LocalAgentHost, openWorkspaceCLI, workspaceHome } from '../../packages/cli-backend/src/index';
import { workspaceDatabase } from '../../packages/test-utils/src/index';
import { ownerTurnsFrom, type OwnerTurn } from '../src/omp';
import { freezeHeldOut, FrozenHeldOutSchema, recordedShell, shellFromRecord, type FrozenHeldOut } from '../src/omp-run';
import { limitEgress } from '../src/omp-egress';
import { armEvolution } from '../src/reactive';

/** A dream is owed every five rated turns, as the cadence takes them. */
const DREAM_CADENCE = 5;

/** Passes a dream may take to settle, its subagents' turns between them, before the run moves on without it. */
const DREAM_PASSES = 40;

const SETTLED = new Set(['applied', 'rolled_back', 'refused']);

const MODEL_HOST = 'api.cloudflare.com:443';

/**
 * What a kept call with no record answers in this run, the same for every arm: on this machine Plan runs no shell
 * command or program, so the one way to read the folder is named (a smoke run's agent gave up reading without it).
 */
const KEPT = 'Not run: this session is measured, so shell commands and programs do not run. Read the folder with the file tool '
  + '(op read, list or search); the call is kept as what you meant to do.';

/** How long a provider said to wait, from its `waiting 1m` or `waiting 30s`. */
const WAITED = /waiting (\d+)(m|s)\b/u;

interface Kept { readonly name: string; readonly input: JsonValue; readonly refused: readonly string[]; readonly answered: boolean }

/** Where a request's time went, from the diagnostics its calls wrote. */
interface Spent { modelCalls: number; modelOpenMs: number; rateLimits: number; rateLimitWaitMs: number }

const spentNothing = (): Spent => ({ modelCalls: 0, modelOpenMs: 0, rateLimits: 0, rateLimitWaitMs: 0 });

/** The console's logger, tallying into `spent()` the model calls and rate-limit waits it sees. */
function tallying(spent: () => Spent): Logger {
  const console = createConsoleLogger();

  return {
    event: (name, fields) => {
      if (name === 'provider.stream_opened') {
        spent().modelCalls += 1;
        const opened = v.safeParse(v.object({ ms: v.number() }), fields);
        spent().modelOpenMs += opened.success ? opened.output.ms : 0;
      }

      console.event(name, fields);
    },
    failure: (name, error, fields) => {
      if (name === 'provider.rate_limited') {
        const waited = WAITED.exec(error.message);
        spent().rateLimits += 1;
        spent().rateLimitWaitMs += waited === null ? 0 : Number(waited[1]) * (waited[2] === 'm' ? 60_000 : 1_000);
      }

      console.failure(name, error, fields);
    },
  };
}

function workersAi(account: string, token: string, model: string): LLMProviderConfig {
  return { name: 'workers-ai', baseURL: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1`, headers: { Authorization: `Bearer ${token}` }, model };
}

function frozenSet(data: string, heldOut: readonly OwnerTurn[], count: number, seed: number): FrozenHeldOut {
  const path = join(data, 'held-out-frozen.json');

  if (existsSync(path)) return v.parse(v.pipe(v.string(), v.parseJson(), FrozenHeldOutSchema), readFileSync(path, 'utf8'));
  const frozen = freezeHeldOut(heldOut, { count, seed });
  writeFileSync(path, `${JSON.stringify(frozen, null, 2)}\n`);

  return frozen;
}

/** Passes until the dreams owed have settled, the subagents' turns run between them; how many it took. */
async function dream(run: { readonly lane: () => Promise<void>; readonly tick: () => Promise<void>; readonly rt: Pick<AgentRuntime, 'storage' | 'actor'> }): Promise<number> {
  for (let pass = 1; pass <= DREAM_PASSES; pass += 1) {
    await run.lane();
    await run.tick();

    if (createRefinementStore(run.rt.storage.sql, run.rt.actor).list(DREAM_CADENCE).every((request) => SETTLED.has(request.stage))) return pass;
  }

  return DREAM_PASSES;
}

interface Arm {
  readonly arm: 'dreaming' | 'off';
  readonly spec: string;
  readonly llm: LLMProviderConfig;
  readonly snapshot: string;
  /** This arm's workspace folder: its database and its files. */
  readonly space: string;
}

/** The arm's agent over the workspace in `space`, behind the boundary; `record` takes what the run must keep. */
function armHost(arm: Arm, boundary: { intended: (call: { readonly name: string; readonly input: JsonValue; readonly refused: readonly string[] }) => void; recorded: (name: string, input: JsonValue) => string }): LocalAgentHost {
  return new LocalAgentHost({
    roster: () => [{ name: 'root', cwd: arm.snapshot, workspaceId: `omp-${arm.arm}` }],
    dbPath: () => join(arm.space, 'agent.db'),
    open: async (_ref, db, path) => {
      const openConfig = { llm: arm.llm, defaultSpec: arm.spec, cwd: arm.snapshot, boundary };
      const { rt } = await openWorkspaceCLI(db, path, openConfig);
      rt.actor.config.setLearning(arm.arm === 'dreaming');

      return { rt, openConfig, modelResolver: createLocalModelResolver({ llm: arm.llm, defaultSpec: arm.spec }) };
    },
  });
}

async function prepare(arm: Arm, train: readonly OwnerTurn[], last: number): Promise<void> {
  const seedDb = workspaceDatabase(join(arm.space, 'agent.db'));

  try {
    await createWorkspace(seedDb, { name: 'root', purpose: 'Answer the requests of the measured sessions.', home: workspaceHome(seedDb) });
  } finally {
    seedDb.close();
  }

  const spent = spentNothing();
  const restore = setDiagnosticsSink(tallying(() => spent));
  const host = armHost(arm, { intended: () => {}, recorded: () => KEPT });
  const started = Date.now();

  try {
    const session = await host.acquire('root');
    const rt = await host.runtime('root');
    const trained = arm.arm === 'dreaming' ? train.filter((turn) => turn.followup !== null).slice(-last) : [];
    const engine = new EvolutionEngine(rt, historyTurnPairs(rt.stores.history));
    let dreamPasses = 0;

    // A review the provider fails (a fast-tier call past Workers AI's ten minutes, 2026-10-20) is that turn's alone, as in
    // a workspace: the arm is prepared from the reviews that answered, and says how many did not.
    const unreviewed: { readonly turnId: string | null; readonly reason: string }[] = [];

    for (const [at, turn] of trained.entries()) {
      const [review] = await Promise.allSettled([engine.reviewTurn(turn.turn, turn.followup?.text ?? '')]);

      if (review.status === 'rejected') unreviewed.push({ turnId: turn.turn.turnId ?? null, reason: renderThrownChain({ cause: review.reason }).slice(0, 500) });

      if ((at + 1) % DREAM_CADENCE === 0) dreamPasses += await dream({ lane: () => session.runRefinementLane(), tick: async () => { await host.tick('root'); }, rt });
    }

    const evolution = armEvolution({ refinements: session.listRefinements(200), changelog: session.getEvolutionChangelog(200).entries });
    writeFileSync(join(arm.space, 'prepared.json'), `${JSON.stringify({ ...arm, llm: undefined, trained: trained.length, unreviewed, dreamPasses, evolution, spent, ms: Date.now() - started }, null, 2)}\n`);
  } finally {
    await host.close();
    restore();
  }
}

/** One request on its own copy of the prepared workspace at `prepared`, as the line its answers file keeps. */
/** The held-out turns a copy's answers file already holds: a copy restarted after its process died asks only the rest. A
 *  line the dead process left torn is no answer, and its request is asked again. */
export function answeredTurnIds(answers: string): Set<string> {
  if (!existsSync(answers)) return new Set();

  return new Set(readFileSync(answers, 'utf8').split('\n').flatMap((line) => {
    const row = v.safeParse(v.pipe(v.string(), v.parseJson(), v.object({ turnId: v.string() })), line);

    return row.success ? [row.output.turnId] : [];
  }));
}

/** How often a request the provider refused before any model call is asked again, and how many times at most: a declared
 *  wait past the minute a call waits (Workers AI's, minutes long) is waited out, and an hour of refusals gives up. */
const UNASKED_RETRY_MS = 60_000;

const UNASKED_ATTEMPTS = 60;

/** A request's answer row once it was asked: one the provider refused before any model call is no measurement, so it
 *  is asked again (on a fresh copy, as every ask is) after `retryMs`, up to `attempts` times; the last row stands. */
export async function askedRow<Row extends { readonly answer: string | null; readonly spent: { readonly modelCalls: number } }>(
  ask: () => Promise<Row>, wait: (ms: number) => Promise<void>, retryMs = UNASKED_RETRY_MS, attempts = UNASKED_ATTEMPTS,
): Promise<Row> {
  for (let attempt = 1; ; attempt++) {
    const row = await ask();

    if (row.answer !== null || row.spent.modelCalls > 0 || attempt >= attempts) return row;
    await wait(retryMs);
  }
}

async function answered(arm: Arm, prepared: string, turn: OwnerTurn) {
  // The kept calls of the request, what its own record answers a kept shell command with, and where its time went.
  const kept: Kept[] = [];
  const fromRecord = shellFromRecord(recordedShell(turn));
  const spent = spentNothing();
  const restore = setDiagnosticsSink(tallying(() => spent));

  rmSync(arm.space, { recursive: true, force: true });
  cpSync(prepared, arm.space, { recursive: true });

  const host = armHost(arm, {
    intended: (call) => { kept.push({ ...call, answered: fromRecord(call.name, call.input) !== null }); },
    recorded: (name, input) => fromRecord(name, input) ?? KEPT,
  });

  // The turns the root ran, as their ends report them, and every agent of the tree that ran one.
  const ended: CompletedTurn[] = [];
  const agents = new Set(['root']);

  const unsubscribe = host.subscribe((key, event) => {
    agents.add(key);

    if (key === 'root' && event.type === 'turn-end') ended.push(event.turn);
  });

  try {
    const session = await host.acquire('root');
    const askedAt = Date.now();

    // A send settles once the request is admitted to its turn; the tree settles once nothing runs or is owed.
    await session.send(turn.turn.userMessage, { id: crypto.randomUUID() });
    await host.settle();
    const answeredAt = Date.now();
    const left: JobRetirement = { stopped: [], refused: [] };

    for (const agent of agents) {
      const retired = await host.peek(agent)?.retireJobs();

      left.stopped.push(...retired?.stopped ?? []);
      left.refused.push(...retired?.refused ?? []);
    }

    return {
      turnId: turn.turn.turnId, request: turn.turn.userMessage, answer: ended.at(-1)?.assistantResponse ?? null,
      calls: ended.flatMap((each) => each.toolCalls.map((call) => call.name)), turns: ended.length, agents: agents.size,
      leftRunning: left.stopped, refusedStop: left.refused, kept, spent, ms: answeredAt - askedAt,
    };
  } finally {
    unsubscribe();
    await host.close();
    restore();
    rmSync(arm.space, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: {
    phase: { type: 'string' }, data: { type: 'string' }, snapshot: { type: 'string' }, arm: { type: 'string' }, out: { type: 'string' },
    spec: { type: 'string', default: 'workers-ai/@cf/zai-org/glm-5.3' }, 'held-out': { type: 'string', default: '40' },
    'train-last': { type: 'string', default: '250' }, seed: { type: 'string', default: '1' },
    copy: { type: 'string', default: '0' }, of: { type: 'string', default: '1' },
  } });

  const { phase, data, snapshot, arm, out, spec } = values;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;

  if ((phase !== 'prepare' && phase !== 'answer') || data === undefined || snapshot === undefined || out === undefined || (arm !== 'dreaming' && arm !== 'off')) {
    throw new Error('--phase prepare|answer, --data, --snapshot, --out and --arm dreaming|off are required');
  }

  if (account === undefined || token === undefined) throw new Error('set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
  const model = spec.replace(/^workers-ai\//u, '');
  const base = join(out, model.replaceAll('/', '_'), arm);
  const egress = limitEgress([MODEL_HOST]);

  try {
    if (phase === 'prepare') {
      mkdirSync(join(base, 'base'), { recursive: true });
      await prepare({ arm, spec, snapshot, llm: workersAi(account, token, model), space: join(base, 'base') }, ownerTurnsFrom(readFileSync(join(data, 'train.jsonl'), 'utf8')), Number(values['train-last']));
    } else {
      const heldOut = ownerTurnsFrom(readFileSync(join(data, 'held-out.jsonl'), 'utf8'));
      const frozen = frozenSet(data, heldOut, Number(values['held-out']), Number(values.seed));
      const [copy, of] = [Number(values.copy), Number(values.of)];

      const requests = frozen.turnIds.filter((_, at) => at % of === copy).map((id) => {
        const turn = heldOut.find((candidate) => candidate.turn.turnId === id);

        if (turn === undefined) throw new Error(`held-out turn ${id} is not in held-out.jsonl`);

        return turn;
      });

      const answering: Arm = { arm, spec, snapshot, llm: workersAi(account, token, model), space: join(base, `copy-${String(copy)}`) };
      const answers = join(base, `answers-${String(copy)}.jsonl`);
      const done = answeredTurnIds(answers);

      for (const turn of requests.filter((request) => request.turn.turnId === undefined || !done.has(request.turn.turnId))) {
        const row = await askedRow(() => answered(answering, join(base, 'base'), turn), (ms) => Bun.sleep(ms));

        appendFileSync(answers, `${JSON.stringify(row)}\n`);
      }
    }

    if (egress.refused.length > 0) writeFileSync(join(base, `egress-refused-${phase}-${values.copy}.json`), `${JSON.stringify(egress.refused)}\n`);
  } finally {
    egress.stop();
  }
}
