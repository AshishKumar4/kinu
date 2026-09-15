# The model-facing tool surface

What the model can call, by what name, from where. Decided 2026-09-15 with the owner; this page is the spec the implementation batch executes and the record of why. Where a figure is unmeasured it says so.

## Names

| Today | After | Why |
|---|---|---|
| `execute_tools` | `eval` | The name every coding agent the models learned from uses for this tool. Identifiers follow as `codemode` (`executeToolsCalls` becomes `executeCodemodeCalls`); `eval` itself is reserved as a binding name in strict mode. |
| `run` | `shell` | One shell command in one runtime. `bash` was considered: the sandbox and a device run `bash -c`, the hosted workspace runs Nimbus's own shell, so `shell` is the name that is true on all three. |
| `run.runtime` + `run.device` | `shell.runtime` | One field. Its values are the names the live prompt lists: `workspace`, `sandbox`, and each device by its nickname. The `device` field goes. |
| executor kind `laptop` | `device` | Four names for one thing today (`laptop`, `device`, "Your PC", `/pc`). The registry and the consent tables already say device. |
| mount `/pc` (one device) or `/pc/<name>` | `/pc/<name>` always | A path stays valid when a second machine joins, so a saved tool or a slate that names it never breaks. `mounts.ts` and `volatile-context.ts` are the two sites. |

The `//` first-line intent comment convention stays; there is no separate intent field.

## The program

Both backends run the program through `normalizeCode` from `@cloudflare/codemode/normalize`, which parses with acorn and wraps a bare body in an async function. Top-level statements, `await`, and `return` or a trailing expression all work today. The only text that said "async arrow function" was the package's `code` field label; core now owns that string (`fix/codemode-code-field`).

## Namespaces inside `eval`

One vocabulary, one shape. A slate binding kind is the codemode namespace name.

| Namespace | Members | Slate binding kind |
|---|---|---|
| `workspace` | `exec`, `readFile`, `writeFile`, `editFile`, `readdir`, `exists`, `remove` | `workspace` (with `members`, `paths`) |
| `sandbox` | the same members plus `startProcess`, `stopProcess`, `listProcesses`, `exposePort`, `unexposePort`, `listPorts` | `sandbox` |
| `<device name>` | the same members as `sandbox` | `<device name>` |
| `tools` | every native tool as `tools.<name>(input)` with the native input object; crafted tools; `create`, `list` | `tools` (with `name`) |
| `memory` | `save`, `search`, `conversations`, `remember`, `recall`, `forget` | `memory` |
| `tasks` | as today | `tasks` |
| `web` | `search`, `fetch` | `web` |
| `db` | as today (`tools/db-codemode.ts`) | `db` |
| `agents` | as today | refused to slates, as today |
| `agent` | as today | refused to slates, as today |
| `release` | as today | none |
| `slates` | `preview`, and the slate members `workspace.slate` carries today | `app` (binds another slate by id; unchanged) |
| `plugins` | `list`, `search`, `describe`, and `plugins.<plugin>.<tool>(args)` | `plugins` (with `server`, `tools`) |
| `state` | `get`, `set` | none |

What moves: `workspace` loses `searchMemory`, `saveNote`, `listTools`, `createTool`, `slate`; `sandbox` loses `listFiles`. Every runtime namespace returns the same result and refusal shapes. The Node `fs`, `fs/promises`, and `child_process` shims stay as aliases over the `workspace` binding. `tools.<name>` stays for builtins so a mistaken call still lands. The generic `namespace` slate binding kind goes away; `rpc`, `mcp` (renamed `plugins`), `agent`, and `ai` stay slate-only. Slate persistence is unchanged: `this.sql` is the slate process's own SQLite and `this.storage` its key-value store; the `db` namespace is bindable for the shared store.

Unmeasured: whether a slate's `this.sql` survives eviction the way its files and port do. A test proves it before anything relies on it.

## Plugins

MCP servers leave the native tool set. The eight standing tools (`unit-tools.test.ts` pins the count against `BUILTIN_TOOLS`) are the whole top level again, and `admitMcpDescriptors` with its per-turn budget is deleted with them. Inside `eval`:

- `plugins.list()` returns `Array<{ plugin, tools: Array<{ name, summary }>, more }>`: every connected plugin, one line per tool (first sentence, at most 100 characters), at most 40 tools per plugin and the count beyond. Dynamic context carries one line per plugin.
- `plugins.search(query, { limit?, plugin? })` returns `{ results: Array<{ path, summary, input, requiresApproval }>, searched, weak }`. `summary` is the first sentence at most 120 characters; `input` is the input type rendered by `jsonSchemaToTs`, present on the first eight results so a hit is callable without a second call; `searched` is the number of tools considered; `weak` is true when no strong match exists, in which case the best-ranked hits are still returned. Search never returns empty while a plugin is connected.
- `plugins.describe(path)` returns the full description and the input and output types for one plugin or one method.
- `plugins.<plugin>.<tool>(args)` is callable whether or not the model searched. No plugin method is ever in the schema, and nothing is added to the schema after a search: the result lives in the transcript, so the cache prefix holds.

Ranking reuses the memory retrieval path: FTS5 BM25 for the lexical side, the vector store's `Embedder` for the semantic side, `hybridSearch` for reciprocal rank fusion. Each tool is one document: plugin name, tool name split on case and underscores, title, first sentence, and parameter names. Compared on 2026-09-15: OpenSeal (`packages/agent-utils/src/tools/search.ts`) ranks with MiniSearch BM25 plus fuzzy and prefix and then activates discovered tools into the schema, which edits the prompt mid-conversation; `@cloudflare/codemode` 0.5.1 ranks lexically with a coverage gate that returns nothing when a two-word query has one unmatched word, and returns no signature. Kinu takes the hybrid ranking, the never-empty rule, and the transcript-only delivery.

Plugins bind through Kinu's own `McpToolSurfaceCache` descriptors and `codemodeFunction`, not the package's `McpConnector` or its durable runtime: claims, admission, and approvals already exist here, and the package's snippets duplicate crafted tools. MCP stays the protocol's name in settings; the agent never sees it.

## What the lane proves

- `bun run check`, the tool and codemode suites, the slate binding suites, `gate:agents-fields`, the prompt budget gate, and the layer gate re-locked with the reason.
- A rendered `eval` description measured in bytes on the harness actor, before and after, recorded here.
- The trajectory tier green on the deployed build with the new names.
