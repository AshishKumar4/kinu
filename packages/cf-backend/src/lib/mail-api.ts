/** The signed-in person's Mailbox: the page and shell read the same HTTP contract. */
import * as v from "valibot";
import { Effect } from "effect";
import { KinuError, settle } from "@kinu.run/core/obs";
import type { MailBox, MailListing, MailListQuery, MailMessageView, MailOutgoing, MailThreadSummary, MailThreadView } from "@kinu.run/core";
import { request } from "./http";

const ImportantMailSchema = v.object({
  /** Opens `/mail/<id>`. */
  thread: v.string(),
  from: v.object({ name: v.string(), address: v.string() }),
  /** The box it reached. */
  to: v.string(),
  subject: v.string(),
  /** Why the assistant marked it Important, in one line. */
  reason: v.string(),
  at: v.number(),
  unread: v.boolean(),
});

export type ImportantMail = v.InferOutput<typeof ImportantMailSchema>;

const ImportantSchema = v.object({ unread: v.number(), items: v.array(ImportantMailSchema) });

export type Important = v.InferOutput<typeof ImportantSchema>;

export function readImportantMail(limit: number): Promise<Important> {
  return settle(request(ImportantSchema, `/api/user/mail/important?limit=${String(limit)}`));
}

const PartySchema = v.object({ name: v.nullable(v.string()), address: v.string() });

const BoxSchema = v.object({
  path: v.string(), address: v.string(), kind: v.picklist(["person", "workspace", "agent"]),
  workspace: v.nullable(v.string()), actorId: v.nullable(v.string()), wake: v.picklist(["owner", "allowlist", "verified", "never"]),
}) satisfies v.GenericSchema<unknown, MailBox>;

const BoxesSchema = v.object({ address: v.nullable(v.string()), canClaim: v.boolean(), boxes: v.array(BoxSchema) });

export type MailBoxes = v.InferOutput<typeof BoxesSchema>;

const SummarySchema = v.object({
  id: v.string(), path: v.string(), subject: v.string(), from: v.array(PartySchema), snippet: v.string(), sender: PartySchema, at: v.number(),
  count: v.number(), unread: v.boolean(), verified: v.boolean(), attachments: v.boolean(), important: v.nullable(v.string()),
  trashedAt: v.nullable(v.number()), draft: v.boolean(), outgoing: v.boolean(),
}) satisfies v.GenericSchema<unknown, MailThreadSummary>;

const MessageSchema = v.object({
  id: v.string(), threadId: v.string(), direction: v.picklist(["in", "out"]), from: PartySchema,
  to: v.array(PartySchema), cc: v.array(PartySchema), deliveredTo: v.nullable(v.string()), subject: v.string(), at: v.number(),
  verified: v.boolean(), auth: v.nullable(v.string()), woke: v.nullable(v.picklist(["owner", "input"])), text: v.string(), html: v.nullable(v.string()),
  attachments: v.array(v.object({ id: v.string(), filename: v.string(), contentType: v.string(), size: v.number() })),
  writtenBy: v.nullable(v.string()), sendState: v.nullable(v.picklist(["draft", "queued", "sent", "delivered", "bounced", "failed", "complained"])), read: v.boolean(),
}) satisfies v.GenericSchema<unknown, MailMessageView>;

const ThreadSchema = v.object({ thread: SummarySchema, messages: v.array(MessageSchema) }) satisfies v.GenericSchema<unknown, MailThreadView>;

const ListingSchema = v.object({ threads: v.array(SummarySchema), unread: v.number() }) satisfies v.GenericSchema<unknown, MailListing>;

export type MailWrite = MailOutgoing & { readonly threadId?: string };

export function readMailBoxes(): Promise<MailBoxes> {
  return settle(request(BoxesSchema, "/api/user/mail/boxes"));
}

export function claimMailAddress(username: string): Promise<{ address: string }> {
  return settle(request(v.object({ address: v.string() }), "/api/user/mail/claim", { method: "POST", json: { username } }));
}

export function listMailThreads(query: MailListQuery): Promise<MailListing> {
  const params = new URLSearchParams({ view: query.view });

  if (query.path !== undefined) params.set("path", query.path);

  if (query.query !== undefined && query.query !== "") params.set("q", query.query);

  if (query.before !== undefined) params.set("before", String(query.before));

  return settle(request(ListingSchema, `/api/user/mail/threads?${params.toString()}`));
}

export function readMailThread(id: string): Promise<MailThreadView> {
  return settle(request(ThreadSchema, `/api/user/mail/threads/${encodeURIComponent(id)}`));
}

export function updateMailThread(id: string, change: { readonly read?: boolean; readonly trashed?: boolean }): Promise<MailThreadSummary> {
  return settle(request(SummarySchema, `/api/user/mail/threads/${encodeURIComponent(id)}`, { method: "PATCH", json: change }));
}

export function sendMail(message: MailWrite): Promise<MailMessageView> {
  return settle(request(MessageSchema, "/api/user/mail/send", { method: "POST", json: message }));
}

/** "Send to a workspace…": the thread, as its agent reads mail, becomes a turn of that workspace's own; one it did not take fails, named. */
export function handMailThread(to: { readonly workspace: string; readonly title: string }, thread: string): Promise<void> {
  return settle(Effect.flatMap(
    request(v.object({ status: v.picklist(["queued", "skipped"]) }), `/api/workspaces/${encodeURIComponent(to.workspace)}/mail`, { method: "POST", json: { thread } }),
    ({ status }) => (status === "queued" ? Effect.void : Effect.fail(new KinuError("unavailable", `${to.title} did not take it.`))),
  ));
}

export function saveMailDraft(message: MailWrite): Promise<MailMessageView> {
  return settle(request(MessageSchema, "/api/user/mail/drafts", { method: "POST", json: message }));
}
