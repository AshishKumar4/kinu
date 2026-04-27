# Architecture

Proteus is a self-evolving AI agent built on Cloudflare's Agents SDK. It uses Monte Carlo Tree Search (MCTS) to explore multiple solution strategies in parallel, learns reusable tool patterns via a CraftStore, and can rewrite its own agentic loop (scaffold) based on observed performance.

## Message Flow

### End-to-End: User Clicks Send → Response Appears

```
User types text + clicks Send (or presses Enter)
│
├─ WorkspacePage.handleSend()                         [WorkspacePage.tsx:577]
│  wraps as { role: "user", parts: [{ type: "text", text }] }
│
├─ useProteus.sendChat(content)                       [use-proteus.ts:305]
│  calls useAgentChat.sendMessage()
│
├─ WebSocketChatTransport.sendMessages()              [ai-chat react.js:64]
│  generates requestId = nanoid(8)
│  sends over WebSocket:
│    { type: "cf_agent_use_chat_request",
│      id: requestId,
│      init: { method: "POST", body: JSON { messages, trigger } } }
│
═══════════════ NETWORK (WebSocket) ════════════════════
│
├─ Think._handleChatRequest()                         [think.js:815]
│  parse body, append user messages to session,
│  broadcast to other connections, enqueue in TurnQueue
│  (wrapped in keepAliveWhile + runFiber for durability)
│
├─ Think._runInferenceLoop()                          [think.js:295]
│  ├─ Merge tools: workspace + getTools() + session context + MCP + client
│  ├─ getSystemPrompt() — read agent_soul
│  ├─ Build + prune messages from session history
│  ├─ getModel() — read agent_config
│  ├─ beforeTurn() — reset counters, return activeTools
│  └─ streamText({...})                               [Vercel AI SDK]
│     │
│     ├─ [MULTI-STEP LOOP — managed by AI SDK, up to 500 steps]
│     │  ├─ Model generates text + optional tool calls
│     │  ├─ onChunk fires per token → orchestrator logs first chunk
│     │  ├─ If tool calls present:
│     │  │  ├─ AI SDK calls tool.execute(args) automatically
│     │  │  └─ onStepFinish fires:
│     │  │     ├─ afterToolCall → orchestrator records tool call
│     │  │     └─ onStepFinish → orchestrator increments step count
│     │  └─ If model stops or maxSteps reached: exit loop
│     │
│     └─ Returns StreamTextResult
│
├─ Think._streamResult()                              [think.js:944]
│  ├─ Stream chunks to all WebSocket clients as cf_agent_use_chat_response
│  ├─ Send { done: true } on completion
│  ├─ Persist assistant message to session
│  └─ _fireResponseHook()
│
├─ OrchestratorAgent.onChatResponse()                 [orchestrator.ts:468]
│  ├─ Build CompletedTurn { userMessage, assistantResponse, toolCalls, steps, durationMs }
│  ├─ void engine.onTurnComplete(turn)   — async, never blocks TurnQueue
│  └─ Every 5 turns: void engine.onSessionComplete(sessionData)
│
═══════════════ NETWORK (WebSocket) ════════════════════
│
├─ WebSocketChatTransport ReadableStream listener     [ai-chat react.js:110]
│  matches response by requestId, parses UIMessageChunks
│
├─ AI SDK useChat processes stream, updates messages array
│
└─ WorkspacePage re-renders message list               [WorkspacePage.tsx:632]
```

```mermaid
sequenceDiagram
    participant U as User (Browser)
    participant WS as WebSocket
    participant T as Think (OrchestratorAgent)
    participant LLM as AI Gateway / Workers AI
    participant Tools as Tool Execution
    participant Evo as EvolutionEngine
    participant DB as DO SQLite

    U->>WS: cf_agent_use_chat_request
    WS->>T: _handleChatRequest → TurnQueue.enqueue
    T->>T: getTools() — 5 tools + session context
    T->>T: getSystemPrompt() — read agent_soul
    T->>T: getModel() — read agent_config
    T->>T: beforeTurn() — reset counters, set activeTools
    T->>LLM: streamText(model, system, messages, tools)
    loop Tool calling loop (up to 500 steps)
        LLM-->>T: text delta / tool call
        T-->>U: stream chunk via WebSocket
        opt Tool call
            T->>Tools: AI SDK calls tool.execute() automatically
            Tools-->>T: tool result
            T->>T: afterToolCall() — record for evolution
            T->>LLM: continue with tool result
        end
        T->>T: onStepFinish() — increment counter
    end
    LLM-->>T: done
    T-->>U: cf_agent_use_chat_response { done: true }
    T->>DB: persist assistant message (Think Session)
    T->>Evo: void onTurnComplete(turn) — fire and forget
    Note over Evo: Runs async — does NOT block TurnQueue
    Evo->>DB: assess quality, reflect, extract patterns
    Evo->>DB: write evolution_events
```

## Package Structure

```mermaid
graph TB
    subgraph "packages/"
        Core["core/<br/>Abstract interfaces, MCTS engine,<br/>EvolutionEngine, CraftStore,<br/>scaffold, tools"]
        AgentUtils["agent-utils/<br/>SqliteFS (chunked VFS),<br/>MemoryStore (FTS5),<br/>CraftStore (FTS5),<br/>Shell emulator (16 POSIX cmds)"]
        CFBackend["cf-backend/<br/>OrchestratorAgent extends Think,<br/>ExplorationAgent (Facets),<br/>React UI, Vite+Wrangler"]
        CLI["cli/<br/>proteus create/chat/evolve/status/list<br/>Commander CLI"]
        CLIBackend["cli-backend/<br/>bun:sqlite runtime,<br/>Node vm executor,<br/>child_process MCTS branches"]
    end

    CFBackend --> Core
    CFBackend --> AgentUtils
    CLI --> Core
    CLI --> CLIBackend
    CLIBackend --> Core
    CLIBackend --> AgentUtils

    subgraph "External"
        Think["@cloudflare/think"]
        Agents["agents (Agents SDK)"]
        AISDK["ai (Vercel AI SDK v6)"]
    end

    CFBackend --> Think
    CFBackend --> Agents
    Core --> AISDK
```

## Durable Object Layout

```mermaid
graph LR
    subgraph "Cloudflare Workers"
        Worker["Worker (fetch handler)<br/>routeAgentRequest()"]
    end

    subgraph "Durable Objects"
        Orch["OrchestratorAgent<br/>extends Think&lt;Env&gt;<br/><br/>SQLite: agent_soul, agent_identity,<br/>agent_config, vfs_files, memory_chunks,<br/>crafted_tools, craft_scores, search_nodes,<br/>evolution_events, scaffold_versions,<br/>scaffold_regression_fixtures, task_history,<br/>fibers, messages, conversation_history,<br/>executor_output, activity_log"]

        subgraph "Facets (MCTS branches)"
            E1["ExplorationAgent #1<br/>extends Agent&lt;Env&gt;<br/>Isolated SQLite: traces"]
            E2["ExplorationAgent #2<br/>Isolated SQLite: traces"]
            E3["ExplorationAgent #N<br/>Isolated SQLite: traces"]
        end
    end

    Worker --> Orch
    Orch -->|"subAgent()"| E1
    Orch -->|"subAgent()"| E2
    Orch -->|"subAgent()"| E3
```

## AgentRuntime Interface

The `AgentRuntime` is the central contract. Every backend (CF Workers or CLI) must provide these primitives:

| Primitive | Interface | CF Backend | CLI Backend |
|-----------|-----------|------------|-------------|
| **Storage** | `VFS` + `SqlExecutor` + `RawSqlExec` | SqliteFS over DO SQLite | SqliteFS over bun:sqlite |
| **Memory** | `write`, `append`, `index`, `search`, `read` | MemoryStore (FTS5 BM25) | MemoryStore (FTS5 BM25) |
| **Executor** | `execute(code, providers)` | `new Function()` fallback / LOADER codemode | Bun subprocess sandbox (30s timeout) |
| **LLM** | `stream`, `complete` | Workers AI binding or AI Gateway | AI Gateway via Vercel AI SDK |
| **Schedule** | `after`, `cron`, `fiber` | `agent.runFiber()` (durable) | SQLite-backed fiber |
| **Identity** | `id`, `name`, `scaffold.*` | DO ID + agent_soul table | UUID + ~/.proteus/ directory |

Additional runtime fields:
- **CraftStore** — FTS5-indexed learned tool storage
- **SpawnBranch** / **AbortBranch** — MCTS branch lifecycle (Facets on CF, child_process on CLI)
- **ExecutionRouter** (optional) — multi-executor routing for codemode
- **JudgeModel** (optional) — second LLM for cross-model judging

## Think Lifecycle Hooks

The `OrchestratorAgent` extends Think and implements these hooks:

| Hook | When | What Proteus Does |
|------|------|-------------------|
| `getModel()` | Every turn | Read stored model preference from `agent_config`, create Workers AI or AI Gateway model |
| `getSystemPrompt()` | Every turn | Read agent soul from `agent_soul` table |
| `getTools()` | Every turn | Build 5-tool ToolSet (execute_tools, run, explore, save_note, search_memory). Cached by CraftStore version. `activeTools` restricts Think to only these 5 + session context tools. |
| `configureSession()` | Session init | Memory context block (32000 tokens) + cached prompt |
| `beforeTurn()` | Before inference | Reset turn tracking (tool calls, step count, timer) |
| `afterToolCall()` | After each tool | Record tool call for evolution pattern extraction |
| `onStepFinish()` | After each step | Increment step counter |
| `onChatResponse()` | After turn complete | Fire-and-forget evolution hooks (async, never blocks TurnQueue) |
| `onFiberRecovered()` | DO wake from hibernation | Log interrupted fibers for debugging |
