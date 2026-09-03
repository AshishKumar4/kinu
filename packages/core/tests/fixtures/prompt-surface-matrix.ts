/**
 * The surfaces the system prompt is frozen against.
 *
 * Sectionising `prompt.ts` moved every line of its prose out of the builder and
 * into `prompting/section-templates.ts`. That is a change of REPRESENTATION, so
 * the landing condition is that not one byte of any rendered prompt moved — the
 * layergate `context-assembly/system-prefix` digest included.
 *
 * A conversion like that is only proven by a matrix, because the bytes are the
 * easy half: every branch in the builder has to keep taking the same branch, and
 * a branch nobody renders is a branch nobody checked. This list covers each
 * conditional at least once in each direction: the two plan-submission
 * spellings, both model-family overlays, each built-in role, the background
 * resume overlay, an offline laptop, a preview-capable executor, the empty
 * tool surface, the delegation rungs one at a time, and a workspace carrying
 * instruction files in both trust tiers.
 *
 * `fixtures/prompt-golden.json` holds the last deliberate rendering of these
 * surfaces. Regenerate it only when a prompt change is the point
 * (`bun run scripts/prompt-golden.ts`), never to make a red test green. It was
 * re-cut on 2026-08-25 by a measured slimming pass; the reasoning and the
 * before/after byte totals are recorded in `unit-prompt-sections.test.ts`.
 */

import type { SystemPromptOptions } from '../../src/prompt';
import { BUILTIN_TOOLS } from '../../src/tools/registry';
import { BUILTIN_ROLE_DEFINITIONS, deriveRoleLabel } from '../../src/profiles';
import type { PromptExecutorInfo } from '../../src/prompting/surface';
import { skillIndexLine } from '../../src/skills/render';
import type { ActiveSkill, SkillHeader, SkillsIndex } from '../../src/skills/types';

const WORKSPACE: PromptExecutorInfo = {
  name: 'workspace', kind: 'workspace', available: true, configured: true, active: true, status: 'active',
};
const SANDBOX: PromptExecutorInfo = {
  name: 'sandbox', kind: 'sandbox', capabilities: ['net_inbound'], available: true, configured: true, active: true, status: 'active',
};
const LAPTOP: PromptExecutorInfo = {
  name: 'laptop', kind: 'laptop', available: true, configured: true, active: true, status: 'active',
};
const LAPTOP_OFFLINE: PromptExecutorInfo = {
  name: 'laptop', kind: 'laptop', available: false, configured: true, active: false, status: 'disconnected',
};
const CUSTOM: PromptExecutorInfo = {
  name: 'gpu', kind: 'laptop', available: true, configured: true, active: true, status: 'active',
};

const SKILL_HEADER: SkillHeader = {
  name: 'deploy-runbook',
  description: 'How this project deploys.',
  allowed_tools: [],
  keywords: ['deploy'],
  auto_activate: false,
  disable_model_invocation: false,
  user_invocable: true,
  ext: {},
  source: 'builtin',
};

/** The ambient index as the admission already decided to print it: this
 *  fixture states the lines, because re-admitting a corpus here would test the
 *  admission rather than the prompt's rendering of its answer. */
const SKILLS_INDEX: SkillsIndex = {
  lines: [skillIndexLine(SKILL_HEADER)],
  omitted: 0,
  tokens: 0,
};

/** The same skill, active, with the body this turn's allocation paid for. A
 *  built-in body: its trust comes from where it ships, not from an approval. */
const ACTIVE_SKILL: ActiveSkill = {
  ...SKILL_HEADER,
  trust: 'builtin',
  bodyRef: { kind: 'builtin', text: 'Body of the deploy runbook.' },
  body: 'Body of the deploy runbook.',
};

const ALL_TOOLS = [...BUILTIN_TOOLS];

export interface PromptCase {
  readonly name: string;
  readonly opts: SystemPromptOptions;
}

function rolePromptCase(
  id: string,
  role: (typeof BUILTIN_ROLE_DEFINITIONS)[keyof typeof BUILTIN_ROLE_DEFINITIONS],
): PromptCase {
  return {
    name: `role-${id}`,
    opts: {
      availableTools: ['memory'],
      roleSection: { id, label: deriveRoleLabel(id), instructions: role.instructions },
      backend: 'cf',
    },
  };
}

export const PROMPT_MATRIX: readonly PromptCase[] = [
  { name: 'defaults', opts: {} },
  {
    name: 'cf-full-surface',
    opts: {
      soulOverride: 'You are Kinu.',
      availableTools: ALL_TOOLS,
      executors: [WORKSPACE, SANDBOX, LAPTOP],
      backend: 'cf',
      workMode: 'build',
      temporaryAsk: true,
      model: { id: 'claude-sonnet-4-7', provider: 'anthropic' },
      currentDate: '2026-01-01',
      cwd: '/workspace',
      // Both trust tiers on one surface, which is the real shape of a workspace
      // the owner approved once and the agent has since written to: the approved
      // file keeps system placement, the other only earns the block that governs
      // it (its bytes ride a user message, not this prompt).
      agentsMd: {
        admitted: [
          { path: '/AGENTS.md', content: 'Root rules.', trust: 'approved' },
          { path: '/workspace/AGENTS.md', content: 'Nearest rules.', trust: 'unverified' },
        ],
        referenced: [],
      },
      availableSkills: SKILLS_INDEX,
      activeSkills: { active: [ACTIVE_SKILL], reasons: [] },
    },
  },
  {
    name: 'cli-local-full-surface',
    opts: {
      soulOverride: 'You are Kinu.',
      availableTools: ALL_TOOLS,
      executors: [WORKSPACE, SANDBOX, LAPTOP],
      backend: 'cli-local',
      temporaryAsk: true,
      model: { id: 'gpt-5-codex', provider: 'openai' },
      currentDate: '2026-01-01',
    },
  },
  {
    name: 'family-kimi',
    opts: {
      availableTools: ['run', 'memory'],
      backend: 'cf',
      model: { id: 'kimi-k3-instruct', provider: 'moonshot' },
      currentDate: '2026-01-01',
    },
  },
  {
    name: 'family-gpt',
    opts: {
      availableTools: ['run', 'memory'],
      backend: 'cf',
      model: { id: 'gpt-5-codex', provider: 'openai' },
      currentDate: '2026-01-01',
    },
  },
  {
    name: 'plan-mode-with-submission',
    opts: {
      availableTools: ALL_TOOLS,
      executors: [WORKSPACE],
      backend: 'cf',
      workMode: 'plan',
      planSubmissionAvailable: true,
    },
  },
  {
    name: 'plan-mode-without-submission',
    opts: {
      availableTools: ALL_TOOLS,
      executors: [WORKSPACE],
      backend: 'cf',
      workMode: 'plan',
      planSubmissionAvailable: false,
    },
  },
  {
    name: 'background-resume',
    opts: { availableTools: ['run'], provenance: 'background_resume', backend: 'cf' },
  },
  ...Object.entries(BUILTIN_ROLE_DEFINITIONS).map(([id, role]) => rolePromptCase(id, role)),
  {
    name: 'no-tools',
    opts: { availableTools: [], executors: [WORKSPACE], backend: 'cf' },
  },
  {
    name: 'external-tools',
    opts: {
      availableTools: ['run'],
      externalTools: [{ name: 'jira', source: 'mcp', description: 'Issue tracker.' }, 'linear'],
      backend: 'cf',
    },
  },
  {
    name: 'executors-workspace-only',
    opts: { availableTools: ['run'], executors: [WORKSPACE], backend: 'cf' },
  },
  {
    name: 'executors-offline-laptop',
    opts: { availableTools: ['run'], executors: [WORKSPACE, LAPTOP_OFFLINE], backend: 'cf' },
  },
  {
    name: 'executors-preview-capable',
    opts: { availableTools: ['run'], executors: [WORKSPACE, SANDBOX], backend: 'cf' },
  },
  {
    name: 'executors-unnamed-namespace',
    opts: { availableTools: ['run'], executors: [WORKSPACE, CUSTOM], backend: 'cf' },
  },
  {
    name: 'executors-cli-local-laptop',
    opts: { availableTools: ['run'], executors: [WORKSPACE, LAPTOP], backend: 'cli-local' },
  },
  {
    name: 'delegation-swarm-only',
    opts: { availableTools: ['agents'], agentsActions: ['swarm'], registeredExecutors: [] },
  },
  {
    name: 'delegation-hire-only',
    opts: { availableTools: ['agents'], agentsActions: ['hire'], registeredExecutors: [] },
  },
  {
    name: 'delegation-swarm-with-codemode',
    opts: {
      availableTools: ['agents', 'execute_tools'],
      agentsActions: ['swarm'],
      temporaryAsk: true,
      registeredExecutors: [],
    },
  },
  {
    name: 'delegation-report-subordinate',
    opts: { availableTools: ['report'], registeredExecutors: [] },
  },
  {
    name: 'code-execution-without-temporary-ask',
    opts: { availableTools: ['execute_tools'], temporaryAsk: false, registeredExecutors: [] },
  },
  {
    name: 'code-execution-with-temporary-ask',
    opts: { availableTools: ['execute_tools'], temporaryAsk: true, registeredExecutors: [] },
  },
  {
    name: 'delegation-temporary-ask',
    opts: {
      availableTools: ['agents'],
      agentsActions: ['ask', 'hire', 'list'],
      temporaryAsk: true,
      registeredExecutors: [],
    },
  },
];
