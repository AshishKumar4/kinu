/**
 * Prompt prose as data: each template is an addressable, evolvable artifact.
 * `{{#if}}` keeps a whole section one string; iteration and non-boolean
 * decisions stay in `prompt.ts` (see `template.ts`). `PROMPT_SECTIONS` is the
 * index the GEPA bridge reads; anything not in it is not separately evolvable.
 */

// One import spelling across Bun/CLI, esbuild and Vite/workerd (Vite's promptText plugin;
// tsconfig.base.json declares the Markdown module).
import agentNamesLine from "../prompts/agent-names-line.md" with { type: 'text' };
import builtinToolLine from "../prompts/builtin-tool-line.md" with { type: 'text' };
import operatingGuidance from "../prompts/operating-guidance.md" with { type: 'text' };
import roleSection from "../prompts/role-section.md" with { type: 'text' };
import toolsSection from "../prompts/tools-section.md" with { type: 'text' };
import toolUseSection from "../prompts/tool-use-section.md" with { type: 'text' };
import workspaceExecutorLine from "../prompts/workspace-executor-line.md" with { type: 'text' };
import sandboxExecutorLine from "../prompts/sandbox-executor-line.md" with { type: 'text' };
import deviceExecutorLine from "../prompts/device-executor-line.md" with { type: 'text' };
import genericExecutorLine from "../prompts/generic-executor-line.md" with { type: 'text' };
import executorsSection from "../prompts/executors-section.md" with { type: 'text' };
import planesSection from "../prompts/planes-section.md" with { type: 'text' };
import persistenceSection from "../prompts/persistence-section.md" with { type: 'text' };
import codeExecutionSection from "../prompts/code-execution-section.md" with { type: 'text' };
import delegationSection from "../prompts/delegation-section.md" with { type: 'text' };
import backgroundWorkSection from "../prompts/background-work-section.md" with { type: 'text' };
import verificationSection from "../prompts/verification-section.md" with { type: 'text' };
import outputFormatSection from "../prompts/output-format-section.md" with { type: 'text' };
import workspaceInstructionsSection from "../prompts/workspace-instructions-section.md" with { type: 'text' };
// Lead/worker doctrine adapted from AshishKumar4/oh-my-pi c6a7d56cc6,
// fusion-lead and agents/sidekick (MIT-licensed sources:
// opencode-fusion and OpenHands; upstream THIRD-PARTY-NOTICES.txt).
import leadResponsibility from '../prompts/lead-responsibility.md' with { type: 'text' };
import leadBrief from '../prompts/lead-brief.md' with { type: 'text' };
import leadParallel from '../prompts/lead-parallel.md' with { type: 'text' };
import leadReview from '../prompts/lead-review.md' with { type: 'text' };
import leadInterruptions from '../prompts/lead-interruptions.md' with { type: 'text' };
import leadDelivery from '../prompts/lead-delivery.md' with { type: 'text' };
// GPT wording follows Codex's instructions and Claude wording Claude Code's (THIRD_PARTY_NOTICES.md).
import operatingGeneric from '../prompts/operating-guidance.generic.md' with { type: 'text' };
import operatingGpt from '../prompts/operating-guidance.gpt.md' with { type: 'text' };
import operatingClaude from '../prompts/operating-guidance.claude.md' with { type: 'text' };
import operatingGemini from '../prompts/operating-guidance.gemini.md' with { type: 'text' };
import operatingKimi from '../prompts/operating-guidance.kimi.md' with { type: 'text' };
import toolUseGeneric from '../prompts/tool-use.generic.md' with { type: 'text' };
import toolUseGpt from '../prompts/tool-use.gpt.md' with { type: 'text' };
import toolUseClaude from '../prompts/tool-use.claude.md' with { type: 'text' };
import outputGeneric from '../prompts/output-format.generic.md' with { type: 'text' };
import outputGpt from '../prompts/output-format.gpt.md' with { type: 'text' };
import outputClaude from '../prompts/output-format.claude.md' with { type: 'text' };
import briefGpt from '../prompts/lead-brief.gpt.md' with { type: 'text' };
import { definePromptSection, type PromptSection } from './template';
import type { PromptModelFamily } from './model-profile';

/**
 * Who the model is, by title (never the slug), rendered from the live title.
 * Not in `PROMPT_SECTIONS`: runtime facts, nothing to optimise.
 */
export const AGENT_NAMES_LINE = definePromptSection(
  "identity/names",
  "{{agent}}{{workspace}}{{#if hasWorkspace}}{{/if}}{{#if isSubagent}}{{/if}}",
  agentNamesLine.trimEnd(),
);

/**
 * No `summary` slot: it already ships as the first line of the tool's schema
 * description (registry.ts renderToolSchemaDescription). The `example` has no
 * other route to the model (OpenAI GPT-4.1 prompting guide, § Tool calls).
 */
export const BUILTIN_TOOL_LINE = definePromptSection(
  "tools/builtin-line",
  "{{example}}{{name}}",
  builtinToolLine.trimEnd(),
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

/** The one Role section: the resolved role's own instructions, copied nowhere else. */
export const ROLE_SECTION = definePromptSection(
  "role/profile",
  "{{id}}{{instructions}}{{label}}",
  roleSection.trimEnd(),
);

/** One index for every model family. When-to-use doctrine lives in the schema
 * descriptions (registry.ts); the prompt shows one real call per tool. */
export const TOOLS_SECTION = definePromptSection(
  "tools/index",
  "{{builtins}}",
  toolsSection.trimEnd(),
);

/** How to use the tools above, worded per family; the index stays family-neutral. */
export const TOOL_USE_SECTION = definePromptSection(
  "tools/use",
  '{{familyDelta}}',
  toolUseSection.trimEnd(),
);

/** Hosted, `workspace` is the authoritative Nimbus session. The ceiling is prose fed
 * from the `worker.isolate.memory` catalog fact, not a measured `resourceLimits`. */
export const WORKSPACE_EXECUTOR_LINE = definePromptSection(
  "executors/workspace",
  "{{memoryMb}}{{#if cliLocal}}{{/if}}",
  workspaceExecutorLine.trimEnd(),
);

/** Sized from the host's table, which the sandbox executor reports; the current size is volatile, so absent. */
export const SANDBOX_EXECUTOR_LINE = definePromptSection(
  "executors/sandbox",
  "{{#if sized}}{{defaultSize}}{{sizes}}{{/if}}",
  sandboxExecutorLine.trimEnd(),
);

/** Names no machine: the fleet is volatile and renders in the dynamic-context block. */
export const DEVICE_EXECUTOR_LINE = definePromptSection(
  "executors/device",
  "",
  deviceExecutorLine.trimEnd(),
);

export const GENERIC_EXECUTOR_LINE = definePromptSection(
  "executors/generic",
  "{{name}}",
  genericExecutorLine.trimEnd(),
);

/**
 * Doctrine only; live availability and live mounts render in volatile context,
 * never in this cacheable prefix. Mount doctrine is stated once under
 * `hasDevices` (implied by `executors.length > 1`). `hasSandbox` adds that the
 * file plane's `/sandbox` is the container's `/`. Approvals doctrine is stated
 * once, only on turns with a shell.
 */
export const EXECUTORS_SECTION = definePromptSection(
  "executors/section",
  "{{deviceNamespaces}}{{executorLines}}{{exposeCalls}}{{workspaceRoot}}{{#if hasFolder}}{{/if}}{{#if hasSandbox}}{{/if}}{{#if hasDevices}}{{/if}}{{#if hasPreview}}{{/if}}{{#if workspacePreview}}{{/if}}{{#if hasHire}}{{/if}}",
  executorsSection.trimEnd(),
);

/** Each prefix as the `vfs://` subtree it names, and where each subtree is on this machine: a fact per workspace, after the shared prefix. */
export const PLANES_SECTION = definePromptSection(
  "executors/planes",
  "{{aliases}}{{mounts}}{{ownSkills}}{{views}}{{#if hasViews}}{{/if}}{{#if hasOwnSkills}}{{/if}}",
  planesSection.trimEnd(),
);

export const PERSISTENCE_SECTION = definePromptSection(
  "state/persistence",
  "",
  persistenceSection.trimEnd(),
);

/** Does not enumerate `agent.*`: the codemode declarations (tools/agent-self.ts TYPES) own
 * that. States only the two habits and where the contracts are. */
export const CODE_EXECUTION_SECTION = definePromptSection(
  "state/code-execution",
  "",
  codeExecutionSection.trimEnd(),
);

/** Names the helper lifetimes; which rung to pick lives in the `agents` tool description. */
export const DELEGATION_SECTION = definePromptSection(
  "state/delegation",
  "{{#if hasActions}}{{/if}}{{#if hasHire}}{{/if}}{{#if hasReport}}{{/if}}{{#if hasSwarm}}{{/if}}{{#if hasTemporaryAsk}}{{/if}}{{#if rungsInCode}}{{/if}}",
  delegationSection.trimEnd(),
);

export const BACKGROUND_WORK_SECTION = definePromptSection(
  "state/background-work",
  "{{#if hasHire}}{{/if}}",
  backgroundWorkSection.trimEnd(),
);

/**
 * Last doctrine before the answer. Deliberately no re-read/re-check instruction:
 * the CompletionGate is that mechanism, and an unconditional re-verification pass
 * is what Anthropic's Opus 5 guidance says to delete.
 */
export const VERIFICATION_SECTION = definePromptSection(
  "state/verification",
  "{{#if hasShell}}{{/if}}",
  verificationSection.trimEnd(),
);

export const OUTPUT_FORMAT_SECTION = definePromptSection(
  "state/output-format",
  "{{familyDelta}}",
  outputFormatSection.trimEnd(),
);

/** Tells the model what the unapproved-instructions delimiter means (KINU-N028). Lives
 * in the immutable prefix, above the block, so its bytes cannot displace the rule. */
export const WORKSPACE_INSTRUCTIONS_SECTION = definePromptSection(
  "state/workspace-instructions",
  "",
  workspaceInstructionsSection.trimEnd(),
);

// Only the root actor with a wired hire action renders these.
export const LEAD_RESPONSIBILITY = definePromptSection('lead/responsibility', '{{#if hasTaskHire}}{{/if}}', leadResponsibility.trimEnd());

export const LEAD_BRIEF = definePromptSection('lead/brief', '{{familyDelta}}', leadBrief.trimEnd());

export const LEAD_PARALLEL = definePromptSection('lead/parallel', '', leadParallel.trimEnd());

export const LEAD_REVIEW = definePromptSection('lead/review', '', leadReview.trimEnd());

export const LEAD_INTERRUPTION = definePromptSection('lead/interruptions', '', leadInterruptions.trimEnd());

export const LEAD_DELIVERY = definePromptSection('lead/delivery', '', leadDelivery.trimEnd());

// A family's wording for a section: GPT reads Codex's, Claude reads Claude Code's, any other model the generic
// text, which alone carries every behaviour. Gemini and Kimi add their own lines to it. The familyDelta slot
// survives promotion.
const delta = (id: string, source: string) => definePromptSection(id, '', source.trimEnd());

const OPERATING_GENERIC = delta('delta/operating-generic', operatingGeneric);

const TOOL_USE_GENERIC = delta('delta/tool-use-generic', toolUseGeneric);

const OUTPUT_GENERIC = delta('delta/output-generic', outputGeneric);

const FAMILY_DELTAS = new Map<string, Readonly<Partial<Record<PromptModelFamily, readonly PromptSection<''>[]>>>>([
  [OPERATING_GUIDANCE.id, {
    generic: [OPERATING_GENERIC],
    gpt: [delta('delta/operating-gpt', operatingGpt)],
    claude: [delta('delta/operating-claude', operatingClaude)],
    gemini: [OPERATING_GENERIC, delta('delta/operating-gemini', operatingGemini)],
    kimi: [OPERATING_GENERIC, delta('delta/operating-kimi', operatingKimi)],
  }],
  [TOOL_USE_SECTION.id, {
    generic: [TOOL_USE_GENERIC],
    gpt: [delta('delta/tool-use-gpt', toolUseGpt)],
    claude: [delta('delta/tool-use-claude', toolUseClaude)],
    gemini: [TOOL_USE_GENERIC],
    kimi: [TOOL_USE_GENERIC],
  }],
  [OUTPUT_FORMAT_SECTION.id, {
    generic: [OUTPUT_GENERIC],
    gpt: [delta('delta/output-gpt', outputGpt)],
    claude: [delta('delta/output-claude', outputClaude)],
    gemini: [OUTPUT_GENERIC],
    kimi: [OUTPUT_GENERIC],
  }],
  [LEAD_BRIEF.id, {
    gpt: [delta('delta/brief-gpt', briefGpt)],
  }],
]);

export function promptFamilyDelta(sectionId: string, family: PromptModelFamily): string {
  return (FAMILY_DELTAS.get(sectionId)?.[family] ?? []).map((section) => `\n${section.render({})}`).join('');
}

export const PROMPT_SECTIONS: readonly PromptSection<string>[] = [
  OPERATING_GUIDANCE,
  ROLE_SECTION,
  TOOLS_SECTION,
  TOOL_USE_SECTION,
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
];

/** Absent means built-in sources, the state the layergate prefix digest is locked against. */
export type PromptSectionOverrides = Readonly<Record<string, string>>;

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
