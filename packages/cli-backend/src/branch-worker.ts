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
import { generateText } from 'ai';
import {
  DEFAULT_WORKERS_AI_MODEL_ID,
  explorePrompt,
  formatInheritedContext,
  normalizeUsage,
  parseModelSpec,
  reasoningEffortOptions,
  reflectionPrompt,
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

// Open the branch's SQLite DB for trace storage
const db = new Database(dbPath);
db.exec('PRAGMA journal_mode = WAL');
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
        const { system, user } = explorePrompt({
          mode: msg.args.mode,
          context: formatInheritedContext(history),
          craftedTools,
          languages,
          siblings,
        });
        const { model, providerOptions } = resolveLowEffortModel();
        const request: Parameters<typeof generateText>[0] = {
          model,
          system,
          messages: [{ role: 'user', content: user }],
        };
        if (providerOptions) request.providerOptions = providerOptions;
        const { text, usage } = await generateText(request);
        const trimmed = text.trim();
        db.run('INSERT INTO traces (step, text) VALUES (?, ?)', [1, trimmed]);
        // The spend travels back with the proposal: this process resolves its
        // own model, so the parent's mission ledger cannot see the call any
        // other way (mcts/engine.ts debits it).
        send({ method: msg.method, id: msg.id, result: { text: trimmed, usage: normalizeUsage(usage) } });
        break;
      }
      case BRANCH_REFLECT: {
        const { task, outcome } = msg.args;
        // Read the branch's own trace table (mirror cf generateReflection): the
        // reflection is about the attempt this branch actually made, not the
        // bare task string — and `outcome` carries the environment's verdict on
        // it, which lives on the engine side and never reaches this process
        // any other way.
        const traces = db.query<{ text: string }, []>('SELECT text FROM traces ORDER BY step').all();
        const attempt = traces.map(t => t.text).join('\n');
        const { model, providerOptions } = resolveLowEffortModel();
        const request: Parameters<typeof generateText>[0] = {
          model,
          messages: [{ role: 'user', content: reflectionPrompt(task, attempt, outcome) }],
        };
        if (providerOptions) request.providerOptions = providerOptions;
        const { text, usage } = await generateText(request);
        send({ method: msg.method, id: msg.id, result: { text: text.trim(), usage: normalizeUsage(usage) } });
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
  db.close();
});

function readStoredModelSpec(): string | null {
  const row = parentDb?.query<{ value: string }, []>("SELECT value FROM agent_config WHERE key = 'model' LIMIT 1").get();
  return row?.value ?? null;
}

function resolveLowEffortModel() {
  const spec = modelResolver.normalizeSpecSync(readStoredModelSpec());
  return {
    model: modelResolver.resolveModel(spec),
    providerOptions: reasoningEffortOptions('low', parseModelSpec(spec).provider),
  };
}

function readJson<T>(schema: v.GenericSchema<T>, raw: string | undefined): T | null {
  return raw ? v.parse(schema, JSON.parse(raw)) : null;
}
