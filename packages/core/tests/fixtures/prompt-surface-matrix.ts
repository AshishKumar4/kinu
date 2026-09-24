/**
 * Prompt surfaces covering each template conditional in both directions, for
 * `unit-prompt-sections.test.ts`. No recorded bytes: comparisons are between live renderings.
 */

import type { SystemPromptOptions } from '../../src/prompt';
import type { DynamicContext } from '../../src/prompting/volatile-context';
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

const DEVICE: PromptExecutorInfo = {
  name: 'device', kind: 'device', available: true, configured: true, active: true, status: 'active',
};

const DEVICE_OFFLINE: PromptExecutorInfo = {
  name: 'device', kind: 'device', available: false, configured: true, active: false, status: 'disconnected',
};

const CUSTOM: PromptExecutorInfo = {
  name: 'gpu', kind: 'device', available: true, configured: true, active: true, status: 'active',
};

const SKILL_HEADER: SkillHeader = {
  name: 'deploy-runbook',
  description: 'How this project deploys.',
  allowed_tools: [],
  user_invocable: true,
  ext: {},
  source: 'builtin',
};

/** Stated lines, so this tests rendering rather than admission. */
const SKILLS_INDEX: SkillsIndex = {
  lines: [skillIndexLine(SKILL_HEADER)],
  omitted: 0,
  tokens: 0,
};

/** Built-in body: trust comes from where it ships. */
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
  readonly mode?: DynamicContext['mode'];
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
      executors: [WORKSPACE, SANDBOX, DEVICE],
      backend: 'cf',
      temporaryAsk: true,
      model: { id: 'claude-sonnet-4-7', provider: 'anthropic' },
      currentDate: '2026-01-01',
      cwd: '/workspace',
      // Both trust tiers: the approved file keeps system placement; the other rides a user message.
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
      // The CLI registers one executor: the machine is the workspace.
      executors: [WORKSPACE],
      backend: 'cli-local',
      temporaryAsk: true,
      model: { id: 'gpt-5-codex', provider: 'openai' },
      currentDate: '2026-01-01',
    },
  },
  {
    name: 'family-kimi',
    opts: {
      availableTools: ['shell', 'memory'],
      backend: 'cf',
      model: { id: 'kimi-k3-instruct', provider: 'moonshot' },
      currentDate: '2026-01-01',
    },
  },
  {
    name: 'family-gpt',
    opts: {
      availableTools: ['shell', 'memory'],
      backend: 'cf',
      model: { id: 'gpt-5-codex', provider: 'openai' },
      currentDate: '2026-01-01',
    },
  },
  {
    name: 'family-gemini',
    opts: {
      availableTools: ['shell', 'memory'],
      backend: 'cf',
      model: { id: 'gemini-3-pro', provider: 'google' },
      currentDate: '2026-01-01',
    },
  },
  {
    name: 'plan-mode-with-submission',
    mode: { workMode: 'plan', planSubmission: true },
    opts: {
      availableTools: ALL_TOOLS,
      executors: [WORKSPACE],
      backend: 'cf',
    },
  },
  {
    name: 'plan-mode-without-submission',
    mode: { workMode: 'plan', planSubmission: false },
    opts: {
      availableTools: ALL_TOOLS,
      executors: [WORKSPACE],
      backend: 'cf',
    },
  },
  ...Object.entries(BUILTIN_ROLE_DEFINITIONS).map(([id, role]) => rolePromptCase(id, role)),
  {
    name: 'no-tools',
    opts: { availableTools: [], executors: [WORKSPACE], backend: 'cf' },
  },
  {
    name: 'external-tools',
    opts: {
      availableTools: ['shell'],
      externalTools: [{ name: 'jira', source: 'mcp', description: 'Issue tracker.' }, 'linear'],
      backend: 'cf',
    },
  },
  {
    name: 'executors-workspace-only',
    opts: { availableTools: ['shell'], executors: [WORKSPACE], backend: 'cf' },
  },
  {
    name: 'executors-offline-device',
    opts: { availableTools: ['shell'], executors: [WORKSPACE, DEVICE_OFFLINE], backend: 'cf' },
  },
  {
    name: 'executors-preview-capable',
    opts: { availableTools: ['shell'], executors: [WORKSPACE, SANDBOX], backend: 'cf' },
  },
  {
    name: 'executors-unnamed-namespace',
    opts: { availableTools: ['shell'], executors: [WORKSPACE, CUSTOM], backend: 'cf' },
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
      availableTools: ['agents', 'eval'],
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
    // One case: without `agents`, `hasTemporaryAsk` is false either way (prompt.ts).
    name: 'code-execution',
    opts: { availableTools: ['eval'], registeredExecutors: [] },
  },
  {
    // The only case rendering `hasTemporaryAsk` true; `delegation-hire-only` is the false direction.
    name: 'delegation-task-lifetime',
    opts: {
      availableTools: ['agents'],
      agentsActions: ['hire', 'msg', 'list'],
      temporaryAsk: true,
      registeredExecutors: [],
    },
  },
];
