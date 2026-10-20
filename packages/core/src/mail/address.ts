/**
 * Mail addresses (docs/MAIL.md §1). Every box hangs under the account's username, so a workspace or agent rename
 * never collides with another account's:
 *
 * - `<username>@D`: the person's own box, read by their Personal assistant;
 * - `<workspace>.<username>@D`: a workspace's box, read by its main agent;
 * - `<agent>.<workspace>.<username>@D`: an agent's own box.
 *
 * Any of them may carry `+<tag>`: the same box, the tag kept with the message. A box's path is its address's local
 * part without the username: `''`, `<workspace>`, `<agent>.<workspace>`.
 */

/** One label: lowercase letters, digits and inner hyphens, at most 20 long, as a username is. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/u;

const TAG = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export interface MailRecipient {
  readonly username: string;
  /** The box under the username: `''`, `<workspace>` or `<agent>.<workspace>`. */
  readonly path: string;
  readonly tag: string | null;
}

/** The box an address names on `domain`, or null when it names none. */
export function parseMailRecipient(address: string, domain: string): MailRecipient | null {
  const at = address.lastIndexOf('@');

  if (at <= 0 || address.slice(at + 1).toLowerCase() !== domain.toLowerCase()) return null;

  const local = address.slice(0, at).toLowerCase();
  const plus = local.indexOf('+');
  const tag = plus < 0 ? null : local.slice(plus + 1);
  const labels = (plus < 0 ? local : local.slice(0, plus)).split('.');

  if (tag !== null && !TAG.test(tag)) return null;

  if (labels.length > 3 || !labels.every((label) => LABEL.test(label))) return null;

  const username = labels.at(-1) ?? '';

  return { username, path: labels.slice(0, -1).join('.'), tag };
}

/** The address of the box at `path` under `username`. */
export function mailAddressOf(username: string, path: string, domain: string): string {
  return `${path === '' ? '' : `${path}.`}${username}@${domain}`;
}

/**
 * A name as an address label: lowercased, `.` and `_` (and anything else a label cannot hold) turned into `-`, cut
 * to 20 characters, with no hyphen at either end. Null when nothing usable is left. The caller makes it unique per
 * person (`-2`, `-3`, …) against the labels it already holds.
 */
export function mailLabelOf(name: string): string | null {
  const label = name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+/u, '').slice(0, 20).replace(/-+$/u, '');

  return LABEL.test(label) ? label : null;
}

/** Usernames no account may have: the mailbox names mail systems and people expect to reach a deployment's operator. */
const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'postmaster', 'abuse', 'admin', 'administrator', 'noreply', 'no-reply', 'mail', 'mailer-daemon', 'ops', 'dmarc', 'security',
  'support', 'root', 'www', 'hostmaster', 'webmaster', 'info', 'help', 'billing',
]);

/** Why `username` cannot be anyone's: not a label (`invalid`), or one mail systems need (`reserved`); null when it can. */
export function mailUsernameRefusal(username: string): 'invalid' | 'reserved' | null {
  if (!LABEL.test(username)) return 'invalid';

  return RESERVED_USERNAMES.has(username) ? 'reserved' : null;
}

/**
 * The username a person is offered: their first name as it reads in an address (accents dropped), else their sign-in
 * email's local part; null when neither makes one they may have.
 */
export function suggestedMailUsername(person: { readonly displayName: string | null; readonly email: string }): string | null {
  const plain = (text: string): string => text.normalize('NFD').replace(/\p{M}+/gu, '');
  const firstName = plain(person.displayName?.trim().split(/\s+/u)[0] ?? '');
  const local = plain(person.email.slice(0, Math.max(0, person.email.lastIndexOf('@'))));

  return [mailLabelOf(firstName), mailLabelOf(local)].find((label): label is string => label !== null && mailUsernameRefusal(label) === null) ?? null;
}
