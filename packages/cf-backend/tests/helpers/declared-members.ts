/**
 * The members a Durable Object class body declares, read from source: `private`/`protected` are gone at
 * runtime and the base is stubbed under bun. Deliberately broad over member forms, so none slips through.
 */
export interface DeclaredMember {
  modifiers: string;
  name: string;
  params: string;
}

const DECLARATION = /^ {2}((?:@[A-Za-z_$][A-Za-z0-9_$]*\([^\n]*?\)\s+)*)((?:public |protected |private |static |readonly |override |async |\* |get |set )*)([A-Za-z_$][A-Za-z0-9_$]*)(<[^()]*>)?\(/gm;

/** The text between `open` (an index pointing at `(`) and its matching `)`. */
function balancedParams(source: string, open: number): string | null {
  let depth = 0;

  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) return source.slice(open + 1, i).trim();
  }

  return null;
}

export function declaredClassMembers(source: string): DeclaredMember[] {
  const members: DeclaredMember[] = [];

  for (const match of source.matchAll(DECLARATION)) {
    const name = match[3];

    if (name === 'constructor') continue;
    const params = balancedParams(source, match.index + match[0].length - 1);

    if (params === null) continue;
    members.push({ modifiers: match[2].trim(), name, params });
  }

  return members;
}

export function isInternalMember(member: DeclaredMember): boolean {
  return /\b(private|protected|static)\b/.test(member.modifiers);
}
