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
 * `PROMPT_SECTIONS` at the foot is the section index the GEPA bridge reads
 * (`evolution/gepa/section-bridge.ts`). A template that is not in it is a line or
 * a fragment, not a section, and is not separately evolvable.
 */

// One import spelling across Bun/CLI, esbuild and Vite/workerd. Vite's
// promptText plugin implements the text attribute in both of its configs;
// tsconfig.base.json includes the shared Markdown module declaration.
import agentNamesLine from "../prompts/agent-names-line.md" with { type: 'text' };
import builtinToolLine from "../prompts/builtin-tool-line.md" with { type: 'text' };
import externalToolLine from "../prompts/external-tool-line.md" with { type: 'text' };
import operatingGuidance from "../prompts/operating-guidance.md" with { type: 'text' };
import roleSection from "../prompts/role-section.md" with { type: 'text' };
import toolsSection from "../prompts/tools-section.md" with { type: 'text' };
import workspaceExecutorLine from "../prompts/workspace-executor-line.md" with { type: 'text' };
import sandboxExecutorLine from "../prompts/sandbox-executor-line.md" with { type: 'text' };
import laptopExecutorLine from "../prompts/laptop-executor-line.md" with { type: 'text' };
import offlineLaptopLine from "../prompts/offline-laptop-line.md" with { type: 'text' };
import genericExecutorLine from "../prompts/generic-executor-line.md" with { type: 'text' };
import executorsSection from "../prompts/executors-section.md" with { type: 'text' };
import persistenceSection from "../prompts/persistence-section.md" with { type: 'text' };
import codeExecutionSection from "../prompts/code-execution-section.md" with { type: 'text' };
import delegationSection from "../prompts/delegation-section.md" with { type: 'text' };
import backgroundWorkSection from "../prompts/background-work-section.md" with { type: 'text' };
import verificationSection from "../prompts/verification-section.md" with { type: 'text' };
import outputFormatSection from "../prompts/output-format-section.md" with { type: 'text' };
import workspaceInstructionsSection from "../prompts/workspace-instructions-section.md" with { type: 'text' };
// Lead/worker doctrine adapted from AshishKumar4/oh-my-pi c6a7d56cc6,
// fusion-lead/direct-edit-reminder and agents/sidekick (MIT-licensed sources:
// opencode-fusion and OpenHands; upstream THIRD-PARTY-NOTICES.txt).
import leadResponsibility from '../prompts/lead-responsibility.md' with { type: 'text' };
import leadBrief from '../prompts/lead-brief.md' with { type: 'text' };
import leadParallel from '../prompts/lead-parallel.md' with { type: 'text' };
import leadReview from '../prompts/lead-review.md' with { type: 'text' };
import leadInterruptions from '../prompts/lead-interruptions.md' with { type: 'text' };
import leadDelivery from '../prompts/lead-delivery.md' with { type: 'text' };
import leadDirectEdit from '../prompts/lead-direct-edit.md' with { type: 'text' };
import operatingKimi from '../prompts/operating-guidance.kimi.md' with { type: 'text' };
import operatingGpt from '../prompts/operating-guidance.gpt.md' with { type: 'text' };
import operatingGemini from '../prompts/operating-guidance.gemini.md' with { type: 'text' };
import briefGpt from '../prompts/lead-brief.gpt.md' with { type: 'text' };
import { definePromptSection, type PromptSection } from './template';
import type { PromptModelFamily } from './model-profile';

/**
 * Who the model is, by name.
 *
 * The slug a workspace is addressed by (`identity/naming.ts` workspaceSlug) is
 * an ID, and before this line it was the only name a prompt carried: the CLI
 * create path seeded SOUL.md's heading with it, and that heading is the first
 * thing `buildSystemPromptSync` emits. So a fresh workspace introduced itself
 * to its own model as `handwrought-walnut-4166c321`.
 *
 * Rendered from the LIVE title rather than from any document. A title lands
 * after birth — `planWorkspaceTitle` names the workspace from its first prompt
 * — and a heading seeded before that cannot follow it.
 *
 * Not in `PROMPT_SECTIONS`: this states two facts the runtime holds, so there
 * is no wording for an optimiser to improve and nothing it could rewrite that
 * would still be true.
 */
export const AGENT_NAMES_LINE = definePromptSection(
  "identity/names",
  "{{agent}}{{workspace}}{{#if hasWorkspace}}{{/if}}{{#if isSubagent}}{{/if}}",
  agentNamesLine.trimEnd(),
);

/**
 * One built-in tool's index entry: its name and one real call.
 *
 * The builder maps this over the turn's tool list, so the iteration is typed
 * TypeScript and only the line's wording lives here.
 *
 * NO `summary` slot. The summary is already the first line of the tool's own
 * JSON-schema description (registry.ts renderToolSchemaDescription), which
 * ships in the SAME request, so rendering it here sent every summary twice per
 * turn — 942 chars across the eight builtins, measured 2026-08-25. OpenAI
 * measured the general case of hand-copying schema text into the prompt: "a 2%
 * increase in SWE-bench Verified pass rate when using API-parsed tool
 * descriptions versus manually injecting the schemas"
 * (developers.openai.com/cookbook/examples/gpt4-1_prompting_guide, § Tool
 * calls), so the second copy was not free-but-harmless.
 *
 * What survives is the `example`, which the schema description does NOT carry
 * and which has no other route to a model. That split is the shape the same
 * guide prescribes: put examples in "an `# Examples` section in your system
 * prompt ... rather than adding them into the \"description\" field".
 */
export const BUILTIN_TOOL_LINE = definePromptSection(
  "tools/builtin-line",
  "{{example}}{{name}}",
  builtinToolLine.trimEnd(),
);

/** One connected provider's tool. The source label and the description suffix
 *  are computed by the builder, because both are absences as often as values. */
export const EXTERNAL_TOOL_LINE = definePromptSection(
  "tools/external-line",
  "{{description}}{{name}}{{source}}",
  externalToolLine.trimEnd(),
);

/**
 * Stable operating doctrine. The current mode and submission reach ride the
 * dynamic ledger, while tool execution still enforces the resolved profile.
 * GEPA can tune this section's wording, not the mode's permission rules.
 */
export const OPERATING_GUIDANCE = definePromptSection(
  "guidance/operating",
  '{{familyDelta}}',
  operatingGuidance.trimEnd(),
);

/**
 * The ONE Role section. Its body is the resolved role's own instructions and
 * nothing else — no second surface copies role prose, so an authority that
 * edits a definition changes exactly one rendered block.
 */
export const ROLE_SECTION = definePromptSection(
  "role/profile",
  "{{id}}{{instructions}}{{label}}",
  roleSection.trimEnd(),
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
  "tools/index",
  "{{builtins}}{{externalLines}}{{#if hasExternal}}{{/if}}",
  toolsSection.trimEnd(),
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
  "executors/workspace",
  "{{memoryMb}}{{#if cliLocal}}{{/if}}",
  workspaceExecutorLine.trimEnd(),
);

export const SANDBOX_EXECUTOR_LINE = definePromptSection(
  "executors/sandbox",
  "",
  sandboxExecutorLine.trimEnd(),
);

/**
 * The namespace line names no machine. Which machines the user has, which
 * are live, and whether this workspace holds each one's grant are the FLEET,
 * and the fleet is volatile: it renders in the dynamic-context block, by
 * name, every step. This line carries only what never changes — what the
 * namespace is and how a call names its machine.
 */
export const LAPTOP_EXECUTOR_LINE = definePromptSection(
  "executors/laptop",
  "{{#if cliLocal}}{{/if}}",
  laptopExecutorLine.trimEnd(),
);

/** A registered-but-offline device is still listed (the user can bring it
 *  back), unlike other unavailable executors, which are omitted entirely. */
export const OFFLINE_LAPTOP_LINE = definePromptSection(
  "executors/laptop-offline",
  "{{deviceName}}",
  offlineLaptopLine.trimEnd(),
);

export const GENERIC_EXECUTOR_LINE = definePromptSection(
  "executors/generic",
  "{{name}}",
  genericExecutorLine.trimEnd(),
);

/**
 * Doctrine only — live availability labels render in the per-turn volatile
 * context message (prompting/volatile-context.ts), never in this cacheable
 * prefix, so a sandbox waking up doesn't re-prefill the whole conversation.
 *
 * No backend conditional on the separate-machines line: the workspace
 * filesystem is the same durable component everywhere, and every other runtime
 * is a different machine on every backend. So the line is unconditional and the
 * prompt carries no per-backend exception.
 *
 * The file doctrine states the mount table: a live environment's files appear
 * in the agent's own plane under its mount point (`/pc`, `/sandbox` —
 * vfs/mounts.ts), where the `file` tool and `workspace.*` reach them directly.
 * Which mounts are live RIGHT NOW is volatile state; it renders on the
 * executor rows in the dynamic-context block, never here. The workspace shell
 * stays a shell over workspace bytes only — commands do not see mount points,
 * and that limit is stated so the model routes commands by namespace.
 *
 * The mount doctrine is stated ONCE, under ONE gate — `hasDevices`. Two
 * paragraphs saying the same three facts (separate machines, commands through
 * their own namespace, mounts showing native paths) in different words are
 * free to disagree with each other, and cost tokens twice: the recorded
 * comparison is 724 characters for 600 of content when the three facts are
 * worded in separate paragraphs. `hasDevices` is deliberately the WEAKER
 * condition: `executors.length > 1` implies it — with two or more executors
 * at most one is `workspace`, so a device is always among them — and not the
 * reverse, so gating on it loses no surface and a lone non-workspace executor
 * (a sandbox with no workspace beside it) reads the doctrine too.
 *
 * What the mount paragraph cannot say is the one equivalence a device-less
 * workspace still needs: the container mounts its WHOLE filesystem, so the
 * file plane's `/sandbox` is the container's `/` while its commands run in
 * `/workspace`. That is `hasSandbox`'s one sentence — gated separately because
 * it names only the container and holds with or without a device bound.
 *
 * The approvals doctrine is stated ONCE, and only on turns that have a shell.
 * It is a standing fact about this surface, so it lives here and the parked
 * tool result is one line (safety/deferred-approval.ts) instead of 222 tokens
 * of the same doctrine on every call. It names no executor: which ones exist
 * this turn is the list above.
 */
export const EXECUTORS_SECTION = definePromptSection(
  "executors/section",
  "{{deviceNamespaces}}{{executorLines}}{{exposeCalls}}{{workspaceRoot}}{{#if hasSandbox}}{{/if}}{{#if hasDevices}}{{/if}}{{#if hasPreview}}{{/if}}{{#if workspacePreview}}{{/if}}",
  executorsSection.trimEnd(),
);

export const PERSISTENCE_SECTION = definePromptSection(
  "state/persistence",
  "",
  persistenceSection.trimEnd(),
);

/**
 * The scaffold self-provider ships on both backends, so `agent.*` needs no
 * gate here.
 *
 * This section does NOT enumerate the `agent.*` API: prose describing a
 * declaration it cannot read is free to disagree with it. The codemode
 * declarations own that documentation — every symbol with its doc comment in
 * the `agent.*` type block (tools/agent-self.ts TYPES), shipped to the model
 * in the same request inside the execute_tools description
 * (registry.ts renderExecuteToolsDescription), including scaffold gates,
 * export shape, host-bridge restriction and rationale floor — and are emitted
 * only for wired providers. Both backends wire agent-self today (cf
 * orchestrator.ts, cli local-session.ts). A duplicate bullet list here would
 * add 1,250 hand-maintained characters outside that declaration gate.
 *
 * What this section states is the half no declaration carries: the two HABITS
 * (look before building, save what you built), and one pointer at the namespace
 * so the model knows where the contracts are.
 */
export const CODE_EXECUTION_SECTION = definePromptSection(
  "state/code-execution",
  "{{craftedNamespace}}",
  codeExecutionSection.trimEnd(),
);

/**
 * The `agents` index: which helper lifetimes exist, and nothing about when to
 * pick one. The section names the actions and their one-line shape; which rung
 * a task wants is selection doctrine and lives in the `agents` tool
 * description (registry.ts), which every family reads.
 */
export const DELEGATION_SECTION = definePromptSection(
  "state/delegation",
  "{{#if hasActions}}{{/if}}{{#if hasHire}}{{/if}}{{#if hasReport}}{{/if}}{{#if hasSwarm}}{{/if}}{{#if hasTemporaryAsk}}{{/if}}{{#if rungsInCode}}{{/if}}",
  delegationSection.trimEnd(),
);

export const BACKGROUND_WORK_SECTION = definePromptSection(
  "state/background-work",
  "",
  backgroundWorkSection.trimEnd(),
);

/**
 * Last doctrine before the answer, because that is when it applies. Each line
 * targets an observed failure where the model solved the problem and then
 * fumbled the deliverable: reasoning the causal structure out correctly and
 * writing every row of it transposed; building an API to its own convenient
 * signature and self-grading it green against its own tests.
 *
 * Deliberately NOT here: any instruction to re-read or re-check as such. The
 * CompletionGate is that instruction as a mechanism — it shows the harness's
 * own reading of the working directory and asks for it to be checked against
 * the task — and an unconditional re-verification pass is the family
 * Anthropic's Opus 5 guidance says to delete: removing it measured a third
 * off cost per ticket with no accuracy change. The framing sentence went
 * first; "Re-read the artifact itself against the request's own words" was
 * the same instruction in narrower words and went with it. What survives is
 * what the gate does not say and cannot: the exact SHAPE the request named,
 * and the interface the work will be called through. Both name a specific
 * thing to look at, neither asks for a second pass over the whole artifact.
 */
export const VERIFICATION_SECTION = definePromptSection(
  "state/verification",
  "{{#if hasShell}}{{/if}}",
  verificationSection.trimEnd(),
);

export const OUTPUT_FORMAT_SECTION = definePromptSection(
  "state/output-format",
  "",
  outputFormatSection.trimEnd(),
);

/**
 * The rule that makes the unapproved-instructions block a boundary rather than
 * a decoration (KINU-N028).
 *
 * A delimiter on its own is not a boundary: the model has to be told what the
 * delimiter MEANS. This is that telling, and it lives in the immutable prefix,
 * above the block it governs, so the bytes inside cannot displace the rule
 * about themselves. Rendered only on turns that actually carry such a block.
 */
export const WORKSPACE_INSTRUCTIONS_SECTION = definePromptSection(
  "state/workspace-instructions",
  "",
  workspaceInstructionsSection.trimEnd(),
);

/**
 * The sections of the system prompt, in the order they render.
 *
 * This is the GEPA target index and the answer to "what is a section": a piece
 * of prose the builder emits as one block, addressable end to end. The
 * per-line templates above are fragments of these, not entries here — a line
 * evolved on its own would be scored against a prompt it cannot move.
 *
 * `PromptSection<string>` erases the compile-time slot contract on purpose: the
 * registry holds a different contract per entry, and what a generic consumer
 * needs is the id and the source. Rendering still goes through the concrete
 * export, so every call site keeps its exact typed slots.
 */
// Separate rule families remain evolvable under GEPA's unchanged 4,800-byte
// section ceiling. Only the root actor with a wired hire action renders these.
export const LEAD_RESPONSIBILITY = definePromptSection('lead/responsibility', '{{#if hasTaskHire}}{{/if}}', leadResponsibility.trimEnd());

export const LEAD_BRIEF = definePromptSection('lead/brief', '{{familyDelta}}', leadBrief.trimEnd());

export const LEAD_PARALLEL = definePromptSection('lead/parallel', '{{#if hasTaskHire}}{{/if}}', leadParallel.trimEnd());

export const LEAD_REVIEW = definePromptSection('lead/review', '', leadReview.trimEnd());

export const LEAD_INTERRUPTION = definePromptSection('lead/interruptions', '', leadInterruptions.trimEnd());

export const LEAD_DELIVERY = definePromptSection('lead/delivery', '', leadDelivery.trimEnd());

export const LEAD_DIRECT_EDIT = definePromptSection('lead/direct-edit', '', leadDirectEdit.trimEnd());

// Files contain only differing paragraphs. No entry means base wording, not
// another copy of the base. The required familyDelta slot survives promotion,
// so GEPA replaces one whole section while the selected delta still composes.
// GPT packet and Gemini redirect wording come from the same fork cited above;
// Claude has no fork-authored delta and deliberately uses the shared base.
const FAMILY_DELTAS = new Map<string, Readonly<Partial<Record<PromptModelFamily, PromptSection<''>>>>>([
  [OPERATING_GUIDANCE.id, {
    kimi: definePromptSection('delta/operating-kimi', '', operatingKimi.trimEnd()),
    gpt: definePromptSection('delta/operating-gpt', '', operatingGpt.trimEnd()),
    gemini: definePromptSection('delta/operating-gemini', '', operatingGemini.trimEnd()),
  }],
  [LEAD_BRIEF.id, {
    gpt: definePromptSection('delta/brief-gpt', '', briefGpt.trimEnd()),
  }],
]);

export function promptFamilyDelta(sectionId: string, family: PromptModelFamily): string {
  const delta = FAMILY_DELTAS.get(sectionId)?.[family];

  return delta ? `\n${delta.render({})}` : '';
}

export const PROMPT_SECTIONS: readonly PromptSection<string>[] = [
  OPERATING_GUIDANCE,
  ROLE_SECTION,
  TOOLS_SECTION,
  EXECUTORS_SECTION,
  PERSISTENCE_SECTION,
  CODE_EXECUTION_SECTION,
  DELEGATION_SECTION,
  BACKGROUND_WORK_SECTION,
  VERIFICATION_SECTION,
  OUTPUT_FORMAT_SECTION,
  WORKSPACE_INSTRUCTIONS_SECTION,
  LEAD_RESPONSIBILITY,
  LEAD_BRIEF,
  LEAD_PARALLEL,
  LEAD_REVIEW,
  LEAD_INTERRUPTION,
  LEAD_DELIVERY,
  LEAD_DIRECT_EDIT,
];

/** A promoted replacement per section id, resolved by the backend before the
 *  turn. Absent means every section renders its built-in source — the state the
 *  layergate prefix digest is locked against. */
export type PromptSectionOverrides = Readonly<Record<string, string>>;

/** Renders a section against the turn's overrides. One closure is built per
 *  prompt so every call site stays a `render(SECTION, {…})`. */
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
