/**
 * Fixture for `scripts/tracing-gate.ts`: the real `createWorkersTracer` in workerd, reporting each span's `isTraced`.
 * Imports the shipped tracer because the defect lives in its wiring to the runtime; nested spans are the shape every Kinu path uses.
 */
import { createWorkersTracer } from '../../src/obs/cf-tracer';

interface Observation {
  readonly name: string;
  readonly isTraced: boolean;
}

export default {
  fetch(): Response {
    const tracer = createWorkersTracer();
    const observed: Observation[] = [];
    tracer.span('gate.outer', { isolateGen: 1, selfPath: 'RootProbe:root' }, (outer) => {
      outer.setAttribute('gate.probe', 'outer');
      observed.push({ name: 'gate.outer', isTraced: outer.isTraced });
      tracer.span('gate.inner', { isolateGen: 1, selfPath: 'RootProbe:root/LeafProbe:a' }, (inner) => {
        observed.push({ name: 'gate.inner', isTraced: inner.isTraced });
        // A non-thrown failure, so `fail` has a real call site under a real runtime.
        inner.fail(new Error('probe: a tolerated failure, recorded not swallowed'));
      });
    });

    return Response.json(observed);
  },
};
