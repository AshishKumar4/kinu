/**
 * The surfaces the system prompt is measured over.
 *
 * `prompt.ts` holds no prose: every line of it lives in
 * `prompting/section-templates.ts` as one addressable template, and the
 * builder renders the eleven of them through one override-aware seam. Both
 * properties are branch-shaped — a section that renders on one arm and not the
 * other, a family overlay, a plan-submission spelling — so measuring them takes
 * a matrix rather than one call: a branch nobody renders is a branch nobody
 * checked.
 *
 * This list covers each conditional at least once in each direction: the two
 * plan-submission spellings, both model-family overlays, each built-in role,
 * an offline laptop, a preview-capable executor, the empty tool surface, the
 * delegation rungs one at a time, and a workspace carrying instruction files
 * in both trust tiers. No resume case: provenance is turn-local and renders
 * no system section at all (prompting/volatile-context.ts).
 *
 * Consumers (`unit-prompt-sections.test.ts`): the per-section override
 * controls, which compare two LIVE renderings, and the whole-matrix byte
 * ceiling. Nothing here records prompt bytes — the prompt's content changes
 * deliberately, and a recorded rendering would only ever say which prompt
 * shipped the day it was recorded.
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
    // ONE case, not the `code-execution-with/without-temporary-ask` pair this
    // replaces. `temporaryAsk` reaches the prompt only through the Delegation
    // section's `hasTemporaryAsk`, which is `surface.temporaryAsk && has('ask')`
    // (prompt.ts) — so on a surface carrying `execute_tools` and no `agents`
    // tool the flag renders nothing in either position, and the two cases were
    // one request under two names. The Code-execution section had its own
    // `agents.ask` bullet until the 2026-09-03 delegation-nudge cutover; the
    // pair outlived it.
    name: 'code-execution',
    opts: { availableTools: ['execute_tools'], registeredExecutors: [] },
  },
  {
    // The ask rung's TRUE direction, and the only case that renders it. Its
    // false direction is `delegation-hire-only` above: the section branches on
    // `hasTemporaryAsk`, not on why it is false, so a fourth case pairing these
    // actions with `temporaryAsk: false` renders `delegation-hire-only`'s exact
    // bytes and measures nothing.
    name: 'delegation-temporary-ask',
    opts: {
      availableTools: ['agents'],
      agentsActions: ['ask', 'hire', 'list'],
      temporaryAsk: true,
      registeredExecutors: [],
    },
  },
];
