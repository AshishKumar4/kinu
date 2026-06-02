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
import { renderActiveSkillsSection } from './skills/render.js';
import type { ActiveSkillSet } from './skills/types.js';

export interface SystemPromptOptions {
  /** Executor provider names currently registered (e.g. ['workspace', 'nimbus']). */
  registeredExecutors?: string[];
  /** Extra knowledge to append — CLI pastes the first few KB of memory/MEMORY.md. */
  extraKnowledge?: string;
  /** Override the soul/purpose lookup. If omitted, reads from agent_soul. */
  purposeOverride?: string;
  /** Active skills for this turn — body injected into prompt, tool surface
   *  restricted to the union of their `allowed_tools`. Resolved at turn
   *  start by `skills/loader.resolveActiveSkills`. */
  activeSkills?: ActiveSkillSet;
}

export const FALLBACK_PURPOSE = 'You are Proteus, a powerful self-evolving agent. You spawn independent ' +
  'sub-agents that run concurrently (`think` heads — each with shell + sandbox + tool access, ' +
  'recursing to depth 3) and parallel tree-search (`think` mcts); you persist across turns (durable memory, ' +
  'keyed world-model facts, crafted tools, and your own rewritable scaffold); you run real shells ' +
  'and Linux sandboxes, fan out sub-LLM calls (llm.query), and improve yourself over time.';

function renderExecutorSection(names: string[]): string {
  if (names.length === 0) return '';
  const lines = names.map((n) => {
    switch (n) {
      case 'workspace':
        return '  **workspace.*** — local VFS + shell (readFile, writeFile, readdir, exists, exec, listTools, createTool). For memory use the top-level `memory` tool (save / search), not workspace.*.';
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
  // Each executor is a SEPARATE filesystem — a file written via one namespace
  // is NOT visible to another (workspace.* is the Worker VFS; sandbox.* is the
  // container; laptop.* is the user's disk). Stay on one executor for a task,
  // and read back with the SAME namespace you wrote with. (Prevents the
  // "wrote in the sandbox, read an empty workspace" confusion.)
  const disjointNote = names.length > 1
    ? '\n\n**These namespaces are separate filesystems.** A file you write with one (e.g. `sandbox.writeFile`) is NOT readable through another (e.g. `workspace.readFile`). Pick the executor a task lives on and read/write/inspect it all through that same namespace.'
    : '';
  // When the sandbox executor is registered, append a "Showing apps" guide
  // so the model knows that user-visible previews require exposePort. The
  // app's UI auto-renders the returned URL as a live iframe in the chat
  // and on the Executors tab. (STABILITY-AUDIT §C1.)
  const showingApps = names.includes('sandbox')
    ? `\n### Showing a running app to the user
For the user to *see* a running web app, the flow is strict and in this order:

  1. Write your files into \`/workspace/<app-dir>/\`.
  2. **Start a server listening on a TCP port** inside the sandbox. The server
     MUST be running before step 3 or \`exposePort\` returns an error.
  3. Call \`sandbox.exposePort(port)\` to get the public preview URL. The UI
     auto-renders it as a live iframe in the chat and on the Executors tab.

Concrete examples — pick the one matching your app type:

**Static site (HTML / CSS / JS only):**
\`\`\`
await sandbox.writeFile("/workspace/myapp/index.html", "<!doctype html>...")
await sandbox.exec("cd /workspace/myapp && nohup python3 -m http.server 8080 > /tmp/srv-8080.log 2>&1 &")
await new Promise(r => setTimeout(r, 800))     // let the server bind
const url = await sandbox.exposePort(8080)
\`\`\`

**Node server:**
\`\`\`
await sandbox.exec("cd /workspace/myapp && nohup node server.js > /tmp/srv-8080.log 2>&1 &")
await new Promise(r => setTimeout(r, 1500))    // node + framework boot is slower
const url = await sandbox.exposePort(8080)
\`\`\`

**Dev server (Vite/Next/etc.):**
\`\`\`
await sandbox.exec("cd /workspace/myapp && npm install && nohup npx vite --host 0.0.0.0 --port 5173 > /tmp/srv-5173.log 2>&1 &")
await new Promise(r => setTimeout(r, 5000))    // npm install + bundler boot
const url = await sandbox.exposePort(5173)
\`\`\`

Rules:
  - Always background the process: \`nohup ... > /tmp/srv.log 2>&1 &\` so \`exec\`
    returns immediately.
  - **Bind to \`0.0.0.0\` (or omit host), never just \`127.0.0.1\`** — the proxy
    reaches the container over its internal network.
  - Wait briefly (\`await new Promise(r => setTimeout(r, 800-5000))\`) after
    starting the server so it has time to bind before \`exposePort\` probes.
  - \`exposePort\` verifies the port is responsive before returning a URL. If
    nothing is listening, you get an error telling you to start a server first;
    do that, then call \`exposePort\` again.
  - If your server takes a while to boot (e.g. Next.js), inspect
    \`sandbox.readFile("/tmp/srv-<port>.log")\` to see what's happening.\n`
    : '';
  return `\n### Executor namespaces inside execute_tools\n${lines.join('\n')}${disjointNote}\n${showingApps}`;
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

### Parallel sub-agents
\`think({ strategy: 'heads', task, heads: [...] })\` spawns 2–6 INDEPENDENT
sub-agents that run concurrently — each runs its own multi-step agentic loop
with shell + sandbox + tool access, optionally a different model per head, and
each can recurse (spawn its own sub-heads) down to depth 3. Their findings are
merged via structured synthesis (synthesize / best_of / consensus). Reach for
this when a task splits into 3+ genuinely independent sub-questions — e.g. survey
prior art + draft a design + stress-test it, or analyse N files at once.
\`think({ strategy: 'mcts' })\` runs parallel tree-search rollouts over candidate
approaches. These are real concurrent agents, not a single sequential stream.

### You persist across turns
You are NOT stateless between turns. Your conversation, long-term memory, keyed
world-model facts, crafted tools, and your own scaffold all live durably in your
storage and are present on every turn — work you save now is yours next turn.

${executorSection}${opts.activeSkills ? renderActiveSkillsSection(opts.activeSkills) : ''}
## World model (agent_facts)
Stable, keyed facts you've remembered appear at the bottom of this prompt.
Use \`fact\` (action=remember) for re-readable keyed state: user preferences,
project state, dates, names, URLs, configuration values. Prefer it over
\`memory\` when the value is keyed; prefer \`memory\` (action=save) for prose /
lessons / narratives.

## Evolution
After each turn the system scores tool usage, extracts successful patterns into
new crafted tools, and (every few turns) reflects on the session. Your surface
improves automatically — good patterns become reusable \`codemode.*\` functions.

## Output format
Your final user-facing message is plain markdown. Keep reasoning concise —
internal thinking belongs inside tool calls or hidden reasoning tokens, not in
the user reply. Don't dump raw JSON unless asked.
${knowledgeSection}`;
}

/** Async wrapper for symmetry with other core builders; CLI uses either form. */
export async function buildSystemPrompt(
  rt: AgentRuntime,
  opts: SystemPromptOptions = {},
): Promise<string> {
  return buildSystemPromptSync(rt, opts);
}
