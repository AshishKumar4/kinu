/**
 * The authored-facing runtime modules. `server.js` is the `kinu:slate`
 * specifier's real module on the server side — every slate's VFS holds it
 * under `/usr/lib/kinu/slate/`, kernel-owned — and `client.js` is the module
 * the browser's import map serves at `/__kinu/slate.js`.
 */

/**
 * `server.js` — `kinu:slate` on the server. `SlateObject` is the class every
 * authored `main` extends; the marker on its prototype is how the runner
 * verifies the contract without importing this module a second time
 * (application.js bundles its own copy).
 *
 * The client-only names exist so single-file sources can import them and the
 * server build still links: called on the server, they throw.
 */
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

/** `client.js` — `kinu:slate` in the browser bundle, served verbatim at
 *  `/__kinu/slate.js` through the shell's import map. React and capnweb
 *  resolve there too, so this module keeps the singletons the authored
 *  component and the host frame share. */
export const SLATE_CLIENT_MODULE = `import { createElement, useMemo, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { newWebSocketRpcSession } from "capnweb";

function defaultTheme() {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const DEFAULT_CONTEXT = { theme: defaultTheme(), styles: { variables: {} }, containerDimensions: {}, display: "pane" };

function parseContext() {
  const raw = new URLSearchParams(window.location.search).get("kinu");
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
  if (message === null || typeof message !== "object" || message.kinu !== "host-context") return;
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
  window.parent.postMessage({ kinu: "size-changed", height }, hostOrigin);
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
