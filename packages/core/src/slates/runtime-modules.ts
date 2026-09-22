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
`;

/** React and capnweb resolve through the same import map, so this module keeps the singletons shared with the host frame. */
export const SLATE_CLIENT_MODULE = `import { createElement, useMemo, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { newWebSocketRpcSession } from "capnweb";

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

// The host names its own origin inside the context it composes; the referrer
// is the fallback for older hosts. When neither says who the parent is,
// outbound posts do not run and inbound context messages still apply.
let hostOrigin = typeof context.origin === "string" ? context.origin : null;
if (hostOrigin === null) {
  try { hostOrigin = new URL(document.referrer).origin; } catch { /* stays null */ }
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  if (hostOrigin !== null && event.origin !== hostOrigin) return;
  const message = event.data;
  if (message === null || typeof message !== "object" || message.kinu !== "${SLATE_HOST_CONTEXT_MESSAGE}") return;
  context = message.context;
  applyContext();
  for (const listener of listeners) listener();
});

function applyContext() {
  const root = document.documentElement;
  if (context && context.theme !== undefined) root.dataset.mode = context.theme;
  const variables = context && context.styles ? context.styles.variables : undefined;
  if (variables && typeof variables === "object") {
    for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, String(value));
  }
}

// One session for the tab's life: per-call sockets would kill callback stubs
// passed across a call, and every call would pay the handshake. A broken one
// is replaced on the next call, never reasoned about.
let live = null;
function session() {
  if (live === null) {
    const socket = new WebSocket(new URL("/__rpc", window.location.href));
    const stub = newWebSocketRpcSession(socket);
    stub.onRpcBroken(() => { if (live !== null && live.stub === stub) live = null; });
    live = { stub };
  }
  return live.stub;
}

export const slate = new Proxy(Object.create(null), {
  get(_target, member) {
    if (typeof member !== "string" || member === "then") return undefined;
    return (...args) => session()[member](...args);
  },
});

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

export function mount(App) {
  let element = document.getElementById("root");
  if (element === null) {
    element = document.createElement("div");
    element.id = "root";
    document.body.appendChild(element);
  }
  applyContext();
  new ResizeObserver(() => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      resize(document.documentElement.scrollHeight);
    });
  }).observe(document.documentElement);
  createRoot(element).render(createElement(App));
}

function serverOnly(name) {
  return function () {
    throw new Error(name + " is a slate server API; it is not available inside the client bundle");
  };
}
export const SlateObject = serverOnly("SlateObject");
`;
