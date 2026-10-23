/** A raw message as the Mailbox files it: postal-mime's reading, with quoted history set aside from the words. */
import type { Address, Email } from 'postal-mime';
import type { MailParty } from '@kinu.run/core';
import { inboundBody, stripQuotedReply, type ParsedMail } from '@kinu.run/core';

/** Each address an address field names, a group's members included. */
function parties(field: readonly Address[] | Address | undefined): MailParty[] {
  if (field === undefined) return [];
  const list = Array.isArray(field) ? field : [field];

  return list.flatMap((each) => (each.group === undefined ? [each] : each.group))
    .filter((each) => each.address !== undefined && each.address !== '')
    .map((each) => ({ name: each.name === '' ? null : each.name, address: (each.address ?? '').toLowerCase() }));
}

function bytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === 'string') return new TextEncoder().encode(content);

  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

async function postalMime(raw: Uint8Array): Promise<Email> {
  // Loaded with the first message, not at the Worker's start (armada 20261007213937-cdf08921).
  return (await import('postal-mime')).default.parse(raw);
}

/** A message as it would leave, for an approval card: every recipient it is sent to, Bcc's too, and its words. */
export async function readOutgoing(raw: Uint8Array): Promise<Pick<ParsedMail, 'to' | 'cc' | 'subject' | 'text'> & { readonly bcc: ParsedMail['cc'] }> {
  const parsed = await postalMime(raw);

  return {
    to: parties(parsed.to), cc: parties(parsed.cc), bcc: parties(parsed.bcc),
    subject: parsed.subject?.trim() ?? '', text: (await inboundBody(parsed.text, parsed.html)).trimEnd(),
  };
}

export async function parseMail(raw: Uint8Array): Promise<ParsedMail> {
  const parsed = await postalMime(raw);
  const text = (await inboundBody(parsed.text, parsed.html)).trimEnd();

  return {
    from: parties(parsed.from)[0] ?? null,
    to: parties(parsed.to),
    cc: parties(parsed.cc),
    subject: parsed.subject === undefined || parsed.subject.trim() === '' ? '(no subject)' : parsed.subject.trim(),
    messageId: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
    references: (parsed.references ?? '').split(/\s+/u).filter(Boolean),
    text,
    ownWords: stripQuotedReply(text),
    html: parsed.html ?? null,
    attachments: parsed.attachments.map((file) => ({
      filename: file.filename ?? 'unnamed', contentType: file.mimeType, content: bytes(file.content),
    })),
  };
}
