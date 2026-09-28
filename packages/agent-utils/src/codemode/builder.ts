// Structural copy of core's CraftedTool; core depends on this package, so it cannot be shared the other way.

export interface CraftedTool {
  name: string;
  description: string;
  code: string;
  createdAt: number;
  updatedAt: number;
}

export interface CraftedToolProvider {
  getAll(): CraftedTool[];
}
