/**
 * One arm of the OMP measurement (variant 1, replay as evidence), on this machine behind the inert boundary:
 *
 *   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… bun evals/omp/run.ts --data /mnt/local/kinu/datasets/omp/proteus \
 *     --snapshot /mnt/local/kinu/wt/omp-f2fa713f7 --arm dreaming --out /mnt/local/kinu/datasets/omp/proteus/runs/pilot
 *
 * `dreaming` rates the last `--train-last` training turns from the person's real next messages and dreams over them as
 * the lane would; `off` learns nothing. Then each arm answers the frozen held-out requests (`--held-out`, drawn once,
 * shared by every arm), each in a cleared conversation. Every call Plan would refuse is kept and recorded; a kept shell
 * command is answered from the held-out turn's own record where it ran the same one. The only way out is the model's
 * host. Writes `<out>/<arm>/answers.jsonl` and `<out>/<arm>/run.json`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import * as v from 'valibot';
import { EvolutionEngine, historyTurnPairs, type AgentRuntime, type CompletedTurn, type JsonValue, type LLMProviderConfig } from '../../packages/core/src/index';
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

/** Passes a dream may take to settle, its helpers' turns between them, before the run moves on without it. */
const DREAM_PASSES = 40;

const SETTLED = new Set(['applied', 'rolled_back', 'refused']);

const MODEL_HOST = 'api.cloudflare.com:443';

/**
 * What a kept call with no record answers in this run, the same for every arm: on this machine Plan runs no shell
 * command or program, so the one way to read the folder is named (a smoke run's agent gave up reading without it).
 */
const KEPT = 'Not run: this session is measured, so shell commands and programs do not run. Read the folder with the file tool '
  + '(op read, list or search); the call is kept as what you meant to do.';

interface Kept { readonly name: string; readonly input: JsonValue; readonly refused: readonly string[]; readonly answered: boolean }

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

/** Passes until the dreams owed have settled, the helpers' turns run between them; how many it took. */
async function dream(run: { readonly lane: () => Promise<void>; readonly tick: () => Promise<void>; readonly rt: Pick<AgentRuntime, 'storage' | 'actor'> }): Promise<number> {
  for (let pass = 1; pass <= DREAM_PASSES; pass += 1) {
    await run.lane();
    await run.tick();

    if (createRefinementStore(run.rt.storage.sql, run.rt.actor).list(DREAM_CADENCE).every((request) => SETTLED.has(request.stage))) return pass;
  }

  return DREAM_PASSES;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: {
    data: { type: 'string' }, snapshot: { type: 'string' }, arm: { type: 'string' }, out: { type: 'string' },
    spec: { type: 'string', default: 'workers-ai/@cf/zai-org/glm-5.3' }, 'held-out': { type: 'string', default: '40' },
    'train-last': { type: 'string', default: '250' }, seed: { type: 'string', default: '1' },
    /** Only the first this many frozen requests: a smoke run, never a measurement. */
    first: { type: 'string' },
  } });

  const { data, snapshot, arm, out, spec } = values;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;

  if (data === undefined || snapshot === undefined || out === undefined || (arm !== 'dreaming' && arm !== 'off')) {
    throw new Error('--data, --snapshot, --out and --arm dreaming|off are required');
  }

  if (account === undefined || token === undefined) throw new Error('set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
  const train = ownerTurnsFrom(readFileSync(join(data, 'train.jsonl'), 'utf8'));
  const heldOut = ownerTurnsFrom(readFileSync(join(data, 'held-out.jsonl'), 'utf8'));
  const frozen = frozenSet(data, heldOut, Number(values['held-out']), Number(values.seed));
  const space = join(out, arm);
  mkdirSync(space, { recursive: true });
  const egress = limitEgress([MODEL_HOST]);
  const started = Date.now();

  // The kept calls of the request being answered, and what its own record answers a kept shell command with.
  let kept: Kept[] = [];
  let fromRecord: (name: string, input: JsonValue) => string | null = () => null;

  const boundary = {
    intended: (call: { readonly name: string; readonly input: JsonValue; readonly refused: readonly string[] }) => {
      kept.push({ ...call, answered: fromRecord(call.name, call.input) !== null });
    },
    recorded: (name: string, input: JsonValue) => fromRecord(name, input) ?? KEPT,
  };

  const llm = workersAi(account, token, spec.replace(/^workers-ai\//u, ''));
  const dbPath = join(space, 'agent.db');
  const seedDb = workspaceDatabase(dbPath);

  try {
    await createWorkspace(seedDb, { name: 'root', purpose: 'Answer the requests of the measured sessions.', home: workspaceHome(seedDb) });
  } finally {
    seedDb.close();
  }

  const host = new LocalAgentHost({
    roster: () => [{ name: 'root', cwd: snapshot, workspaceId: `omp-${arm}` }],
    dbPath: () => dbPath,
    open: async (_ref, db, path) => {
      const openConfig = { llm, defaultSpec: spec, cwd: snapshot, boundary };
      const { rt } = await openWorkspaceCLI(db, path, openConfig);
      rt.actor.config.setLearning(arm === 'dreaming');

      return { rt, openConfig, modelResolver: createLocalModelResolver({ llm, defaultSpec: spec }) };
    },
  });

  // The turns each held-out request ran, as their ends report them.
  const ended: CompletedTurn[] = [];

  const unsubscribe = host.subscribe((key, event) => {
    if (key === 'root' && event.type === 'turn-end') ended.push(event.turn);
  });

  try {
    const session = await host.acquire('root');
    const rt = await host.runtime('root');
    const trained = arm === 'dreaming' ? train.filter((turn) => turn.followup !== null).slice(-Number(values['train-last'])) : [];
    const engine = new EvolutionEngine(rt, historyTurnPairs(rt.stores.history));
    let dreamPasses = 0;

    for (const [at, turn] of trained.entries()) {
      await engine.reviewTurn(turn.turn, turn.followup?.text ?? '');

      if ((at + 1) % DREAM_CADENCE === 0) dreamPasses += await dream({ lane: () => session.runRefinementLane(), tick: async () => { await host.tick('root'); }, rt });
    }

    const trainedAt = Date.now();

    for (const id of frozen.turnIds.slice(0, values.first === undefined ? undefined : Number(values.first))) {
      const turn = heldOut.find((candidate) => candidate.turn.turnId === id);

      if (turn === undefined) throw new Error(`held-out turn ${id} is not in held-out.jsonl`);
      kept = [];
      ended.length = 0;
      fromRecord = shellFromRecord(recordedShell(turn));
      const askedAt = Date.now();
      await session.send(turn.turn.userMessage, { id: crypto.randomUUID() });
      const ran = ended.at(-1);

      appendFileSync(join(space, 'answers.jsonl'), `${JSON.stringify({
        turnId: id, request: turn.turn.userMessage, answer: ran?.assistantResponse ?? null, calls: ran?.toolCalls.map((call) => call.name) ?? [],
        kept, ms: Date.now() - askedAt,
      })}\n`);
      await session.clearConversation();
    }

    const evolution = armEvolution({ refinements: session.listRefinements(200), changelog: session.getEvolutionChangelog(200).entries });

    writeFileSync(join(space, 'run.json'), `${JSON.stringify({
      arm, spec, snapshot, heldOut: { count: frozen.turnIds.length, digest: frozen.digest }, trained: trained.length, dreamPasses, evolution,
      egressRefused: egress.refused, trainMs: trainedAt - started, heldOutMs: Date.now() - trainedAt,
    }, null, 2)}\n`);
  } finally {
    unsubscribe();
    await host.close();
    egress.stop();
  }
}
