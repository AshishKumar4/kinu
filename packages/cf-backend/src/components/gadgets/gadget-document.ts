/**
 * The gadget iframe's document — the static half of the sandbox.
 *
 * The posture is the workshop reference's, verbatim: a srcdoc document whose
 * Content-Security-Policy leaves the client no way out (no network, no
 * frames, no plugins, no forms, scripts and styles from data: URLs only), an
 * iframe sandbox of scripts plus popups, the client module embedded as a
 * data: URL script, and Cap'n Web (npm `capnweb`, MIT) embedded as a base64
 * data: import the client reaches its host through.
 *
 * The iframe talks back over exactly one channel: it opens a MessageChannel
 * and posts `"handshake"` with one port to `window.parent`, and the bridge
 * (gadget-bridge.ts) is the only reader. The client names a method on the
 * `gadget` stub the prefix hands it; the bridge forwards it as a workspace
 * `gadgetCall`. There is deliberately no Escape forwarding: the reference
 * uses it to leave fullscreen gadget mode, which this surface does not have.
 */

// The reference writes `import CAPNWEB_BUNDLE from "capnweb?raw"`, the form
// Vite documents, and this repository's `import/default` rule rejects it: the
// linter resolves the specifier without its `?raw` suffix and finds no default
// export on the package. A dynamic import is not resolved that way, and the
// `?raw` module still answers the bundle text as its default.
const capnwebRaw = await import("capnweb?raw");
const CAPNWEB_BUNDLE: string = capnwebRaw.default;

/** The iframe sandbox token: scripts run, popups may escape, nothing else. */
export const GADGET_IFRAME_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox";

/** The srcdoc document's Content-Security-Policy. The client reaches the
 *  network, the host document, and everything else through nothing at all:
 *  `connect-src 'none'` refuses fetch and WebSocket alike, and the sandbox
 *  above keeps the document at the opaque `null` origin.
 *  `scripts/gadget-sandbox-ux.test.ts` asserts the mounted document carries
 *  this policy verbatim. */
const GADGET_DOCUMENT_CSP =
  "default-src 'none'; frame-src 'none'; script-src data: 'unsafe-inline'; style-src data: 'unsafe-inline'; img-src data:; media-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none';";

// btoa() below requires this to stay ASCII; capnweb's build enforces ASCII-only dist bundles.
const CAPNWEB_BUNDLE_ANNOTATED = `//# sourceURL=jsrpc.js\n${CAPNWEB_BUNDLE}`;

// The client cannot import Cap'n Web from anywhere — its document may load
// from data: URLs only — so the library rides in as a base64 data: import,
// and the client module itself rides as a URL-encoded data: script. One
// module, two nestings: the inner import is base64 (no double-escaping) and
// the outer script URL-encodes the whole text.
const INJECTED_CODE_PREFIX = encodeURIComponent(String.raw`//# sourceURL=client.js
import { RpcTarget, RpcStub, newMessagePortRpcSession } from "data:text/javascript;charset=utf-8;base64,${btoa(CAPNWEB_BUNDLE_ANNOTATED)}";

let gadget;  // RPC stub to the gadget's server side, through the parent frame.
{
  let {port1, port2} = new MessageChannel();
  window.parent.postMessage("handshake", "*", [port2]);
  gadget = newMessagePortRpcSession(port1);
}

// Monkey-patch console to forward logs to the parent frame.
for (let level of ['debug', 'info', 'log', 'warn', 'error']) {
  let original = console[level];
  console[level] = (...args) => {
    original.apply(console, args);
    try {
      let message = args.map(arg => {
        if (typeof arg === 'string') return arg;
        try { return JSON.stringify(arg); }
        catch { return String(arg); }
      });
      window.parent.postMessage({ type: 'console', level, message }, '*');
    } catch {};
  };
}

// Allow user-activated target=_blank links, but block programmatic popups.
const blockedOpen = () => {
  console.error('window.open() is disabled in Gadget UIs. Use a link with target="_blank" instead.');
  return null;
};
window.open = blockedOpen;
globalThis.open = blockedOpen;
try {
  Window.prototype.open = blockedOpen;
} catch {}

window.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }

  const anchor = event.target.closest('a[href][target]');
  if (!anchor || anchor.target.toLowerCase() !== '_blank') {
    return;
  }

  const rel = new Set((anchor.getAttribute('rel') || '').split(/\s+/).filter(Boolean));
  rel.add('noopener');
  anchor.setAttribute('rel', Array.from(rel).join(' '));
}, true);

// Capture unhandled exceptions and promise rejections.
window.addEventListener('error', (event) => {
  window.parent.postMessage({
    type: 'console',
    level: 'error',
    message: ['Uncaught', event.error?.stack || event.message],
  }, '*');
});
window.addEventListener('unhandledrejection', (event) => {
  let reason = event.reason;
  window.parent.postMessage({
    type: 'console',
    level: 'error',
    message: ['Unhandled promise rejection:', reason?.stack || String(reason)],
  }, '*');
});

`);

/** Build the srcdoc for a gadget client. The style element carries the
 *  gadget's own CSS, if it published any; a `</` sequence in it is escaped so
 *  agent-authored text can never close the element early. */
export function gadgetDocument({ js, css }: { js: string; css: string | null }): string {
  const style = css === null ? "" : `\n  <style>${css.replace(/<\//g, "<\\/")}</style>`;
  return `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="${GADGET_DOCUMENT_CSP}">
</head>
<body>${style}
    <script type="module" src="data:text/javascript;charset=utf-8,${INJECTED_CODE_PREFIX}${encodeURIComponent(js)}"></script>
</body>
</html>`;
}
