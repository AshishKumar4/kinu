/**
 * Client contracts for what a grant reaches and what a fork brings, as the share sheet and the part frame show them.
 * Client-safe: valibot and nothing of the runtime.
 *
 * Slates run as Nimbus apps in their owner's workspace (docs/SLATE-SHARING-NIMBUS.md). The policy model is
 * `lean/Kinu/SharingNimbus/Model.lean`; these presentation contracts are not evidence about host isolation or routing.
 *
 * Words: the host gives facts (a service's title, a tool's title, a scope, whether a call changes anything); the UI writes
 * the sentences around them.
 */
import * as v from 'valibot';

/** Who someone is to a room. People are named by email: an account id is derived from it (`accountIdFor`). */
const RoomPersonSchema = v.object({
  email: v.string(),
  /** Their display name, once they have opened the slate; null while only invited. */
  name: v.nullable(v.string()),
});

export type RoomPerson = v.InferOutput<typeof RoomPersonSchema>;

const ROOM_ROLES = ['edit', 'use'] as const;

/** What the owner gives someone they add: Edit changes the code with their own agent; Use uses the slate. */
const RoomRoleSchema = v.picklist(ROOM_ROLES);

export type RoomRole = v.InferOutput<typeof RoomRoleSchema>;

/** How this session holds the slate: as its owner, as someone the owner added, or through the link. */
const RoomAccessSchema = v.picklist(['owner', 'edit', 'use', 'link'] as const);

export type RoomAccess = v.InferOutput<typeof RoomAccessSchema>;

/** The sheet's three audiences: derived from the room's people and its link, and set in one call. */
const RoomAudienceSchema = v.picklist(['only-you', 'people', 'anyone'] as const);

export type RoomAudience = v.InferOutput<typeof RoomAudienceSchema>;

// ── What a grant reaches ────────────────────────────────────────────────────────────────────────────────────────

/** A connection as people know it: GitHub, an MCP server by its title, the workspace's own model. */
export const RoomServiceSchema = v.object({
  title: v.string(),
  kind: v.picklist(['github', 'mcp', 'ai', 'workspace'] as const),
});

export type RoomService = v.InferOutput<typeof RoomServiceSchema>;

const RoomToolSchema = v.object({
  name: v.string(),
  title: v.string(),
  /** Changes nothing, by the connection's own declaration. */
  readOnly: v.boolean(),
});

export type RoomTool = v.InferOutput<typeof RoomToolSchema>;

/**
 * Where data comes from, as one tag of a label: whose connection read it, the service, and the scope it is fixed to
 * (`acme/secret`), null for the whole service. `label` is the words a person sees: the scope, else the service's title.
 */
const RoomSourceSchema = v.object({
  holder: RoomPersonSchema,
  service: RoomServiceSchema,
  scope: v.nullable(v.string()),
  label: v.string(),
  /** The service can say whether this session's person reads the scope directly, with their own connection (`check`). */
  checkable: v.boolean(),
});

export type RoomSource = v.InferOutput<typeof RoomSourceSchema>;

/** What one grant reaches: a service, the tools it may call there, its scope, and whether any tool changes anything. */
const RoomReachSchema = v.object({
  service: RoomServiceSchema,
  tools: v.array(RoomToolSchema),
  scope: v.nullable(v.string()),
  effect: v.boolean(),
});

export type RoomReach = v.InferOutput<typeof RoomReachSchema>;

// ── Fork ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What forking a slate brings: its code; per part, whether it ran with someone's lend, which the fork does not keep. */
const ForkPreviewSchema = v.object({
  title: v.string(),
  owner: RoomPersonSchema,
  parts: v.array(v.object({ fn: v.string(), lent: v.boolean(), needs: v.nullable(RoomServiceSchema) })),
});

export type ForkPreview = v.InferOutput<typeof ForkPreviewSchema>;
