// Voyager-style automatic curriculum + Absolute Zero learnability filter.
//
// Voyager (NeurIPS 2023, arXiv:2305.16291): an LLM proposes the next task
// based on current capabilities + world state, scaling difficulty automatically.
// Absolute Zero (NeurIPS 2025 Spotlight, arXiv:2505.03335): pick tasks at the
// "barely succeeds" sweet spot (success rate ~0.3–0.7) — too-easy doesn't
// teach, too-hard doesn't either.
//
// In Proteus: read the CraftStore + recent turn outcomes, ask an LLM to
// propose 3–5 next tasks, filter by predicted-learnability, persist as
// `proposed_tasks`. The user (or an autonomous loop) picks one and runs it.

import * as v from 'valibot';
import type { AgentRuntime } from '../types/agent-runtime.js';
import type { LLM } from '../types/primitives.js';
import type { TurnOutcome } from '../evolution/outcomes.js';
import { extractJsonArray, jsonArrayOnlyInstruction } from '../prompts/structured.js';
import { parseJsonValue } from '../utils/json.js';

const ProposedTaskStatusSchema = v.picklist([
  'pending',
  'accepted',
  'rejected',
  'completed',
]);

type ProposedTaskStatus = v.InferOutput<typeof ProposedTaskStatusSchema>;

export interface ProposedTask {
  id: string;
  task: string;
  rationale: string;
  /** Predicted success rate ∈ [0..1] — 0.5 is ideal "barely succeeds." */
  predictedSuccess: number;
  /** Skills this task would exercise or extend. */
  targetsSkills: string[];
  proposedAt: number;
  status: ProposedTaskStatus;
}

export interface CurriculumProposerOpts {
  rt: AgentRuntime;
  judge: LLM;
  /** [low, high] for predicted-success filter. Default [0.3, 0.7]. */
  learnabilityWindow?: [number, number];
  /** Max tasks to propose per call. Default 5. */
  count?: number;
}

const ProposalListSchema = v.array(
  v.object({
    task: v.pipe(v.string(), v.minLength(1)),
    rationale: v.string(),
    predictedSuccess: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
    targetsSkills: v.array(v.string()),
  }),
);

const StringListSchema = v.array(v.string());

export function initCurriculumTable(execRaw: (ddl: string) => void): void {
  execRaw(`
    CREATE TABLE IF NOT EXISTS proposed_tasks (
      id                 TEXT PRIMARY KEY,
      task               TEXT NOT NULL,
      rationale          TEXT NOT NULL,
      predicted_success  REAL NOT NULL,
      targets_skills     TEXT NOT NULL,
      proposed_at        INTEGER NOT NULL,
      status             TEXT NOT NULL DEFAULT 'pending'
    )
  `);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_proposed_tasks_status_proposed
             ON proposed_tasks(status, proposed_at DESC)`);
}

interface RecentOutcome {
  task: string;
  succeeded: boolean;
}

interface CurriculumSkill {
  name: string;
  description: string;
  score: number;
  uses: number;
}

interface CurriculumContext {
  skills: CurriculumSkill[];
  recent: RecentOutcome[];
}

function collectContext(rt: AgentRuntime, takeOutcomes = 20): CurriculumContext {
  const skills = rt.storage.sql<CurriculumSkill>`
    SELECT ct.name, COALESCE(ct.description, '') as description,
           COALESCE(cs.score, 0.5) as score,
           COALESCE(cs.uses, 0) as uses
      FROM crafted_tools ct
      LEFT JOIN craft_scores cs ON cs.tool_name = ct.name
      ORDER BY cs.uses DESC NULLS LAST, ct.name`;

  // The durable outcome ledger (evolution/outcomes.ts) — the one record of how
  // turns landed. This read used to name `completed_turns`, a table no schema
  // has ever created, under a catch that turned `no such table` into an empty
  // list: the curriculum has been proposing from crafted skills alone since it
  // shipped, and its prompt said "(no recent turns)" in a way nothing could
  // tell apart from a genuinely fresh workspace.
  const recent = rt.storage.sql<{ user_message: string; outcome: TurnOutcome }>`
    SELECT user_message, outcome FROM turn_outcomes
      ORDER BY created_at DESC LIMIT ${takeOutcomes}`
    .map((row) => ({ task: row.user_message, succeeded: row.outcome === 'accepted' }));

  return { skills, recent };
}

function buildPrompt(
  ctx: CurriculumContext,
  count: number,
  window: [number, number],
): string {
  const skillList = ctx.skills.slice(0, 40)
    .map(s => `- ${s.name} (score=${s.score.toFixed(2)}, uses=${s.uses}): ${s.description.slice(0, 80)}`)
    .join('\n') || '(no crafted skills yet)';
  const recentList = ctx.recent.slice(0, 10)
    .map(r => `- [${r.succeeded ? '✓' : '✗'}] ${r.task.slice(0, 120)}`)
    .join('\n') || '(no recent turns)';
  return `You are proposing the NEXT tasks for a self-improving agent to attempt. The
goal is to maximize *learnability*: tasks that the agent will barely succeed
at (predicted success ${window[0]}–${window[1]}) — too-easy doesn't teach,
too-hard doesn't either.

Current crafted skills:
${skillList}

Recent task outcomes (newest first):
${recentList}

Propose ${count} candidate tasks. Each should:
1. Exercise or extend at least one existing skill, OR build a clearly useful
   new capability that composes with existing skills.
2. Be concretely formulated (no "explore X further" — give a specific task).
3. Have predictedSuccess in the "barely succeeds" window.

  JSON shape:
  [{"task": "<task statement>", "rationale": "<1-2 sentences why this task>",
    "predictedSuccess": <0..1>, "targetsSkills": ["<skill name>", ...]}, ...]

  ${jsonArrayOnlyInstruction()}`;
}

export async function proposeNextTasks(opts: CurriculumProposerOpts): Promise<ProposedTask[]> {
  const window = opts.learnabilityWindow ?? [0.3, 0.7];
  const count = opts.count ?? 5;
  const ctx = collectContext(opts.rt);
  const prompt = buildPrompt(ctx, count, window);

  const parsed = extractJsonArray(await opts.judge.complete(prompt));
  const result = v.safeParse(ProposalListSchema, parsed);
  if (!result.success) {
    throw new Error(`Curriculum response schema invalid: ${result.issues.map(i => i.message).join('; ')}`);
  }

  const [lo, hi] = window;
  const filtered = result.output.filter(p => p.predictedSuccess >= lo && p.predictedSuccess <= hi);

  const now = Date.now();
  const proposals: ProposedTask[] = filtered.map((p, i) => ({
    id: `prop-${now}-${i}`,
    task: p.task,
    rationale: p.rationale,
    predictedSuccess: p.predictedSuccess,
    targetsSkills: p.targetsSkills,
    proposedAt: now,
    status: 'pending' as const,
  }));

  // Persist for the UI / autonomous loop to consume.
  for (const p of proposals) {
    void opts.rt.storage.sql`
      INSERT INTO proposed_tasks (id, task, rationale, predicted_success, targets_skills, proposed_at, status)
      VALUES (${p.id}, ${p.task}, ${p.rationale}, ${p.predictedSuccess},
              ${JSON.stringify(p.targetsSkills)}, ${p.proposedAt}, ${p.status})`;
  }

  return proposals;
}

export function listProposedTasks(rt: AgentRuntime, status?: ProposedTask['status']): ProposedTask[] {
  type Row = {
    id: string; task: string; rationale: string; predicted_success: number;
    targets_skills: string; proposed_at: number; status: string;
  };
  const rows = status
    ? rt.storage.sql<Row>`
        SELECT id, task, rationale, predicted_success, targets_skills, proposed_at, status
          FROM proposed_tasks WHERE status = ${status} ORDER BY proposed_at DESC`
    : rt.storage.sql<Row>`
        SELECT id, task, rationale, predicted_success, targets_skills, proposed_at, status
          FROM proposed_tasks ORDER BY proposed_at DESC LIMIT 50`;
  // These are our OWN rows: a status outside the picklist, or skills JSON that
  // will not parse, is corruption in the workspace database — not a row to
  // drop quietly, which is what made a truncated write look like a short list.
  return rows.map((row) => ({
    id: row.id,
    task: row.task,
    rationale: row.rationale,
    predictedSuccess: row.predicted_success,
    targetsSkills: v.parse(StringListSchema, parseJsonValue(row.targets_skills)),
    proposedAt: row.proposed_at,
    status: v.parse(ProposedTaskStatusSchema, row.status),
  }));
}

export function updateProposedTaskStatus(
  rt: AgentRuntime, id: string, status: ProposedTask['status'],
): void {
  void rt.storage.sql`UPDATE proposed_tasks SET status = ${status} WHERE id = ${id}`;
}
