export const SLATE_READ_MODELS = [
  'getAlignmentConvergence',
  'getExecutors',
  'getGepaRuns',
  'getHeadRuns',
  'getMctsTree',
  'getOutcomeCalibration',
  'getRunTimeline',
  'getToolDescriptions',
  'getWorkspaceSnapshot',
  'listBackgroundJobs',
  'listTriggers',
] as const;

export type SlateReadModel = (typeof SLATE_READ_MODELS)[number];
