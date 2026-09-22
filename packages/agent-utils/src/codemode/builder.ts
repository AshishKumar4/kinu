// Structural copy of core's CraftedTool; core depends on this package, so it cannot be shared the other way.

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
