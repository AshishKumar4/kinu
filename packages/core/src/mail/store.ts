/**
 * The account's mail over its Mailbox's SQLite and its R2 prefix: what `MailboxDO` answers (docs/MAIL.md §2, §11).
 * Every count is a query over the rows; nothing is kept beside them. Bytes (raw messages, large text, HTML,
 * attachments) live in R2, content-addressed, and go when the last row naming them goes.
 */
import * as v from 'valibot';
import { Effect } from 'effect';
import { KinuError, settle, settleSync } from '../obs/index';
import { mailAddressOf, mailLabelOf, type MailRecipient } from './address';
import { mailVerdict } from './verdict';
import type {
  MailAgentMessage, MailBox, MailCaller, MailDelivery, MailListing, MailListQuery, MailMessageView, MailOutgoing, MailParty, MailThreadSummary, MailThreadView, MailWake, MailWoke,
} from './mailbox-api';
import type { SqlExec } from '../types/primitives';

/** Trash empties itself 30 days after a thread went in (the owner, 2026-10-19). */
const TRASH_DAYS = 30;

/** A text part up to this size stays in the row; a longer one goes to R2. */
const INLINE_TEXT_BYTES = 64 * 1024;

const DAY = 86_400_000;

/** What the store needs of a parsed message; the Mailbox reads it with postal-mime. */
export interface ParsedMail {
  readonly from: MailParty | null;
  readonly to: readonly MailParty[];
  readonly cc: readonly MailParty[];
  readonly subject: string;
  readonly messageId: string | null;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  /** Its text part, or its HTML as text, quoted history and all: the reader folds the quote itself. */
  readonly text: string;
  /** The words the sender wrote this time, quoted history set aside: an owner's instruction is these. */
  readonly ownWords: string;
  readonly html: string | null;
  readonly attachments: readonly { readonly filename: string; readonly contentType: string; readonly content: Uint8Array; readonly contentId: string | null }[];
}

/** The account's R2 prefix: keys are relative to `mail/<user_id>/`. */
export interface MailBlobs {
  put(key: string, value: Uint8Array | string): Promise<void>;
  text(key: string): Promise<string | null>;
  delete(keys: readonly string[]): Promise<void>;
}

export interface MailStoreDeps {
  readonly sql: SqlExec;
  readonly blobs: MailBlobs;
  readonly domain: string;
  readonly now: () => number;
  readonly id: () => string;
  readonly parse: (raw: Uint8Array) => Promise<ParsedMail>;
  readonly digest: (bytes: Uint8Array | string) => Promise<string>;
}

const BoxRow = v.object({
  path: v.string(), kind: v.picklist(['person', 'workspace', 'agent']), workspace: v.nullable(v.string()),
  actor_id: v.nullable(v.string()), wake: v.picklist(['owner', 'allowlist', 'verified', 'never']),
});

const IdentityRow = v.object({ user_id: v.string(), email: v.string(), username: v.string() });

const MessageRow = v.object({
  rowid: v.number(), id: v.string(), thread_id: v.string(), direction: v.picklist(['in', 'out']), header_id: v.nullable(v.string()),
  from_addr: v.string(), from_name: v.nullable(v.string()), to_json: v.string(), cc_json: v.string(), delivered_to: v.nullable(v.string()),
  subject: v.string(), at: v.number(), verdict: v.picklist(['verified', 'unverified', 'ours']), auth: v.nullable(v.string()),
  woke: v.nullable(v.picklist(['owner', 'input'])), snippet: v.string(), text_body: v.nullable(v.string()), text_key: v.nullable(v.string()),
  html_key: v.nullable(v.string()), raw_key: v.nullable(v.string()), read: v.number(), written_by: v.nullable(v.string()),
  send_state: v.nullable(v.picklist(['draft', 'queued', 'sent', 'delivered', 'bounced', 'failed', 'complained'])),
});

type Message = v.InferOutput<typeof MessageRow>;

const ThreadRow = v.object({
  id: v.string(), path: v.string(), subject: v.string(), important: v.nullable(v.string()), trashed_at: v.nullable(v.number()),
});

const AttachmentRow = v.object({ id: v.string(), message_id: v.string(), filename: v.string(), content_type: v.string(), size: v.number(), digest: v.string() });

const PartiesJson = v.pipe(v.string(), v.parseJson(), v.array(v.object({ name: v.nullable(v.string()), address: v.string() })));

const rows = <T extends v.GenericSchema>(schema: T, found: { toArray(): unknown[] }): v.InferOutput<T>[] => found.toArray().map((row) => v.parse(schema, row));

/** The search box's words, each quoted, so FTS5 reads none of them as syntax. */
function ftsQuery(words: string): string {
  return words.split(/\s+/u).filter(Boolean).map((word) => `"${word.replaceAll('"', '""')}"`).join(' ');
}

/** A Message-ID without its angle brackets, the form threading compares. */
const bare = (id: string): string => id.trim().replace(/^<|>$/gu, '');

const snippetOf = (text: string): string => text.replace(/\s+/gu, ' ').trim().slice(0, 200);

export class MailStore {
  constructor(private readonly deps: MailStoreDeps) {}

  /** Who the account is; null before `open`, when it also has no box to read. */
  private identity(): v.InferOutput<typeof IdentityRow> | null {
    return rows(IdentityRow, this.deps.sql.exec('SELECT user_id, email, username FROM mail_box WHERE id = 1'))[0] ?? null;
  }

  private box(path: string): MailBox | null {
    const [row] = rows(BoxRow, this.deps.sql.exec("SELECT path, kind, workspace, actor_id, wake FROM mail_addresses WHERE path = ? AND state = 'active'", path));

    return row === undefined ? null : this.boxOf(row);
  }

  private boxOf(row: v.InferOutput<typeof BoxRow>): MailBox {
    return {
      path: row.path, kind: row.kind, workspace: row.workspace, actorId: row.actor_id, wake: row.wake,
      address: mailAddressOf(this.identity()?.username ?? '', row.path, this.deps.domain),
    };
  }

  open(account: { userId: string; email: string; username: string; assistant: { workspace: string; actorId: string } | null }): MailBox {
    const now = this.deps.now();

    this.deps.sql.exec('INSERT OR IGNORE INTO mail_box (id, user_id, email, username, created_at) VALUES (1, ?, ?, ?, ?)', account.userId, account.email.toLowerCase(), account.username, now);
    this.deps.sql.exec("INSERT OR IGNORE INTO mail_addresses (path, kind, workspace, actor_id, created_at) VALUES ('', 'person', ?, ?, ?)",
      account.assistant?.workspace ?? null, account.assistant?.actorId ?? null, now);

    // The person's box names its reader once the Personal assistant is installed.
    if (account.assistant !== null) {
      this.deps.sql.exec("UPDATE mail_addresses SET workspace = ?, actor_id = ? WHERE path = '' AND workspace IS NULL", account.assistant.workspace, account.assistant.actorId);
    }

    return this.box('') ?? this.boxOf({ path: '', kind: 'person', workspace: null, actor_id: null, wake: 'owner' });
  }

  /** The box a workspace's main agent or one of its other agents reads; made on first ask. */
  boxFor(owner: { kind: 'workspace' | 'agent'; workspace: string; name: string; actorId: string }): MailBox {
    // By kind too: the Personal assistant's main agent reads the person's box and its workspace's.
    const [held] = rows(BoxRow, this.deps.sql.exec(
      "SELECT path, kind, workspace, actor_id, wake FROM mail_addresses WHERE workspace = ? AND actor_id = ? AND kind = ? AND state = 'active'", owner.workspace, owner.actorId, owner.kind,
    ));

    if (held !== undefined) return this.boxOf(held);

    const label = mailLabelOf(owner.name) ?? (owner.kind === 'workspace' ? 'workspace' : 'agent');

    const workspacePath = rows(v.object({ path: v.string() }), this.deps.sql.exec("SELECT path FROM mail_addresses WHERE kind = 'workspace' AND workspace = ?", owner.workspace))[0]?.path
      ?? mailLabelOf(owner.workspace) ?? 'workspace';

    const base = owner.kind === 'workspace' ? label : `${label}.${workspacePath}`;
    let path = base;

    // A label is unique per person: a clash gets `-2`, `-3`, … (§1).
    for (let n = 2; this.deps.sql.exec('SELECT 1 FROM mail_addresses WHERE path = ?', path).toArray().length > 0; n += 1) path = `${base}-${String(n)}`;

    this.deps.sql.exec('INSERT INTO mail_addresses (path, kind, workspace, actor_id, created_at) VALUES (?, ?, ?, ?, ?)', path, owner.kind, owner.workspace, owner.actorId, this.deps.now());

    return this.box(path) ?? this.boxOf({ path, kind: owner.kind, workspace: owner.workspace, actor_id: owner.actorId, wake: 'owner' });
  }

  /**
   * The boxes an agent reads (docs/MAIL.md §3), its own first, made on first ask: its own, its workspace's, and for the
   * agent a box names as its reader (the Personal assistant's main agent, the person's) that one too.
   */
  readableBy(caller: MailCaller): MailBox[] {
    // The workspace's box first, so an agent's address sits under the workspace's label whoever asked first.
    const home = this.boxFor({ kind: 'workspace', workspace: caller.workspace, name: caller.title, actorId: caller.mainActorId });
    const own = caller.actorId === caller.mainActorId ? home : this.boxFor({ kind: 'agent', workspace: caller.workspace, name: caller.name, actorId: caller.actorId });
    const others = this.boxes().filter((box) => box.path !== own.path && box.workspace === caller.workspace && (box.kind === 'workspace' || box.actorId === caller.actorId));

    return [own, ...others];
  }

  /* ——— An agent's calls (docs/MAIL.md §3): only the boxes it reads ——— */

  findFor(caller: MailCaller, query: Omit<MailListQuery, 'path'> & { box?: string; unread?: boolean }): MailListing {
    const paths = query.box === undefined
      ? this.readableBy(caller).map((box) => box.path)
      : [this.readablePath(caller, query.box)].filter((path) => path !== null);

    const listing = this.list(query, paths);

    return query.unread === true ? { ...listing, threads: listing.threads.filter((thread) => thread.unread) } : listing;
  }

  async readFor(caller: MailCaller, thread: string): Promise<MailThreadView | null> {
    return this.reads(caller, thread) ? this.thread(thread) : null;
  }

  async draftFor(caller: MailCaller, message: MailAgentMessage): Promise<MailMessageView> {
    const outgoing = this.outgoingFor(caller, message);

    if (outgoing instanceof KinuError) return settle(Effect.fail(outgoing));

    return this.draft(outgoing);
  }

  /** Files an agent's message to send: the Mailbox calls this only with the owner's approval of it in hand. */
  async queueFor(caller: MailCaller, message: MailAgentMessage): Promise<{ view: MailMessageView; headerId: string; from: string; outgoing: MailOutgoing }> {
    const outgoing = this.outgoingFor(caller, message);

    if (outgoing instanceof KinuError) return settle(Effect.fail(outgoing));

    return { ...await this.queue(outgoing), outgoing };
  }

  updateFor(caller: MailCaller, thread: string, change: { read?: boolean; trashed?: boolean; important?: string | null }): MailThreadSummary {
    if (!this.reads(caller, thread)) return settleSync(Effect.fail(new KinuError('missing', `No thread "${thread}" in a box you read.`)));

    return this.update(thread, change);
  }

  /** Whether the agent reads the thread's box. */
  private reads(caller: MailCaller, thread: string): boolean {
    const path = this.pathOf(thread);

    return path !== null && this.readablePath(caller, path) !== null;
  }

  /** The agent's message as it is filed: from a box it reads, answering a thread it reads, signed as its writer. */
  private outgoingFor(caller: MailCaller, message: MailAgentMessage): (MailOutgoing & { threadId?: string }) | KinuError {
    const path = this.readablePath(caller, message.box);

    if (path === null) return new KinuError('denied', `You do not read the box "${message.box ?? ''}".`);

    if (message.thread !== undefined && !this.reads(caller, message.thread)) return new KinuError('missing', `No thread "${message.thread}" in a box you read.`);

    return {
      path, to: message.to, cc: message.cc ?? [], subject: message.subject, text: message.text, writtenBy: caller.name,
      ...message.thread !== undefined && { threadId: message.thread, inReplyTo: this.newestHeader(message.thread) },
    };
  }

  /** A thread's box, if it has one; null for no such thread. */
  pathOf(threadId: string): string | null {
    return rows(v.object({ path: v.string() }), this.deps.sql.exec('SELECT path FROM mail_threads WHERE id = ?', threadId))[0]?.path ?? null;
  }

  /** The Message-ID a reply in this thread answers: its newest message's. */
  newestHeader(threadId: string): string | null {
    return rows(v.object({ header_id: v.nullable(v.string()) }), this.deps.sql.exec(
      "SELECT header_id FROM mail_messages WHERE thread_id = ? AND send_state IS NOT 'draft' ORDER BY at DESC, rowid DESC LIMIT 1", threadId,
    ))[0]?.header_id ?? null;
  }

  /** The box path `asked` names, if the agent reads it; its own when none is named. */
  readablePath(caller: MailCaller, asked: string | undefined): string | null {
    const readable = this.readableBy(caller);

    return asked === undefined ? readable[0]?.path ?? null : readable.find((box) => box.path === asked)?.path ?? null;
  }

  boxes(): MailBox[] {
    return rows(BoxRow, this.deps.sql.exec("SELECT path, kind, workspace, actor_id, wake FROM mail_addresses WHERE state = 'active' ORDER BY path")).map((row) => this.boxOf(row));
  }

  setWake(path: string, wake: MailWake, allow?: readonly string[]): MailBox {
    const box = this.box(path);

    if (box === null) return settleSync(Effect.fail(new KinuError('missing', `No box at "${path}".`)));
    this.deps.sql.exec('UPDATE mail_addresses SET wake = ? WHERE path = ?', wake, path);

    if (allow !== undefined) {
      this.deps.sql.exec('DELETE FROM mail_allow WHERE path = ?', path);

      for (const sender of new Set(allow.map((each) => each.trim().toLowerCase()).filter(Boolean))) {
        this.deps.sql.exec('INSERT INTO mail_allow (path, sender, added_at) VALUES (?, ?, ?)', path, sender, this.deps.now());
      }
    }

    return { ...box, wake };
  }

  /** Who an arrival wakes, and on whose word (§3): the owner's verified mail always; others by the box's wake. */
  private wakeOf(box: MailBox, verdict: { verified: boolean; from: string | null }): MailWoke | null {
    if (box.workspace === null || !verdict.verified || verdict.from === null) return null;

    if (verdict.from === this.identity()?.email) return 'owner';

    if (box.wake === 'verified') return 'input';

    if (box.wake !== 'allowlist') return null;

    return this.deps.sql.exec('SELECT 1 FROM mail_allow WHERE path = ? AND sender = ?', box.path, verdict.from).toArray().length > 0 ? 'input' : null;
  }

  /** The thread a message belongs to: the one holding a message it answers or references, else a new one. */
  private threadFor(path: string, parsed: ParsedMail, at: number): string {
    const answered = [parsed.inReplyTo, ...parsed.references].filter((id): id is string => id !== null).map(bare);

    for (const id of answered) {
      const [found] = rows(v.object({ thread_id: v.string() }), this.deps.sql.exec(
        'SELECT m.thread_id FROM mail_messages m JOIN mail_threads t ON t.id = m.thread_id WHERE m.header_id = ? AND t.path = ?', id, path,
      ));

      if (found !== undefined) return found.thread_id;
    }

    const id = this.deps.id();

    this.deps.sql.exec('INSERT INTO mail_threads (id, path, subject, created_at) VALUES (?, ?, ?, ?)', id, path, parsed.subject, at);

    return id;
  }

  async deliver(input: { raw: Uint8Array; envelopeFrom: string; recipient: MailRecipient }): Promise<MailDelivery | null> {
    const named = this.box(input.recipient.path);
    // A label the person does not have is kept in their own box and wakes nothing, so no bounce tells a sender which
    // workspaces exist (docs/MAIL.md §4). `delivered_to` keeps the address it was sent to.
    const box = named ?? this.box('');

    if (box === null) return null;

    const parsed = await this.deps.parse(input.raw);
    const verdict = mailVerdict(new TextDecoder().decode(input.raw));
    const from: MailParty = { name: parsed.from?.name ?? null, address: verdict.from ?? parsed.from?.address ?? input.envelopeFrom.toLowerCase() };
    const headerId = parsed.messageId === null ? null : bare(parsed.messageId);

    const [seen] = headerId === null ? [] : rows(v.object({ id: v.string(), thread_id: v.string(), verdict: v.string() }), this.deps.sql.exec(
      'SELECT m.id, m.thread_id, m.verdict FROM mail_messages m JOIN mail_threads t ON t.id = m.thread_id WHERE m.header_id = ? AND t.path = ?', headerId, box.path,
    ));

    // The edge redelivers a message it is unsure arrived: it is filed and woken once.
    if (seen !== undefined) {
      return {
        box: box.path, messageId: seen.id, threadId: seen.thread_id, headerId, references: null, attachments: [], duplicate: true,
        verified: seen.verdict === 'verified', from, subject: parsed.subject, woke: null, wake: null, instruction: null,
      };
    }

    const at = this.deps.now();
    const woke = named === null ? null : this.wakeOf(box, verdict);
    const threadId = this.threadFor(box.path, parsed, at);
    const messageId = this.deps.id();
    const keys = await this.keep(input.raw, parsed);
    const tag = input.recipient.tag === null ? '' : `+${input.recipient.tag}`;

    this.deps.sql.exec(
      `INSERT INTO mail_messages (id, thread_id, direction, header_id, in_reply_to, refs, from_addr, from_name, to_json, cc_json, delivered_to,
        subject, at, verdict, auth, woke, snippet, text_body, text_key, html_key, raw_key, size)
       VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      messageId, threadId, headerId, parsed.inReplyTo === null ? null : bare(parsed.inReplyTo), JSON.stringify(parsed.references.map(bare)),
      from.address, from.name, JSON.stringify(parsed.to), JSON.stringify(parsed.cc),
      `${(input.recipient.path === '' ? '' : `${input.recipient.path}.`)}${input.recipient.username}${tag}@${this.deps.domain}`,
      parsed.subject, at, verdict.verified ? 'verified' : 'unverified', verdict.auth, woke, snippetOf(parsed.text),
      keys.text === null ? parsed.text : null, keys.text, keys.html, keys.raw, input.raw.byteLength,
    );
    await this.attach(messageId, parsed.attachments);
    this.index(messageId, parsed.subject, `${from.name ?? ''} ${from.address}`, parsed.text);
    // A thread that comes back to life leaves the Trash.
    this.deps.sql.exec('UPDATE mail_threads SET trashed_at = NULL WHERE id = ?', threadId);

    return {
      box: box.path, messageId, threadId, headerId, duplicate: false, verified: verdict.verified, from, subject: parsed.subject, woke,
      references: parsed.references.length === 0 ? null : parsed.references.join(' '),
      attachments: parsed.attachments.map((file) => ({ filename: file.filename, content_type: file.contentType, size: file.content.byteLength })),
      wake: woke === null || box.workspace === null || box.actorId === null ? null : { workspace: box.workspace, actorId: box.actorId, main: box.kind !== 'agent' },
      instruction: woke === 'owner' ? parsed.ownWords : null,
    };
  }

  /** Its bytes in R2: the raw message, a text part too long for the row, and its HTML. */
  private async keep(raw: Uint8Array, parsed: ParsedMail): Promise<{ raw: string; text: string | null; html: string | null }> {
    const keys = {
      raw: `raw/${await this.deps.digest(raw)}.eml`,
      text: new TextEncoder().encode(parsed.text).byteLength <= INLINE_TEXT_BYTES ? null : `text/${await this.deps.digest(parsed.text)}.txt`,
      html: parsed.html === null ? null : `html/${await this.deps.digest(parsed.html)}.html`,
    };

    await this.deps.blobs.put(keys.raw, raw);

    if (keys.text !== null) await this.deps.blobs.put(keys.text, parsed.text);

    if (keys.html !== null && parsed.html !== null) await this.deps.blobs.put(keys.html, parsed.html);

    return keys;
  }

  private async attach(messageId: string, files: ParsedMail['attachments']): Promise<void> {
    for (const file of files) {
      const digest = await this.deps.digest(file.content);

      await this.deps.blobs.put(`att/${digest}`, file.content);
      this.deps.sql.exec('INSERT INTO mail_attachments (id, message_id, filename, content_type, size, digest, inline_cid) VALUES (?, ?, ?, ?, ?, ?, ?)',
        this.deps.id(), messageId, file.filename, file.contentType, file.content.byteLength, digest, file.contentId);
    }
  }

  private index(messageId: string, subject: string, sender: string, body: string): void {
    const [row] = rows(v.object({ rowid: v.number() }), this.deps.sql.exec('SELECT rowid FROM mail_messages WHERE id = ?', messageId));

    if (row !== undefined) this.deps.sql.exec('INSERT INTO mail_fts (rowid, subject, sender, body) VALUES (?, ?, ?, ?)', row.rowid, subject, sender, body);
  }

  /** `only`: just these boxes, an agent's (the ones it reads). */
  list(query: MailListQuery, only?: readonly string[]): MailListing {
    const where: string[] = [];
    const bindings: (string | number)[] = [];

    if (query.view === 'trash') where.push('t.trashed_at IS NOT NULL');
    else where.push('t.trashed_at IS NULL');

    if (query.view === 'important') where.push("t.important IS NOT NULL AND t.path = ''");

    if (query.view === 'sent') where.push("EXISTS (SELECT 1 FROM mail_messages s WHERE s.thread_id = t.id AND s.direction = 'out' AND s.send_state <> 'draft')");

    if (query.view === 'drafts') where.push("EXISTS (SELECT 1 FROM mail_messages d WHERE d.thread_id = t.id AND d.send_state = 'draft')");

    if (query.path !== undefined) {
      where.push('t.path = ?');
      bindings.push(query.path);
    }

    if (only !== undefined) {
      where.push(`t.path IN (${only.map(() => '?').join(', ') || 'NULL'})`);
      bindings.push(...only);
    }

    if (query.query !== undefined && query.query.trim() !== '') {
      where.push('t.id IN (SELECT m.thread_id FROM mail_messages m WHERE m.rowid IN (SELECT rowid FROM mail_fts WHERE mail_fts MATCH ?))');
      bindings.push(ftsQuery(query.query));
    }

    const ids = rows(v.object({ id: v.string(), latest: v.number() }), this.deps.sql.exec(
      `SELECT t.id, (SELECT MAX(at) FROM mail_messages m WHERE m.thread_id = t.id) AS latest FROM mail_threads t WHERE ${where.join(' AND ')}
       ORDER BY latest DESC`, ...bindings,
    )).filter((row) => query.before === undefined || row.latest < query.before);

    const threads = ids.map((row) => this.summary(row.id)).filter((summary): summary is MailThreadSummary => summary !== null);

    return { threads: threads.slice(0, query.limit ?? 50), unread: threads.filter((thread) => thread.unread).length };
  }

  private messages(threadId: string): Message[] {
    return rows(MessageRow, this.deps.sql.exec('SELECT rowid, * FROM mail_messages WHERE thread_id = ? ORDER BY at, rowid', threadId));
  }

  private summary(id: string): MailThreadSummary | null {
    const [thread] = rows(ThreadRow, this.deps.sql.exec('SELECT id, path, subject, important, trashed_at FROM mail_threads WHERE id = ?', id));
    const messages = this.messages(id);
    const last = messages.at(-1);

    if (thread === undefined || last === undefined) return null;

    const sent = messages.filter((message) => message.send_state !== 'draft');
    const shown = sent.at(-1) ?? last;
    const from = new Map<string, MailParty>();

    for (const message of sent) from.set(message.from_addr, { name: message.from_name, address: message.from_addr });

    return {
      id, path: thread.path, subject: thread.subject, from: [...from.values()], snippet: shown.snippet, at: shown.at, count: sent.length,
      unread: messages.some((message) => message.direction === 'in' && message.read === 0), verified: shown.verdict !== 'unverified',
      attachments: this.deps.sql.exec(`SELECT 1 FROM mail_attachments WHERE message_id IN (${messages.map(() => '?').join(',')}) LIMIT 1`, ...messages.map((m) => m.id)).toArray().length > 0,
      important: thread.important, trashedAt: thread.trashed_at, draft: messages.some((message) => message.send_state === 'draft'),
      outgoing: shown.direction === 'out',
    };
  }

  async thread(id: string): Promise<MailThreadView | null> {
    const thread = this.summary(id);

    if (thread === null) return null;

    const attachments = rows(AttachmentRow, this.deps.sql.exec('SELECT a.* FROM mail_attachments a JOIN mail_messages m ON m.id = a.message_id WHERE m.thread_id = ?', id));

    const messages = await Promise.all(this.messages(id).map(async (message): Promise<MailMessageView> => ({
      id: message.id, threadId: id, direction: message.direction, from: { name: message.from_name, address: message.from_addr },
      to: v.parse(PartiesJson, message.to_json), cc: v.parse(PartiesJson, message.cc_json), deliveredTo: message.delivered_to,
      subject: message.subject, at: message.at, verified: message.verdict !== 'unverified', auth: message.auth, woke: message.woke,
      text: message.text_body ?? (message.text_key === null ? '' : await this.deps.blobs.text(message.text_key) ?? ''),
      html: message.html_key === null ? null : await this.deps.blobs.text(message.html_key),
      attachments: attachments.filter((file) => file.message_id === message.id)
        .map((file) => ({ id: file.id, filename: file.filename, contentType: file.content_type, size: file.size })),
      writtenBy: message.written_by, sendState: message.send_state, read: message.read === 1,
    })));

    return { thread, messages };
  }

  update(id: string, change: { read?: boolean; trashed?: boolean; important?: string | null }): MailThreadSummary {
    const [thread] = rows(ThreadRow, this.deps.sql.exec('SELECT id, path, subject, important, trashed_at FROM mail_threads WHERE id = ?', id));

    if (thread === undefined) return settleSync(Effect.fail(new KinuError('missing', `No thread "${id}".`)));

    if (change.read !== undefined) this.deps.sql.exec("UPDATE mail_messages SET read = ? WHERE thread_id = ? AND direction = 'in'", change.read ? 1 : 0, id);

    if (change.trashed !== undefined) this.deps.sql.exec('UPDATE mail_threads SET trashed_at = ? WHERE id = ?', change.trashed ? this.deps.now() : null, id);

    if (change.important !== undefined) {
      // The assistant picks from the box it reads: the person's own.
      if (thread.path !== '') return settleSync(Effect.fail(new KinuError('denied', 'Only mail to the person\'s own address can be marked Important.')));
      this.deps.sql.exec('UPDATE mail_threads SET important = ? WHERE id = ?', change.important === null ? null : change.important.slice(0, 280), id);
    }

    const summary = this.summary(id);

    if (summary === null) return settleSync(Effect.fail(new KinuError('missing', `No thread "${id}".`)));

    return summary;
  }

  /** An outgoing message's row: a draft, or one queued to send. Its thread is the one it answers, or a new one. */
  private writeOut(box: MailBox, outgoing: MailOutgoing & { threadId?: string }, state: 'draft' | 'queued') {
    const at = this.deps.now();
    let threadId = outgoing.threadId ?? null;

    if (threadId === null && outgoing.inReplyTo != null) {
      threadId = rows(v.object({ thread_id: v.string() }), this.deps.sql.exec('SELECT thread_id FROM mail_messages WHERE header_id = ?', bare(outgoing.inReplyTo)))[0]?.thread_id ?? null;
    }

    if (threadId === null) {
      threadId = this.deps.id();
      this.deps.sql.exec('INSERT INTO mail_threads (id, path, subject, created_at) VALUES (?, ?, ?, ?)', threadId, outgoing.path, outgoing.subject, at);
    }

    const id = this.deps.id();
    const headerId = `${id}@${this.deps.domain}`;
    const party = (address: string): MailParty => ({ name: null, address: address.trim().toLowerCase() });

    this.deps.sql.exec(
      `INSERT INTO mail_messages (id, thread_id, direction, header_id, in_reply_to, from_addr, to_json, cc_json, subject, at, verdict, snippet,
        text_body, size, read, written_by, send_state) VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, 'ours', ?, ?, ?, 1, ?, ?)`,
      id, threadId, headerId, outgoing.inReplyTo == null ? null : bare(outgoing.inReplyTo), box.address,
      JSON.stringify(outgoing.to.map(party)), JSON.stringify((outgoing.cc ?? []).map(party)), outgoing.subject, at, snippetOf(outgoing.text),
      outgoing.text, new TextEncoder().encode(outgoing.text).byteLength, outgoing.writtenBy ?? null, state,
    );
    this.index(id, outgoing.subject, box.address, outgoing.text);

    return { id, headerId, threadId };
  }

  async draft(outgoing: MailOutgoing & { threadId?: string }): Promise<MailMessageView> {
    const box = this.box(outgoing.path);

    if (box === null) return settleSync(Effect.fail(new KinuError('missing', `No box at "${outgoing.path}".`)));

    // One draft per thread: a new one replaces the old.
    if (outgoing.threadId !== undefined) this.dropDrafts(outgoing.threadId);

    const { id, threadId } = this.writeOut(box, outgoing, 'draft');
    const view = await this.messageView(threadId, id);

    if (view === null) return settleSync(Effect.fail(new KinuError('missing', `No message "${id}".`)));

    return view;
  }

  private dropDrafts(threadId: string): void {
    for (const draft of rows(v.object({ rowid: v.number() }), this.deps.sql.exec("SELECT rowid FROM mail_messages WHERE thread_id = ? AND send_state = 'draft'", threadId))) {
      this.deps.sql.exec('DELETE FROM mail_fts WHERE rowid = ?', draft.rowid);
    }

    this.deps.sql.exec("DELETE FROM mail_messages WHERE thread_id = ? AND send_state = 'draft'", threadId);
  }

  /** Sends sent from this account in the last day, against its cap (none for operators, 100 otherwise). */
  sentToday(): number {
    return rows(v.object({ n: v.number() }), this.deps.sql.exec(
      "SELECT COUNT(*) AS n FROM mail_messages WHERE direction = 'out' AND send_state <> 'draft' AND at >= ?", this.deps.now() - DAY,
    ))[0]?.n ?? 0;
  }

  /** Files a message to send, the person's word already given; the Mailbox then hands it to its outbox. */
  async queue(outgoing: MailOutgoing & { threadId?: string }): Promise<{ view: MailMessageView; headerId: string; from: string }> {
    const box = this.box(outgoing.path);

    if (box === null) return settleSync(Effect.fail(new KinuError('missing', `No box at "${outgoing.path}".`)));

    if (outgoing.threadId !== undefined) this.dropDrafts(outgoing.threadId);

    const { id, headerId, threadId } = this.writeOut(box, outgoing, 'queued');
    const view = await this.messageView(threadId, id);

    if (view === null) return settleSync(Effect.fail(new KinuError('missing', `No message "${id}".`)));

    return { view, headerId, from: view.from.address };
  }

  markSent(messageId: string, state: 'sent' | 'failed'): void {
    this.deps.sql.exec('UPDATE mail_messages SET send_state = ? WHERE id = ?', state, messageId);
  }

  private async messageView(threadId: string, id: string): Promise<MailMessageView | null> {
    return (await this.thread(threadId))?.messages.find((each) => each.id === id) ?? null;
  }

  /** Empties the Trash of what has been in it 30 days: its rows, its search entries, and bytes no row names any more. */
  async purge(): Promise<number> {
    const cutoff = this.deps.now() - TRASH_DAYS * DAY;
    const gone = rows(v.object({ id: v.string() }), this.deps.sql.exec('SELECT id FROM mail_threads WHERE trashed_at IS NOT NULL AND trashed_at <= ?', cutoff));
    const keys = new Set<string>();

    for (const { id } of gone) {
      for (const message of this.messages(id)) {
        for (const key of [message.raw_key, message.text_key, message.html_key]) if (key !== null) keys.add(key);

        for (const file of rows(AttachmentRow, this.deps.sql.exec('SELECT * FROM mail_attachments WHERE message_id = ?', message.id))) keys.add(`att/${file.digest}`);
        this.deps.sql.exec('DELETE FROM mail_fts WHERE rowid = ?', message.rowid);
        this.deps.sql.exec('DELETE FROM mail_attachments WHERE message_id = ?', message.id);
      }

      this.deps.sql.exec('DELETE FROM mail_messages WHERE thread_id = ?', id);
      this.deps.sql.exec('DELETE FROM mail_threads WHERE id = ?', id);
    }

    const named = (key: string): boolean => (key.startsWith('att/')
      ? this.deps.sql.exec('SELECT 1 FROM mail_attachments WHERE digest = ? LIMIT 1', key.slice(4)).toArray().length > 0
      : this.deps.sql.exec('SELECT 1 FROM mail_messages WHERE raw_key = ? OR text_key = ? OR html_key = ? LIMIT 1', key, key, key).toArray().length > 0);

    await this.deps.blobs.delete([...keys].filter((key) => !named(key)));

    return gone.length;
  }

  /** When the Trash next has something to empty, or null. */
  nextPurgeAt(): number | null {
    const [row] = rows(v.object({ at: v.nullable(v.number()) }), this.deps.sql.exec('SELECT MIN(trashed_at) AS at FROM mail_threads WHERE trashed_at IS NOT NULL'));

    return row?.at == null ? null : row.at + TRASH_DAYS * DAY;
  }
}
