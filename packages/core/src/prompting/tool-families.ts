/**
 * A family's own notes for a native tool, in place of the shared ones: Claude reads Anthropic's subagent guidance, GPT
 * reads Codex's spawn_agent wording (THIRD_PARTY_NOTICES.md). Only words move; the summary and each operation's text stay.
 */
import type { ToolSet } from 'ai';
import { BUILTIN_TOOL_DESCRIPTIONS, BUILTIN_TOOL_SPECS, isBuiltinToolName, renderToolSchemaDescription, type BuiltinToolName } from '../tools/registry';
import type { PromptModelFamily } from './model-profile';

type FamilyNotes = Readonly<Partial<Record<BuiltinToolName, readonly string[]>>>;

const FAMILY_TOOL_NOTES: Readonly<Partial<Record<PromptModelFamily, FamilyNotes>>> = {
  claude: {
    agents: [
      'Use a helper when tasks can run in parallel, need isolated context, or are independent workstreams. For simple tasks, sequential steps, single-file edits, or work that needs context shared across steps, work directly rather than delegating.',
      'A helper costs more than it looks: you write its brief, you see only its report, and trusting that report means reading what it touched. Once you have delegated something, do not also do it yourself.',
    ],
  },
  gpt: {
    agents: [
      'Only hire for a concrete, bounded subtask that can run independently alongside useful local work; otherwise continue locally.',
      'First form a short plan: decide which step is on the critical path and do it yourself now; delegate only sidecar work your next step does not wait on. Keep work local when it is tightly coupled, urgent, or too hard to brief well.',
      'Make each delegated task concrete, self-contained and narrowed to the output you need, and give parallel writers disjoint files. Do not duplicate work between yourself and a helper, and do not redo a helper\'s task.',
      'While a helper runs, do meaningful non-overlapping work; when its report arrives, review its changes, then integrate or refine them.',
    ],
  },
};

/** Each tool whose family has notes of its own, with them in place of the shared notes; the rest untouched. */
export function withFamilyToolNotes(tools: ToolSet, family: PromptModelFamily): ToolSet {
  const notes = FAMILY_TOOL_NOTES[family];

  if (notes === undefined) return tools;

  return Object.fromEntries(Object.entries(tools).map(([name, entry]) => {
    const own = isBuiltinToolName(name) ? notes[name] : undefined;
    const { description } = entry;

    if (!isBuiltinToolName(name) || own === undefined || typeof description !== 'string') return [name, entry];
    const shared = BUILTIN_TOOL_DESCRIPTIONS[name];

    if (!description.startsWith(shared)) return [name, entry];

    return [name, { ...entry, description: renderToolSchemaDescription({ ...BUILTIN_TOOL_SPECS[name], notes: own }) + description.slice(shared.length) }];
  }));
}
