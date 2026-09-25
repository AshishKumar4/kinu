/** An oxc ESTree node, as far as a caller of this module reads it. */
export interface TsNode {
  readonly type: string;
}

export interface TsDeclaration {
  readonly node: TsNode;
  readonly members: ReadonlyMap<string, TsNode>;
}

export function tsDeclarations(path: string, source: string): ReadonlyMap<string, TsDeclaration>;

export function stringValues(node: TsNode | undefined): string[];
