// Deterministic, no-LLM regression gate scoring the turn pipeline per layer; complements `../eval`.

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
