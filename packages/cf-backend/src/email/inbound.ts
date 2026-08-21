/**
 * Mission Inbox — inbound side. Pure parsing helpers between the Worker's
 * `email()` handler and the agent's `acceptEmailDelivery` RPC:
 *
 *   addressing:  `<agent-name>@<EMAIL_DOMAIN>` — the local part IS the agent
 *                name (agent names are globally unique DO ids), with
 *                `+tag` sub-addressing tolerated and case ignored.
 *   parsing:     raw MIME (postal-mime) → subject / top-of-thread text /
 *                threading headers / attachment metadata. Attachment bytes
 *                never leave this layer.
 */

import PostalMime from 'postal-mime';
import { normalizeEmailAddress, type EmailAttachmentMeta } from '@kinu.run/core';

/** Agent-name charset — mirrors identity/naming.ts slugs (`scout-a1b2c3`). */
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Resolve the receiving agent from the envelope RCPT TO. Returns null (drop)
 * when the domain doesn't match the configured EMAIL_DOMAIN or the local part
 * isn't a plausible agent name. `+tag` sub-addressing is stripped.
 */
export function agentNameFromRecipient(to: string, emailDomain: string | undefined): string | null {
  const addr = normalizeEmailAddress(to);
  const at = addr.lastIndexOf('@');
  if (at <= 0) return null;
  const host = addr.slice(at + 1);
  if (!emailDomain || host !== emailDomain.trim().toLowerCase()) return null;
  const local = addr.slice(0, at).split('+')[0];
  return AGENT_NAME_RE.test(local) ? local : null;
}

/** The agent's canonical address on the configured mail domain. */
export function agentEmailAddress(agentName: string, emailDomain: string): string {
  return `${agentName.toLowerCase()}@${emailDomain.trim().toLowerCase()}`;
}

/**
 * RFC 3834 auto-reply / bulk-mail detection. Since Kinu auto-replies
 * on-thread, admitting another machine's auto-reply (a vacation responder, or
 * a second agent) would loop the two forever — so these are dropped inbound.
 * Adopted from the Agents SDK's `isAutoReplyEmail`.
 */
export function isAutoReplyEmail(headers: Headers): boolean {
  // RFC 3834: "no" is the only value that marks human-sent mail.
  const autoSubmitted = headers.get('auto-submitted');
  if (autoSubmitted && autoSubmitted.trim().toLowerCase() !== 'no') return true;
  // Any value means the sender doesn't want auto-replies.
  if (headers.get('x-auto-response-suppress')) return true;
  const precedence = headers.get('precedence')?.trim().toLowerCase();
  if (precedence === 'bulk' || precedence === 'junk' || precedence === 'list') return true;
  // Mailing-list mail carries List-* headers (RFC 2919/2369).
  if (headers.has('list-id') || headers.has('list-unsubscribe')) return true;
  return false;
}

// ── Quoted-history stripping ─────────────────────────────────────

/** Markers that begin quoted history / signatures in common mail clients.
 *  The earliest match wins; everything from it onward is dropped. */
const QUOTE_MARKERS: ReadonlyArray<RegExp> = [
  /^\s*On .{0,200}wrote:\s*$/m,               // Gmail / Apple Mail
  /^\s*-{2,}\s*Original Message\s*-{2,}/im,   // Outlook classic
  /^\s*_{5,}\s*$/m,                           // Outlook divider
  /^\s*From:\s.+\nSent:\s.+$/m,               // Outlook top-post block
  /^\s*Le .{0,200}a écrit\s*:\s*$/m,          // French clients
  /^>/m,                                      // first quoted line
  /^\s*--\s*$/m,                              // signature delimiter
];

/** Keep the sender's new text; drop quoted history and the signature. Falls
 *  back to the full text when stripping would leave nothing. */
export function stripQuotedReply(text: string): string {
  let cut = text.length;
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  const stripped = text.slice(0, cut).trim();
  return stripped.length > 0 ? stripped : text.trim();
}

// ── MIME extraction ──────────────────────────────────────────────

export interface ParsedInboundEmail {
  subject: string;
  /** Top-of-thread text, quoted history stripped. */
  body_text: string;
  message_id: string | null;
  in_reply_to: string | null;
  references: string | null;
  attachments: EmailAttachmentMeta[];
}

/** Crude HTML→text for HTML-only mail. Good enough for turn input. */
function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+\n/g, '\n\n')
    .trim();
}

function attachmentSize(content: ArrayBuffer | Uint8Array | string): number {
  return content instanceof ArrayBuffer || content instanceof Uint8Array
    ? content.byteLength
    : content.length;
}

/** Parse a buffered raw MIME message into the turn-input fields. */
export async function parseInboundMime(raw: ArrayBuffer): Promise<ParsedInboundEmail> {
  const parsed = await PostalMime.parse(raw);
  const text = parsed.text?.trim()
    ? parsed.text
    : parsed.html
      ? htmlToText(parsed.html)
      : '';
  return {
    subject: parsed.subject?.trim() ?? '(no subject)',
    body_text: stripQuotedReply(text),
    message_id: parsed.messageId ?? null,
    in_reply_to: parsed.inReplyTo ?? null,
    references: parsed.references ?? null,
    attachments: parsed.attachments.map((a) => ({
      filename: a.filename ?? 'unnamed',
      content_type: a.mimeType,
      size: attachmentSize(a.content),
    })),
  };
}
