# Research notes — v2 build references

Compact, citable summaries of the three reference codebases. Full agent reports archived in conversation transcript.

## A. Cloudflare Agents SDK — exact API surface

### Think `Session` (LLM-writable context blocks)

```typescript
// Session.create returns chainable builder
const session = Session.create(provider)
  .forSession(sessionId)
  .withContext("memory", { description: "Facts", maxTokens: 2000, provider })
  .withContext("soul", { provider: { get: async () => "..." } })
  .withCachedPrompt()
  .compactAfter(8000)
  .onCompaction(fn)
  .onCompactionError(handler);

// Think hook:
override configureSession(session: Session): Session {
  return session.withContext(...).withCachedPrompt();
}
```

- File: `external/agents/packages/agents/src/experimental/memory/session/session.ts`
- `WritableContextProvider`: `{ get(): Promise<string>; set(value: string): Promise<void> }`
- Tree-structured history: `getHistory(leafId?)`, `getMessage(id)`, `getLatestLeaf()`, `getBranches(messageId)`

### `runFiber` (durable execution, eviction-safe)

```typescript
async runFiber<T>(name: string, fn: (ctx: FiberContext) => Promise<T>): Promise<T>

type FiberContext = {
  id: string;
  signal: AbortSignal;
  stash(data: unknown): void;        // synchronous SQLite write
  snapshot: unknown | null;
};

override async onFiberRecovered(ctx: FiberRecoveryContext): Promise<void | FiberRecoveryResult> {
  // ctx.snapshot has last stashed value
}
```

- File: `external/agents/packages/agents/src/index.ts:661-670`, `:4708-4713`, `:4985-4993`
- Table `cf_agents_runs` already created

### DynamicWorkerExecutor + codemode

```typescript
new DynamicWorkerExecutor({
  loader: env.LOADER,                    // worker_loaders binding
  timeout: 30000,
  globalOutbound: null,                  // network: null=blocked, undefined=parent, Fetcher=routed
  modules: { "lib.js": "..." }
});

executor.execute(code, providers: ResolvedProvider[])
// ResolvedProvider = { name: string; fns: Record<string, (...args) => Promise<unknown>> }

createCodeTool({ tools: ToolProvider[], executor, description? })
// Auto-generates `declare namespace <name> { ... }` types

stateTools(workspace: Workspace): ToolProvider          // file ops as `state.*`
```

- File: `external/agents/packages/codemode/src/executor.ts`, `tool.ts`
- File: `external/agents/packages/shell/src/workers.ts:54`, `filesystem.ts:223`
- `Workspace` is fully-fledged FS: readFile, writeFile, mkdir, rm, glob, diff, symlink, lstat, R2 spillover

### agentTool() / runAgentTool() / subAgent()

```typescript
// In parent's getTools():
return {
  research: agentTool(ResearcherAgent, {
    description: "Research X",
    inputSchema: z.object({ query: z.string() }),
    outputSchema: ResearchResultSchema     // optional Valibot/Zod
  })
};

// Direct API:
const child = await this.subAgent(ChildClass, "child-name");      // get-or-create
await this.abortSubAgent(ChildClass, "child-name");
await this.deleteSubAgent(ChildClass, "child-name");

const result = await this.runAgentTool<Input, Output>(ChildClass, {
  input, parentToolCallId, signal, display: { name, icon, ... }
});
// result.status: 'completed' | 'error' | 'aborted' | 'interrupted'
```

- File: `external/agents/packages/agents/src/agent-tools.ts:57-111`, `index.ts:6814-6841`
- Table `cf_agent_tool_runs` for run tracking
- Parent UI sees streamed child timeline via `_broadcastAgentToolEvent`
- Authorization gate: `onBeforeSubAgent(req, {className, name})`

## B. Flue runtime — patterns to lift

### SandboxApi (Flue's contract — match this)

```typescript
// external/flue/packages/runtime/src/sandbox.ts:167-185
export interface SandboxApi {
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<FileStat>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  exec(command: string, options?: {
    cwd?: string; env?: Record<string,string>;
    timeout?: number; signal?: AbortSignal;
  }): Promise<ShellResult>;
}

// SandboxFactory
export interface SandboxFactory {
  createSessionEnv(options: { id: string; cwd?: string }): Promise<SessionEnv>;
  tools?: SessionToolFactory;
}

// SessionEnv wraps SandboxApi with `cwd` + `resolvePath`
createSandboxSessionEnv(api: SandboxApi, cwd: string): SessionEnv
```

- For Proteus: adopt this *exact* shape. Adapter `sandboxToExecutorProvider` brings it down to codemode's ExecutorProvider.

### Event log (FlueEvent — adopt for SSE)

Discriminated union: `run_start`, `text_delta`, `tool_start`, `tool_call`, `turn`, `task_start`, `task`, `compaction_start`, `compaction`, `operation_start`, `operation`, `log`, `idle`, `run_end`. Every event decorated with `runId`, `eventIndex` (monotonic), `timestamp` at emission.

```typescript
observe((event, ctx) => { /* subscriber */ })
GET /runs/<runId>/stream             # SSE w/ Last-Event-ID resume
GET /runs/<runId>/events?limit=&types=
```

### Compaction defaults

```typescript
DEFAULT_COMPACTION_SETTINGS = {
  enabled: true,
  reserveTokens: 20000,
  keepRecentTokens: 8000
};

shouldCompact(contextTokens, contextWindow, settings):
  contextTokens > contextWindow - settings.reserveTokens
```

### Valibot result parsing

```typescript
session.prompt(text, { result: v.object({ summary: v.string(), confidence: v.number() }) })
// returns { data: { summary: string; confidence: number }, usage, model }
// First successful `finish` tool call wins; LLM retried on schema failure
```

### MCP client

```typescript
const conn = await connectMcpServer('name', { url, transport: 'streamable-http' });
// conn.tools is ToolDef[], prefixed `mcp__<server>__<tool>`
await conn.close();
```

## C. Nimbus HTTP/WebSocket API

**Base URL:** `https://nimbus.ashishkmr472.workers.dev` (custom domains supported)

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST/GET | `/new` | Create session, 302 → `/s/{id}/` |
| GET/WS | `/s/{id}/` | Session terminal UI (HTML on GET, WebSocket on Upgrade) |
| GET→WS | `/s/{id}/api/logs/{pid}` | Stream process logs |
| GET | `/s/{id}/api/processes` | List `{command, state, exitCode, pid}` |
| `/s/{id}/port/{port}/` | Access exposed port |

### WebSocket protocol (the agent surface)

```typescript
// Client → Server
{ type: "input", data: "ls -la\n" }
{ type: "resize", cols, rows }
{ type: "fs-read", path, reqId }
{ type: "fs-write", path, content, reqId }
{ type: "fs-list", dir, recursive?, reqId }

// Server → Client
{ type: "output", data: "..." }                    // 5ms-coalesced batches
{ type: "fs-read-result", reqId, ok, content?, error? }
{ type: "fs-write-result", reqId, ok, error? }
{ type: "fs-list-result", reqId, ok, files?: [{name, isDir, size}], error? }
```

### Auth

HS256 JWT (`issueNimbusToken(env, { tn, sub, ttl })`). Three modes:
- `auto` (default) — accept if provided
- `enforce` — required
- `legacy` — old API-key

Attach via URL: `/s/{id}/?nimbus_token=<jwt>`

### Capabilities

- 60+ Unix commands, bash-like shell
- Stateful Python (Pyodide), Ruby (ruby.wasm)
- Native Node/Bun via workerd
- LLVM C → wasm32-wasi
- 10 GB SQLite-backed VFS per session
- Sub-500ms cold starts, $0 idle (hibernation)
- 45/46 WASI preview1 functions
- npm packages with R2-cached L2

### Proteus integration approach

Skip the iframe SDK. Build a **WebSocket client** that:
1. Issues `POST /new` → captures `<sessionId>`
2. Connects `wss://<endpoint>/s/<id>/ws`
3. For `exec`: sends `{type:"input", data:cmd+"\n"}`, waits for prompt-return marker via `output` accumulation
4. For `fs-read/write/list`: uses the dedicated message types with `reqId` round-trip
5. Handles hibernation reconnects transparently
