/** `none` is the control: the facet restarts over the storage it kept. */
export type DeleteAllWipe = 'none' | 'deleteAll' | 'facet-then-deleteAll';

export interface DeleteAllMeasurement {
  readonly facetBefore: string[];
  readonly facetAfter: string[];
  readonly parentTables: number;
  readonly alarmAfter: number | null;
}
