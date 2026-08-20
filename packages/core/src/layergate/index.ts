/**
 * Layer gate — the deterministic, no-LLM regression gate over the turn
 * pipeline.
 *
 * Kinu can rewrite its own agentic loop, and until now it validated a
 * change two ways: four structural gates, and an LLM judge. Nothing in
 * between. A real behavioural regression therefore showed up, if at all, as a
 * movement of a point or two in an aggregate that a single user's traffic can
 * never resolve. Decomposing the pipeline into dependency-closed layers and
 * scoring each one separately is what supplies the resolution traffic cannot:
 * the same regression that barely registers in aggregate takes its own layer's
 * slice down by tens of points.
 *
 * Complements `../eval` (the LLM-judged corpus): this tier needs no model, no
 * network and no clock, so it can run on every change.
 */

export { LAYERS, type Layer, type Probe } from './layers';
export {
  createPipelineSubjects,
  SUBJECT_SOURCE,
  type PipelineSubjects,
  type SubjectName,
} from './subjects';
export {
  lockBaseline,
  observePipeline,
  renderLayerGateReport,
  runLayerGate,
  scoreAgainstBaseline,
  type Baseline,
  type LayerGateReport,
  type LayerScore,
} from './gate';
export {
  FAULTS,
  LOCALIZATION_OTHER_MAX_PP,
  LOCALIZATION_OWN_MIN_PP,
  renderFaultMatrix,
  runFaultMatrix,
  type Fault,
  type FaultImpact,
} from './faults';
export { LOCKED_BASELINE } from './baseline';
