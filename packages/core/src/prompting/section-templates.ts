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
import externalToolLine from "../prompts/external-tool-line.md" with { type: 'text' };
import operatingGuidance from "../prompts/operating-guidance.md" with { type: 'text' };
import roleSection from "../prompts/role-section.md" with { type: 'text' };
import toolsSection from "../prompts/tools-section.md" with { type: 'text' };
import workspaceExecutorLine from "../prompts/workspace-executor-line.md" with { type: 'text' };
import sandboxExecutorLine from "../prompts/sandbox-executor-line.md" with { type: 'text' };
import deviceExecutorLine from "../prompts/device-executor-line.md" with { type: 'text' };
import offlineDeviceLine from "../prompts/offline-device-line.md" with { type: 'text' };
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
  "{{builtins}}{{externalLines}}{{#if hasExternal}}{{/if}}",
  toolsSection.trimEnd(),
);

/** Hosted, `workspace` is the authoritative Nimbus session. The ceiling is prose fed
 * from the `worker.isolate.memory` catalog fact, not a measured `resourceLimits`. */
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

/** Names no machine: the fleet is volatile and renders in the dynamic-context block. */
export const DEVICE_EXECUTOR_LINE = definePromptSection(
  "executors/device",
  "",
  deviceExecutorLine.trimEnd(),
);

/** An offline device is still listed (the user can bring it back); other unavailable executors are omitted. */
export const OFFLINE_DEVICE_LINE = definePromptSection(
  "executors/device-offline",
  "{{deviceName}}",
  offlineDeviceLine.trimEnd(),
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
  "{{deviceNamespaces}}{{executorLines}}{{exposeCalls}}{{workspaceRoot}}{{#if hasSandbox}}{{/if}}{{#if hasDevices}}{{/if}}{{#if hasPreview}}{{/if}}{{#if workspacePreview}}{{/if}}",
  executorsSection.trimEnd(),
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
  "{{craftedNamespace}}",
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
  "",
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
  "",
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

export const LEAD_PARALLEL = definePromptSection('lead/parallel', '{{#if hasTaskHire}}{{/if}}', leadParallel.trimEnd());

export const LEAD_REVIEW = definePromptSection('lead/review', '', leadReview.trimEnd());

export const LEAD_INTERRUPTION = definePromptSection('lead/interruptions', '', leadInterruptions.trimEnd());

export const LEAD_DELIVERY = definePromptSection('lead/delivery', '', leadDelivery.trimEnd());

export const LEAD_DIRECT_EDIT = definePromptSection('lead/direct-edit', '', leadDirectEdit.trimEnd());

// Files contain only differing paragraphs; no entry means base wording. The familyDelta slot
// survives promotion. GPT/Gemini wording comes from the fork cited above; Claude uses the base.
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
