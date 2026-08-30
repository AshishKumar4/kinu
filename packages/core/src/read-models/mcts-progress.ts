export interface MctsProgressOrder {
  readonly isolateGen: number;
  readonly pushSeq: number;
}

export interface MctsProgressState<Tree> {
  readonly actorKey: string;
  readonly trees: ReadonlyMap<string, Tree>;
  readonly lastPush: ReadonlyMap<string, MctsProgressOrder>;
}

export interface MctsProgressStamp {
  readonly rootId: string;
  readonly isolateGen: number;
  readonly pushSeq: number;
}

export function createMctsProgressState<Tree>(actorKey: string): MctsProgressState<Tree> {
  return { actorKey, trees: new Map(), lastPush: new Map() };
}
export function activateMctsProgressActor<Tree>(
  state: MctsProgressState<Tree>,
  actorKey: string,
): MctsProgressState<Tree> {
  return state.actorKey === actorKey ? state : createMctsProgressState(actorKey);
}

/** Admit one parsed socket update after its shared read model built the tree. */
export function applyMctsProgress<Tree>(
  state: MctsProgressState<Tree>,
  actorKey: string,
  progress: MctsProgressStamp,
  tree: Tree | null,
): MctsProgressState<Tree> {
  if (actorKey !== state.actorKey) return state;
  const previous = state.lastPush.get(progress.rootId);
  if (
    previous !== undefined
    && (
      progress.isolateGen < previous.isolateGen
      || (progress.isolateGen === previous.isolateGen && progress.pushSeq <= previous.pushSeq)
    )
  ) return state;
  if (tree === null) return state;
  const trees = new Map(state.trees);
  trees.set(progress.rootId, tree);
  const lastPush = new Map(state.lastPush);
  lastPush.set(progress.rootId, { isolateGen: progress.isolateGen, pushSeq: progress.pushSeq });
  return { actorKey, trees, lastPush };
}
