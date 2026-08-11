// CraftedTool as agent-utils sees it. Structurally identical to core's
// (packages/core/src/types/craft.ts); core depends on this package, so the
// declaration cannot be shared the other way.

export interface CraftedTool {
  name: string;
  description: string;
  params: Record<string, string> | null;
  code: string;
  scope: "local" | "shared";
  createdAt: number;
  updatedAt: number;
}

export interface CraftedToolProvider {
  getAll(): CraftedTool[];
}
