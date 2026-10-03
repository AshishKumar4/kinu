export const SLATE_READ_MODELS = [
  'getExecutors',
  'getGepaRuns',
  'getHeadRuns',
  'getMctsTree',
  'getQuality',
  'getRunTimeline',
  'getToolDescriptions',
  'getWorkspaceSnapshot',
  'listBackgroundJobs',
  'listTriggers',
] as const;

export type SlateReadModel = (typeof SLATE_READ_MODELS)[number];
