# Live UI: gadgets

The agent writes a small app and Kinu runs it. The app's server runs in a
resident process with no network, no `ctx`, no SQLite, and only the
bindings the app declares. The app's client runs in a sandboxed iframe with no
network and one MessagePort to its server. This replaces the JSON dashboard
vocabulary (`packages/core/src/views/`, deleted) with real code the agent
writes. This document holds the research, the decision, the trust boundary and
what stays open.

Every figure here is dated and names its source. Every mechanism claim names a
file.

## 1. Research

### 1.1 Cloudflare OS gadgets, the reference

Source: [github.com/cloudflare/cloudflare-os](https://github.com/cloudflare/cloudflare-os)
(Apache-2.0), `README.md`, `docs/sharing.md`, `docs/blueprints.md`,
`docs/observers.md`, `packages/workshop-backend/src/overseer.ts`,
`packages/workshop-frontend/src/GadgetUI.tsx`, read 2026-09-05.

A gadget is a private instance of a small app, one per user, with a server
half and a client half.

- Server. `overseer.ts` `loadGadgetWorker` builds a dynamic Worker from the
  gadget's committed `.js` files with `mainModule: "server.js"`,
  `globalOutbound: null`, and `env: this.getEnvForLoader(...)`, cached by
  `env.LOADER.get(`${this.ctx.id}.${codeVersion}.${gadgetId}`, ...)`.
  `getGadgetFacetFetcher` then runs the exported class as a facet of the
  workspace Durable Object:
  `this.ctx.facets.get(facetName, () => ({ class: stub.getDurableObjectClass("Gadget"), id: facetName }))`.
  A code change calls `this.ctx.facets.abort(facetName, ...)`, and the next
  `get` restarts the facet under the new load. The gadget's `env` is a flat
  object of loopback stubs, one per introduced binding:
  `env[name] = this.makeBindingLoopback({type: "gatekeeper", id: edge.target}, caller)`,
  built with `this.ctx.exports.GatekeeperLoopback({props})`.
- Gatekeepers. `packages/workshop-shared/src/gatekeeper.ts`: a gatekeeper is a
  facet the overseer installs, exposed to the overseer and never to the
  gadget. Every session call is submitted to an approval queue. Reads are
  authorised before data returns. Side-effecting actions are simulated
  locally while the owner decides, so the agent never blocks.
- Client. `GadgetUI.tsx` synthesises the document client-side and mounts it
  with `srcDoc`. The document carries
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'none'; script-src data: 'unsafe-inline'; style-src data: 'unsafe-inline'; img-src data:; media-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none';">`,
  the iframe carries
  `sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"`, and
  the client module is a `data:` URL that first imports Cap'n Web from a
  base64 `data:` URL (`import CAPNWEB_BUNDLE from 'capnweb?raw'`). The client
  creates a `MessageChannel`, posts `"handshake"` with one port to
  `window.parent`, and the parent accepts it only when
  `event.source === iframeRef.current?.contentWindow && event.origin === "null"`,
  then opens `newMessagePortRpcSession(port, forwardingTarget)`. The client
  has an opaque origin and no network at all. Its only channel is the port it
  handed over.
- Tool surface. The server's RPC methods are what the agent calls through
  Code Mode: `executeCodeMode` loads the agent's program into a second
  dynamic Worker with `globalOutbound: null` and `env: this.getEnvForAgent(...)`,
  where each gadget is a loopback stub under its binding name.
- Storage. Gadget files live in a git object database inside the workspace
  object (`git-store.ts`). Hot reload is a version counter in the loader id
  plus `facets.abort`.
- Stated limits. The README says the iframe is blocked from the internet "to
  the maximum extent allowed by browsers". The code widens the sandbox with
  `allow-popups allow-popups-to-escape-sandbox` and neuters programmatic
  `window.open`, so only a user-activated `_blank` link escapes, stamped
  `noopener`.

### 1.2 Cap'n Web

Source: [github.com/cloudflare/capnweb](https://github.com/cloudflare/capnweb),
README and `packages/docs`, and npm, read 2026-09-05.

- `capnweb@0.12.0`, MIT. The README claims the core bundle compresses "to
  under 16 kB with no dependencies"; the published `dist/index.js` is
  100,764 bytes unminified (jsdelivr package listing).
- Transports: HTTP batch, WebSocket, and `newMessagePortRpcSession(port, localMain?)`.
  The docs say "Do not use a `Window` object itself as a port for RPC" and
  that the RPC system "does not authenticate that messages came from the
  expected sender": the host verifies the port's sender first.
- `RpcTarget`: prototype members are reachable, instance properties are not,
  `#`-prefixed members never are. Stubs are Proxies, so a forwarding target
  can be a Proxy over `new RpcTarget()`, which is what the reference does.
- Security guide: authenticate in band, rate-limit expensive operations
  because pipelining is cheap for an attacker, set payload limits,
  `Object.prototype` members are unreachable by protocol.

### 1.3 Dynamic Workers and Durable Object facets

Source: [developers.cloudflare.com/dynamic-workers](https://developers.cloudflare.com/dynamic-workers/)
(landing, api-reference, usage/bindings, usage/egress-control, usage/limits,
usage/durable-object-facets, platform/limits, pricing), read 2026-09-05.

- `env.LOADER.get(id, callback)` caches an isolate by id; "the callback
  always returns exactly the same content, when called for the same ID".
  `WorkerCode` carries `compatibilityDate`, `mainModule`, `modules`, `env`,
  `globalOutbound`, `limits`.
- `globalOutbound: null`: "Both `fetch()` and `connect()` will throw
  exceptions." Omitted, the dynamic Worker inherits the parent's network.
- `env` "may contain: Structured clonable types. Service Bindings, including
  loopback bindings from ctx.exports." A loopback stub carries `props` only
  the loader Worker can read. "Stubs have no global identifier and cannot be
  forged, the only way to obtain one is to receive it."
- `limits: { cpuMs, subRequests }` throw at the boundary when reached. A load
  that omits them runs under the plan's limits.
- Facets: `this.ctx.facets.get(name, () => ({ class, id? }))` creates or
  resumes a child Durable Object "with its own isolated SQLite database"; "the
  dynamic code cannot read the supervisor's database". `abort(name, reason)`
  stops it and keeps storage; `delete(name)` destroys storage. A Durable Object
  can have "up to ten distinct Dynamic Workers with in-flight requests".
- Availability: open beta for paid Workers plans since 2026-03-24; billed per
  unique (id, code) per day, per request, and per CPU millisecond including
  isolate start-up.

### 1.4 agent-core SPEC (vocabulary)

Source: `/home/mrwhite0racle/agent-core/packages/agent-core/SPEC.md` §4.1,
§4.7, §6.3, §10.2, read 2026-09-05.

- §4.1 splits a Facet into a `FacetManifest` (data a host can read without
  running code: identity, `bindings`, isolation, contributions) and a runtime
  class. The gadget manifest here is that shape: the declared bindings are the
  reach.
- §4.7: agent-authored code runs in a `dynamic` domain "with zero ambient
  authority", and "the explicitly passed Bindings are also the whole of what
  the isolate's names reach" (`C13-AUTH-ISOLATE-NAMESPACE-CLOSED`).
- §10.2: a load carries an exact resource bound; a load that omits it "gets
  the account's entire compute budget" (`C13-CLOUDFLARE-DYNAMIC-COMPUTE-BOUND`).
  Warm reuse is keyed on the whole load, bindings included
  (`C13-CLOUDFLARE-DYNAMIC-ISOLATE-IDENTITY`). The no-egress demonstration is
  "code running in a real isolate ... failing both an unbound global fetch and
  an unbound connection attempt while a Binding it was explicitly passed
  answers normally" (`C13-CLOUDFLARE-DYNAMIC-NO-EGRESS`).
- §6.3: a View is a data-only snapshot with `ActionDescriptor`s, streamed as
  JSON Patch `ViewDelta`s, never live state. Adopted here as the observation
  vocabulary (§4 below), not as the rendering path.

### 1.5 The wider landscape

Each row: what the agent writes, where it runs, the trust boundary, the cost.
Primary sources read 2026-09-05.

| System | Writes | Runs where | Trust boundary | Cost |
|---|---|---|---|---|
| OpenAI Apps SDK ([developers.openai.com/plugins](https://developers.openai.com/plugins/build/chatgpt-ui)) | HTML/JS bundle served as an MCP resource | iframe in ChatGPT | "Widgets run inside an isolated iframe with a strict Content Security Policy"; `window.openai` bridge; sandbox tokens not documented | public MCP server, app review |
| MCP Apps ([modelcontextprotocol/ext-apps](https://github.com/modelcontextprotocol/ext-apps)) | HTML as a `ui://` resource | host iframe, MCP over postMessage | default CSP `default-src 'none'; ... connect-src 'none'`; "The Host and the Sandbox MUST have different origins"; sandbox `allow-scripts, allow-same-origin` | none mandated |
| Vercel AI SDK generative UI ([ai-sdk.dev](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces)) | tool calls, data only | host app | only host-shipped components render | none |
| A2UI ([google/A2UI](https://github.com/google/A2UI)) | declarative JSON | client renderer over a catalog | "A2UI is a declarative data format, not executable code" | catalog and renderer maintenance |
| Claude Code artifacts ([code.claude.com/docs/en/artifacts](https://code.claude.com/docs/en/artifacts)) | one HTML file | claude.ai page under a strict CSP | CDN and font allowlist, no backend | hosted |
| WebContainers ([webcontainers.io](https://webcontainers.io/guides/introduction)) | a Node project | Node in the browser tab | tab containment; needs COOP/COEP and HTTPS | runtime download |
| v0 ([v0.app/docs/sandbox](https://v0.app/docs/sandbox)) | a full project | Vercel Sandbox VM dev server | per-chat isolation, network policy; preview iframe posture not documented | sandbox compute |
| Svelte compiler / Vue REPL ([svelte.dev](https://svelte.dev/docs/svelte/svelte-compiler), [vuejs/repl](https://github.com/vuejs/repl)) | component source | in-browser compile, srcdoc preview | pure transform; the Vue REPL's iframe sandbox includes `allow-same-origin` | CDN downloads |

What the table says: the systems that render agent-written UI in a host all
converge on a sandboxed iframe with a `connect-src 'none'`-class CSP and a
postMessage bridge (OpenAI, MCP Apps, cloudflare-os). The systems that run
agent-written servers do it in a per-user sandbox (cloudflare-os, v0). The
declarative options (A2UI, AI SDK, and Kinu's own deleted vocabulary) are safe
because they are not code, and that is also their ceiling.

## 2. Decision

Kinu adopts the cloudflare-os model. The server runs on a resident process.

A gadget is a directory `gadgets/<slug>/` in the workspace file plane:

| File | What it is | Who runs it |
|---|---|---|
| `gadget.json` | the manifest: `{ v: 1, title, subtitle?, bindings? }` (`core/src/gadgets/manifest.ts`) | the host reads it, never executes it |
| `server.js` | `import { RpcTarget } from './capnweb.js'; export class Gadget extends RpcTarget` with `constructor(env) { super(); this.env = env; }` | a resident process the host boots per gadget (`cf-backend/src/gadgets/host.ts`) |
| `client.js` | an ES module; `gadget` is in scope as a stub of the server | a sandboxed srcdoc iframe (`cf-backend/src/components/gadgets/`) |
| `client.css` | optional stylesheet | inlined into the document |

There is no publish tool. The agent writes the files with the `file` tool,
`workspace.*` or the shell, and the workspace object reacts to the write. The
codemode surface is `workspace.gadgets()` and
`workspace.gadget(slug, method, ...args)` (`core/src/execution/inline.ts`),
which is the reference's "the server's RPC surface doubles as the agent's tool
surface".

### 2.1 Bindings are the object-capability model

The manifest's `bindings` map is the whole of what the server reaches. Each
entry becomes one loopback stub in the resident process `env`, minted by the
workspace object with `exports.<Class>({ props })` and the workspace, gadget
and binding name as props (`cf-backend/src/gadgets/bindings.ts`,
`host.ts` `mintEnv`). Nothing else is in `env`: no namespace, no `LOADER`, no
secret. A binding call comes back to the workspace object
(`gadgetBindingCall`, stub transport only), which re-reads the manifest and
decides with the pure rules in `core/src/gadgets/bindings.ts`.

| Binding kind | What `env.<NAME>` offers | The Kinu seam that mints and enforces it |
|---|---|---|
| `files` (`root?`) | `read(path)`, `write(path, text)`, `list(dir)`, `remove(path)` under the root, default `gadgets/<slug>/data` | the workspace file plane (`rt.storage.vfs`, the same plane the `file` tool writes); `resolveGadgetFilePath` refuses every path that leaves the root |
| `workspace` | `read(source)` for the closed list `GADGET_DATA_SOURCES` (`core/src/gadgets/sources.ts`) | the orchestrator's `@callable` read models, each classed `workspace.read` in `cli/rpc-gate.ts` (`tests/unit-gadget-sources.test.ts` holds the list to the gate); the needs-you and consent queues stay off the list |
| `mcp` (`server`, `tools?`) | `tools()`, `call(tool, args)` on one owner-configured connection | the owner's UserDO (`userMcp_toolDescriptors`, `userMcp_callTool` behind the `mcp.tools` capability tier) reached through `userHub()`, with every call judged by `decideApproval` (`core/src/safety/approval-gate.ts`): a read-only tool (MCP `readOnlyHint`) runs; anything else is parked on the owner through the deferred-approval queue under executor `gadget:<slug>` and rule `gadget_mcp_action` |

The MCP binding's `server` names the connection id. Discovery and dispatch
use that id. Renaming the connection does not change the binding.

Two deliberate differences from the reference. Kinu does not simulate an
outcome while the owner decides: the gadget is told the call is queued and
NOT run, the honesty rule `safety/deferred-approval.ts` already states for the
agent's own commands. And an owner's `always` grant scopes to
(`gadget_mcp_action`, `gadget:<slug>`), so a grant to one gadget never answers
for another or for the agent's shell.

### 2.2 The server half

`server.js` imports `RpcTarget` from `./capnweb.js`. It exports `class Gadget extends RpcTarget`. The constructor keeps `env`: `constructor(env) { super(); this.env = env; }`. Each prototype method is a JSON RPC method. User code receives no `ctx` and no SQLite. The embedder runner hosts `new Gadget(env)` privately. The runner boxes a thrown method into the value `{__gadgetError: message}`, so the host refuses the call as `io` with its message.

`GadgetHost.call` (`cf-backend/src/gadgets/host.ts`):

1. reads `server.js` and the manifest fresh from the file plane;
2. checks the method name with `isGadgetMethodName` and the args as an array of JSON values;
3. spawns a resident process with the server bytes and an `env` that holds one loopback stub per declared binding; the process inherits the workspace's outbound network and runs under the platform's own limits;
4. sends the call as framed Cap'n Web HTTP batch bytes through `resident.handleHttpRequest` over an `RpcSession` transport, and answers the JSON value or a refusal with its class first. The process side serves the bytes with `newHttpBatchRpcResponse`.

State that must last lives in the `files` binding, by default `gadgets/<slug>/data`. The process keeps no SQLite of its own. A write under `gadgets/<slug>/` releases the resident process. The next call boots a new server from the files as they stand then. The file plane's event bus (`session.vfs.events.on`, subscribed in `OrchestratorAgent.onStart`) carries the write, whichever path wrote it.

### 2.3 The client half

`cf-backend/src/components/gadgets/gadget-document.ts` builds the document
the reference builds: the meta CSP quoted in §1.1, the client module as a
`data:` URL, Cap'n Web embedded as a base64 `data:` import, the prefix that
opens the MessageChannel and posts the handshake. `GadgetFrame.tsx` mounts it
with `sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"`.
`gadget-bridge.ts` is the one seam between that port and the server: it
accepts a handshake only from the frame's own `contentWindow` with origin
`"null"`, opens `newMessagePortRpcSession(port, forwardingTarget)`, and
forwards every method call as `rpc("gadgetCall", [slug, method, args])` over
the SPA's existing authenticated WebSocket. The prefix also forwards the
client's console lines and uncaught errors as `console` messages, and the
frame shows the last 100 under the iframe, so a broken `client.js` names its
error where the owner looks. `scripts/gadget-sandbox-ux.test.ts` reads one
such line from the host document. A second surface that wants a gadget
reuses `GadgetFrame`, or the bridge alone.

Why not the preview rail for the client. The reference does not serve the
client from a hostname, and Kinu should not either: staging sets
`PREVIEW_HOST_SUFFIX: ""` (`wrangler.jsonc`), so a rail-served client would
not render there or under `vite dev`; a preview hostname needs
`allow-same-origin` and a live port capability that dies with the isolate
(the 410 `RECYCLED_WORKSPACE_PREVIEW` path in `workspace-host.ts`); and
no-network is stronger than the rail's `connect-src`. The preview rail stays
what it is: the carrier for agent-started servers on exposed ports.

The workspace snapshot includes gadget summaries, so tabs appear on the first
load. A successful list read removes reload counters for unpublished gadgets.
If the open gadget disappears, the reader returns to Work.

The memoized workspace boot subscribes to file changes once. A retry after an
activation failure installs the same subscription. The workspace object broadcasts
`{ type: 'gadgets_changed', slugs }` on the event that releases the resident process.
The UI re-lists gadgets and remounts the open frame, which fetches
`getGadgetClient` again.

## 3. Trust boundary

| Row | The server sees | The client sees | Neither can reach | Enforced by |
|---|---|---|---|---|
| Network | nothing: `fetch`/`connect` throw | nothing: `connect-src 'none'`, `default-src 'none'` | the internet, the app origin, the preview hosts | `globalOutbound: null` on the resident spawn (host.ts); the meta CSP (gadget-document.ts) and `frame-src` of the app document (`lib/security-headers.ts`) |
| Files | the `files` binding's root, read and write | nothing | the rest of the workspace tree, SOUL.md, memory/, other workspaces | `resolveGadgetFilePath` over the manifest root, re-read per call (host.ts `bindingCall`) |
| Workspace data | the `workspace` binding's closed read-model list | nothing | the needs-you queue, consents, instruction approvals, anything with a free argument | `GADGET_DATA_SOURCES` + `resolveGadgetDataSource`; `unit-gadget-sources.test.ts` holds it to `workspace.read` |
| External services | the `mcp` binding's connection: read-only tools now, side effects after the owner decides | nothing | any connection the manifest did not name; any credential | `reviewGadgetMcpCall` + `decideApproval`; the credential never leaves UserDO (`user/mcp.ts`) |
| Storage | none: no `ctx`, no SQLite; lasting state lives in the `files` binding, by default `gadgets/<slug>/data` | none (opaque origin: no cookies, no localStorage) | the workspace object's SQLite, other gadgets, any path outside the binding root | the runner passes no `ctx`; `gadgetFilesRoot` + `resolveGadgetFilePath` hold the binding to its root |
| Host document and session | nothing | nothing: opaque origin, no `allow-same-origin`, `frame-src 'none'` inside | the owner's session cookie, `/api/*`, the SPA DOM | the sandbox attribute; `__Host-` cookies; the bridge accepts only its own frame's port |
| Compute | the platform's own Worker limits | the browser tab | nothing beyond them | the Worker Loader |
| Spoofing host chrome | cannot title itself as a host surface | draws only inside its frame | Approve, consent, credential and settings chrome | `RESERVED_GADGET_TITLES` at parse time; the tab strip marks the group |
| What crosses out | JSON return values, thrown errors, console lines | JSON calls over one MessagePort, console lines, user-activated `_blank` links | anything else | the bridge's forwarding target; `window.open` neutered in the prefix |

The app keeps its no-HTML-injection-sink property: agent bytes never enter the
host document. They enter an iframe of opaque origin the host built, and the
host document's own CSP does not change.

## 4. Observation channel

A gadget may implement `view()` returning a data-only JSON snapshot. The host
reads it through the same `gadgetCall` path when a reader asks (the agent via
`workspace.gadget(slug, 'view')`, a future chat card). That is agent-core's
View shape, adopted as vocabulary: a snapshot with no live state, rendered by
the host as data and never as platform voice. JSON Patch `ViewDelta` streaming
and `ActionDescriptor` routing are not built; see §6.

## 5. Retirement of the JSON DSL

Deleted: `packages/core/src/views/{spec,sources,store,index}.ts`,
`unit-views.test.ts`, the `agent_views` table and its `initViewTables`, the
`view` changelog kind and `view_revert`, `workspace.createView`/`deleteView`,
the `listAgentViews`/`getAgentView` RPCs, `AgentViewSurface.tsx`. Production
is reset, so no stored spec is migrated; a `views/` directory in a workspace is
an ordinary directory.

What carried over by name: the closed read-model list and its rationale
(`gadgets/sources.ts`), the reserved-title list (`gadgets/manifest.ts`), the
fail-closed `strictObject` validation, and the rule that the needs-you queue is
host-owned.

## 6. Open

- Bundle budget, measured: after `bun run build` and `bunx wrangler deploy --dry-run`
  in `packages/cf-backend` with `capnweb@0.12.0` in the graph, the Worker
  bundle is **7,298.99 KiB gzip** (raw upload 27,817.73 KiB) on 2026-09-05,
  50.77 KiB below the 2026-08-31 reading of 7,349.76 KiB: the deleted views
  renderer outweighs the embedded Cap'n Web module. Recorded in AGENTS.md §
  Deploy Discipline.
- Server-to-client callbacks. Cap'n Web can carry a client callback to the
  parent and on to the workspace object; whether the resident transport then passes that
  stub into the process as a function is untested. Clients poll today.
- `ViewDelta` streaming, `ActionDescriptor` routing and a chat card for a
  gadget's `view()` are vocabulary only.
- Console forwarding from the server (the reference uses a tail Worker) is
  not wired; server errors reach the caller as the refusal text.
- The first-run row `tests/first-run/gadget.first-run.ts` is written and not
  proved red against a deployed sha: the build before the gadget commit has
  no `listGadgets` RPC, so the row fails there on the missing surface, not on
  the defect it names. The first `gate:first-run` run after a deploy is the
  measurement.
