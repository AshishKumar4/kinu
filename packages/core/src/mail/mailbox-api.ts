/**
 * The Mailbox's calls and what they answer: the one contract the router, the agent's `mail.*` tools, the HTTP routes
 * and the pages share (docs/MAIL.md §2-§3, §11). The Mailbox is one Durable Object per account; every box the
 * account has (its person, workspaces and agents) is a path in it. Nothing here is stored beside its rows: every count
 * is a query.
 */
import type { MailRecipient } from './address';

export type MailBoxKind = 'person' | 'workspace' | 'agent';

/** Who may wake a box's agent (docs/MAIL.md §3): the verified owner only, also listed senders, any verified sender, or nobody. */
export type MailWake = 'owner' | 'allowlist' | 'verified' | 'never';

/** On whose word an arrival woke its box's agent: the owner's verified instruction, or untrusted input. */
export type MailWoke = 'owner' | 'input';

export type MailView = 'important' | 'all' | 'sent' | 'drafts' | 'trash';

export type MailSendState = 'draft' | 'queued' | 'sent' | 'delivered' | 'bounced' | 'failed' | 'complained';

export interface MailBox {
  readonly path: string;
  readonly address: string;
  readonly kind: MailBoxKind;
  /** The workspace that reads it (its Durable Object's name); null for a person with no assistant installed. */
  readonly workspace: string | null;
  readonly actorId: string | null;
  readonly wake: MailWake;
}

export interface MailParty {
  readonly name: string | null;
  readonly address: string;
}

/** A thread as a list draws it. */
export interface MailThreadSummary {
  readonly id: string;
  readonly path: string;
  readonly subject: string;
  /** The people who wrote in it, in order, each once. */
  readonly from: readonly MailParty[];
  readonly snippet: string;
  /** Who wrote the newest message, which `at`, `verified` and `snippet` are about. */
  readonly sender: MailParty;
  readonly at: number;
  readonly count: number;
  readonly unread: boolean;
  /** The newest message's verdict: false shows "Not verified". */
  readonly verified: boolean;
  readonly attachments: boolean;
  /** The assistant's reason, on the person's box only. */
  readonly important: string | null;
  readonly trashedAt: number | null;
  /** A draft waiting in it, written by the person or by an agent for them. */
  readonly draft: boolean;
  readonly outgoing: boolean;
}

export interface MailAttachmentView {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
}

export interface MailMessageView {
  readonly id: string;
  readonly threadId: string;
  readonly direction: 'in' | 'out';
  readonly from: MailParty;
  readonly to: readonly MailParty[];
  readonly cc: readonly MailParty[];
  readonly deliveredTo: string | null;
  readonly subject: string;
  readonly at: number;
  readonly verified: boolean;
  /** The Authentication-Results field the verdict was read from. */
  readonly auth: string | null;
  readonly woke: MailWoke | null;
  readonly text: string;
  /** Its HTML part, for a sealed frame; null when it had none. */
  readonly html: string | null;
  readonly attachments: readonly MailAttachmentView[];
  readonly writtenBy: string | null;
  readonly sendState: MailSendState | null;
  readonly read: boolean;
}

export interface MailThreadView {
  readonly thread: MailThreadSummary;
  readonly messages: readonly MailMessageView[];
}

/** A view's threads, newest first, and how many of them are unread. */
export interface MailListing {
  readonly threads: readonly MailThreadSummary[];
  readonly unread: number;
}

export interface MailListQuery {
  readonly view: MailView;
  /** One box, or every box the account has. */
  readonly path?: string;
  /** Words, each matched in subject, sender or body (FTS5, quoted). */
  readonly query?: string;
  readonly before?: number;
  readonly limit?: number;
}

/** What an arrival came to: where it was filed, and whom it woke, on whose word. */
export interface MailDelivery {
  /** The box it was filed in. */
  readonly box: string;
  readonly messageId: string;
  readonly threadId: string;
  /** Its Message-ID and References, for the reply thread the owner's instruction opens. */
  readonly headerId: string | null;
  readonly references: string | null;
  readonly attachments: readonly { readonly filename: string; readonly content_type: string; readonly size: number }[];
  readonly duplicate: boolean;
  readonly verified: boolean;
  readonly from: MailParty;
  readonly subject: string;
  readonly woke: MailWoke | null;
  /** The box's reader to wake; null when nothing wakes. `main`: the workspace's own box, read by its main agent. */
  readonly wake: { readonly workspace: string; readonly actorId: string; readonly main: boolean } | null;
  /** The owner's verified instruction's own words, the only body an arrival hands an agent unasked (§3). */
  readonly instruction: string | null;
}

export interface MailOutgoing {
  readonly path: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly inReplyTo?: string | null;
  /** The agent that wrote it; absent when the person writes it in the app. */
  readonly writtenBy?: string;
}

/** An agent of a workspace, as its workspace names it to the Mailbox; only the Worker and workspaces hold the binding. */
export interface MailCaller {
  /** The workspace, by its Durable Object's name. */
  readonly workspace: string;
  /** The workspace's own name, for its box's label. */
  readonly title: string;
  /** The workspace's main agent: it reads the workspace's box as its own. */
  readonly mainActorId: string;
  readonly actorId: string;
  /** The agent's name, for its box's label. */
  readonly name: string;
}

/** A message an agent writes, from one of the boxes it reads (its own by default). */
export interface MailAgentMessage {
  readonly box?: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly subject: string;
  readonly text: string;
  /** The thread it answers. */
  readonly thread?: string;
}

/** The Mailbox's calls for an agent (docs/MAIL.md §3): only the boxes it reads, its own first. */
export interface MailboxAgentCalls {
  readableBy(caller: MailCaller): Promise<readonly MailBox[]>;
  findFor(caller: MailCaller, query: Omit<MailListQuery, 'path'> & { readonly box?: string; readonly unread?: boolean }): Promise<MailListing>;
  readFor(caller: MailCaller, thread: string): Promise<MailThreadView | null>;
  draftFor(caller: MailCaller, message: MailAgentMessage): Promise<MailMessageView>;
  /** Sends it now: the workspace calls this only with the owner's approval of these exact bytes in hand. */
  sendFor(caller: MailCaller, message: MailAgentMessage): Promise<MailMessageView>;
  updateFor(caller: MailCaller, thread: string, change: { readonly read?: boolean; readonly trashed?: boolean; readonly important?: string | null }): Promise<MailThreadSummary>;
}

/** The Mailbox Durable Object's calls (`env.MAILBOX`, `idFromName(user_id)`). */
export interface MailboxCalls {
  /** Makes the account's mail identity and its person's box; a second call changes nothing. */
  open(account: { readonly userId: string; readonly email: string; readonly username: string; readonly assistant: { readonly workspace: string; readonly actorId: string } | null }): Promise<MailBox>;
  /**
   * The box a workspace's main agent (`workspace`) or another of its agents (`agent`, named `name`) reads, made on first
   * ask. Its address labels come from the names (`mailLabelOf`); a clash within the account gets `-2`, `-3`, ….
   */
  boxFor(owner: { readonly kind: 'workspace' | 'agent'; readonly workspace: string; readonly name: string; readonly actorId: string }): Promise<MailBox>;
  boxes(): Promise<readonly MailBox[]>;
  /** The owner's Personal assistant's main agent reads their own box from now on; null before they have an address. */
  readBy(reader: { readonly workspace: string; readonly actorId: string }): Promise<MailBox | null>;
  /**
   * Files a raw message that reached `recipient`; decides, by the box's wake and the verdict, whom it wakes. A label
   * the person does not have is filed in their own box and wakes nothing. Null only before the person has a box.
   */
  deliver(input: { readonly raw: Uint8Array; readonly envelopeFrom: string; readonly recipient: MailRecipient }): Promise<MailDelivery | null>;
  list(query: MailListQuery): Promise<MailListing>;
  thread(id: string): Promise<MailThreadView | null>;
  update(id: string, change: { readonly read?: boolean; readonly trashed?: boolean; readonly important?: string | null }): Promise<MailThreadSummary>;
  /** Saves (or replaces) the thread's draft; the person sends it themselves from Drafts. */
  draft(outgoing: MailOutgoing & { readonly threadId?: string }): Promise<MailMessageView>;
  /** Sends now: the caller has the person's word for it (the app, or an approved `mail-send`). Counts toward the cap. */
  send(outgoing: MailOutgoing): Promise<MailMessageView>;
  setWake(path: string, wake: MailWake, allow?: readonly string[]): Promise<MailBox>;
}
