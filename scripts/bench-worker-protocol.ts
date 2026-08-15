import * as v from 'valibot';
import { parseJsonValue, type JsonValue } from '../packages/core/src/index.js';

const NonNegativeIntegerSchema = v.pipe(v.number(), v.finite(), v.integer(), v.minValue(0));
const PositiveIntegerSchema = v.pipe(NonNegativeIntegerSchema, v.minValue(1));

export const LLMProviderConfigSchema = v.strictObject({
  name: v.pipe(v.string(), v.minLength(1)),
  baseURL: v.pipe(v.string(), v.url()),
  headers: v.record(v.string(), v.string()),
  model: v.pipe(v.string(), v.minLength(1)),
  maxTokens: v.optional(PositiveIntegerSchema),
});

const BenchCheckSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  command: v.pipe(v.array(v.string()), v.minLength(1)),
  cwd: v.optional(v.string()),
  timeoutMs: v.optional(PositiveIntegerSchema),
});

const BenchTaskSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  title: v.string(),
  prompt: v.string(),
  editable: v.array(v.string()),
  guarded: v.array(v.string()),
  checks: v.pipe(v.array(BenchCheckSchema), v.minLength(1)),
  tags: v.optional(v.array(v.string())),
});

export const AgentWorkerInputSchema = v.strictObject({
  dbPath: v.pipe(v.string(), v.minLength(1)),
  workspaceName: v.pipe(v.string(), v.minLength(1)),
  purpose: v.pipe(v.string(), v.minLength(1)),
  asks: v.pipe(v.array(v.string()), v.minLength(1)),
  removeAfterAsk: v.array(v.nullable(v.string())),
  maxTokens: PositiveIntegerSchema,
  autoEvolve: v.boolean(),
  llm: LLMProviderConfigSchema,
  sessionId: v.pipe(v.string(), v.minLength(1)),
});

export const PiWorkerInputSchema = v.strictObject({
  agentDir: v.pipe(v.string(), v.minLength(1)),
  asks: v.pipe(v.array(v.string()), v.minLength(1)),
  removeAfterAsk: v.array(v.nullable(v.string())),
  maxTokens: PositiveIntegerSchema,
  llm: LLMProviderConfigSchema,
  task: BenchTaskSchema,
  repoRoot: v.pipe(v.string(), v.minLength(1)),
  verifierRetry: v.boolean(),
});

export const PanelWorkerInputSchema = v.strictObject({
  dbPath: v.pipe(v.string(), v.minLength(1)),
  workspaceName: v.pipe(v.string(), v.minLength(1)),
  purpose: v.pipe(v.string(), v.minLength(1)),
  ask: v.pipe(v.string(), v.minLength(1)),
  panel: v.pipe(v.array(LLMProviderConfigSchema), v.minLength(2)),
  analyst: LLMProviderConfigSchema,
  maxTokens: PositiveIntegerSchema,
});

export const WorkerOutputSchema = v.strictObject({
  tokens: NonNegativeIntegerSchema,
  steps: NonNegativeIntegerSchema,
  hadError: v.boolean(),
  budgetBreach: v.nullable(v.literal('tokens')),
  peakPromptTokens: NonNegativeIntegerSchema,
  modelCalls: v.optional(NonNegativeIntegerSchema),
  headScores: v.optional(v.array(v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1)))),
  grounded: v.optional(v.boolean()),
  blindSpots: v.optional(v.array(v.string())),
  error: v.optional(v.string()),
});

export type AgentWorkerInput = v.InferOutput<typeof AgentWorkerInputSchema>;
export type PiWorkerInput = v.InferOutput<typeof PiWorkerInputSchema>;
export type PanelWorkerInput = v.InferOutput<typeof PanelWorkerInputSchema>;
export type WorkerOutput = v.InferOutput<typeof WorkerOutputSchema>;

function decodeJson(raw: string, label: string): JsonValue {
  try {
    return parseJsonValue(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON: ${detail}`);
  }
}

function issueSummary(issues: readonly v.BaseIssue<unknown>[]): string {
  return issues.map((issue) => issue.message).join('; ');
}

export function parseAgentWorkerInput(raw: string): AgentWorkerInput {
  const parsed = v.safeParse(AgentWorkerInputSchema, decodeJson(raw, 'agent worker input'));
  if (!parsed.success) throw new Error(`invalid agent worker input: ${issueSummary(parsed.issues)}`);
  if (parsed.output.asks.length !== parsed.output.removeAfterAsk.length) {
    throw new Error('invalid agent worker input: asks and removeAfterAsk must have equal length');
  }
  return parsed.output;
}

export function parsePiWorkerInput(raw: string): PiWorkerInput {
  const parsed = v.safeParse(PiWorkerInputSchema, decodeJson(raw, 'pi worker input'));
  if (!parsed.success) throw new Error(`invalid pi worker input: ${issueSummary(parsed.issues)}`);
  if (parsed.output.asks.length !== parsed.output.removeAfterAsk.length) {
    throw new Error('invalid pi worker input: asks and removeAfterAsk must have equal length');
  }
  return parsed.output;
}

export function parsePanelWorkerInput(raw: string): PanelWorkerInput {
  const parsed = v.safeParse(PanelWorkerInputSchema, decodeJson(raw, 'panel worker input'));
  if (!parsed.success) throw new Error(`invalid panel worker input: ${issueSummary(parsed.issues)}`);
  return parsed.output;
}

export function parseWorkerOutput(raw: string): WorkerOutput {
  const parsed = v.safeParse(WorkerOutputSchema, decodeJson(raw, 'worker output'));
  if (!parsed.success) throw new Error(`invalid worker output: ${issueSummary(parsed.issues)}`);
  return parsed.output;
}
