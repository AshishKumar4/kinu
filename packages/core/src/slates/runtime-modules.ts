/** Authored-facing `kinu:slate` modules: `server.js` under `/usr/lib/kinu/slate/`, `client.js` at `/__kinu/slate.js`. */

import { SLATE_HOST_CONTEXT_MESSAGE, SLATE_QUERY_PARAM, SLATE_SIZE_CHANGED_MESSAGE } from './host-context';

/** The prototype marker lets the runner verify the contract without importing this module twice. Client-only names throw on the server. */
export const SLATE_SERVER_MODULE = `export class SlateObject {
  #context;
  #bindings;
  constructor(ctx, env) {
    this.#context = ctx;
    this.#bindings = env;
  }
  get env() { return this.#bindings; }
  get sql() { return this.#context.storage.sql; }
  get storage() { return this.#context.kv; }
  get ctx() { return { waitUntil: this.#context.waitUntil }; }
}
SlateObject.prototype[Symbol.for("kinu.slate")] = true;
function clientOnly(name) {
  return function () {
    throw new Error(name + " is a slate client API; it is not available inside the server module");
  };
}
export const slate = clientOnly("slate");
export const useSlate = clientOnly("useSlate");
export const useHostContext = clientOnly("useHostContext");
export const resize = clientOnly("resize");
export const mount = clientOnly("mount");
export const fit = clientOnly("fit");
export const workspace = clientOnly("workspace");
`;

/** React and capnweb resolve through the same import map, so this module keeps the singletons shared with the host frame. */
export const SLATE_CLIENT_MODULE = `import { createElement, useMemo, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

function defaultTheme() {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const DEFAULT_CONTEXT = { theme: defaultTheme(), styles: { variables: {} }, containerDimensions: {}, display: "pane" };

function parseContext() {
  const raw = new URLSearchParams(window.location.search).get("${SLATE_QUERY_PARAM}");
  if (raw === null) return DEFAULT_CONTEXT;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? { ...DEFAULT_CONTEXT, ...parsed } : DEFAULT_CONTEXT;
  } catch {
    return DEFAULT_CONTEXT;
  }
}

let context = parseContext();
const listeners = new Set();
// Set once \`fit\` has started measuring; until then the page has not asked to be sized.
let fitted = false;

const hostOrigin = typeof context.origin === "string" && URL.canParse(context.origin)
  && new URL(context.origin).origin === context.origin ? context.origin : null;

window.addEventListener("message", (event) => {
  if (hostOrigin === null || event.source !== window.parent || event.origin !== hostOrigin) return;
  const message = event.data;
  if (message === null || typeof message !== "object" || message.kinu !== "${SLATE_HOST_CONTEXT_MESSAGE}") return;
  context = message.context;
  applyContext();
  for (const listener of listeners) listener();
  // Answered with the height, so a host waiting to show the frame at its size hears it once the frame has loaded.
  if (fitted) resize(documentHeight());
});


function applyContext() {
  const root = document.documentElement;
  // The frame is transparent over the chat; a scheme other than the host's paints an opaque canvas.
  if (context && context.theme !== undefined) { root.dataset.mode = context.theme; root.style.colorScheme = context.theme; }
  if (context && typeof context.display === "string") root.dataset.display = context.display;
  const variables = context && context.styles ? context.styles.variables : undefined;
  if (variables && typeof variables === "object") {
    for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, String(value));
  }
}

/** The document's own height, never the frame's: a document fills at least its frame, so its scroll height could only
 *  ever grow. */
function documentHeight() {
  return Math.ceil(document.documentElement.getBoundingClientRect().height);
}

// Every call goes through the slate's room, which admits it as this page's person and runs it with what they hold:
// in the slate's shared server, or confined when it needs someone's connection.
async function roomCall(path, body) {
  const response = await fetch(path, {
    method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const answer = await response.json();
  if (!answer.ok) throw new Error(answer.reason + ": " + answer.error);
  return answer.value;
}

/** A call whose answer only its page may show answers a part: render it with <Part value={...} />. */
function outcome(value) {
  return value && typeof value === "object" && "part" in value ? { kinuPart: value.part.frame } : value.value;
}

export const slate = new Proxy(Object.create(null), {
  get(_target, member) {
    if (typeof member !== "string" || member === "then") return undefined;
    return async (...args) => outcome(await roomCall("/__kinu/call", { method: member, args }));
  },
});

/** A method's answer as a part, always: its own frame, which shows each person only what they may see. */
export async function part(method, ...args) {
  return outcome(await roomCall("/__kinu/part", { method, args }));
}

/** A value, or the frame of a part a call answered. */
export function Part({ value, style }) {
  if (value && typeof value === "object" && typeof value.kinuPart === "string") {
    return createElement("iframe", { src: value.kinuPart, style: { border: 0, width: "100%", ...style }, sandbox: "allow-scripts allow-same-origin allow-popups" });
  }
  return createElement("span", null, value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value));
}

/** A slate's one surface, as a program reaches its namespaces: workspace.memory.search(query),
 *  workspace.mcp.github.list_issues({ state: "open" }), workspace.agent.send({ text }). The workspace executor's own
 *  members sit at the top too, so workspace.readFile(path) reads as it does in a program. */
function surface(path) {
  return new Proxy(function () {}, {
    apply(_fn, _self, args) { return roomCall("/__kinu/workspace", { path, args }).then(outcome); },
    get(_fn, name) {
      if (typeof name !== "string" || name === "then") return undefined;
      return surface([...path, name]);
    },
  });
}

export const workspace = surface([]);

export function useSlate() {
  return useMemo(() => slate, []);
}

export function useHostContext() {
  return useSyncExternalStore(
    (notify) => { listeners.add(notify); return () => { listeners.delete(notify); }; },
    () => context,
  );
}

export function resize(height) {
  if (window.parent === window || hostOrigin === null) return;
  window.parent.postMessage({ kinu: "${SLATE_SIZE_CHANGED_MESSAGE}", height }, hostOrigin);
}

let resizeQueued = false;

/** The host's theme now and as it changes, and the page's height as it grows and shrinks: what every slate page needs of
 *  its host. */
export function fit() {
  applyContext();
  if (fitted) return;
  fitted = true;
  new ResizeObserver(() => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      resize(documentHeight());
    });
  }).observe(document.documentElement);
}

export function mount(App) {
  let element = document.getElementById("root");
  if (element === null) {
    element = document.createElement("div");
    element.id = "root";
    document.body.appendChild(element);
  }
  fit();
  createRoot(element).render(createElement(App));
}

function serverOnly(name) {
  return function () {
    throw new Error(name + " is a slate server API; it is not available inside the client bundle");
  };
}
export const SlateObject = serverOnly("SlateObject");
`;
