/**
 * What the account's routes and roster socket send, as one schema per body: the UserDO's types are inferred from these
 * and the browser parses with them, so producer and page cannot disagree about a field.
 */
import * as v from 'valibot';
import { AccountMemoryProposalSchema } from '../memory/account';
import { REASONING_EFFORTS } from '../providers/effort';
import { ProviderFailureSchema } from '../providers/registry';
import { ModelPricingSchema } from '../providers/types';
import { WorkspaceOverviewSchema } from './workspace-overview';

export const UserProfileSchema = v.object({
  email: v.string(),
  displayName: v.nullable(v.string()),
  createdAt: v.number(),
  lastSeenAt: v.number(),
  /** `null` until the wizard reaches `finish()`. */
  onboardedAt: v.nullable(v.number()),
  /** Counted like `listWorkspaces`' `total`. An account owning a workspace never sees the wizard, stamp or not. */
  workspaceCount: v.number(),
});

export type UserProfile = v.InferOutput<typeof UserProfileSchema>;

export const WorkspaceEntrySchema = v.object({
  name: v.string(),
  displayName: v.string(),
  createdAt: v.number(),
  lastVisited: v.number(),
});

export type WorkspaceEntry = v.InferOutput<typeof WorkspaceEntrySchema>;

const RosterEntrySchema = v.object({
  ...WorkspaceEntrySchema.entries,
  overview: v.nullable(WorkspaceOverviewSchema),
  decisions: v.number(),
  logo: v.optional(v.nullable(v.string())),
  /** The owner's assistant: Home, so the sidebar lists it nowhere and its address opens Home. */
  home: v.optional(v.literal(true)),
});

export type RosterEntry = v.InferOutput<typeof RosterEntrySchema>;

const RosterCountsSchema = v.object({
  all: v.number(),
  needs: v.number(),
  working: v.number(),
  idle: v.number(),
  unreported: v.number(),
  decisions: v.number(),
});

export type RosterCounts = v.InferOutput<typeof RosterCountsSchema>;

/** `total` counts what the query matches; `counts`, the whole roster. */
export const RosterPageSchema = v.object({
  entries: v.array(RosterEntrySchema),
  total: v.number(),
  nextCursor: v.nullable(v.string()),
  counts: RosterCountsSchema,
});

export type RosterPage = v.InferOutput<typeof RosterPageSchema>;

/** `entry` is null once the workspace has left the roster. */
export const RosterFrameSchema = v.object({
  type: v.literal('workspace'),
  name: v.string(),
  entry: v.nullable(RosterEntrySchema),
  counts: RosterCountsSchema,
});

export type RosterFrame = v.InferOutput<typeof RosterFrameSchema>;

/** On the same socket: the account-memory proposals waiting on the owner, so their chats' stacks show them. */
export const AccountMemoryFrameSchema = v.object({
  type: v.literal('account_memory'),
  pending: v.pipe(v.array(AccountMemoryProposalSchema), v.readonly()),
});

export type AccountMemoryFrame = v.InferOutput<typeof AccountMemoryFrameSchema>;

/** A page tells its roster socket whether its owner is looking at it, shown and focused, each time that changes. */
export const ForegroundReportSchema = v.object({ type: v.literal('foreground'), looking: v.boolean() });

export type ForegroundReport = v.InferOutput<typeof ForegroundReportSchema>;

/** On the same socket: how many of the account's open pages, on every device, its owner is looking at, as it changes and
 *  as the socket opens. Kinu's alerts are for an owner away from all of them (use-owner-alerts.ts). */
export const AccountForegroundFrameSchema = v.object({ type: v.literal('account_foreground'), looking: v.number() });

export type AccountForegroundFrame = v.InferOutput<typeof AccountForegroundFrameSchema>;

export const CredentialSummarySchema = v.object({
  key: v.string(),
  kind: v.picklist(['bearer', 'oauth', 'openai-compat']),
});

export type CredentialSummary = v.InferOutput<typeof CredentialSummarySchema>;

const ModelMenuEntrySchema = v.object({
  /** `<provider>/<modelId>`, used as the actor_config.model value. */
  spec: v.string(),
  label: v.string(),
  provider: v.string(),
  providerLabel: v.optional(v.string()),
  capabilities: v.optional(v.array(v.string())),
  contextWindow: v.optional(v.number()),
  /** The settings control renders exactly these after "model default". Absent when the catalog could not say; empty
   *  when the model takes none. */
  reasoningEfforts: v.optional(v.pipe(v.array(v.picklist(REASONING_EFFORTS)), v.readonly())),
  /** The account's rate, so a signed-in machine's fast pick orders by the same prices (`fastCandidatesOf`). */
  cost: v.optional(ModelPricingSchema),
});

export type ModelMenuEntry = v.InferOutput<typeof ModelMenuEntrySchema>;

/** `failures` lists unreachable providers so the picker can say so instead of dropping them. */
export const ModelMenuResponseSchema = v.object({
  models: v.array(ModelMenuEntrySchema),
  failures: v.array(ProviderFailureSchema),
  accounts: v.optional(v.pipe(v.record(v.string(), v.pipe(v.array(v.string()), v.readonly())), v.readonly())),
  /** What an unset fast tier may run on, cheapest first (`fastCandidatesOf`), so settings name the pick. */
  fast: v.optional(v.array(v.object({ model: v.string() }))),
});

export type ModelMenuResponse = v.InferOutput<typeof ModelMenuResponseSchema>;

export const ProviderCatalogEntrySchema = v.object({
  /** Also the model-spec prefix (`<id>/<modelId>`). */
  id: v.string(),
  credKey: v.string(),
  name: v.string(),
  doc: v.optional(v.string()),
  /** From models.dev metadata. */
  envVar: v.optional(v.string()),
  connected: v.boolean(),
});

export type ProviderCatalogEntry = v.InferOutput<typeof ProviderCatalogEntrySchema>;
