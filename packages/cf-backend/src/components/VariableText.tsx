import type { ReactNode } from "react";

export function variableReferences(text: string): readonly { index: number; text: string }[] {
  return [...text.matchAll(/\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/gu)]
    .filter((match) => text.charAt(match.index - 1) !== '$')
    .map((match) => ({ index: match.index, text: match[0] }));
}

export function VariableText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let from = 0;

  for (const reference of variableReferences(text)) {
    parts.push(text.slice(from, reference.index));
    parts.push(<code className="p-code-inline" key={reference.index}>{reference.text}</code>);
    from = reference.index + reference.text.length;
  }

  parts.push(text.slice(from));

  return <>{parts}</>;
}
