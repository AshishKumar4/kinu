/**
 * Built-in skills, merged with `/workspace/skills/`. Their names are reserved
 * (KINU-N028): an agent-writable file must not shadow shipped doctrine.
 */

import { parseSkillFile } from './parse';
import type { ParsedSkill } from './types';

const AUDIT_IMPLEMENTATION_SRC = `---
name: audit-implementation
description: Multi-head audit of your own recent implementation — correctness, security, ergonomics.
allowed-tools:
  - agents
  - memory
keywords: [audit, review, verify, double-check, audit-this, validate-implementation]
auto_activate: false
---

# Audit your implementation

You just shipped something — code, a refactor, a design — and want a
second opinion using the same search you use to explore problems. This
skill runs that audit.

## Procedure

1. Restate what you implemented in two or three sentences: the change,
   the user-facing effect, the files touched.

2. Call \`agents({ action: "swarm", preset: "ideate", branches: 4, task: <the whole audit brief> })\`.
   An audit wants distinct findings rather than a ranked winner, which is what
   \`ideate\` returns; the nodes write their own angles from \`task\`, so name the
   angles you want covered IN the task rather than as per-node briefs:

   - **correctness** — does the implementation match the stated
     intent? Bugs, missing edge cases, unhandled errors, broken
     invariants? Walk every changed function.
   - **security** — threat-model anything that crosses a trust boundary
     in the change (user input, external API responses, file paths,
     shell args, deserialized payloads). Name attacks, then check
     whether the change prevents them.
   - **ergonomics / UX** — does the change leave the user with an
     interface that's discoverable and hard to misuse? For backend
     work: is the error path as good as the happy path? Does logging
     surface what the operator needs?
   - **simplicity** (optional, fourth angle) — is there code that doesn't
     earn its keep? Parallel paths? Compatibility shims? Apply the
     deletion test: would removing this and inlining the callsites
     produce clearer code?

3. Each node reports as evidence + a graded finding (P0–P3 or none-found), and
   the settled set comes back unranked. Synthesise it yourself into:

   - the top three findings ranked by severity
   - a one-line "ship / fix-first / abort" verdict
   - the smallest concrete change list that addresses every P0 + P1

4. If any P0 surfaces, do not claim the work is done — fix it before
   the next step. If everything is P2 or below, note them and proceed.

## Output

Reply with the synthesised report. Do not produce additional prose
beyond the findings + verdict + fix-list. The user wants the audit, not
a recap of what you implemented.
`;

const SLATES_SRC = `---
name: slates
description: Build a slate — a small live app with a server class and a React client — for a dashboard, a form, a control panel, a choice card or any interface a user asks for. Read this before writing one.
keywords: [slate, slates, dashboard, interface, widget, control panel, form, card, live view]
auto_activate: true
---

# Slates

A slate is a small application that lives in this workspace: a server class with its own storage, a React client in a sandboxed iframe, and an RPC link between them. Users rarely ask for "a slate". They ask for a tracker, a dashboard, a picker, a form, a live view over workspace data. Each of those is a slate.

A slate is a directory \`/home/user/slates/<id>/\` with a \`package.json\`:

\`\`\`json
{ "main": "server.ts", "browser": "client.tsx",
  "slate": { "title": "Deploy checklist", "bindings": { "agent": { "kind": "agent" } }, "inline": { "height": 320 } } }
\`\`\`

\`main\` exports the server class. \`browser\` exports the React component. You may put both in one \`slate.tsx\`: point \`main\` and \`browser\` at the same file. The build splits it, so keep server code out of the component and React out of the class.

## The class is the API

\`server.ts\` exports a class named \`Slate\` that extends \`SlateObject\` from \`kinu:slate\`. Every public method on it is callable from the client. There is no fetch handler to write and no routes to declare.

\`\`\`ts
import { SlateObject } from "kinu:slate";

export class Slate extends SlateObject {
  async add(text: string) {
    const items = (await this.storage.get("items")) ?? [];
    items.push({ text, done: false });
    await this.storage.put("items", items);
    return items;
  }
  async list() { return (await this.storage.get("items")) ?? []; }
}
\`\`\`

Methods whose names start with \`_\`, the constructor, \`fetch\`, and anything set on the instance (\`this.x = ...\`) are never reachable over RPC. Arguments and results are JSON values, plus functions passed by reference. An error thrown in a method reaches the caller as an error.

State lives in two places:

- \`this.storage\` is a key-value store: \`get(key)\`, \`put(key, value)\`, \`delete(key)\`, \`list({ prefix?, limit? })\` returns \`[key, value]\` pairs sorted by key. It lives in the workspace's own database, so it persists today across code edits, restarts and eviction. Use it for anything the user expects to keep.
- \`this.sql\` is the slate's own SQLite, the Durable Object \`SqlStorage\` API: \`this.sql.exec("SELECT ...", ...params).toArray()\`. It persists across code edits, restarts and eviction: the slate is a durable Nimbus application and keeps its facet until you remove the slate. Use it for tables, joins and caches.

Memory on the class (\`this.count = 0\`) is a cache, nothing more.

Define \`fetch(request)\` on the class only when the slate must answer plain HTTP on a path of its own, for a download or a static asset. The page, the client bundle and the RPC route are served for you.

## The client

\`client.tsx\` exports a React component as its default export. Kinu provides React 19: import from \`react\`, \`react-dom/client\` and \`react/jsx-runtime\` as usual; do not install them. The component is mounted for you.

\`\`\`tsx
import { useEffect, useState } from "react";
import { slate } from "kinu:slate";

export default function App() {
  const [items, setItems] = useState<{ text: string; done: boolean }[]>([]);
  useEffect(() => { void slate.list().then(setItems); }, []);
  return (
    <ul>{items.map((item, i) => <li key={i}>{item.text}</li>)}
      <li><button onClick={() => slate.add("new").then(setItems)}>Add</button></li>
    </ul>
  );
}
\`\`\`

\`slate\` is a Cap'n Web stub of your server class: \`slate.method(...args)\` calls the same-named method and returns its promise. Cap'n Web is bidirectional: pass a function as an argument and the server receives a stub it can call back. That is how you push updates:

\`\`\`ts
// server
watchers = new Set<(items: unknown) => void>();
async subscribe(callback: (items: unknown) => void) {
  const held = callback.dup();          // the argument stub is disposed when this call returns; dup() keeps it
  this.watchers.add(held);
  held.onRpcBroken(() => this.watchers.delete(held));
  held(await this.list());
}
// client
useEffect(() => { void slate.subscribe(setItems); }, []);
\`\`\`

Broadcast from any method by calling every watcher. The client reconnects when the socket drops; subscribe again in that case.

Also from \`kinu:slate\`: \`useSlate()\` returns the stub; \`useHostContext()\` returns \`{ theme: "dark" | "light", styles: { variables }, containerDimensions: { width, height }, display: "inline" | "pane" }\`. Kinu's colour tokens are set on \`:root\` before your component mounts (\`var(--c-bg)\`, \`var(--c-text)\`, \`var(--c-accent)\`, \`var(--c-border)\`, \`var(--c-surface)\`, ...), so a slate looks native in both themes with no CSS of its own. \`resize(height)\` asks the chat card for a height when the automatic measurement is wrong.

Neither side reaches the network. The server reaches the world only through bindings.

## Bindings

A binding is a capability of YOURS handed to the slate under a name in \`slate.bindings\`; the server calls it as \`this.env.NAME.member(...)\`. Each call runs with your reach at that moment, gated as your own call would be. Call bindings from inside methods: a binding called from the constructor or from module top level is refused, because there is no request to run it under. \`this.storage\` has no such rule.

- \`{ "kind": "agent" }\` — \`env.agent.send({ text, data? })\` puts a message in your inbox as an event of kind \`slate\`. This is the one way a slate reaches you; use it when a user acts and you should react.
- \`{ "kind": "ai", "tier"?: "<tier>" }\` — \`env.ai.run({ prompt, system?, tier? })\` runs one model call through your catalog and tiers and answers \`{ text, model, tier, usage }\`. A binding that declares a tier is pinned to it.
- \`{ "kind": "namespace", "namespace": "workspace", "paths": ["/home/user/data"] }\` — \`readFile\`, \`writeFile\`, \`editFile\`, \`readdir\`, \`exists\` under those prefixes only. Without \`paths\`, the whole namespace with all its members.
- \`{ "kind": "memory" | "tasks" | "web" }\`, \`{ "kind": "tool", "name": "file" }\`, \`{ "kind": "mcp", "server": "..." }\`, \`{ "kind": "rpc", "methods": [...] }\` for read models, \`{ "kind": "app", "id": "<other slate>" }\` to call another slate's methods.

A slate cannot bind \`agents\` or \`eval\`; it never delegates or steers you.

## A choice card in the chat

Write \`slate://<id>\` on its own line in your reply and the chat renders that slate inline at \`slate.inline.height\` pixels (default 320, at most 720); it grows to fit. A card that asks the user something:

\`\`\`ts
// server.ts
export class Slate extends SlateObject {
  async options() { return (await this.storage.get("options")) ?? []; }
  async choose(option: string) {
    await this.storage.put("chosen", option);
    await this.env.agent.send({ text: \`The user chose \${option}.\`, data: { option } });
  }
}
// client.tsx
export default function App() {
  const [options, setOptions] = useState<string[]>([]);
  useEffect(() => { void slate.options().then(setOptions); }, []);
  return <div>{options.map((o) => <button key={o} onClick={() => slate.choose(o)}>{o}</button>)}</div>;
}
\`\`\`

Seed the options with \`workspace.slate({ op: "call", id, method: "seed", args: [[...]] })\` (a \`seed(options)\` method that stores them), reply with the \`slate://<id>\` line, and the user's click arrives as a \`slate\` event in your next step.

## Working with a slate

- \`workspace.slate({ op: "preview", id })\` compiles and boots it and returns the URL; the chat and the work surface load the same URL. The URL is durable: it is the same on every launch and keeps working after eviction. Compile errors come back as \`bad_input\` with the file and line: fix and preview again. Edits reload the running slate; \`this.storage\` and \`this.sql\` keep their data across the reload.
- \`workspace.slate({ op: "remove", id })\` ends a slate: its process, its URL, its \`this.sql\` and its files. Committed versions stay.
- \`workspace.slate({ op: "call", id, method, args })\` calls a method yourself, the way the client does.
- \`commit\` freezes the source as a version, \`fork\` copies one, \`restore\` puts a version's source back.
- Make the UI usable on a phone: one column, large touch targets. Never \`alert()\` or \`confirm()\`; the sandbox blocks them.
- Do not import \`RpcTarget\`; pass functions, not classes.
`;

function parseBuiltin(src: string): ParsedSkill {
  const r = parseSkillFile(src, 'builtin');

  if (!r.ok) throw new Error(`built-in skill failed to parse: ${r.error}`);

  return r.skill;
}

export const BUILTIN_SKILLS: ReadonlyArray<ParsedSkill> = Object.freeze([
  parseBuiltin(AUDIT_IMPLEMENTATION_SRC),
  parseBuiltin(SLATES_SRC),
]);
