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

const FALLBACK_PURPOSE = 'You are a helpful coding assistant.';

function renderExecutorSection(names: string[]): string {
  if (names.length === 0) return '';
  const lines = names.map((n) => {
    switch (n) {
      case 'workspace':
        return '  **workspace.*** — local VFS + shell (readFile, writeFile, readdir, exists, exec, searchMemory, saveNote, listTools, createTool)';
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

## Tools (5 top-level)
${renderBuiltinToolsSection()}

### Crafted capabilities
Tools you learn and save via the CraftStore become callable inside \`execute_tools\`
as \`codemode.<name>(args)\`. They improve over time via EMA scoring; low-quality
tools are filtered out automatically.
${executorSection}
## Evolution
After each turn the system scores tool usage, extracts successful patterns into
new crafted tools, and (every few turns) reflects on the session. Your surface
improves automatically — good patterns become reusable \`codemode.*\` functions.
${knowledgeSection}`;
}

/** Async wrapper for symmetry with other core builders; CLI uses either form. */
export async function buildSystemPrompt(
  rt: AgentRuntime,
  opts: SystemPromptOptions = {},
): Promise<string> {
  return buildSystemPromptSync(rt, opts);
}
