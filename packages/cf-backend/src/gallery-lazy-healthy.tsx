/**
 * The healthy split route of the `lazyroute` gallery frame, as its OWN chunk.
 *
 * It is a separate module on purpose: a loader that resolves in a microtask
 * never leaves the render that started it, so a fixture defined inline proved
 * nothing about a route whose chunk crosses the network. The deployed
 * `/deploy` page stayed on its Suspense fallback for good (2026-09-18) while
 * that inline fixture rendered, because React commits the fallback while a
 * real import is in flight and retries the mount from scratch afterwards. A
 * real `import()` here is what makes the gate see what production sees.
 */
import type { ReactElement } from "react";

export default function LazyHealthyRoute(): ReactElement {
  return <p data-lazy-healthy className="text-sm p-text-2">The other split route rendered.</p>;
}
