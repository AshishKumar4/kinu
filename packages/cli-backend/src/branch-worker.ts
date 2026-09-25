/**
 * Branch worker, run in a forked child. Opens the workspace's one database and writes rollout traces
 * under its own actor id. No 'evaluate' method: scoring happens in the parent, never self-rated.
 */

import { Database } from 'bun:sqlite';
import {
  DEFAULT_WORKERS_AI_MODEL_ID, WorkspaceActorDirectory, agentAffinityKey,
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
} from '@kinu.run/core';
import { createLocalModelResolver, type LocalProviderCredentials } from './model-resolver';
import { createFileOAuthStore } from './oauth-store';
import { LocalActorProcessBootstrapSchema } from './actor-identity';
import { makeSql } from './runtime';

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

/** The parent's default endpoint; an empty KINU_LLM_NAME means none. */
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

const encodedBootstrap = process.env.KINU_ACTOR_BOOTSTRAP;

if (!encodedBootstrap) throw new KinuError('missing', 'The branch has no root-issued actor bootstrap.');

const bootstrap = v.parse(LocalActorProcessBootstrapSchema, JSON.parse(encodedBootstrap));

if (process.env.KINU_ROOT_DB !== bootstrap.rootDbPath) throw new KinuError('denied', 'The branch was pointed at a database its bootstrap does not name.');

// Set WAL here too: both processes hold the file, and a fixture-created database may not be in WAL.
const db = new Database(bootstrap.rootDbPath);

db.exec('PRAGMA journal_mode = WAL');

const sql = makeSql(db);

const owner = sql<{ id: string; name: string; owner_user_id: string }>`SELECT id, name, owner_user_id FROM workspace_identity`[0];

if (!owner || owner.id !== bootstrap.reference.workspaceId) throw new KinuError('denied', 'The branch belongs to a different workspace.');

const directory = new WorkspaceActorDirectory(sql, { workspaceId: owner.id, ownerUserId: owner.owner_user_id });

const validateActor = () => {
  const entry = directory.apply(bootstrap.parent, bootstrap.parentStoragePath, { action: 'validate', name: bootstrap.name, reference: bootstrap.reference });

  if (entry.storageKey !== bootstrap.storageKey || entry.kind !== 'branch') throw new KinuError('denied', 'The branch physical identity does not match its directory record.');
};

validateActor();

const modelResolver = createLocalModelResolver({
  llm: llmConfig,
  credentials,
  sessionAffinity: agentAffinityKey(bootstrap.name),
  oauthStore: process.env.KINU_CONFIG_PATH
    ? createFileOAuthStore(process.env.KINU_CONFIG_PATH)
    : undefined,
});

/** This branch's rollout attempt, held in process: one worker runs exactly one branch, so explore and reflect share it. */
const attempts: string[] = [];

// The parent provisions this table before forking (initWorkspaceSchema); a failure here is a broken parent.
const craftedTools: ExploreToolHint[] = db
  .query<ExploreToolHint, []>('SELECT name, description FROM crafted_tools').all();

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

        attempts.push(result.text);
        // The parent's mission ledger sees this process's spend only through the reply (mcts/engine.ts debits it).
        send({ method: msg.method, id: msg.id, result });
        break;
      }

      case BRANCH_REFLECT: {
        // `outcome` carries the environment's verdict, which reaches this process no other way.
        const attempt = attempts.join('\n');

        const result = await reflectRollout(lowEffortRoute(), {
          task: msg.args.task,
          attempt,
          outcome: msg.args.outcome,
        });

        send({ method: msg.method, id: msg.id, result });
        break;
      }
    }
  } catch (err) {
    // An empty message reads as "no error" to presence-checking callers.
    send({ method: msg.method, id: msg.id, error: renderThrownChain({ cause: err }) || 'branch worker failed' });
  }
});

function send(reply: BranchReply): void {
  if (!process.send) throw new KinuError('unavailable', 'branch worker has no IPC channel to its parent');
  process.send(reply);
}

send({ method: BRANCH_READY });

process.once('exit', () => {
  db.close();
});

function readStoredModelSpec(): string | null {
  validateActor();
  const row = db.query<{ value: string }, [string]>("SELECT value FROM actor_config WHERE actor_id = ? AND key = 'model' LIMIT 1").get(bootstrap.parent.actorId);

  return row?.value ?? null;
}

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
