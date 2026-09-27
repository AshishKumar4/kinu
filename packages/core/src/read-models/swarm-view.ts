/** The swarm explorer's view model: only the web client reads it, so the Worker loads none of it. */
export {
  swarmResolutionOf, swarmAxisRows, fanInArity, fanInVertices, nodeRationales,
  runRefusal, runLiveness, formatEvidenceValue,
  type SwarmAxis, type SwarmAxisRow, type SwarmResolution, type RunRefusal,
  type RunLevel, type RunLiveness,
} from './swarm-resolution';

export {
  scoreBand,
  type ExplorerSelection,
  cleanNodeLabel,
  clipToWidth,
  isCompeted,
  principalVariation,
  ancestorIds,
  findForkNode,
  terminalForkNode,
  treeStats,
  maxVisits,
  subtreeCount,
  losingBranchIds,
  NODE_R_MAX,
  NODE_R_UNSCORED,
  nodeRadius,
  linkWidth,
  LABEL_MIN_SCALE,
  viewNoteFor,
} from './swarm-tree-model';
