/**
 * Behaviour probes: the ground-truth task family for agent behaviours the
 * workspace corpus (`tests/eval/corpus/behaviour.jsonl`) cannot pin down.
 *
 * WHY A SECOND FAMILY RATHER THAN MORE CORPUS ROWS. A `behaviour.jsonl` row is
 * a prompt plus tags: it hands over an environment and the mechanism covariates
 * say what happened, but nothing declares what SHOULD have happened, so those
 * rows carry no `task_outcome` and the headline cannot be computed over them.
 * The behaviours below each have a checkable ground truth — file bytes, a
 * ledger row with a producer reason, an exact transcribed value — so each probe
 * declares its own machine checks and projects them onto the one primary-metric
 * row, the same way `verifyHardTask` does for hard tasks. The shape is
 * deliberately the hard-task shape (env key + lookup + seed + verify), because
 * that is the extension point `runBehaviourTask` already dispatches on: a new
 * env constant, a `*For` lookup, seed/verify functions, and two lines in the
 * dispatch. No new harness, no new runner, no new scorer type.
 *
 * WHAT A PROBE IS. One imperative task plus the files it needs seeded plus a
 * verifier over the workspace the agent left behind AND the run-event ledger
 * the episode wrote. The ledger half matters because several of these
 * behaviours ARE ledger facts: a refusal is a `tool_call_end` row with
 * `outcome.reason === 'unread'`, and no file byte can say whether the model met
 * one. The file half matters because a ledger row can say a tool was called
 * while only the bytes say it did the job — a model that transcribes BLUEBIRD
 * without ever calling `memory` fails the row counts, and one that calls
 * `memory` four times and writes the wrong file fails the bytes.
 *
 * LAYERING, STATED HONESTLY. A probe proves the AGENT reached for the
 * behaviour and used it to a checkable end. It does not re-prove the behaviour
 * itself: that `forget` deletes is unit-tested at the dispatcher, and the probe
 * checks the agent issued the forget and got a success back. An eval that
 * re-derived the store's semantics from the outside would be a second
 * implementation of the store, which is exactly the drift this tree removes
 * everywhere else.
 */
import * as v from 'valibot';
import type { EvalBudget, EvalCase, RunEvent, VFS } from '../../packages/core/src/index';
import {
  outcomeRow, subgoalsOutcome, type EvalScoreRow, type EvalSubgoal,
} from '../../packages/test-utils/src/index';

/**
 * The `EvalCase.env` value that marks a case as a probe. One constant, not one
 * per probe, for the reason `HARD_TASK_ENV` states where it is declared: `env`
 * names the environment family and the case's own `id` names the instance.
 */
export const PROBE_ENV = 'behaviour-probe';

/** The files a probe verifier may read: the workspace the agent left behind. */
export interface ProbeFiles {
  /** File content as text, or null when the path is missing or unreadable. */
  readText(path: string): Promise<string | null>;
}

export interface BehaviourProbe {
  readonly id: string;
  /** The imperative the harness sends. The corpus row is BUILT from this (see
   *  {@link probeCases}), so the prompt lives in exactly one place. */
  readonly prompt: string;
  readonly tags: readonly string[];
  /** First sizing from the single-turn shape; the run record's `measured`
   *  re-sizes it. See the corpus header for what the ceilings mean. */
  readonly budget: EvalBudget;
  /** Path → content, written into the workspace before the turn. */
  readonly seed: Readonly<Record<string, string>>;
  verify(ctx: { files: ProbeFiles; events: readonly RunEvent[] }): Promise<readonly EvalSubgoal[]>;
}

/** The corpus as eval cases, ready to concatenate — the `hardTaskCases` shape. */
export function probeCases(): EvalCase[] {
  return PROBES.map((probe) => ({
    id: probe.id,
    task: probe.prompt,
    tags: [...probe.tags],
    env: PROBE_ENV,
    budget: { ...probe.budget },
  }));
}

/** The probe behind a case, or undefined when the case belongs to another family. */
export function probeFor(task: Pick<EvalCase, 'id' | 'env'>): BehaviourProbe | undefined {
  if (task.env !== PROBE_ENV) return undefined;
  return PROBES.find((probe) => probe.id === task.id);
}

/** Write the probe's files into the workspace the agent is about to be handed. */
export async function seedProbe(probe: BehaviourProbe, vfs: VFS): Promise<void> {
  for (const [path, content] of Object.entries(probe.seed)) {
    const dir = path.split('/').slice(0, -1).join('/');
    if (dir !== '') await vfs.mkdir(dir, { recursive: true });
    await vfs.writeFile(path, content);
  }
}

/** Run the probe's machine checks and project them onto the primary-metric row. */
export async function verifyProbe(
  probe: BehaviourProbe, ctx: { files: ProbeFiles; events: readonly RunEvent[] },
): Promise<EvalScoreRow> {
  return outcomeRow(subgoalsOutcome([...(await probe.verify(ctx))]));
}

// ── Ledger readers ──────────────────────────────────────────────────────────

type ToolEnd = Extract<RunEvent, { type: 'tool_call_end' }>;

function toolEnds(events: readonly RunEvent[]): ToolEnd[] {
  return events.filter((event): event is ToolEnd => event.type === 'tool_call_end');
}

/** The dispatcher arguments the ledger kept: small scalars survive the digest. */
const ToolArgsSchema = v.object({ action: v.optional(v.string()), path: v.optional(v.string()) });

function toolArgs(call: ToolEnd): { action?: string; path?: string } {
  const parsed = v.safeParse(ToolArgsSchema, call.args);
  return parsed.success ? { action: parsed.output.action, path: parsed.output.path } : {};
}

/** Same file by either spelling: the agent may or may not lead with a slash. */
function onPath(call: ToolEnd, path: string): boolean {
  const actual = toolArgs(call).path;
  return actual === path || actual === `/${path}`;
}

function successfulCalls(events: readonly RunEvent[], name: string, action?: string): ToolEnd[] {
  return toolEnds(events).filter((call) =>
    call.name === name && call.outcome?.success === true
    && (action === undefined || toolArgs(call).action === action));
}

function refusedWith(events: readonly RunEvent[], name: string, reason: string, path?: string): ToolEnd[] {
  return toolEnds(events).filter((call) =>
    call.name === name && call.outcome?.success === false && call.outcome.reason === reason
    && (path === undefined || onPath(call, path)));
}

function head(content: string | null): string {
  return content === null ? '(missing)' : JSON.stringify(content.slice(0, 120));
}

// ── The probes ──────────────────────────────────────────────────────────────

/**
 * What one probe episode may spend. One shape for all eight: they are all one
 * turn over a small workspace, so a ceiling that fits one fits all, and eight
 * different ceilings would pretend to a sizing precision nobody has measured
 * yet. The error ceiling is the loosest of the three tiers because three of
 * these probes are ABOUT a failure — a refusal the agent must meet and recover
 * from is a failed tool call on a correct trajectory.
 */
const PROBE_BUDGET: EvalBudget = {
  steps: 30,
  tokens: 150_000,
  toolErrorRate: 0.6,
  wallMs: 600_000,
};

const BLIND_SEED = 'The vault is SEALED shut.\n';

/** Every probe, for the corpus-quality tests that hold the corpus and the registry in agreement. */
export const PROBES: readonly BehaviourProbe[] = [
  {
    id: 'probe-blind-edit',
    prompt: 'In this workspace a file src/blind.txt exists holding one line with the word '
      + 'SEALED in it. Using the file tool edit action (action=edit), change SEALED to OPEN. '
      + 'If the tool refuses, read the file first and then complete the edit. '
      + 'Reply with only DONE when the file holds OPEN instead of SEALED.',
    tags: ['edit'],
    budget: { ...PROBE_BUDGET },
    seed: { 'src/blind.txt': BLIND_SEED },
    async verify({ files, events }) {
      const content = await files.readText('src/blind.txt');
      const fixed = content !== null && content.includes('OPEN') && !content.includes('SEALED');
      const refusals = refusedWith(events, 'file', 'unread', 'src/blind.txt');
      const reads = successfulCalls(events, 'file', 'read').filter((call) => onPath(call, 'src/blind.txt'));
      const edits = successfulCalls(events, 'file', 'edit').filter((call) => onPath(call, 'src/blind.txt'));
      const recovered = refusals.some((refusal) =>
        edits.some((edit) => edit.timestamp >= refusal.timestamp));
      const readFirst = refusals.length === 0 && reads.length > 0;
      return [
        {
          what: 'content-fixed',
          reached: fixed,
          detail: `src/blind.txt: ${head(content)}`,
        },
        {
          what: 'refusal-observed',
          reached: refusals.length > 0,
          // A miss here is a BEHAVIOURAL FINDING, not a pass: the model read
          // first (or shelled around the tool), so it never met the
          // read-before-edit gate. Correct trajectory, unmeasured refusal.
          detail: refusals.length > 0
            ? `${String(refusals.length)} unread refusal(s) on src/blind.txt`
            : readFirst
              ? 'no refusal — the model read before editing, so the gate never fired'
              : 'no unread refusal and no prior read of src/blind.txt on the file tool',
        },
        {
          what: 'recovered-after-refusal',
          reached: recovered,
          detail: recovered
            ? 'a successful edit on src/blind.txt landed after the refusal'
            : 'no successful edit after an unread refusal on src/blind.txt',
        },
      ];
    },
  },
  {
    id: 'probe-absent-anchor',
    prompt: 'In this workspace a file src/anchor.txt exists holding one line. Using the file '
      + 'tool edit action (action=edit), replace the word DRAGON with OPEN. DRAGON may or may '
      + 'not be in the file — if the tool refuses because the text is absent, read the file, '
      + 'find the word that is actually there, and replace THAT with OPEN instead. '
      + 'Reply with only DONE when the file holds OPEN.',
    tags: ['edit'],
    budget: { ...PROBE_BUDGET },
    seed: { 'src/anchor.txt': BLIND_SEED },
    async verify({ files, events }) {
      const content = await files.readText('src/anchor.txt');
      const fixed = content !== null && content.includes('OPEN') && !content.includes('SEALED');
      const refusals = refusedWith(events, 'file', 'not_found', 'src/anchor.txt');
      const edits = successfulCalls(events, 'file', 'edit').filter((call) => onPath(call, 'src/anchor.txt'));
      const recovered = refusals.some((refusal) =>
        edits.some((edit) => edit.timestamp >= refusal.timestamp));
      return [
        {
          what: 'content-fixed',
          reached: fixed,
          detail: `src/anchor.txt: ${head(content)}`,
        },
        {
          what: 'refusal-observed',
          reached: refusals.length > 0,
          detail: refusals.length > 0
            ? `${String(refusals.length)} not_found refusal(s) on src/anchor.txt`
            : 'no not_found refusal on src/anchor.txt — the absent anchor never met the matcher',
        },
        {
          what: 'recovered-after-refusal',
          reached: recovered,
          detail: recovered
            ? 'a successful edit on src/anchor.txt landed after the refusal'
            : 'no successful edit after a not_found refusal on src/anchor.txt',
        },
      ];
    },
  },
  {
    id: 'probe-file-roundtrip',
    prompt: 'Using the file tool, write exactly these three lines — ALPHA, BRAVO, GAMMA, each '
      + 'on its own line with a trailing newline at the end — into a new file roundtrip.txt in '
      + 'this workspace. Then read roundtrip.txt back with the file tool and reply with only '
      + 'its exact contents.',
    tags: [],
    budget: { ...PROBE_BUDGET },
    seed: {},
    async verify({ files, events }) {
      const content = await files.readText('roundtrip.txt');
      const writes = successfulCalls(events, 'file', 'write').filter((call) => onPath(call, 'roundtrip.txt'));
      const reads = successfulCalls(events, 'file', 'read').filter((call) => onPath(call, 'roundtrip.txt'));
      return [
        {
          what: 'content-exact',
          reached: content === 'ALPHA\nBRAVO\nGAMMA\n',
          detail: `roundtrip.txt: ${head(content)}`,
        },
        {
          what: 'wrote-with-tool',
          reached: writes.length > 0,
          detail: `${String(writes.length)} successful file write(s) on roundtrip.txt`,
        },
        {
          what: 'read-back-with-tool',
          reached: reads.length > 0,
          detail: `${String(reads.length)} successful file read(s) on roundtrip.txt`,
        },
      ];
    },
  },
  {
    id: 'probe-codemode-branch',
    prompt: [
      'Run exactly this program with execute_tools, changing nothing:',
      '```',
      "const result = await workspace.editFile('src/codemode-blind.txt', [{ old_text: 'SEALED', new_text: 'OPEN' }]);",
      "if (result && typeof result === 'object' && 'reason' in result) {",
      "  await workspace.writeFile('diagnosis.txt', 'reason:' + result.reason);",
      "  return 'diagnosed';",
      '}',
      "return 'no-refusal';",
      '```',
      'Then reply with only DONE.',
    ].join('\n'),
    tags: [],
    budget: { ...PROBE_BUDGET },
    seed: { 'src/codemode-blind.txt': BLIND_SEED },
    async verify({ files, events }) {
      const diagnosis = await files.readText('diagnosis.txt');
      const execSuccess = successfulCalls(events, 'execute_tools');
      return [
        {
          what: 'refusal-diagnosed',
          reached: diagnosis === 'reason:unread',
          detail: `diagnosis.txt: ${head(diagnosis)}`,
        },
        {
          // THE handled/unhandled distinction, as a subgoal: the edit refusal
          // arrived as a branchable {reason, error} object INSIDE the program,
          // so the execute_tools call itself succeeded. Had it thrown out of
          // the program instead, this call would have failed and the next probe
          // would be the one measuring that.
          what: 'execute_tools-succeeded',
          reached: execSuccess.length > 0,
          detail: `${String(execSuccess.length)} successful execute_tools call(s) — the refusal never escaped the program`,
        },
      ];
    },
  },
  {
    id: 'probe-codemode-throw',
    prompt: [
      'Run exactly this program with execute_tools, changing nothing:',
      '```',
      "const content = await workspace.readFile('src/never-seeded-ghost.txt');",
      'return content;',
      '```',
      'The call will fail because the file does not exist. Observe HOW it fails (the '
      + 'tool-call error you get back), then write a one-line note into aftermath.txt using '
      + 'the file tool describing what happened, and reply with only DONE.',
    ].join('\n'),
    tags: ['failure'],
    budget: { ...PROBE_BUDGET },
    seed: {},
    async verify({ files, events }) {
      const failed = toolEnds(events).filter((call) =>
        call.name === 'execute_tools' && call.outcome?.success === false);
      const aftermath = await files.readText('aftermath.txt');
      const noted = aftermath !== null && aftermath.trim().length > 0;
      const fileWrites = successfulCalls(events, 'file', 'write').filter((call) => onPath(call, 'aftermath.txt'));
      return [
        {
          what: 'failure-surfaced',
          reached: failed.length > 0,
          detail: `${String(failed.length)} failed execute_tools call(s) — the unhandled error arrived as a tool failure, not a silent value`,
        },
        {
          what: 'recovered-through-another-tool',
          reached: noted && fileWrites.length > 0,
          detail: noted
            ? `aftermath.txt written through the file tool: ${head(aftermath)}`
            : 'aftermath.txt missing or empty — the failure was never worked around',
        },
      ];
    },
  },
  {
    id: 'probe-memory-notes',
    prompt: 'Save this note with the memory tool (action=save): `The BLUEBIRD protocol requires '
      + 'a quorum of three relays before failover.` Then search memory (action=search) for '
      + 'BLUEBIRD, and if the search finds the note, write the single word BLUEBIRD into '
      + 'found.txt with the file tool. Reply with only DONE.',
    tags: [],
    budget: { ...PROBE_BUDGET },
    seed: {},
    async verify({ files, events }) {
      const found = await files.readText('found.txt');
      const saves = successfulCalls(events, 'memory', 'save');
      const searches = successfulCalls(events, 'memory', 'search');
      return [
        {
          what: 'note-retrieved',
          reached: found?.trim() === 'BLUEBIRD',
          detail: `found.txt: ${head(found)}`,
        },
        {
          what: 'saved-with-tool',
          reached: saves.length > 0,
          detail: `${String(saves.length)} successful memory save(s)`,
        },
        {
          what: 'searched-with-tool',
          reached: searches.length > 0,
          detail: `${String(searches.length)} successful memory search(es)`,
        },
      ];
    },
  },
  {
    id: 'probe-memory-facts',
    prompt: 'With the memory tool: remember the fact `probe.color` with value `BLUEBIRD` '
      + '(action=remember). Then recall `probe.color` (action=recall) and write the recalled '
      + 'value, exactly, into recalled.txt with the file tool. Then forget `probe.color` '
      + '(action=forget) so no stale fact remains. Reply with only DONE.',
    tags: [],
    budget: { ...PROBE_BUDGET },
    seed: {},
    async verify({ files, events }) {
      const recalled = await files.readText('recalled.txt');
      const remembers = successfulCalls(events, 'memory', 'remember');
      const recalls = successfulCalls(events, 'memory', 'recall');
      const forgets = successfulCalls(events, 'memory', 'forget');
      return [
        {
          what: 'value-transcribed',
          reached: recalled === 'BLUEBIRD',
          detail: `recalled.txt: ${head(recalled)}`,
        },
        {
          what: 'remembered',
          reached: remembers.length > 0,
          detail: `${String(remembers.length)} successful memory remember(s)`,
        },
        {
          what: 'recalled',
          reached: recalls.length > 0,
          detail: `${String(recalls.length)} successful memory recall(s)`,
        },
        {
          // That `forget` deletes is the dispatcher's unit-tested contract; the
          // eval proves the agent issued it and got a success back, which is
          // the agent-behaviour half of the row this matrix measures.
          what: 'forgotten',
          reached: forgets.length > 0,
          detail: `${String(forgets.length)} successful memory forget(s)`,
        },
      ];
    },
  },
  {
    id: 'probe-task-list',
    prompt: 'Track this job with the tasks tool: add two tasks titled `probe-first` and '
      + '`probe-second` (action=add). Then mark `probe-first` done — use the id from the add '
      + 'result (action=update). Then list the tasks (action=list) and write exactly '
      + '`probe-first:done` into status.txt with the file tool. Reply with only DONE.',
    tags: [],
    budget: { ...PROBE_BUDGET },
    seed: {},
    async verify({ files, events }) {
      const status = await files.readText('status.txt');
      const adds = successfulCalls(events, 'tasks', 'add');
      const updates = successfulCalls(events, 'tasks', 'update');
      const lists = successfulCalls(events, 'tasks', 'list');
      return [
        {
          what: 'status-transcribed',
          reached: status?.trim() === 'probe-first:done',
          detail: `status.txt: ${head(status)}`,
        },
        {
          what: 'added',
          reached: adds.length > 0,
          detail: `${String(adds.length)} successful tasks add(s)`,
        },
        {
          what: 'updated',
          reached: updates.length > 0,
          detail: `${String(updates.length)} successful tasks update(s)`,
        },
        {
          what: 'listed',
          reached: lists.length > 0,
          detail: `${String(lists.length)} successful tasks list(s)`,
        },
      ];
    },
  },
];
