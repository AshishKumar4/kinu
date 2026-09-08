/**
 * Branch worker process — runs inside a forked child process.
 *
 * Each MCTS branch gets its own isolated SQLite database. The worker loads
 * crafted tools from the parent database, so a branch uses what the agent
 * learned during exploration.
 *
 * The whole wire lives in branch-protocol.ts. This file parses calls with
 * BranchCallSchema and answers with BranchReplySchema.
 *
 * There is deliberately no 'evaluate' method: branch scoring happens in the
 * parent process at the engine seam (core mcts/evaluation.ts), grounded in
 * execution — branches must not rate themselves.
 */

import { Database } from 'bun:sqlite';
import {
  DEFAULT_WORKERS_AI_MODEL_ID, FacetIdentity, WorkspaceActorDirectory,
  exploreRollout,
  formatInheritedContext,
  parseModelSpec,
  reasoningEffortOptions, REASONING_EFFORT_FOR_STAGE,
  reflectRollout,
  type BranchRoute,
  type ExploreToolHint,
  type JsonValue,
  type LLMProviderConfig,
} from '@kinu.run/core';
import { diagnostics, KinuError, renderThrownChain } from '@kinu.run/core/obs';
import * as v from 'valibot';
import {
  BRANCH_EXPLORE, BRANCH_READY, BRANCH_REFLECT,
  BranchCallSchema, BranchCallAttributionSchema,
  type BranchReply,
} from './branch-protocol';
import { createLocalModelResolver, type LocalProviderCredentials } from './model-resolver';
import { createFileCodexAuthStore } from './codex-auth-store';
import { LocalActorProcessBootstrapSchema } from './actor-identity';
import { makeSql, makeSqlExec } from './runtime';
const dbPath = process.argv[2];
if (!dbPath) {
  diagnostics.failure(
    'branch.worker_missing_db_path',
    new KinuError('bad_input', 'branch worker started without a database path'),
  );
  process.exit(1);
}

const stringMapSchema = v.record(v.string(), v.string());
const localProviderCredentialsSchema = v.object({
  openaiApiKey: v.optional(v.string()),
  anthropicApiKey: v.optional(v.string()),
  openrouterApiKey: v.optional(v.string()),
  codexAccessToken: v.optional(v.string()),
  openaiCompat: v.optional(v.record(v.string(), v.object({
    baseURL: v.string(),
    apiKey: v.optional(v.string()),
    headers: v.optional(stringMapSchema),
    extraHeaders: v.optional(stringMapSchema),
  }))),
});

/** The parent's default endpoint, or null when the parent had none: an empty
 *  KINU_LLM_NAME is that absence, and bare ids then fail at resolution with
 *  the fixes named — exactly as they would in the parent. */
const llmConfig: LLMProviderConfig | null = process.env.KINU_LLM_NAME
  ? {
    name: process.env.KINU_LLM_NAME,
    baseURL: process.env.KINU_BASE_URL ?? '',
    headers: readJson(stringMapSchema, process.env.KINU_LLM_HEADERS) ?? {
      Authorization: process.env.KINU_AUTH ?? '',
    },
    model: process.env.KINU_MODEL ?? DEFAULT_WORKERS_AI_MODEL_ID,
  }
  : null;

const credentials: LocalProviderCredentials = readJson(
  localProviderCredentialsSchema,
  process.env.KINU_PROVIDER_CREDENTIALS,
) ?? {};
if (process.env.CODEX_ACCESS_TOKEN) credentials.codexAccessToken = process.env.CODEX_ACCESS_TOKEN;

const modelResolver = createLocalModelResolver({
  llm: llmConfig,
  credentials,
  codexAuthStore: process.env.KINU_CONFIG_PATH
    ? createFileCodexAuthStore(process.env.KINU_CONFIG_PATH)
    : undefined,
});

const encodedBootstrap = process.env.KINU_ACTOR_BOOTSTRAP;
if (!encodedBootstrap) throw new KinuError('missing', 'The branch has no root-issued actor bootstrap.');
const bootstrap = v.parse(LocalActorProcessBootstrapSchema, JSON.parse(encodedBootstrap));
const rootDb = new Database(bootstrap.rootDbPath, { readonly: true });
const rootSql = makeSql(rootDb);
const owner = rootSql<{ id: string; name: string; owner_user_id: string }>`SELECT id, name, owner_user_id FROM workspace_identity`[0];
if (!owner || owner.id !== bootstrap.reference.workspaceId) throw new KinuError('denied', 'The branch belongs to a different workspace.');
const directory = new WorkspaceActorDirectory(rootSql, { workspaceId: owner.id, ownerUserId: owner.owner_user_id });
const validateActor = () => {
  const entry = directory.apply(bootstrap.parent, bootstrap.parentStoragePath, { action: 'validate', name: bootstrap.name, reference: bootstrap.reference });
  if (entry.storageKey !== bootstrap.storageKey || entry.kind !== 'branch') throw new KinuError('denied', 'The branch physical identity does not match its directory record.');
};
validateActor();
const db = new Database(dbPath);
db.exec('PRAGMA journal_mode = WAL');
new FacetIdentity(makeSqlExec(db)).seed({ actor: { ...bootstrap.reference, name: bootstrap.name, storageKey: bootstrap.storageKey },
  ownerUserId: owner.owner_user_id, parentWorkspace: owner.name, capabilityToken: null });
db.exec(`CREATE TABLE IF NOT EXISTS traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  step INTEGER NOT NULL, text TEXT NOT NULL
)`);

// Crafted tools from the parent workspace DB. Both tables it reads are
// provisioned by the parent runtime before it forks (initWorkspaceSchema /
// initAgentConfigTable), so a failure here is a broken parent, not an old one.
let craftedTools: ExploreToolHint[] = [];
let parentDb: Database | null = null;
const parentDbPath = process.env.KINU_PARENT_DB;
if (parentDbPath) {
  parentDb = new Database(parentDbPath, { readonly: true });
  craftedTools = parentDb.query<ExploreToolHint, []>('SELECT name, description FROM crafted_tools').all();
}

process.on('message', async (rawMessage: JsonValue) => {
  validateActor();
  const parsed = v.safeParse(BranchCallSchema, rawMessage);
  if (!parsed.success) {
    const attributed = v.safeParse(BranchCallAttributionSchema, rawMessage);
    if (!attributed.success) {
      diagnostics.failure(
        'branch.call_malformed',
        new KinuError(
          'bad_input',
          `branch call carries no usable id or method: ${parsed.issues.map((issue) => issue.message).join('; ')}`,
        ),
      );
      return;
    }
    const { id, method } = attributed.output;
    send({
      method,
      id,
      error: `branch call is not a well-formed ${method} call: ${parsed.issues.map((issue) => issue.message).join('; ')}`,
    });
    return;
  }
  const msg = parsed.output;
  try {
    switch (msg.method) {
      case BRANCH_EXPLORE: {
        const { history, siblings } = msg.args;
        const [language, ...alternates] = msg.args.languages;
        if (!language) throw new Error('Branch exploration requires at least one executor language');
        const languages: [string, ...string[]] = [language, ...alternates];
        const result = await exploreRollout(lowEffortRoute(), {
          mode: msg.args.mode,
          context: formatInheritedContext(history),
          craftedTools,
          languages,
          siblings,
        });
        db.run('INSERT INTO traces (step, text) VALUES (?, ?)', [1, result.text]);
        // The spend travels back with the proposal: this process resolves its
        // own model, so the parent's mission ledger cannot see the call any
        // other way (mcts/engine.ts debits it).
        send({ method: msg.method, id: msg.id, result });
        break;
      }
      case BRANCH_REFLECT: {
        // The branch's own trace table holds the attempt this reflection is
        // about; `outcome` carries the environment's verdict, which lives on the
        // engine side and reaches this process no other way.
        const traces = db.query<{ text: string }, []>('SELECT text FROM traces ORDER BY step').all();
        const result = await reflectRollout(lowEffortRoute(), {
          task: msg.args.task,
          attempt: traces.map((trace) => trace.text).join('\n'),
          outcome: msg.args.outcome,
        });
        send({ method: msg.method, id: msg.id, result });
        break;
      }
    }
  } catch (err) {
    // Always carry a message: an empty one reads as "no error" to any
    // presence-checking caller and hides the real failure.
    send({ method: msg.method, id: msg.id, error: renderThrownChain({ cause: err }) || 'branch worker failed' });
  }
});

/** A forked worker always has its parent's IPC channel. The throw states the
 *  invariant without a non-null assertion. */
function send(reply: BranchReply): void {
  if (!process.send) throw new KinuError('unavailable', 'branch worker has no IPC channel to its parent');
  process.send(reply);
}

send({ method: BRANCH_READY });

process.once('exit', () => {
  parentDb?.close();
  rootDb.close();
  db.close();
});

function readStoredModelSpec(): string | null {
  validateActor();
  const row = parentDb?.query<{ value: string }, [string]>("SELECT value FROM actor_config WHERE actor_id = ? AND key = 'model' LIMIT 1").get(bootstrap.parent.actorId);
  return row?.value ?? null;
}

/** The stored chat model at rollout effort: what a rollout in this process runs. */
function lowEffortRoute(): BranchRoute {
  const spec = modelResolver.normalizeSpecSync(readStoredModelSpec());
  const providerOptions = reasoningEffortOptions(
    REASONING_EFFORT_FOR_STAGE.mcts_rollout, parseModelSpec(spec).provider,
  );
  const route: BranchRoute = { model: modelResolver.resolveModel(spec) };
  return providerOptions ? { ...route, providerOptions } : route;
}

function readJson<T>(schema: v.GenericSchema<T>, raw: string | undefined): T | null {
  return raw ? v.parse(schema, JSON.parse(raw)) : null;
}
