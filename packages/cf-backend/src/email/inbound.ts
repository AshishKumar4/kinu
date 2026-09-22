/**
 * Mission Inbox inbound parsing. `<agent-name>@<EMAIL_DOMAIN>`: the local part is the agent name
 * (`+tag` and case ignored). Attachment bytes never leave this layer.
 */

import PostalMime from 'postal-mime';
import { normalizeEmailAddress, type EmailAttachmentMeta } from '@kinu.run/core';

/** Mirrors identity/naming.ts slugs (`scout-a1b2c3`). */
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Null (drop) on a foreign domain or implausible agent name; `+tag` is stripped. */
export function agentNameFromRecipient(to: string, emailDomain: string | undefined): string | null {
  const addr = normalizeEmailAddress(to);
  const at = addr.lastIndexOf('@');

  if (at <= 0) return null;
  const host = addr.slice(at + 1);

  if (!emailDomain || host !== emailDomain.trim().toLowerCase()) return null;
  const local = addr.slice(0, at).split('+')[0];

  return AGENT_NAME_RE.test(local) ? local : null;
}

export function agentEmailAddress(agentName: string, emailDomain: string): string {
  return `${agentName.toLowerCase()}@${emailDomain.trim().toLowerCase()}`;
}

/** RFC 3834: another machine's auto-reply would loop with Kinu's on-thread replies, so these are dropped. */
export function isAutoReplyEmail(headers: Headers): boolean {
  // RFC 3834: "no" is the only value that marks human-sent mail.
  const autoSubmitted = headers.get('auto-submitted');

  if (autoSubmitted && autoSubmitted.trim().toLowerCase() !== 'no') return true;

  if (headers.get('x-auto-response-suppress')) return true;
  const precedence = headers.get('precedence')?.trim().toLowerCase();

  if (precedence === 'bulk' || precedence === 'junk' || precedence === 'list') return true;

  // RFC 2919/2369 List-* headers.
  if (headers.has('list-id') || headers.has('list-unsubscribe')) return true;

  return false;
}

/** The earliest match wins; everything from it onward is dropped. */
const QUOTE_MARKERS: ReadonlyArray<RegExp> = [
  /^\s*On .{0,200}wrote:\s*$/m,               // Gmail / Apple Mail
  /^\s*-{2,}\s*Original Message\s*-{2,}/im,   // Outlook classic
  /^\s*_{5,}\s*$/m,                           // Outlook divider
  /^\s*From:\s.+\nSent:\s.+$/m,               // Outlook top-post block
  /^\s*Le .{0,200}a écrit\s*:\s*$/m,          // French clients
  /^>/m,                                      // first quoted line
  /^\s*--\s*$/m,                              // signature delimiter
];

/** Falls back to the full text when stripping would leave nothing. */
function stripQuotedReply(text: string): string {
  let cut = text.length;

  for (const re of QUOTE_MARKERS) {
    const m = re.exec(text);

    if (m && m.index < cut) cut = m.index;
  }

  const stripped = text.slice(0, cut).trim();

  return stripped.length > 0 ? stripped : text.trim();
}

export interface ParsedInboundEmail {
  subject: string;
  body_text: string;
  message_id: string | null;
  in_reply_to: string | null;
  references: string | null;
  attachments: EmailAttachmentMeta[];
}

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

function inboundBody(text: string | undefined, html: string | undefined): string {
  if (text !== undefined && text.trim() !== '') return text;

  if (html !== undefined) return htmlToText(html);

  return '';
}

function attachmentSize(content: ArrayBuffer | Uint8Array | string): number {
  return content instanceof ArrayBuffer || content instanceof Uint8Array
    ? content.byteLength
    : content.length;
}

export async function parseInboundMime(raw: ArrayBuffer): Promise<ParsedInboundEmail> {
  const parsed = await PostalMime.parse(raw);

  const text = inboundBody(parsed.text, parsed.html);

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
