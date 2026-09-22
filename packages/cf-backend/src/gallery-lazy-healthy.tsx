/**
 * Healthy split route of the `lazyroute` gallery frame. Must stay its own chunk: an inline loader resolves in a
 * microtask and never exercises the fallback-commit-then-remount path a real `import()` does.
 */
import type { ReactElement } from "react";

export default function LazyHealthyRoute(): ReactElement {
  return <p data-lazy-healthy className="text-sm p-text-2">The other split route rendered.</p>;
}
