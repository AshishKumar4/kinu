/**
 * A family's own notes for a native tool, in place of the shared ones: Claude reads Claude Code's wording, GPT reads
 * Codex's (THIRD_PARTY_NOTICES.md). Only words move; the summary and every operation's own text stay as built.
 */
import type { ToolSet } from 'ai';
import { BUILTIN_TOOL_DESCRIPTIONS, BUILTIN_TOOL_SPECS, isBuiltinToolName, renderToolSchemaDescription, type BuiltinToolName } from '../tools/registry';
import type { PromptModelFamily } from './model-profile';

type FamilyNotes = Readonly<Partial<Record<BuiltinToolName, readonly string[]>>>;

const FAMILY_TOOL_NOTES: Readonly<Partial<Record<PromptModelFamily, FamilyNotes>>> = {
  claude: {
    file: [
      '`read`: when you already know which part of the file you need, only read that part: `offset` is the line to start from, `limit` the number of lines.',
      '`edit`: you must `read` the file before editing it, or the edit fails. `old_text` must match the file exactly, including indentation, and be unique; keep it to the few lines that make it unique.',
      '`write` creates a file, or replaces in full one you have read; for partial changes, use `edit`.',
      'Do not re-read a file you just edited to verify it: the edit would have failed if it had not applied.',
    ],
    agents: [
      'Reach for a helper when you have independent work to run in parallel, or when answering would mean reading across many files: delegate it and you keep the conclusion, not the file dumps. For a lookup whose target you already know, search directly.',
      'A helper costs more than it looks: you see only its report, and its mistakes come back in the same confident register as its findings. Do the work yourself when it is a handful of tool calls; do not delegate a check you could run inline. When in doubt, do not hire.',
      'Once you have delegated something, do not also do it yourself. A report is not shown to the user: relay what matters.',
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
