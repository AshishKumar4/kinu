# Executor V2 — Nimbus, Sandbox, and PC Access

**Status**: approved design. Implementation in separate PRs per §6.
**Absorbs prior audit findings**: executor stubs (SSH/Container/Nimbus), flat Executors tab, `_rpcExec` missing on Nimbus.
**Scope**: real Nimbus integration (one DO per agent), redesigned Executors tab with per-executor terminal + file tree + preview panes, and a PC-access executor shipped as a reverse-WebSocket daemon.

---

## 0. What exists today (ground truth, with citations)

| Concern | Current state | File:line |
|---|---|---|
| `ExecutorProvider` contract | Well-defined; 4 kinds: workspace, nimbus, sandbox, laptop | `packages/core/src/execution/types.ts:29,38-77` |
| Inline (workspace) executor | Real; always-on | `packages/core/src/execution/inline.ts:213-222` |
| Nimbus executor | Real client code; gated on `env.NIMBUS_SESSION`; binding commented out | `packages/core/src/execution/nimbus.ts:52-196`; `packages/cf-backend/src/runtime.ts:107-117`; `packages/cf-backend/wrangler.jsonc:25` |
| Nimbus `_rpcExec` | **Not implemented on the Nimbus side** — Proteus guards `if (!stub._rpcExec) return EXEC_NOT_AVAILABLE` | `packages/core/src/execution/nimbus.ts:71-72`; `nimbus/src/nimbus-session.ts` — no `exec` RPC exists |
| Container (sandbox) executor | Real client code; needs CF Container DO binding + Dockerfile | `packages/core/src/execution/container.ts:54-170`; `packages/cf-backend/wrangler.jsonc:29` |
| SSH/laptop executor | Real JSON-RPC-over-WS client; **no server-side WS upgrade handler anywhere** | `packages/core/src/execution/ssh.ts:59-216`; `packages/cf-backend/src/runtime.ts:141-142` |
| Executors tab UI | Visible; renders a one-line `<input>` terminal + flat `readdir`; no xterm, no iframe | `packages/cf-backend/src/pages/WorkspacePage.tsx:388-547` |
| Executor RPCs | `getExecutors`, `getExecutorOutput`, `executeInExecutor`, `getExecutorFiles` all present | `packages/cf-backend/src/orchestrator.ts:666-717` |
| `run` tool routing | Already forwards `executor: nimbus/sandbox/laptop` to `router.getProvider(key).tools.exec` | `packages/core/src/tools/builtins.ts:237-263` |
| System prompt | `renderExecutorSection` already advertises `nimbus.*` / `sandbox.*` / `laptop.*` when registered | `packages/core/src/prompt.ts:25-42` |
| Nimbus top-level routing | **Hard-coded** `idFromName('default-session')` — one DO for all callers | `nimbus/src/index.ts:34` |
| Nimbus auth | None — no Authorization check anywhere | `grep -n Authorization nimbus/src/**` → 0 hits |
| Nimbus port proxy | `/port/:n/*` HTTP-only; bridge stores `null` facetStub so node HTTP servers are non-functional | `nimbus/src/nimbus-session.ts:126-130`; `nimbus/src/port-registry.ts:61-89` |
| xterm in React UI | Not installed; not imported | `grep xterm packages/cf-backend/package.json` → 0 hits |
| `<iframe>` in UI | Not used anywhere | `grep iframe packages/**/*.tsx` → 0 hits |

The plan treats all three remote executors (Nimbus, Container, PC) as first-class citizens in a redesigned Executors tab. Each gets a terminal, a file tree, preview slots, and a connection-state card.

---

## 1. Nimbus wiring — service binding, one DO per agent, per-agent VFS

### 1.1 Transport — service binding, not HTTP

Proteus binds Nimbus as a cross-Worker DO namespace:

```jsonc
// packages/cf-backend/wrangler.jsonc — uncomment
"durable_objects": {
  "bindings": [
    { "class_name": "OrchestratorAgent", "name": "OrchestratorAgent" },
    { "class_name": "ExplorationAgent", "name": "ExplorationAgent" },
    { "class_name": "NimbusSession", "name": "NIMBUS_SESSION", "script_name": "nimbus" }
  ]
}
```

Rationale:
- DO-to-DO RPC is in-colo, microsecond-latency. No edge hop.
- No auth plumbing: the Proteus DO is itself the caller, so the Nimbus DO trusts it transitively.
- Nimbus's `SupervisorRPC WorkerEntrypoint` (`nimbus/src/supervisor-rpc.ts:26`) is directly callable via the binding; no JSON-over-HTTP wrapping.

### 1.2 One DO per Proteus agent, bypassing Nimbus's top-level router

Nimbus today pins `env.NIMBUS_SESSION.idFromName('default-session')` in its top-level `fetch` (`nimbus/src/index.ts:34`). Two ways to isolate Proteus agents:

**Option A (chosen) — Proteus bypasses Nimbus's `fetch`.** Proteus routes directly to a per-agent DO stub:
```ts
// packages/cf-backend/src/runtime.ts — existing Nimbus branch
const nimbusNs = env.NIMBUS_SESSION;
const nimbusId = nimbusNs.idFromName(agent.name);  // per-Proteus-agent
const nimbusStub = nimbusNs.get(nimbusId);
executionRouter.register(createNimbusExecutor(nimbusStub));
```
Proteus never routes HTTP through Nimbus's edge domain; it calls DO RPC directly. The browser-facing Nimbus UI (when run standalone) continues to work via its own `fetch`.

**Option B (rejected) — patch `nimbus/src/index.ts:34` to derive the ID from a signed header.** More invasive, requires a second Nimbus PR, and couples the browser-facing Nimbus UI to per-agent sessions (which it doesn't need). Not taken.

Each Proteus agent's Nimbus DO is independent: own 10GB SQLite VFS, own shell state, own spawned facets — full isolation by DO separation.

### 1.3 SqliteFS split — agent state vs user workspace

The **Proteus OrchestratorAgent DO** keeps its existing SQLite for:
- `agent_identity`, `agent_soul` (Proteus identity)
- `memory_chunks`, `vfs_files` (Proteus's `memory/MEMORY.md` + agent scaffold)
- `crafted_tools`, `craft_scores`, `search_nodes` (evolution + MCTS)
- `executor_output`, `activity_log` (UI telemetry)

The **Nimbus DO** holds everything the user cares about:
- Project files (`~/project/...`)
- `node_modules`, build artifacts
- Git repos
- Shell history, environment

This separation is clean because:
- Proteus's memory system (`memory/MEMORY.md`, crafted tools) is small and agent-specific. It stays inside the orchestrator DO's SQLite.
- The user's code + node_modules is large (up to 10GB quota on Nimbus). It lives in Nimbus's paged SqliteVFS (`nimbus/src/sqlite-vfs.ts:67` — 64KB chunks, 32MB LRU).
- They never interleave: `workspace.readFile('/src/foo.ts')` goes to Nimbus via the `nimbus.*` provider; `workspace.readFile('memory/MEMORY.md')` goes to Proteus's inline VFS.

### 1.4 What Nimbus needs to add (one RPC) — upstream PR

Nimbus has **no external `exec(cmd)` RPC** today. Proteus's executor already guards on this: `if (!stub._rpcExec) return EXEC_NOT_AVAILABLE` (`packages/core/src/execution/nimbus.ts:71-72`). Nimbus must add (see §6 Phase 1):

```ts
// nimbus/src/nimbus-session.ts — new public method on NimbusSession
async _rpcExec(command: string, opts?: { cwd?: string; stdin?: string; timeout_ms?: number })
  : Promise<{ stdout: string; stderr: string; exitCode: number; duration_ms: number }> {
  // Lift FacetManager.exec's internals (facet-manager.ts:664-673 is internal).
  // For shell invocations: run through the existing Kernel/Shell non-interactively,
  // capture stdout/stderr into buffers (instead of the WebSocket terminal).
}
```

Design decisions:
- **Single-shot, not streaming** for v1. Long-running processes use `_rpcSpawn(cmd)` → `{ pid }` + a WebSocket subscription for output. Simpler API; matches the `run` tool's string-returning signature (`builtins.ts:250-257`).
- **Bounded timeout.** 30s default, matching `FACET_TIMEOUT_MS` (`nimbus/src/constants.ts:18`).
- **Respects optional allowlist.** Default "all allowed"; deployment-level policy in `nimbus/src/exec-policy.ts` (new) for public Nimbus deployments.

This is the **one required upstream Nimbus change**. File RPCs (`_rpcReadFile`, `_rpcWriteFile`, `_rpcReaddir`, `_rpcStat`, `_rpcExists`, `_rpcMkdir`, `_rpcUnlink`) already exist (`nimbus/src/nimbus-session.ts:64-109`).

Approach (per user decision): **upstream PR to the Nimbus repo, wait for merge**. Proteus Phase 2 lands after.

### 1.5 Per-executor namespace in the codemode sandbox

Already works. `packages/core/src/prompt.ts:31-32` already emits:
```
**nimbus.*** — full dev env over DO RPC
```
when the Nimbus executor is registered. The LLM gets typed access via `ExecutorProvider.types` (`packages/core/src/execution/nimbus.ts:179-196`) — codemode auto-generates the TS declaration into the sandbox. No prompt changes needed.

### 1.6 Proxying `/preview/*` and `/port/:n/*` to the user's browser

Nimbus serves previews at `nimbus.example.com/preview/*`. Proteus's UI wants them in an iframe inside the Executors tab. Three options:

**Option 1 (chosen) — Reverse-proxy via Proteus Worker.**
- Proteus Worker adds new routes:
  - `GET /agent/:id/nimbus-preview/*path` → `nimbusStub.fetch(/preview/*path)`
  - `ANY /agent/:id/nimbus-port/:n/*path`  → `nimbusStub.fetch(/port/:n/*path)`
  - `WS  /agent/:id/nimbus-ws`             → `nimbusStub.fetch(/ws)` [upgrade]
- Same-origin iframe (no CORS, no X-Frame issues). Auth inherited from the Proteus agent session.
- Handler file: `packages/cf-backend/src/nimbus-proxy.ts` (~80 LOC).
- Cost: one extra Worker hop (~5ms).

**Option 2 — Direct Nimbus URLs + iframe with permissive X-Frame-Options.**
- Simpler routing; painful auth (cross-origin cookies, separate session).

**Option 3 — Open Nimbus URL in a new tab.**
- Terrible UX; doesn't meet the "multiple preview iframes" requirement.

Before shipping the preview proxy: **fix Nimbus's `/port/:n/*` bug** (`nimbus/src/nimbus-session.ts:129` stores `facetStub: null`, so `port-registry.ts:63` always returns null for node HTTP servers). Upstream fix required; bundle into the Phase 1 Nimbus PR.

### 1.7 WebSocket terminal proxy

Nimbus's `/ws` is a single-session terminal (`nimbus/src/nimbus-session.ts:230-244`). The browser connects directly today. For Proteus:

- New Worker route: `WS /agent/:agentId/nimbus-ws` (upgrade) → `nimbusStub.fetch(/ws)`.
- Frames passed through bidirectionally. No framing changes needed.
- Auth: Proteus Worker upgrade handler checks the user is authorized for the agent (same checks as other agent RPCs), then upgrades and bridges.

xterm.js goes in the React UI. New `packages/cf-backend/package.json` deps: `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links` (~300KB bundled).

---

## 2. Executors UI redesign — first-class per-executor tabs

### 2.1 Layout

The existing Executors tab (`WorkspacePage.tsx:388-547`) renders a stubbed `<input>` + `<pre>`. Replace with a full multi-pane layout per executor:

```
┌────────────────────────────────────────────────────────────────────┐
│ [workspace] [nimbus ●] [sandbox ○] [laptop ○]   [+ Connect PC]     │
├────────────────────────────────────────────────────────────────────┤
│ ┌────────────────┬──────────────────┬──────────────────────────┐   │
│ │  File tree     │   Terminal       │   Previews               │   │
│ │  (recursive)   │   (xterm.js)     │   ┌─────────┐            │   │
│ │                │                  │   │  :5173  │            │   │
│ │  /             │  $ npm run dev   │   │ preview │            │   │
│ │  ├ src/        │  > vite...       │   │ iframe  │            │   │
│ │  │  ├ App.tsx  │  Local: :5173    │   └─────────┘            │   │
│ │  │  └ main.ts  │  █                │   ┌─────────┐            │   │
│ │  ├ package... │                  │   │  :8080  │            │   │
│ │  └ ...        │                  │   │ preview │            │   │
│ │                │                  │   │ iframe  │            │   │
│ │                │                  │   └─────────┘            │   │
│ │                │                  │   [+ Add preview port]   │   │
│ └────────────────┴──────────────────┴──────────────────────────┘   │
│ Status: nimbus connected · /src · uptime 12m · 1.2GB VFS · 3 procs │
└────────────────────────────────────────────────────────────────────┘
```

Three resizable panels (react-resizable-panels, already in `packages/cf-backend/package.json:22`):
- **Left — file tree** (recursive, lazy-loaded). Replaces the flat `readdir` at `WorkspacePage.tsx:502-528`.
- **Center — xterm terminal**. Connected to the executor's WebSocket (Nimbus `/ws`, PC WS, Container HTTP bridge).
- **Right — preview stack**. N iframes, each pointing at `/agent/:id/nimbus-port/:n/`. The agent programmatically controls which ports to show via an `addPreviewPort(n)` tool (§4). User can also add manually.

Below: status strip with connection state, cwd, resource usage, active process count.

### 2.2 Per-executor customization

Same 3-panel layout, executor-specific bindings:

| Executor | Terminal source | File tree source | Preview source | Status strip |
|---|---|---|---|---|
| **workspace** (inline) | `shell.exec` command input + output pane (no PTY; shell is one-shot) | Proteus VFS via `workspace.readdir` | n/a — no dev servers | "always connected" |
| **nimbus** | `/agent/:id/nimbus-ws` xterm | `nimbus.readdir` RPC, recursive | `/agent/:id/nimbus-port/:n/` iframes | DO uptime, VFS bytes, process count |
| **sandbox** | Container's exposed TCP port → xterm via WS-bridge Worker | `sandbox.readdir` | Container port `:n` proxied | CPU/mem stats from `ctx.container.monitor()` |
| **laptop** (PC) | Daemon WS; daemon spawns a login shell with PTY | `pc.readdir` RPC, recursive | Daemon's port-forward bridge | hostname, os/arch, token label, last-seen |

### 2.3 New tab controls

Top of tab:
- **Executor pills** (existing pattern at `WorkspacePage.tsx:444-456`) — click to switch.
- **`+ Connect PC`** button — only shown if no PC agent is registered. Opens the install-nonce flow (§3.3).
- **Settings gear** per executor — for nimbus: "restart session", "clear VFS". For laptop: "revoke token", "manage permissions".

### 2.4 Activity streaming to the Logs pane

Today, executor output lands in the Executors-tab terminal but NOT in the Logs tab (`orchestrator.ts:742-771` only reads `evolution_events` + `activity_log`). Option: add a `LogType = "executor"` variant and merge into the Logs feed, filtered by default but toggleable. Low-priority; punted to follow-up.

---

## 3. Three executor types — Nimbus, CF Sandbox, User's PC

### 3.1 Nimbus (DO-backed, on-demand per agent) — §1

Covered above. Key points:
- One `NimbusSession` DO per Proteus agent (id = agent's stable name).
- Service binding with `script_name: "nimbus"` (cross-Worker).
- Nimbus upstream change: add `_rpcExec` to `NimbusSession`, fix `/port/:n/*` `facetStub: null` bug.
- Proxy routes on Proteus Worker: `/nimbus-ws`, `/nimbus-preview/*`, `/nimbus-port/:n/*`.
- Cost profile: one extra DO per agent (Workers billing is ~$0/idle, $0.xx/1M requests; DO SQLite storage $0.20/GB/month).

### 3.2 Cloudflare Sandbox (CF-managed Container DO) — binding plumbing only

Existing `container.ts` executor targets CF's built-in Container DO API. **There is no separate `@cloudflare/sandbox` npm package** — the comment at `wrangler.jsonc:27` is aspirational. Per user decision, v2 ships the binding plumbing but **not** the Dockerfile:

1. Add a `containers` top-level block to `wrangler.jsonc` with a placeholder Dockerfile path.
2. Stub `SandboxContainer extends DurableObject` class that throws `not_configured` from all methods. This is a guard so the CF platform doesn't error on missing class when the binding is declared.
3. Add binding:
   ```jsonc
   "durable_objects": {
     "bindings": [
       { "class_name": "SandboxContainer", "name": "CONTAINER" }
     ]
   }
   ```
4. Proteus's existing `createContainerExecutor(stub)` wires up automatically (`runtime.ts:121-137`). `isAvailable()` returns `false` until the stub's `running()` probe succeeds; Executors tab shows "sandbox" with a grey dot and "configure Dockerfile" hint.

**What ships**: binding + type declaration + stub class + UI slot with configure-your-Dockerfile hint.

**What does NOT ship in v2**: the actual Dockerfile, the container entrypoint (HTTP exec server on port 8080), the `containers` block's image configuration. That's a follow-up PR when a user needs python/ruby/native binaries Nimbus can't provide.

### 3.3 User's PC — reverse-WebSocket daemon

Reverse-WS is the right answer per the PC-access research. All Proteus-side plumbing already exists; we need a daemon binary and a DO-side WS upgrade handler.

#### Transport

- Daemon: single-file Bun binary (~55MB compiled with `bun build --compile`), installed at `~/.proteus/pc-agent`.
- Service: `systemd --user` unit (Linux) or LaunchAgent plist (macOS).
- Connection: persistent WSS outbound to `wss://proteus.example.com/agent/<id>/pc-tunnel` with `Authorization: Bearer <token>`.
- Exponential-backoff reconnect; max 60s between attempts; ping every 30s.

#### Install flow

1. User clicks "+ Connect PC" in Executors tab.
2. Proteus `@callable() async createPcAgentInstall(label: string)`:
   - Generates a 32-byte token (base64url).
   - Generates a one-shot install-nonce (16 bytes, 10-min TTL).
   - Stores hashed token in `pc_agent_tokens` table (new; see §5).
   - Returns `{ nonce, command: "curl -fsSL https://.../pc-agent/install/<nonce> | sh" }`.
3. UI shows the curl command with a copy button + a "review script first" link.
4. User pastes into terminal. Script:
   - Detects OS/arch (`uname -s`, `uname -m`).
   - Downloads `pc-agent-${os}-${arch}` from Proteus's R2-backed binary endpoint.
   - Exchanges install-nonce for durable token via POST (nonce is burned server-side).
   - Writes systemd user unit / LaunchAgent plist.
   - Starts service.
   - Polls daemon health; reports back to UI via a `pc-agent-connected` broadcast when daemon's first HELLO hits Proteus.
5. UI flips to "Connected — alice's MBP — darwin/arm64 — 3s uptime".

#### WS protocol

Extends `ssh.ts`'s existing JSON-RPC shape (`{ id, method, params }` / `{ id, result?, error? }`) with streaming frames:

**Server → daemon:**
- `EXEC { id, cmd, args, cwd?, env?, stdin?, timeout_ms? }`
- `EXEC_STDIN { id, chunk }` (optional for interactive)
- `EXEC_KILL { id, signal? }`
- `READFILE { id, path, encoding? }`
- `WRITEFILE { id, path, content, encoding?, mode? }`
- `LISTDIR { id, path }`
- `STAT { id, path }`
- `UNLINK { id, path }`
- `PORTFORWARD_OPEN { id, localPort, protocol? }` (stretch)
- `PORTFORWARD_DATA { id, chunk_b64 }`
- `PORTFORWARD_CLOSE { id }`
- `PING { ts }`
- `REVOKE { reason }`

**Daemon → server:**
- `HELLO { token, version, os, arch, hostname, pid, capabilities[], default_cwd }` (first frame)
- `STDOUT { id, chunk, encoding? }` (streamed during EXEC)
- `STDERR { id, chunk, encoding? }`
- `EXIT { id, code, signal?, duration_ms }` (terminal for EXEC)
- `RESULT { id, result }` (terminal for READFILE/WRITEFILE/LISTDIR/STAT/UNLINK)
- `ERROR { id, code, message }`
- `PONG { ts, rtt_hint? }`
- `LOG { level, msg, ts }`
- `BYE { reason }`

Existing `ssh.ts` `rpc()` (`ssh.ts:70-100`) keeps working for single-shot commands; we add a companion `execStream(cmd)` that yields chunks and returns on EXIT. The `tools.exec(cmd)` tool keeps its current string-returning signature by accumulating stdout/stderr internally.

#### Binary runtime choice

**Bun single-file executable.** Rationale:
- Same language as Proteus core → `@proteus/pc-agent-protocol` shared between DO and daemon; no wire drift.
- Native WebSocket, child_process, fs, signal handling.
- `bun build --compile --target=bun-darwin-arm64` produces one file per platform.
- ~55MB download acceptable for a one-time install.
- Contributors already use bun (per AGENTS.md).

Platforms: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`. Windows deferred (most users have WSL).

#### Revoke

1. User clicks "Revoke" in UI.
2. `@callable() async revokePcAgent(tokenId)`:
   - `UPDATE pc_agent_tokens SET revoked_at = unixepoch() WHERE id = ?`.
   - Sends `REVOKE { reason: "user_revoked" }` on live WS (if any).
   - Waits 2s for `BYE`; else closes WS with code 4403.
   - Calls `rt.sshExecutor.clearSocket()` (existing at `ssh.ts:215`).
   - Broadcasts `pc-agent-disconnected` to UI.
3. Daemon on REVOKE or 4403:
   - Fails all in-flight RPCs with `code: "revoked"`.
   - Logs to `~/.proteus/pc-agent.log`.
   - Exits 0. systemd/launchd auto-restart → reconnect → server sees revoked token → 4403 → exit loop.
4. After 3 consecutive 4403s, daemon sleeps 1hr before retry. User can fully uninstall with `pc-agent uninstall`.

---

## 4. Tool surface — no new top-level tools

Current surface (`packages/core/src/tools/registry.ts:39-59`):
- `execute_tools(code)` — codemode sandbox; `workspace.*`, `codemode.*`, `tools.*`
- `run(command, executor?)` — shell; routes by `executor` name
- `explore(task)`, `save_note(content)`, `search_memory(query)` — orthogonal

Executors expose themselves as **namespaces inside `execute_tools`**:
- `nimbus.exec(cmd)`, `nimbus.readFile(path)`, `nimbus.spawn(cmd)`, `nimbus.listPorts()`, `nimbus.startPreview(port)` — all via `nimbus.ts` `ExecutorProvider.tools`.
- `sandbox.*` — symmetric (after Dockerfile follow-up).
- `laptop.*` — symmetric.

Gains from fold-in:
- Zero top-level bloat. Token budget preserved.
- LLM already knows the pattern: `codemode.*` for crafted tools, `workspace.*` for local, `nimbus.*` for dev env.
- New capabilities (port management, preview control) land as new methods on the existing provider, no LLM-surface churn.

**Additions to Nimbus provider tools** (and later Container/PC):
- `listPorts() → { port, pid, url }[]` — enumerates what's listening.
- `addPreviewPort(port)` — tells the UI to show an iframe for this port.
- `removePreviewPort(port)`.
- `spawn(cmd, cwd?) → { pid }` — long-running process, doesn't block tool call.
- `kill(pid, signal?)`.
- `ps() → { pid, command, uptime_ms, cpu_pct, mem_mb }[]`.

These are declared in `ExecutorProvider.types` (the TS interface codemode exposes to the sandbox), so the LLM sees them in its sandbox TypeScript context automatically.

**`run` tool unchanged.** Still routes `executor:nimbus` → `nimbusStub.tools.exec.execute(cmd)` via `builtins.ts:250-257`. Single-shot only; streaming is the `execute_tools` + `nimbus.spawn` path.

---

## 5. Security

### 5.1 Per-agent isolation

- **Proteus DO isolation**: existing — each agent has its own OrchestratorAgent DO with own SQLite.
- **Nimbus DO isolation**: each Proteus agent gets a Nimbus DO keyed by `nimbusNs.idFromName(agent.name)`. Distinct DOs → distinct SQLite → distinct 10GB VFS. No ACLs needed.
- **PC agent isolation**: one token per `(agent, machine)` pair. A user running two agents with PC access installs two daemons (v1 design) — each has its own token, its own service, its own allowlist. Multi-agent-per-daemon is a v2 consideration (HELLO carries `agent_ids[]`, daemon demuxes).

### 5.2 PC agent: signed + revocable

Key points:
- Token stored server-side hashed (sha256). Never transmitted after install.
- One-shot install nonce for the initial handshake. Prevents replay.
- Token rotation: issue new → revoke old → reinstall.
- Daemon refuses to connect to any URL other than the one baked at install time (prevents rebind attack if config leaks).
- TLS pinning to the issuer cert chain (tolerates CF leaf cert rotation).

### 5.3 Command allowlist (PC only)

Nimbus and sandbox are sandboxed by their own runtime; the allowlist concern is PC-specific. Default:

```json
{
  "read_paths": ["~", "/tmp"],
  "read_denylist": ["~/.ssh", "~/.aws", "~/.config/gh", "~/.proteus",
                    "**/*.pem", "**/id_rsa*", "**/id_ed25519*", "**/.env*"],
  "write_paths": ["~/proteus-workspace", "/tmp/proteus"],
  "command_allowlist": ["ls","cat","grep","find","pwd","which","ps","env","uname",
                        "git","node","npm","bun","python","python3","pytest",
                        "cargo","go","make","head","tail","wc","du","df"],
  "unrestricted": false
}
```

Per-agent opt-in `"unrestricted": true` with a red modal warning. Daemon enforces the policy, not the server — a compromised DO can't silently widen scope without the daemon logging the change.

### 5.4 Exec allowlist (Nimbus)

Nimbus executes in its own DO/facet sandbox — no access to Proteus data, no host fs access. Still, optional deployment-level allowlist in `nimbus/src/exec-policy.ts` (new) for cases where a user deploys Nimbus publicly.

### 5.5 Process isolation

- PC daemon: user UID only, never root. Install script refuses `sudo`.
- All children inherit daemon UID.
- Clean env; only explicit `PROTEUS_*` pass-through.

---

## 6. Migration plan — 7 phases

Each phase is a separate PR. Tests + empirical verification gated at each boundary.

### Phase 1 — Upstream Nimbus: add `_rpcExec` + fix `/port/:n/*`

**Repo**: `/workspace/nimbus/` (upstream PR).

**Files**:
- `src/nimbus-session.ts` — add `async _rpcExec(cmd, opts?)` method. Lifts guts of `FacetManager.exec`, runs non-interactively, captures stdout/stderr into buffers.
- `src/nimbus-session.ts:126-130` — fix `_rpcRegisterPort` to store the real `facetStub` instead of `null`, so `PortRegistry.routeRequest` can reach node HTTP servers.
- `src/types.ts` (if it exists) — export the result shape.

**Before → after**: Proteus's `nimbusExecutor.tools.exec` currently returns `EXEC_NOT_AVAILABLE`. After: returns real `{stdout, stderr, exitCode}`. `/port/:n/*` returns 502 today for node servers; after: proxies correctly.

**Empirical test**: Nimbus-side unit. `bun test` in the Nimbus repo; new test invokes `session._rpcExec('echo hi')` and asserts `stdout === 'hi\n'`, `exitCode === 0`. Port test: spawn a node HTTP server via `FacetManager.spawn`, hit `/port/3000/`, assert 200.

**Commit**: `feat(nimbus): add _rpcExec RPC + fix port registry facetStub`

### Phase 2 — Proteus: wire Nimbus binding + types

**Repo**: `/workspace/proteus/`.

**Files**:
- `packages/cf-backend/wrangler.jsonc` — uncomment the Nimbus binding.
- `packages/cf-backend/env.d.ts` — add `NIMBUS_SESSION: DurableObjectNamespace<NimbusSession>;`.
- `packages/cf-backend/src/types.d.ts` (new or extend) — declare `NimbusSession` stub interface matching `nimbus.ts:33-43`, including the new `_rpcExec` signature.

**Before → after**: Executors tab shows "nimbus" as "not configured". After: shows as "connected"; `nimbus.exec`/`nimbus.readFile`/etc all work end-to-end.

**Empirical test**: live dev server + WS harness (like `scripts/phase-abc-repro.ts`). Send prompt: "Run `echo hello` via the nimbus executor". Assert the tool-output contains `"hello"`.

**Commit**: `feat(exec): enable Nimbus executor binding`

### Phase 3 — Proxy routes: Nimbus WebSocket + preview + port

**Files**:
- `packages/cf-backend/src/nimbus-proxy.ts` (new, ~80 LOC) — three handlers:
  - `handleNimbusWs(request, agentId, env)` → upgrade + forward.
  - `handleNimbusPreview(request, agentId, path, env)` → GET forward.
  - `handleNimbusPort(request, agentId, port, path, env)` → any method forward.
- `packages/cf-backend/src/server.ts` — route dispatch (currently 18 lines; `server.ts:14` calls `routeAgentRequest` as fallback).

**Before → after**: no preview; `/agent/:id/nimbus-*` returns 404. After: iframes render; HMR over WS works.

**Empirical test**: start Nimbus dev server in a test agent (`npm run dev` in the Nimbus terminal producing vite on :5173). Hit `/agent/:id/nimbus-preview/` from a browser. Assert HTML loads. Assert HMR WebSocket upgrades.

**Commit**: `feat(exec): Nimbus WS + preview + port proxy routes`

### Phase 4 — Executors tab redesign: 3-panel layout + xterm

**Files**:
- `packages/cf-backend/package.json` — add `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`.
- `packages/cf-backend/src/pages/WorkspacePage.tsx` — rewrite `ExecutorsTab` (`:388-547`) with resizable panels, xterm terminal per executor, recursive file tree, preview iframes.
- `packages/cf-backend/src/components/ExecutorTerminal.tsx` (new) — xterm-backed.
- `packages/cf-backend/src/components/ExecutorFileTree.tsx` (new) — recursive lazy-load.
- `packages/cf-backend/src/components/ExecutorPreviewPane.tsx` (new) — iframe manager.

**Before → after**: `<input>` + flat readdir → real terminal + file tree + previews.

**Empirical test**: manual — open Executors tab, click nimbus, run `npm create vite@latest`, run `npm install`, run `npm run dev`, add preview for port 5173, verify iframe shows the vite landing page.

**Commit**: `feat(ui): Executors tab redesign — xterm + file tree + preview panes`

### Phase 5 — Sandbox binding plumbing (no Dockerfile)

**Files**:
- `packages/cf-backend/wrangler.jsonc` — add `containers` top-level block with placeholder Dockerfile path; uncomment the SandboxContainer DO binding.
- `packages/cf-backend/src/sandbox-container.ts` (new) — stub `SandboxContainer extends DurableObject` that throws `not_configured` from all methods.
- `packages/cf-backend/env.d.ts` — add `CONTAINER: DurableObjectNamespace<SandboxContainer>;`.
- `packages/cf-backend/src/runtime.ts` — the existing `container.ts` wiring at `:121-137` picks it up automatically.

**Before → after**: "sandbox" executor shows "not configured" in the Executors tab. After: still shows "not configured" (no Dockerfile), but the binding is declared, the class is registered, CF platform doesn't error, and the Executors tab renders a Sandbox card with a "configure Dockerfile" hint link.

**Empirical test**: `wrangler deploy --dry-run` succeeds. Executors tab shows the sandbox card with a grey dot and configure hint. No runtime errors.

**Commit**: `feat(exec): Sandbox binding plumbing (Dockerfile deferred)`

### Phase 6 — PC agent: protocol package + DO-side WS upgrade handler

**Files**:
- `packages/pc-agent-protocol/` (new package) — TS types for every frame + shared policy evaluator.
- `packages/cf-backend/src/orchestrator.ts` — add `fetch()` override for `/pc-tunnel` path; add `@callable() async createPcAgentInstall(label)`, `@callable() async revokePcAgent(tokenId)`, `@callable() async listPcAgents()`.
- `packages/cf-backend/src/pc-agent-tokens.ts` (new) — `pc_agent_tokens`, `pc_agent_install_nonces`, `pc_agent_policy` tables + helpers.
- `packages/core/src/execution/ssh.ts` — evolve `rpc()` to framed dispatcher; add `execStream()` companion.

**Before → after**: laptop executor still reports "not connected". After: new RPCs exist; protocol package published; DO accepts WS upgrades; but no daemon exists yet to connect.

**Empirical test**: integration test — use a mock WS client (inline bun script) to send HELLO with a valid token → assert Proteus upgrades and `rt.sshExecutor.setSocket(ws)` was called. Send EXEC → assert mock receives frame; send STDOUT/EXIT → assert Proteus receives + exposes through `tools.exec`.

**Commit**: `feat(pc): pc-agent protocol package + DO-side WS upgrade`

### Phase 7 — PC agent: the Bun daemon + install UI

**Files**:
- `packages/pc-agent/` (new package) — entire daemon.
  - `src/index.ts` (entrypoint), `src/ws-client.ts` (connect + reconnect), `src/rpc.ts` (frame dispatcher), `src/exec.ts` (spawn + stream), `src/fs.ts` (read/write/list with policy enforcement), `src/policy.ts` (import from pc-agent-protocol), `src/service/launchd.ts`, `src/service/systemd.ts`, `src/logger.ts`.
- Build script: `bun build --compile --target=bun-darwin-arm64 ...` → upload to R2.
- `packages/cf-backend/src/install-route.ts` (new) — serves install.sh, binary, nonce-exchange endpoint.
- `packages/cf-backend/src/components/LaptopExecutorCard.tsx` (new) — connect button, install-nonce display, status, revoke, permissions editor.

**Before → after**: no binary exists + no install UI. After: user can run `curl -fsSL ... | sh`, daemon installs + connects, Laptop executor becomes available with full UI.

**Empirical test**: on a developer machine, trigger the install flow via a local dev Proteus, verify daemon starts, verify LLM can `run("ls ~", executor: "laptop")` and get real output. Verify revoke flow closes connection. Verify 3 consecutive revokes → daemon backs off.

**Commit**: `feat(pc): reverse-WS daemon binary + Laptop UI card`

---

## 7. Open questions

1. **Multi-agent PC daemon.** One daemon per agent means N tokens, N services for a power user. Multi-agent (HELLO `agent_ids[]`, daemon demuxes) is cleaner UX. How many Proteus agents does a typical user run concurrently? If N ≤ 3, the per-agent daemon is fine; if N=10+, multi-agent becomes required. Default: per-agent v1, revisit v2.

2. **PC binary distribution.** Self-hosted Proteus deployments — do we ship signed binaries from a Proteus-central R2 (one supply-chain risk surface), or does each deployment build + sign its own? The second is more work for self-hosters; the first is scarier. Lean: central-default with opt-out for paranoid deployments.

3. **Preview iframe security.** If Nimbus-hosted code is malicious and the iframe is same-origin with Proteus UI, the malicious page could `postMessage` to the Proteus window. Do we isolate via `sandbox` attribute + a nonce-bound postMessage protocol, or serve from a different origin? Same-origin is simpler; sandbox+nonce is safer.

4. **Revoke latency vs DO hibernation.** Orchestrator DOs hibernate. If user revokes during hibernation, the `UPDATE` happens but no one calls `clearSocket`. Next DO wake-up closes the socket; tiny window where stale commands could flow. Fix options:
   - (a) DO Hibernation API — wake on WS message, re-verify token before dispatch. ← correct answer
   - (b) daemon periodically re-verifies token via a server RPC. Belt-and-suspenders.
   - (c) short-lived token (5min) with refresh. Biggest protocol change.

5. **Streaming in `ssh.ts` contract.** Current `exec` returns a string. LLMs consume it synchronously. Changing to AsyncIterator breaks tool signatures. Ship in stages: (a) keep string, add separate streaming tool, (b) migrate later when AI SDK's tool-streaming is stable.

6. **Dockerfile trigger for Phase 5 follow-up.** When a user first needs python/ruby/native binaries, do we auto-prompt to add a Dockerfile, or wait for explicit ask? Affects whether Sandbox follow-up is reactive (user-driven) or proactive.

---

## 8. Summary — what gets built

| Component | LOC (est.) | New package | Upstream change |
|---|---|---|---|
| Nimbus `_rpcExec` + port fix | ~120 | — | **yes** (Nimbus repo) |
| Proteus Nimbus binding + types | ~30 | — | — |
| Nimbus proxy routes | ~80 | — | — |
| xterm-based Executors UI | ~800 | — | + `@xterm/*` deps |
| Sandbox binding plumbing | ~100 | — | — |
| pc-agent protocol | ~400 | `@proteus/pc-agent-protocol` | — |
| PC DO-side WS upgrade | ~250 | — | — |
| PC Bun daemon + install UI | ~1800 | `@proteus/pc-agent` | — |
| **Total** | ~3600 | 2 new packages | 1 upstream PR |

Estimated 7 PRs over ~2 weeks of focused work. The one upstream dependency (Nimbus PR) is the only external blocker; everything else is Proteus-repo-local.

Each phase lands independently behind feature-flags-or-bindings (the Nimbus branch gated on `env.NIMBUS_SESSION`; the PC branch only activates when a daemon connects; the Sandbox branch only activates after a Dockerfile ships). No phase blocks user-visible Proteus functionality if it lands half-done.
