// Type stubs for CraftedTool — extracted from @cf-utils/agent-utils/codemode/builder

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
