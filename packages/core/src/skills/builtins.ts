/**
 * Built-in skills, served read-only under `/skills`. Their names are reserved
 * (KINU-N028): an agent-writable file must not shadow shipped doctrine.
 */

import { Result } from 'effect';
import { parseSkillFile } from './parse';
import type { ParsedSkill } from './types';

const AUDIT_IMPLEMENTATION_SRC = `---
name: audit-implementation
description: Multi-head audit of your own recent implementation: correctness, security, ergonomics.
allowed-tools:
  - agents
  - memory
---

# Audit your implementation

You just shipped something (code, a refactor, a design) and want a
second opinion using the same search you use to explore problems. This
skill runs that audit.

## Procedure

1. Restate what you implemented in two or three sentences: the change,
   the user-facing effect, the files touched.

2. Call \`agents({ op: "swarm", preset: "ideate", branches: 4, task: <the whole audit brief> })\`.
   An audit wants distinct findings rather than a ranked winner, which is what
   \`ideate\` returns; the nodes write their own angles from \`task\`, so name the
   angles you want covered IN the task rather than as per-node briefs:

   - **correctness**: does the implementation match the stated
     intent? Bugs, missing edge cases, unhandled errors, broken
     invariants? Walk every changed function.
   - **security**: threat-model anything that crosses a trust boundary
     in the change (user input, external API responses, file paths,
     shell args, deserialized payloads). Name attacks, then check
     whether the change prevents them.
   - **ergonomics / UX**: does the change leave the user with an
     interface that's discoverable and hard to misuse? For backend
     work: is the error path as good as the happy path? Does logging
     surface what the operator needs?
   - **simplicity** (optional, fourth angle): is there code that doesn't
     earn its keep? Parallel paths? Compatibility shims? Apply the
     deletion test: would removing this and inlining the callsites
     produce clearer code?

3. Each node reports as evidence + a graded finding (P0 to P3 or none-found), and
   the settled set comes back unranked. Synthesise it yourself into:

   - the top three findings ranked by severity
   - a one-line "ship / fix-first / abort" verdict
   - the smallest concrete change list that addresses every P0 + P1

4. If any P0 surfaces, do not claim the work is done; fix it before
   the next step. If everything is P2 or below, note them and proceed.

## Output

Reply with the synthesised report. Do not produce additional prose
beyond the findings + verdict + fix-list. The user wants the audit, not
a recap of what you implemented.
`;

const SLATES_SRC = `---
name: slates
description: Build any interface the user asks for, an app, game, dashboard, chart, form, picker or card, as a slate. Read this before writing one.
---

# Slates

A slate is an interface the user sees in the chat: a page you write into your answer, or a small application in \`/slates/<id>/\` with a server class and storage of its own.

## Build the real one, then check it

Write the slate itself: the \`<slate-ui>\` block in your answer, or the slate's files. Never build a prototype, scratch page or test app first. Then check the finished slate as it renders: for a slate with files, \`await workspace.slates.<id>.$preview()\` answers its URL and \`web.screenshot({ url })\` shows it to you; fix what you see in the slate itself. A page in your answer is drawn in the chat once your answer is stored.

## It looks like the chat

A slate is drawn in the app's theme already, dark and light: its text, font, colours, buttons and inputs. Write plain HTML or JSX and add layout only. Set no page background, text colour or font. Where you need a colour, use the theme's: \`var(--c-text)\`, \`--c-text-2\`, \`--c-text-3\`, \`--c-accent\`, \`--c-border\`, \`--c-surface\`, \`--c-elevated\`, \`--c-success\`, \`--c-warning\`, \`--c-danger\`.

In the chat a slate is as tall as its content, like the text around it. Never size to the viewport (no \`100vh\`, no \`height: 100%\` on \`html\` or \`body\`) and add no scroller of your own. Make it work at a phone's width: one column, large touch targets. \`alert()\` and \`confirm()\` are blocked.

## A page in your answer

For a view with nothing to remember, write the page into your answer on lines of its own, never in a code fence:

<slate-ui name="funnel">
<title>Checkout funnel</title>
<p id="total"></p>
<button id="retry">Retry the import</button>
<script type="module">
  import { workspace } from "kinu:slate";
  document.getElementById("total").textContent = await workspace.readFile("/home/main/funnel.txt");
  document.getElementById("retry").onclick = () => workspace.agent.send({ text: "Retry the import." });
</script>
</slate-ui>

The chat draws it in place once your answer is stored, called by its \`<title>\`, and the user can keep it as a slate of the workspace. Give each block in an answer its own name. A page that must remember anything is a slate with files.

## A slate with files

\`\`\`json
{ "main": "server.ts", "browser": "client.tsx", "slate": { "title": "Deploy checklist" } }
\`\`\`

\`slate.title\` is what the user sees it called. \`browser\` is a React component, or an \`.html\` page written as a block's is. \`main\` exports a class named \`Slate\` extending \`SlateObject\` from \`kinu:slate\`; every public method is callable from the client, with JSON arguments and results, and functions passed by reference. Both may live in one \`slate.tsx\`; keep server code out of the component and React out of the class.

\`\`\`ts
// server.ts
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
// client.tsx: the default export is mounted for you; Kinu provides React 19.
import { useEffect, useState } from "react";
import { slate } from "kinu:slate";
export default function App() {
  const [items, setItems] = useState<{ text: string }[]>([]);
  useEffect(() => { void slate.list().then(setItems); }, []);
  return <ul>{items.map((item, i) => <li key={i}>{item.text}</li>)}<li><button onClick={() => slate.add("new").then(setItems)}>Add</button></li></ul>;
}
\`\`\`

\`this.storage\` is a key-value store (\`get\`, \`put\`, \`delete\`, \`list({ prefix?, limit? })\`) and \`this.sql\` the slate's own SQLite (\`this.sql.exec(query, ...params).toArray()\`); what either holds persists across code edits, restarts and eviction. Memory on the class is a cache. Methods named \`_x\`, the constructor and \`fetch\` are not callable; define \`fetch(request)\` only to serve a download of your own. To push updates, take a callback: \`subscribe(callback)\` keeps \`callback.dup()\` and calls it, and \`held.onRpcBroken(...)\` forgets it; the client subscribes again when its socket drops. \`useHostContext()\` answers \`{ theme, display }\`.

## workspace: your reach, as you

Every slate gets \`workspace\`, the namespaces your \`eval\` programs reach, called as you as of each call: \`this.env.workspace\` in the class, \`import { workspace } from "kinu:slate"\` in a page. Call it from inside methods, never at module top level or in the constructor.

- \`workspace.readFile(path)\`, \`workspace.memory.*\`, \`workspace.tasks.*\`, \`workspace.web.*\` and \`workspace.db.*\`, as a program calls them; \`workspace.ai.run({ prompt, system?, tier? })\` is one model call.
- \`workspace.mcp.<server>.<tool>(args)\`, \`workspace.tools.<name>(input)\`, \`workspace.reads.<model>()\` and \`workspace.slates.<id>.<method>(...args)\`.
- \`workspace.agent.send({ text, data? })\` puts a \`slate\` event in your inbox: the one way a slate reaches you, as when the user picks an option on a card.

A slate never delegates, steers you, makes tools or changes slates.

## Showing and keeping slates

The chat shows each slate your turn changed after your answer; write \`slate://<id>\` on its own line to show another. In \`eval\`, \`workspace.slates.<id>\` is the same stub the client gets, and its \`$\` members are its lifecycle:

- \`$preview()\` compiles and boots it and answers \`{ url, port, sized }\`; a compile error is \`bad_input\` naming the file and line. \`$methods()\` lists its methods. \`$remove()\` ends it: process, URL, data and files.
- \`$commit()\` freezes a version, \`$history(after?)\` lists them, \`$restore(version)\` puts one back, and \`workspace.slates.$fork(version)\` copies one into a new slate. \`workspace.slates.$list()\` answers every slate and why any failed to load. \`workspace.slates.$save(page)\` keeps an answer's page, \`<message id>/<name>\`, as a slate.
- Sharing is the workspace root's alone. \`$graph()\` lists what a slate has called; exercise it before you share. \`$share({ visibility: 'users' | 'public', approved: [{ slate, namespace, member }], fork? })\` makes a live share, \`$inspect(version, include?)\` and \`$publish(version, include?)\` a blueprint; \`workspace.slates.$shares()\`, \`$liveShares()\`, \`$viewerRequests(share)\` and \`$unshare(share)\` list and end them.
`;

function parseBuiltin(src: string): ParsedSkill {
  const r = parseSkillFile(src, 'builtin');

  if (Result.isFailure(r)) throw new Error(`built-in skill failed to parse: ${r.failure.error}`);

  return r.success;
}

const PARSED = [AUDIT_IMPLEMENTATION_SRC, SLATES_SRC].map((source) => ({ source, skill: parseBuiltin(source) }));

export const BUILTIN_SKILLS: ReadonlyArray<ParsedSkill> = Object.freeze(PARSED.map((entry) => entry.skill));

export const BUILTIN_SKILL_FILES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(PARSED.map((entry) => [entry.skill.name, entry.source])),
);
