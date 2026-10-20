/**
 * A message's fields, as the person's sends (`/api/user/mail/send`, drafts) and an agent's (`mail.send`, `mail.draft`)
 * both take them: one definition of an address, the recipients and the subject. The text's limit is the one field the
 * two callers differ in, by a named policy.
 */
import * as v from 'valibot';

/** An address as written. Lowercasing is `mailAddress`'s, not the schema's: an operation's schema is also its JSON Schema,
 *  which no transformation converts to. */
export const MailAddress = v.pipe(v.string(), v.trim(), v.email(), v.maxLength(254));

/** An address as the Mailbox files and compares it. */
export function mailAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** A message's recipients as filed and sent, each in the Mailbox's form: what an approval shows is what leaves. */
export function filedRecipients<M extends MailMessageFields>(message: M): M & { readonly cc: readonly string[] } {
  return { ...message, to: message.to.map(mailAddress), cc: (message.cc ?? []).map(mailAddress) };
}

/** Who writes a message, for its text's limit: the person in the app writes as much as they like; an agent, what one
 *  approval card can show whole. */
const MAIL_TEXT_LIMIT = { person: 1_000_000, agent: 50_000 } as const;

export const MAIL_MESSAGE_FIELDS = {
  to: v.pipe(v.array(MailAddress), v.minLength(1), v.maxLength(50)),
  cc: v.optional(v.pipe(v.array(MailAddress), v.maxLength(50))),
  // RFC 5322's line limit.
  subject: v.pipe(v.string(), v.maxLength(998)),
};

/** A message's text for `by`. */
export function mailText(by: keyof typeof MAIL_TEXT_LIMIT) {
  return v.pipe(v.string(), v.maxLength(MAIL_TEXT_LIMIT[by]));
}

/** The fields every message has, whoever writes it. */
export interface MailMessageFields {
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly subject: string;
  readonly text: string;
}
