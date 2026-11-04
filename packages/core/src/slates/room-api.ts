/** A connection a slate needs of its visitor, as the Gallery shows it. Client-safe: valibot and nothing of the runtime. */
import * as v from 'valibot';

/** A connection as people know it: GitHub, an MCP server by its title, the workspace's own model. */
export const RoomServiceSchema = v.object({
  title: v.string(),
  kind: v.picklist(['github', 'mcp', 'ai', 'workspace'] as const),
});

export type RoomService = v.InferOutput<typeof RoomServiceSchema>;
