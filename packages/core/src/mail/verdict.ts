/**
 * Whether an inbound message is verified: Cloudflare's own DMARC verdict, read where Cloudflare writes it.
 *
 * Measured 2026-10-19 (docs/MAIL.md §4): Cloudflare's MX prepends its fields above everything the sender wrote, its
 * `Received ... by cloudflare-email.net` first and its `Authentication-Results: mx.cloudflare.net; ...` among them. A
 * sender's own `Authentication-Results: mx.cloudflare.net; dmarc=pass ...` arrives intact further down, so the
 * authserv-id alone proves nothing: the verdict is the FIRST Authentication-Results field of the raw header block,
 * and only while the block opens with Cloudflare's Received field. `message.headers` joins every such field into one
 * value and is never read for this. The runtime exposes no verdict of its own.
 *
 * Verified means that field says `dmarc=pass header.from=<d>` and `<d>` is the domain of the message's one From
 * address. DMARC names a domain, not a mailbox: anyone the domain lets send passes the same way.
 */

const AUTHSERV_ID = 'mx.cloudflare.net';

/** Cloudflare's own Received field, which opens the header block of every message its MX delivers. */
const CLOUDFLARE_RECEIVED = /\bby cloudflare-email\.net\b/iu;

interface MailVerdict {
  readonly verified: boolean;
  /** The one From address, lowercased; null when the message has none, or more than one. */
  readonly from: string | null;
  /** That address's domain. */
  readonly domain: string | null;
  /** The Authentication-Results field the verdict was read from, unfolded; null when there was none to read. */
  readonly auth: string | null;
}

interface Field {
  readonly name: string;
  readonly value: string;
}

/** The header block's fields in order, each unfolded onto one line. */
function headerFields(raw: string): Field[] {
  const text = raw.replaceAll('\r\n', '\n');
  const end = text.indexOf('\n\n');
  const block = end < 0 ? text : text.slice(0, end);
  const fields: Field[] = [];

  for (const line of block.split('\n')) {
    const last = fields.at(-1);

    if (/^[ \t]/u.test(line) && last !== undefined) {
      fields[fields.length - 1] = { name: last.name, value: `${last.value} ${line.trim()}` };
    } else {
      const colon = line.indexOf(':');

      if (colon > 0) fields.push({ name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() });
    }
  }

  return fields;
}

/** The addresses a From value names: display names, quoted strings and comments set aside. */
function addresses(value: string): string[] {
  const found: string[] = [];
  let current = '';
  let quoted = false;
  let comment = 0;
  let angle = '';
  let inAngle = false;

  const finish = (): void => {
    const address = (angle !== '' ? angle : current).trim();

    if (address !== '') found.push(address);
    current = '';
    angle = '';
  };

  for (const char of value) {
    if (quoted) {
      if (char === '"') quoted = false;
    } else if (comment > 0) {
      if (char === '(') comment += 1;
      else if (char === ')') comment -= 1;
    } else if (inAngle) {
      if (char === '>') inAngle = false;
      else angle += char;
    } else if (char === '"') quoted = true;
    else if (char === '(') comment = 1;
    else if (char === '<') { inAngle = true; angle = ''; }
    else if (char === ',') finish();
    else current += char;
  }

  finish();

  return found;
}

/** One result of an Authentication-Results value (RFC 8601 §2.2): its method, its result, and its properties. */
interface ResultInfo {
  readonly method: string;
  readonly result: string;
  readonly properties: ReadonlyMap<string, string>;
}

/** An Authentication-Results value: who wrote it (its authserv-id), then its results in order. */
interface AuthenticationResults {
  readonly authservId: string;
  readonly results: readonly ResultInfo[];
}

/**
 * An Authentication-Results value as RFC 8601 reads it: comments (nested, with quoted-pairs) set aside, `;` separating
 * results only outside a quoted string, and each result `method=result` first, then `ptype.property=value` pairs.
 * Cloudflare copies what a sender controls into its field (a DKIM selector, the envelope sender in SPF's comment and
 * smtp.mailfrom), so a `;` or a `dmarc=` inside those must stay inside them. The authserv-id first, then the results.
 */
function authenticationResults(value: string): AuthenticationResults {
  const statements: string[][] = [[]];
  let word = '';
  let quoted = false;
  let comment = 0;
  let escaped = false;

  const endWord = (): void => {
    if (word !== '') statements.at(-1)?.push(word);
    word = '';
  };

  for (const char of value) {
    if (escaped) {
      if (comment === 0) word += char;
      escaped = false;
    } else if (char === '\\' && (quoted || comment > 0)) escaped = true;
    else if (comment > 0) {
      if (char === '(') comment += 1;
      else if (char === ')') comment -= 1;
    } else if (quoted) {
      if (char === '"') quoted = false;
      else word += char;
    } else if (char === '"') quoted = true;
    else if (char === '(') { endWord(); comment = 1; }
    else if (char === ';') { endWord(); statements.push([]); }
    else if (/\s/u.test(char)) endWord();
    else word += char;
  }

  endWord();
  const [head = [], ...rest] = statements;

  const results = rest.flatMap((words): ResultInfo[] => {
    const [first, ...others] = words;
    const resultOf = first === undefined ? null : /^([a-z0-9-]+)=([a-z]+)$/iu.exec(first);

    if (resultOf === null) return [];
    const properties = new Map<string, string>();

    for (const pair of others) {
      const at = pair.indexOf('=');

      // `reason=` is the result's own words, not a property; anything else unnamed is not one either.
      if (at > 0 && pair.slice(0, at).includes('.')) properties.set(pair.slice(0, at).toLowerCase(), pair.slice(at + 1));
    }

    return [{ method: (resultOf[1] ?? '').toLowerCase(), result: (resultOf[2] ?? '').toLowerCase(), properties }];
  });

  return { authservId: (head[0] ?? '').toLowerCase(), results };
}

/** The one DMARC result and its `header.from`; null when there is none, or more than one to choose between. */
function dmarcOf(value: string): { result: string; domain: string | null } | null {
  const dmarc = authenticationResults(value).results.filter((info) => info.method === 'dmarc');
  const [only] = dmarc;

  return dmarc.length !== 1 || only === undefined ? null : { result: only.result, domain: only.properties.get('header.from')?.toLowerCase() ?? null };
}

export function mailVerdict(raw: string): MailVerdict {
  const fields = headerFields(raw);
  const froms = fields.filter((field) => field.name === 'from');
  const named = froms.length === 1 ? addresses(froms[0]?.value ?? '') : [];
  const from = named.length === 1 && /^[^@\s]+@[^@\s]+$/u.test(named[0] ?? '') ? (named[0] ?? '').toLowerCase() : null;
  const domain = from === null ? null : from.slice(from.lastIndexOf('@') + 1);
  const opensWithCloudflare = fields[0]?.name === 'received' && CLOUDFLARE_RECEIVED.test(fields[0].value);
  const first = opensWithCloudflare ? fields.find((field) => field.name === 'authentication-results') : undefined;
  const auth = first?.value ?? null;

  if (first === undefined || domain === null) return { verified: false, from, domain, auth };

  const dmarc = dmarcOf(first.value);
  const verified = authenticationResults(first.value).authservId === AUTHSERV_ID && dmarc?.result === 'pass' && dmarc.domain === domain;

  return { verified, from, domain, auth };
}
