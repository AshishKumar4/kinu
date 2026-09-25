/**
 * A strict reader for the XML subset test reporters write. No XML parser is a
 * declared dependency, so this is owned, over XML 1.0 without namespaces or a
 * DTD internal subset:
 *
 *   document  := node*
 *   node      := element | text | comment | cdata | pi | doctype
 *   element   := '<' name (S name S? '=' S? quoted)* S? ('/>' | '>' node* '</' name S? '>')
 *   quoted    := '"' (char but '<' '"' | reference)* '"' | "'" (char but '<' "'" | reference)* "'"
 *   text      := (char but '<' | reference)*
 *   reference := '&lt;' | '&gt;' | '&amp;' | '&quot;' | '&apos;' | '&#' digits ';' | '&#x' hex ';'
 *   comment   := '<!--' … '-->'     cdata := '<![CDATA[' … ']]>'     pi := '<?' … '?>'
 *   doctype   := '<!DOCTYPE' (char but '>' '[')* '>'
 *
 * Anything else throws with its offset: a report this reader cannot read is a
 * refusal, never a smaller set of testcases.
 */

export interface XmlElement {
  readonly kind: 'element';
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
}

export type XmlNode = XmlElement | { readonly kind: 'text'; readonly text: string };

const NAMED = new Map([['lt', '<'], ['gt', '>'], ['amp', '&'], ['quot', '"'], ['apos', "'"]]);

const isSpace = (char: string | undefined): boolean => char === ' ' || char === '\t' || char === '\n' || char === '\r';

const isNameChar = (char: string | undefined): boolean =>
  char !== undefined && !isSpace(char) && !'<>/=!?"\'&'.includes(char);

export function parseXml(xml: string): readonly XmlNode[] {
  let at = 0;

  const fail = (what: string): never => {
    throw new Error(`xml: ${what} at offset ${String(at)}`);
  };

  const skipPast = (terminator: string): string => {
    const end = xml.indexOf(terminator, at);

    if (end === -1) fail(`unterminated construct, expected ${terminator}`);
    const body = xml.slice(at, end);
    at = end + terminator.length;

    return body;
  };

  const decode = (raw: string): string => {
    let out = '';
    let from = 0;

    for (let amp = raw.indexOf('&'); amp !== -1; amp = raw.indexOf('&', from)) {
      const semi = raw.indexOf(';', amp);

      if (semi === -1) fail('unterminated reference');
      const name = raw.slice(amp + 1, semi);
      const hex = name.startsWith('#x');
      const code = name.startsWith('#') ? Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10) : Number.NaN;
      const char = NAMED.get(name) ?? (Number.isInteger(code) ? String.fromCodePoint(code) : fail(`unknown reference &${name};`));
      out += raw.slice(from, amp) + char;
      from = semi + 1;
    }

    return out + raw.slice(from);
  };

  const readName = (): string => {
    const start = at;

    while (isNameChar(xml[at])) at += 1;

    if (at === start) fail('expected a name');

    return xml.slice(start, at);
  };

  const skipSpace = (): void => {
    while (isSpace(xml[at])) at += 1;
  };

  const readNodes = (parent: string | undefined): XmlNode[] => {
    const nodes: XmlNode[] = [];

    while (at < xml.length) {
      if (xml.startsWith('</', at)) {
        at += 2;
        const name = readName();
        skipSpace();

        if (name !== parent || xml[at] !== '>') fail(`</${name}> does not close <${parent ?? 'document'}>`);
        at += 1;

        return nodes;
      }

      if (xml.startsWith('<!--', at)) {
        at += 4;
        skipPast('-->');
      } else if (xml.startsWith('<![CDATA[', at)) {
        at += 9;
        nodes.push({ kind: 'text', text: skipPast(']]>') });
      } else if (xml.startsWith('<?', at)) {
        skipPast('?>');
      } else if (xml.startsWith('<!DOCTYPE', at)) {
        const body = skipPast('>');

        if (body.includes('[')) fail('a DOCTYPE internal subset is outside this reader');
      } else if (xml[at] === '<') {
        at += 1;
        nodes.push(readElement());
      } else {
        const end = xml.indexOf('<', at);
        nodes.push({ kind: 'text', text: decode(xml.slice(at, end === -1 ? xml.length : end)) });
        at = end === -1 ? xml.length : end;
      }
    }

    if (parent !== undefined) fail(`<${parent}> is never closed`);

    return nodes;
  };

  const readElement = (): XmlElement => {
    const name = readName();
    const attributes: Record<string, string> = {};

    for (;;) {
      const spaced = isSpace(xml[at]);
      skipSpace();

      if (xml.startsWith('/>', at)) {
        at += 2;

        return { kind: 'element', name, attributes, children: [] };
      }

      if (xml[at] === '>') {
        at += 1;

        return { kind: 'element', name, attributes, children: readNodes(name) };
      }

      if (!spaced) fail(`expected whitespace before an attribute of <${name}>`);
      const attribute = readName();
      skipSpace();

      if (xml[at] !== '=') fail(`attribute ${attribute} has no value`);
      at += 1;
      skipSpace();
      const quote = xml[at];

      if (quote !== '"' && quote !== "'") fail(`attribute ${attribute} is not quoted`);
      at += 1;
      const raw = skipPast(quote);

      if (raw.includes('<')) fail(`attribute ${attribute} contains <`);

      if (Object.hasOwn(attributes, attribute)) fail(`attribute ${attribute} repeats`);
      attributes[attribute] = decode(raw);
    }
  };

  return readNodes(undefined);
}

/** Every element named `name` at any depth, outermost first. */
export function elementsNamed(nodes: readonly XmlNode[], name: string): XmlElement[] {
  return nodes.flatMap((node) => {
    if (node.kind === 'text') return [];

    return node.name === name ? [node] : elementsNamed(node.children, name);
  });
}

/** The text and attribute values under an element, decoded. */
export function textOf(element: XmlElement): string {
  return [...Object.values(element.attributes), ...element.children
    .map((child) => child.kind === 'text' ? child.text : textOf(child))].join('\n');
}
