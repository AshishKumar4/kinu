/**
 * Prompt prose, as data.
 *
 * Every template here is an addressable artifact: an id an optimiser or an owner
 * can name, and a source string that can be read, scored and replaced without
 * recompiling the builder around it. Branching that a template can express —
 * one declared boolean, one either/or — is `{{#if}}`, so the whole section stays
 * ONE string and GEPA has a whole section to optimise rather than a fragment.
 * Iteration and every decision that needs more than a boolean stay in the builder
 * (`prompt.ts`), where the unions are exhaustive — see `template.ts` for why.
 *
 * The comments attached to each template are the record of why its wording is
 * what it is. They moved here with the prose they explain; the comments in
 * `prompt.ts` are now only about the branch conditions the builder computes.
 *
 * `PROMPT_SECTIONS` at the foot is the nine-section index the GEPA bridge reads
 * (`evolution/gepa/section-bridge.ts`). A template that is not in it is a line or
 * a fragment, not a section, and is not separately evolvable.
 */

import { definePromptSection, type PromptSection } from './template';

/**
 * One built-in tool's index entry: its name, what it is for, and one real call.
 *
 * The builder maps this over the turn's tool list, so the iteration is typed
 * TypeScript and only the line's wording lives here.
 */
export const BUILTIN_TOOL_LINE = definePromptSection(
  'tools/builtin-line',
  '- **{{name}}** — {{summary}}\n  `{{example}}`',
);

/** One connected provider's tool. The source label and the description suffix
 *  are computed by the builder, because both are absences as often as values. */
export const EXTERNAL_TOOL_LINE = definePromptSection(
  'tools/external-line',
  '- **{{name}}** ({{source}}){{description}}',
);

/**
 * The turn's guidance, in three independent layers.
 *
 * Permission (workMode), provenance and stance are separate facts and each
 * renders on its own: a background-job wake is a resume AND it is plan or
 * build work, and the stance is neither. Collapsing them into one value is
 * what made the resume overlay unreachable — see prompting/surface.ts.
 *
 * Two of the three render nothing in their default state, on purpose: `build`
 * (Auto) is the absence of constraint, and so is the `general` stance.
 */
export const OPERATING_GUIDANCE = definePromptSection(
  'guidance/operating',
  `## Operating guidance
- Treat ambiguous "do this" requests as work to perform.
- Inspect current code, state, logs, or tool results before making claims about them.
- Keep changes scoped to the user request and the existing architecture.
- If a required fact is unavailable, say exactly what is missing and stop.{{#if kimi}}
- Kimi K2.6 works best when tool use is concrete and continuous: preserve tool/result context and continue from each observation.
- For long-horizon coding, write durable decisions down with \`memory\`.{{/if}}{{#if gpt}}
- GPT/Codex-style reasoning models do best with direct success criteria: state assumptions briefly, use tools for current facts, and keep final answers outcome-focused.
- For machine-readable tasks, take the schema-backed output whenever a schema or tool offers one.{{/if}}{{stanceGuidance}}{{#if backgroundResume}}
- Background-resume mode: fetch the referenced job result first, synthesize it, then continue or close the original work.{{/if}}{{#if planMode}}
- Plan mode: {{#if planSubmission}}investigate deeply, then submit a concrete Markdown plan with affected files, risks, and verification through \`submit_plan\`.{{else}}investigate deeply and report concrete findings to the parent Plan turn; the parent owns the reviewed plan.{{/if}}
- Do not change files, system state, releases, or deployments. Ordinary tools remain available for inspection; use mutating operations only after approval starts a Build turn.
- Do not expose ports or produce preview or output links. {{#if planSubmission}}The submitted plan is the only plan-mode output surface.{{else}}Your report is research input for the parent plan, not a separate user-facing output.{{/if}}
{{#if planSubmission}}- Do not begin implementation until the plan is approved. End by calling \`submit_plan\`, or ask a question only when the missing answer must come from the user.{{else}}- Do not begin implementation. Return your research and recommendations to the parent without calling or inventing \`submit_plan\`.{{/if}}{{/if}}`,
);

/**
 * The tool index. One index for every model family.
 *
 * The when-to-use doctrine lives in the JSON-schema tool descriptions
 * (registry.ts renderToolSchemaDescription). The prompt indexes the names and
 * shows one real call each: a concrete argument shape is what a model actually
 * copies, and it teaches the same thing an anti-pattern would without spending
 * the model's attention on a way of calling it we do not want.
 *
 * The kimi branch this replaced stripped the per-tool lines on the claim that
 * prompt prose about tool usage interferes with that family's selection —
 * sourced to a retired, K2.5-scoped Moonshot page that no live source states.
 * What the live K3 guidance does say is "avoid repeating tool behavior in a long
 * system prompt", which is an argument against duplication for everyone (handled
 * above: doctrine is schema-only) and not for a family branch. The branch could
 * not have done what it claimed either: the schemas are family-neutral, so kimi
 * received every byte of the doctrine the index was stripped to protect it from.
 */
export const TOOLS_SECTION = definePromptSection(
  'tools/index',
  `## Tools available this turn
Call the tools listed here and in this turn's model tool schema. That list is live — read it to see which tools and runtimes you have.

### Built-in tools
{{builtins}}
{{#if hasExternal}}
### External tools
These tools are exposed by connected external providers for this turn. Use them when their names/descriptions match the task.
{{externalLines}}{{/if}}`,
);

/**
 * The `workspace` namespace. What it IS differs by backend: hosted, it is the
 * authoritative Nimbus session — files, runtimes and resident processes are one
 * environment rather than a second executor beside storage.
 *
 * Its ceiling is prose, not a `resourceLimits` declaration — it is a platform
 * fact rather than a cgroup this process measured, and ResourceLimits is
 * reserved for measured values (execution/types.ts). The figure is a slot fed
 * from `worker.isolate.memory` so the sentence the model reads cannot drift from
 * the catalog; note that entry is the PUBLISHED figure and
 * `do.isolate.oom_catchable` measured the real wall far higher, so this sentence
 * understates the workspace in the agent's favour.
 */
export const WORKSPACE_EXECUTOR_LINE = definePromptSection(
  'executors/workspace',
  '- **workspace.*** / `runtime: "workspace"`: {{#if cliLocal}}your own durable workspace filesystem and a real shell over it. The machine the CLI is running on is `laptop.*`, in the machine\'s own paths.{{else}}the agent\'s own durable Nimbus workspace — one filesystem and real POSIX shell with node, npm, git, resident background processes, logs, and exposable ports. Additional interpreter/toolchain support is listed in its live capabilities. Its shell runs inside a Worker isolate, so ~{{memoryMb}} MB of memory is what bounds any one command: it fits editing, scripts, package installs, running services, and repositories that clone within that.{{/if}}',
);

export const SANDBOX_EXECUTOR_LINE = definePromptSection(
  'executors/sandbox',
  '- **sandbox.*** / `runtime: "sandbox"`: a full Linux container with its own CPU, memory and disk — heavier installs, longer-running processes, large clones and builds, bulk data, and user-visible port-listening apps. It provisions on first use, so moving a job here the moment it outgrows the workspace is the normal step.',
);

export const LAPTOP_EXECUTOR_LINE = definePromptSection(
  'executors/laptop',
  '- **laptop.*** / `runtime: "laptop"`: {{#if cliLocal}}the local machine the Kinu CLI is running on — direct access, no tunnel or consent prompt.{{else}}the user\'s OWN PC, connected through the Kinu device tunnel. Use it when the task targets local files, local commands, or the user\'s desktop environment. Its first use asks the user for consent — that prompt is expected, not an error.{{/if}}',
);

/** A registered-but-offline laptop is still listed (the user can bring it
 *  back), unlike other unavailable executors, which are omitted entirely. */
export const OFFLINE_LAPTOP_LINE = definePromptSection(
  'executors/laptop-offline',
  '- **laptop** / `runtime: "laptop"` (registered, currently OFFLINE): the user\'s own PC is registered but not connected right now. Do not call it; if the user wants it used, tell them to run `kinu connect` on their machine.',
);

export const GENERIC_EXECUTOR_LINE = definePromptSection(
  'executors/generic',
  '- **{{name}}.***: available executor namespace.',
);

/**
 * Doctrine only — live availability labels render in the per-turn volatile
 * context message (prompting/volatile-context.ts), never in this cacheable
 * prefix, so a sandbox waking up doesn't re-prefill the whole conversation.
 *
 * No backend conditional on the separate-filesystems line: the workspace
 * filesystem is the same durable component everywhere, and every other runtime
 * is a different machine. That used to be untrue on cli-local, where the
 * workspace and laptop executors shared one host shell, and the prompt had to
 * carry the exception.
 *
 * The file doctrine that follows says every environment is its own filesystem
 * addressed in its own native paths — there is no mount table and no path that
 * means two places. The workspace's filesystem is the one the file tools
 * address, and the workspace shell is a real shell over exactly those bytes.
 *
 * The approvals doctrine is stated ONCE, and only on turns that have a shell. A
 * parked tool result used to repeat all of it on every call (222 tokens each);
 * it is a standing fact about this surface, so it lives here and the result is
 * now one line (safety/deferred-approval.ts). It names no executor: which ones
 * exist this turn is the list above.
 */
export const EXECUTORS_SECTION = definePromptSection(
  'executors/section',
  `## Execution environments
The environments listed here are the ones selectable in this turn; a namespace is available exactly when it appears below.
This list reflects live state at the start of THIS turn — trust it over assumptions or earlier turns; it can change when the user connects or disconnects a device.
Choose the runtime that matches the task; keep reads/writes in the same runtime unless you intentionally copy data between runtimes.

{{executorLines}}{{#if manyRuntimes}}

These runtimes have separate filesystems. Use the same runtime to read back files you wrote.{{/if}}

Your own workspace is a durable POSIX filesystem at {{workspaceRoot}}, and the \`workspace\` runtime is a real shell over it — the same bytes the \`file\` tool and \`workspace.*\` file ops read, by the same paths. Relative paths resolve there; \`cd\` persists between commands.{{#if hasDevices}}
The other environments above are SEPARATE machines with separate filesystems, reached only through their own namespaces ({{deviceNamespaces}}) in THEIR native paths. To move a file between two of them, read it from one and write it to the other.{{/if}}{{#if hasPreview}}

### Showing a running app
For a user-visible web app, keep its files and server in one preview-capable environment, start the server bound to 0.0.0.0 in the background, wait for it to bind, then call {{exposeCalls}} for the environment you chose. If exposePort fails, inspect that environment's server log and retry after the server is actually listening.{{/if}}

### Approvals
Commands that touch a machine which is not your own, or reach outside it — a force-push, a publish, reading the user's secrets — need their decision. Your own workspace and sandbox are not gated: clean up, install and delete there freely.
A parked command returns one line, \`NOT RUN — queued for owner approval (<id>)\`. Nothing ran, and re-issuing returns the same line. A decision wakes you either way, so carry on with independent work or end your turn.`,
);

export const PERSISTENCE_SECTION = definePromptSection(
  'state/persistence',
  `## Persistence
You are NOT stateless between turns. Conversation history, durable memory, keyed facts, crafted tools, scaffold versions, background jobs, and event triggers persist in storage.
Your context window is automatically compacted as it approaches its limit, so work each task through to completion and save durable progress to facts/memory as you go.
Your self-changes (crafted tools, learned facts, scaffold promotions) are recorded in an Evolution Changelog the user can review and revert line-by-line — evolve freely and report honestly; nothing you change about yourself is hidden or permanent.`,
);

/** `llm.query` gates on surface.rlmAvailable (wired by both backends); the
 *  scaffold self-provider ships on both since the shared-spine parity. */
export const CODE_EXECUTION_SECTION = definePromptSection(
  'state/code-execution',
  `## Code execution and learned capabilities
- Before building from scratch, check \`workspace.listTools()\` and \`memory\` search for existing tools and prior lessons.
- When you have built a reusable routine, save it with \`workspace.createTool\` — saved tools become callable as \`codemode.<name>(args)\` / \`tools.<name>(args)\` on your next execute_tools call.{{#if rlmAvailable}}
- \`llm.query(text, { model?, reasoning_effort? })\` is available inside execute_tools for one-level decomposition over large inputs: read the file, slice it, \`llm.query\` each slice (cheap at low reasoning_effort), aggregate in code. Handle either a string result or \`{ error }\`. For slices that themselves need decomposition, delegate the whole shape instead (\`agents\` action=swarm) — its nodes run their own full tool loops.{{/if}}
- \`agent.proposeCurriculum(count?)\` proposes self-improvement tasks; \`agent.listCurriculum(status?)\` / \`agent.acceptCurriculumTask(id)\` manage them.
- \`agent.proposeScaffold(rationale, code, baseVersion?)\` proposes a new version of your own agentic-loop scaffold; it must pass the validation gates and win shadow evaluation before going live. \`agent.scaffoldVersions(limit?)\` lists your scaffold archive (lineage + shadow record) — you may branch from any archived version via \`baseVersion\`.
- \`agent.schedule({ cron | atMs, label?, payload? })\` can create a future autonomous wake; use it only when the user or task genuinely calls for recurrence or a reminder. Add \`budget_usd\`/\`budget_tokens\` when the owner names a spending limit — the host then caps that whole run cumulatively; \`agent.budget()\` reads what is left.
- \`agent.jobResult(jobId)\` reads a settled background job's full result — the wake that announces a job settled names the id to read; \`agent.backgroundJobs(limit?)\` lists recent jobs.
- \`agent.compactNow()\` folds the conversation at a phase boundary instead of waiting for the token trigger: the finished range is archived verbatim and stays listed in the checkpoint's Compaction Archive manifest, so you can still read it back.`,
);

/**
 * ONE ladder, keyed on lifetime, behind ONE tool — the only axis the model has
 * to decide on. The rungs are INDEXED here and specified in the `agents` schema:
 * each rung's triggers are selection doctrine, which the schema owns (registry.ts
 * renderToolSchemaDescription) and every family reads. What stays is the
 * prompt-only operational doctrine no tool schema carries — the frame, the turn
 * output budget, the node artifact trail, the coordination loop, the codemode
 * namespace.
 *
 * The zeroth rung is not an agent at all: flat map-reduce sub-calls.
 * Weight-ordered, it sits between doing it yourself and searching, and it
 * renders only where the llm provider is actually wired.
 *
 * The turn-cumulative clamp explained itself here, thousands of tokens before any
 * result could trip it. It says so in its own marker now (tools/clamp.ts), at the
 * trip, where the fact is actionable — and costs nothing on the turns that never
 * reach the floor.
 *
 * The ladder's DEFAULT is where the zeroth rung used to be listed first. A bullet
 * reading "- Do it yourself" made rung 0 the visually first choice and turned the
 * section into a classification: the model had to positively recognise 2+ angles
 * before it acted, so every ambiguous turn failed closed to doing it alone —
 * measured 0% conversion on doctrine against 24% for the mechanical splice. The
 * exemptions are the same three facts, stated last and stated as things to DO, so
 * an unrecognised shape now falls the other way.
 *
 * The swarm rung said what a search IS and never what work calls for one. The
 * schema's Breadth/Doubt triggers are selection doctrine and stay there; what
 * belongs here is the SHAPE test, because deciding the work has parts is upstream
 * of picking a tool. Compressed to a clause rather than restated: turn-steering
 * already says this mechanically, but only at 25 steps, which is after the shape
 * was already chosen wrong.
 *
 * The hire rung carries the CONTEXT half of the index, which is the half that
 * decides which rung a task wants: a node may inherit the caller's window, a hire
 * never does, one takes a one-line brief and the other takes a written one. The
 * rung itself (DELEGATION_RUNGS.hire) carries the mechanism; this is the index.
 *
 * Per-node `models` routing is named as a case and never a default: panel quality
 * tracks the AVERAGE member (Self-MoA, arXiv 2502.00674), so the caveat rides the
 * parameter in agents-tool.ts, where it is read at the moment the field is being
 * filled. The line that decides the rung is who WRITES the candidates and whether
 * anything MEASURES them, because "spawn several and pick the best" describes
 * several things and only one of them runs a verifier.
 *
 * The sibling-visibility half of the artifact line went to the field that is read
 * when the task is being WRITTEN: DELEGATION_INHERITANCE.swarm.brief names what a
 * node can lean on, on `task` itself. Repeating it thousands of tokens earlier
 * bought nothing the field does not already say at the moment it matters. What
 * stays is the artifact trail, which no schema carries.
 *
 * The rungs are also a codemode namespace, so a multi-step plan is code rather
 * than a tool-call-at-a-time grind. What `workspace.createTool` produces is the
 * Code-execution section's own bullet; what belongs here is only that a delegated
 * plan is one of the scripts worth saving.
 *
 * The coordination loop is the prompt-only half: an ORDER of operations no schema
 * field can hold. The roster/re-engage/dismiss half that followed it was
 * DELEGATION_RUNGS.hire said a second time, so it went where the rungs went.
 *
 * Peer addressing is DELEGATION_CONVERSE, which the `agents` docstring already
 * composes from the same deps that decide these actions exist
 * (renderAgentsToolDescription) — every clause of the line that stood here was a
 * paraphrase of it.
 *
 * The `report` line is the frame only. When to report and what turn-end relays
 * are the `report` schema's whenToUse/whenNotToUse, verbatim.
 */
export const DELEGATION_SECTION = definePromptSection(
  'state/delegation',
  `## Delegation{{#if hasActions}}
Delegation is one tool — \`agents\` — and one question: how long does the helper need to live?{{#if rlmAvailable}} The cheapest helper is not an agent: for bulk text that needs no tools, slice it and \`llm.query\` each slice inside execute_tools — reach for the ladder only when the work needs tool loops.{{/if}}
Delegate once the shape of the work is settled: naming the parts is yours, running them is theirs. Work alone on a single coherent change in one file, on a direct answer that needs no change, and on a command the user asked you to run; work with two or more independent parts goes to the ladder.{{/if}}{{#if hasSwarm}}
- Ephemeral search (action=swarm) — nodes of you, each running its own tool loop in parallel, whose candidates are measured and settled back this turn. Reach for it when the work already has 2+ independent angles, or when one step is uncertain enough to be worth two attempts at once.{{/if}}{{#if hasHire}}
- Persistent subordinate (action=hire) — a helper that outlives this turn and stays in your roster. It starts with a blank context, so its mission is the whole brief; hire when the work needs its own memory across turns rather than one answer now.{{/if}}{{#if hasSwarm}}
A search writes its own competing candidates from \`task\` and scores each one with the verifier you named in \`objective\` — you supply what counts, not the angles. \`models\` puts a different vendor on a genuinely open question; a weaker model added for variety measurably subtracts.
Nodes recurse up to search depth 3 and leave durable findings under \`shared/findings/\` — read them after the settle for detail beyond the summary.{{/if}}{{#if rungsInCode}}
The same rungs are callable inside execute_tools as \`agents.<action>\`, so a multi-step plan can be one script — loop, branch, Promise.all — and \`workspace.createTool\` saves that script as a reusable workflow. A search started there rides that call, which does not resume after an eviction.{{/if}}{{#if hasHire}}
Run the coordination loop: hire the needed roles → ask each an independent workstream → integrate their reports as they arrive as events that wake you.
Subordinates share this workspace's files and sandbox.{{/if}}{{#if hasReport}}
You are a subordinate agent of this workspace: the workspace is your world, whoever hired you assigns your work, and \`report\` carries progress back to them.{{/if}}`,
);

export const BACKGROUND_WORK_SECTION = definePromptSection(
  'state/background-work',
  `## Background work
Work moves to the background two ways: a search backgrounds the moment it spawns on a live session, and a long \`execute_tools\` or \`run\` call backgrounds once it outruns the surface threshold. Either way the call returns \`{ background: true, jobId }\` and the work KEEPS RUNNING unwatched — never start the same work again; the running copy will land its effects.
A background job needs nothing from you while it runs, and you are woken with its full result when it settles — mid-turn if you are still working, as a fresh turn if you are idle. Finish whatever other work you have, then end your turn; the wake is how the result arrives.`,
);

/**
 * Last doctrine before the answer, because that is when it applies. Each line
 * targets an observed failure where the model solved the problem and then
 * fumbled the deliverable: reasoning the causal structure out correctly and
 * writing every row of it transposed; building an API to its own convenient
 * signature and self-grading it green against its own tests.
 *
 * Deliberately NOT here: a "check your work before calling it done" framing
 * sentence. The CompletionGate is that instruction as a mechanism — it shows the
 * harness's own reading of the working directory and asks for it to be checked
 * against the task — and a generic re-check prompt is the one Anthropic's Opus 5
 * guidance says to delete because it over-verifies. What survives is what the
 * gate does not say and cannot: the exact SHAPE the request named, and the
 * interface it will be called through.
 */
export const VERIFICATION_SECTION = definePromptSection(
  'state/verification',
  `## Verification
- Re-read the artifact itself — the file, the diff, the final answer — against the request's own words: every deliverable it names, and the exact shape it names (column order, direction, units, filenames).
- Build to the interface the task states: exercise your own work the way the task says it will be called, with the signature, entry point, and arguments it specifies.{{#if hasShell}}
- Run the real check and report what passed or failed. A result is something you executed.{{/if}}`,
);

export const OUTPUT_FORMAT_SECTION = definePromptSection(
  'state/output-format',
  `## Output format
Final replies are plain markdown. Keep user-visible reasoning concise, name important files/checks, and summarize tool output in prose (raw JSON when asked).`,
);

/**
 * The nine sections of the system prompt, in the order they render.
 *
 * This is the GEPA target index and the answer to "what is a section": a piece
 * of prose the builder emits as one block, addressable end to end. The
 * per-line templates above are fragments of these, not entries here — a line
 * evolved on its own would be scored against a prompt it cannot move.
 *
 * `PromptSection<string>` erases the compile-time slot contract on purpose: a
 * registry holds nine different contracts, and what a generic consumer needs is
 * the id and the source. Rendering still goes through the concrete export, so
 * every call site keeps its exact typed slots.
 */
export const PROMPT_SECTIONS: readonly PromptSection<string>[] = [
  OPERATING_GUIDANCE,
  TOOLS_SECTION,
  EXECUTORS_SECTION,
  PERSISTENCE_SECTION,
  CODE_EXECUTION_SECTION,
  DELEGATION_SECTION,
  BACKGROUND_WORK_SECTION,
  VERIFICATION_SECTION,
  OUTPUT_FORMAT_SECTION,
];

/** A promoted replacement per section id, resolved by the backend before the
 *  turn. Absent means every section renders its built-in source — the state the
 *  layergate prefix digest is locked against. */
export type PromptSectionOverrides = Readonly<Record<string, string>>;

/** Renders a section against the turn's overrides. One closure is built per
 *  prompt so the nine call sites stay a `render(SECTION, {…})` each. */
export type RenderSection =
  <Source extends string>(
    section: PromptSection<Source>,
    slots: Parameters<PromptSection<Source>['render']>[0],
  ) => string;

export function sectionRenderer(overrides?: PromptSectionOverrides): RenderSection {
  if (!overrides) return (section, slots) => section.render(slots);
  return (section, slots) => {
    const replacement = overrides[section.id];
    return replacement === undefined ? section.render(slots) : section.renderFrom(replacement, slots);
  };
}
