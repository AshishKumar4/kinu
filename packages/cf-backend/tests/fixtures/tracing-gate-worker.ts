/**
 * Fixture for `scripts/tracing-gate.ts`. Runs the REAL `createWorkersTracer`
 * inside real workerd and reports what each span's `isTraced` actually said.
 *
 * It imports the shipped implementation rather than reimplementing it, because
 * the defect this gate exists to catch lives in the wiring between our tracer
 * and the runtime, and a reimplementation would route around exactly that.
 *
 * Nested on purpose: a child span opened inside a parent's callback is the shape
 * every instrumented Proteus path will use, and it is the shape whose recording
 * a local run CAN prove even though its nesting it cannot.
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
        // A failure that is NOT thrown — the case `fail` exists for. Exercised
        // here so the method has a real call site under a real runtime rather
        // than only in a unit test against the fake.
        inner.fail(new Error('probe: a tolerated failure, recorded not swallowed'));
      });
    });
    return Response.json(observed);
  },
};
