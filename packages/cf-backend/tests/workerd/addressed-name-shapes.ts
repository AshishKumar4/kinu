/** A destroyed workspace's owed alarm: the destroy, each delivery's answer (`retired` or a thrown chain), what is left. */
export interface AlarmAfterDestroy {
  readonly destroyed: string;
  readonly byId: string;
  readonly byName: string;
  readonly byIdOverTables: string;
  readonly left: { readonly starts: number; readonly identity: number; readonly actors: number };
}

/** What each entry answered after an id-addressed first entry: `served`, the owner id, the seed status, or a thrown chain. */
export interface AddressedAnswers {
  readonly supervisor: string;
  readonly claim: string;
  readonly seed: string;
}
