#!/usr/bin/env bun
/**
 * CLAUDE'S PROMPT CACHE ON KINU'S OWN REQUEST PATH, by hand, on a Claude login: the shared chat loop (`runChat`, which
 * places the cache breakpoints) over Kinu's Claude model, a conversation of six appended steps per workspace, workspaces
 * one after another. It prints each request's cache read, cache write and uncached input, and the share of every later
 * step's input that was read. The login is read from omp's credential store, read-only, and never printed.
 *   bun evals/scripts/claude-cache-probe.ts [model id] [workspaces]
 */
import { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import type { ModelMessage } from 'ai';
import * as v from 'valibot';
import { runChat } from '../../packages/core/src/chat';
import { CLAUDE_CRED_KEY, createClaudeProvider } from '../../packages/core/src/providers/claude';
import { asFetchFunction } from '../../packages/core/src/providers/fetch-shim';

const [modelId = 'claude-opus-4-7', workspacesArg = '3'] = process.argv.slice(2);

function login(): string {
  const db = new Database(join(homedir(), '.omp/agent/agent.db'), { readonly: true });

  try {
    const row = db.query<{ data: string }, []>("SELECT data FROM auth_credentials WHERE provider = 'anthropic' AND disabled_cause IS NULL ORDER BY json_extract(data, '$.expires') DESC LIMIT 1").get();

    if (row === null) throw new Error('no live anthropic login');

    return v.parse(v.object({ access: v.string() }), JSON.parse(row.data)).access;
  } finally {
    db.close();
  }
}

const TOKEN = login();

const PROMPTS = join(import.meta.dir, '../../packages/core/src/prompts');

const GUIDANCE = readdirSync(PROMPTS).filter((name) => name.endsWith('.md')).sort().map((name) => readFileSync(join(PROMPTS, name), 'utf8')).join('\n\n').slice(0, 28_000);

const STEPS = ['Name one thing a team offsite needs.', 'And another.', 'One more, briefly.', 'Name a fourth.', 'A fifth, in three words.', 'Last one.'];

const UsageSchema = v.object({ input_tokens: v.number(), cache_read_input_tokens: v.optional(v.nullable(v.number())), cache_creation_input_tokens: v.optional(v.nullable(v.number())) });

const MessageStartSchema = v.object({ type: v.literal('message_start'), message: v.object({ usage: UsageSchema }) });

interface Read {
  readonly workspace: number;
  readonly step: number;
  readonly read: number;
  readonly written: number;
  readonly uncached: number;
}

const reads: Read[] = [];

/** The request's usage, from the `message_start` event its stream opens with. */
async function usageOf(response: Response): Promise<v.InferOutput<typeof UsageSchema> | null> {
  const text = await response.clone().text();

  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const event = v.safeParse(MessageStartSchema, JSON.parse(line.slice(6)));

    if (event.success) return event.output.message.usage;
  }

  return null;
}

const run = crypto.randomUUID().slice(0, 8);

for (let index = 0; index < Number(workspacesArg); index += 1) {
  let step = 0;

  const model = createClaudeProvider().createModel(modelId, {
    env: {}, hasCredential: async () => true,
    getAuth: async (key) => (key === CLAUDE_CRED_KEY ? { headers: { Authorization: `Bearer ${TOKEN}` } } : null),
    fetch: asFetchFunction(async (input, init) => {
      const response = await fetch(input, init);
      const usage = await usageOf(response);

      if (usage !== null) {
        const read = { workspace: index, step, read: usage.cache_read_input_tokens ?? 0, written: usage.cache_creation_input_tokens ?? 0, uncached: usage.input_tokens };

        reads.push(read);
        console.log(`ws${String(index)} step${String(step)}: read ${String(read.read)}, written ${String(read.written)}, uncached ${String(read.uncached)}`);
      }

      return response;
    }),
    workspaceAffinity: `probe-workspace-${run}-${String(index)}`, sessionAffinity: `probe-conversation-${run}-${String(index)}`,
  });

  // The part every workspace shares, then this workspace's own, as `buildSystemPromptParts` splits them.
  const shared = `probe ${run}\n\n${GUIDANCE}`;
  const system = `${shared}\n\nYou work in the workspace "Offsite ${String(index)}"; answer in one line.`;
  const history: ModelMessage[] = [];

  for (; step < STEPS.length; step += 1) {
    history.push({ role: 'user', content: STEPS[step] ?? 'Again.' });

    for await (const event of runChat({ modelSpec: `claude/${modelId}`, model, system, history: [...history], tools: {}, systemShared: shared.length, cache: { providerId: 'claude', modelId } })) {
      if (event.type === 'done') history.push(...event.responseMessages);
    }
  }
}

const later = reads.filter((each) => each.step > 0);

const total = (rows: readonly Read[], pick: (each: Read) => number) => rows.reduce((sum, each) => sum + pick(each), 0);

const input = total(later, (each) => each.read + each.written + each.uncached);

console.log(`\nclaude/${modelId}: later steps read ${String(total(later, (each) => each.read))} of ${String(input)} input tokens `
  + `(${(100 * total(later, (each) => each.read) / Math.max(1, input)).toFixed(1)}%); first steps of later workspaces read `
  + reads.filter((each) => each.step === 0 && each.workspace > 0).map((each) => String(each.read)).join(', '));
