/**
 * Canonical system-prompt builder. Both CF and CLI surfaces call this so the
 * LLM sees the same tool documentation and the same `codemode.*` / `workspace.*`
 * vocabulary — the drift fix for F1.
 */

import type { AgentRuntime } from './types/agent-runtime.js';
import {
  BUILTIN_TOOLS,
  BUILTIN_TOOL_DESCRIPTIONS,
  type BuiltinToolName,
} from './tools/registry.js';

export interface SystemPromptOptions {
  /** Executor provider names currently registered (e.g. ['workspace', 'nimbus']). */
  registeredExecutors?: string[];
  /** Extra knowledge to append — CLI pastes the first few KB of memory/MEMORY.md. */
  extraKnowledge?: string;
  /** Override the soul/purpose lookup. If omitted, reads from agent_soul. */
  purposeOverride?: string;
}

const FALLBACK_PURPOSE = 'You are Proteus, a self-evolving coding agent with a persistent ' +
  'world model (remember_fact / recall_fact), a mutable tool surface (codemode crafted ' +
  'tools), parallel exploration (think / split_heads), and the ability to spawn sub-LLM ' +
  'calls inside the codemode sandbox (llm.query).';

function renderExecutorSection(names: string[]): string {
  if (names.length === 0) return '';
  const lines = names.map((n) => {
    switch (n) {
      case 'workspace':
        return '  **workspace.*** — local VFS + shell (readFile, writeFile, readdir, exists, exec, listTools, createTool). For memory use the top-level `save_note` / `search_memory` tools, not workspace.*.';
      case 'nimbus':
        return '  **nimbus.*** — full dev env over DO RPC';
      case 'sandbox':
        return '  **sandbox.*** — Linux VM over Container (use this for any process that listens on a port; workspace.exec runs in the Worker and cannot expose ports)';
      case 'laptop':
        return '  **laptop.*** — user\'s local machine over SSH tunnel';
      default:
        return `  **${n}.*** — registered executor`;
    }
  });
  // When the sandbox executor is registered, append a "Showing apps" guide
  // so the model knows that user-visible previews require exposePort. The
  // app's UI auto-renders the returned URL as a live iframe in the chat
  // and on the Executors tab. (STABILITY-AUDIT §C1.)
  const showingApps = names.includes('sandbox')
    ? `\n### Showing a running app to the user
For the user to *see* a running web app, you MUST call \`sandbox.exposePort(port)\`
after starting the server. The returned URL renders as a live iframe both
inline in the chat (next to the tool result) and on the Executors tab. A
server running inside the sandbox without exposePort is invisible to the
user. Typical flow:
\`\`\`
await sandbox.exec("cd /workspace && nohup node server.js > out.log 2>&1 &")
const url = await sandbox.exposePort(8080)   // returns the preview URL
\`\`\`
Background the dev server (trailing \`&\` + \`nohup\`) so \`exec\` returns; the
container keeps the process alive across subsequent calls.\n`
    : '';
  return `\n### Executor namespaces inside execute_tools\n${lines.join('\n')}\n${showingApps}`;
}

function renderBuiltinToolsSection(): string {
  return BUILTIN_TOOLS.map((name: BuiltinToolName) => {
    return `- **${name}** — ${BUILTIN_TOOL_DESCRIPTIONS[name]}`;
  }).join('\n');
}

/**
 * Synchronous form. CF's Think.getSystemPrompt returns string synchronously
 * and this runtime's sql executor is also synchronous, so no I/O barrier
 * exists — expose a sync form so CF doesn't need an await hack.
 */
export function buildSystemPromptSync(
  rt: AgentRuntime,
  opts: SystemPromptOptions = {},
): string {
  let purpose = opts.purposeOverride;
  if (!purpose) {
    try {
      const rows = rt.storage.sql<{ purpose: string }>`SELECT purpose FROM agent_soul LIMIT 1`;
      purpose = rows[0]?.purpose ?? FALLBACK_PURPOSE;
    } catch {
      purpose = FALLBACK_PURPOSE;
    }
  }

  const executorSection = renderExecutorSection(opts.registeredExecutors ?? []);
  const knowledgeSection = opts.extraKnowledge
    ? `\n## Knowledge\n${opts.extraKnowledge}\n`
    : '';

  return `${purpose}

## Tools
${renderBuiltinToolsSection()}

### Crafted capabilities
Tools you learn and save via the CraftStore become callable inside \`execute_tools\`
as \`codemode.<name>(args)\`. They improve over time via EMA scoring; low-quality
tools are filtered out automatically.

### Recursive language model (inside execute_tools)
You can spawn a flat LLM call from inside the sandbox to divide-and-conquer
over large inputs:
\`\`\`
const text = await workspace.readFile('big.log')
const chunks = text.match(/[\\s\\S]{1,4000}/g) ?? []
const partials = await Promise.all(chunks.map(c => llm.query(\`Summarize: \${c}\`)))
const answer = await llm.query(\`Synthesize: \${partials.join('\\n\\n')}\`)
\`\`\`
\`llm.query(text, { model?, reasoning_effort? })\` returns either a plain
string OR an \`{ error: string }\` envelope on failure — handle both. The
sub-call has no \`llm.query\` in scope, so recursion depth is bounded at 1.

### Session context blocks
The agent also has three writable context blocks managed by Think Session:
- \`memory\` (read-only, 32k tokens) — long-term knowledge mirrored from
  MEMORY.md. Search via \`search_context('memory', query)\`.
- \`scratch\` (writable, 8k, ephemeral) — write intermediate reasoning with
  \`set_context('scratch', text)\`. Cleared between turns.
- \`working_set\` (writable, 4k, persistent LRU) — last-N items actively in
  play (files, URLs, ids). \`set_context('working_set', text)\` to update.

${executorSection}
## World model (agent_facts)
Stable, keyed facts you've remembered appear at the bottom of this prompt.
Use \`remember_fact\` for re-readable state: user preferences, project state,
dates, names, URLs, configuration values. Prefer it over \`save_note\` when
the value is keyed; prefer \`save_note\` for prose / lessons / narratives.

## Evolution
After each turn the system scores tool usage, extracts successful patterns into
new crafted tools, and (every few turns) reflects on the session. Your surface
improves automatically — good patterns become reusable \`codemode.*\` functions.

## Output format
Your final user-facing message is plain markdown. Keep reasoning concise —
internal thinking belongs inside tool calls, scratch context, or hidden
reasoning tokens, not in the user reply. Don't dump raw JSON unless asked.
${knowledgeSection}`;
}

/** Async wrapper for symmetry with other core builders; CLI uses either form. */
export async function buildSystemPrompt(
  rt: AgentRuntime,
  opts: SystemPromptOptions = {},
): Promise<string> {
  return buildSystemPromptSync(rt, opts);
}
