import { literalString, literalText, walk } from './syntax';
import type { Parsed, SyntaxNode } from './syntax';

export type EdgeKind = 'value' | 'type' | 'text';

export interface ModuleEdge {
  readonly specifier: string;
  readonly line: number;
  readonly kind: EdgeKind;
}

export interface ModuleEdges {
  readonly edges: readonly ModuleEdge[];
  /** Lines carrying an `import(expr)` or `require(expr)` over a non-literal. */
  readonly computed: readonly number[];
  /** Lines carrying `import.meta.resolve(expr)` over a non-literal: a path
   *  computed at runtime, which is a read by path rather than a module edge. */
  readonly resolvedByPath: readonly number[];
}

const attributeName = (attribute: { key: { type: string; name?: string; value?: unknown } }): string =>
  attribute.key.type === 'Identifier' ? attribute.key.name ?? '' : String(attribute.key.value);

/** A type-only import is erased; Markdown read `with { type: 'text' }` is data;
 *  everything else loads a module. */
function importEdgeKind(erased: boolean, asText: boolean): EdgeKind {
  if (erased) return 'type';

  return asText ? 'text' : 'value';
}

/** Every module reference in one parsed file, with its kind and line. */
export function moduleEdges(parsed: Parsed): ModuleEdges {
  const edges: ModuleEdge[] = [];
  const computed: number[] = [];
  const resolvedByPath: number[] = [];

  walk(parsed.root, (node: SyntaxNode) => {
    const { raw } = node;
    const line = parsed.lineAt(node.start);

    if (raw.type === 'ImportDeclaration') {
      const asText = raw.source.value.endsWith('.md')
        && raw.attributes.some((attribute) => attributeName(attribute) === 'type' && attribute.value.value === 'text');

      const kind = importEdgeKind(raw.importKind === 'type', asText);

      edges.push({ specifier: raw.source.value, line, kind });

      return;
    }

    if (raw.type === 'ExportNamedDeclaration' || raw.type === 'ExportAllDeclaration') {
      if (raw.source === null || raw.source === undefined) return;
      edges.push({ specifier: raw.source.value, line, kind: raw.exportKind === 'type' ? 'type' : 'value' });

      return;
    }

    if (raw.type === 'ImportExpression') {
      const literal = node.children.find((child) => child.raw.type === 'Literal');
      const source = literal === undefined ? undefined : literalText(literal);

      if (source !== undefined && raw.source.type === 'Literal') edges.push({ specifier: source, line, kind: 'value' });
      else if (!(raw.source.type === 'TemplateLiteral' && raw.source.quasis[0]?.value.cooked?.startsWith('data:') === true)) computed.push(line);

      return;
    }

    if (raw.type !== 'CallExpression') return;
    const callee = raw.callee;

    const isRequire = callee.type === 'Identifier' && callee.name === 'require';

    const isMetaResolve = callee.type === 'MemberExpression' && !callee.computed
      && callee.property.type === 'Identifier' && callee.property.name === 'resolve'
      && callee.object.type === 'MetaProperty';

    if (!isRequire && !isMetaResolve) return;
    const [argument] = raw.arguments;
    const specifier = argument === undefined ? undefined : literalString(argument);

    if (specifier === undefined) {
      (isMetaResolve ? resolvedByPath : computed).push(line);

      return;
    }

    edges.push({ specifier, line, kind: 'value' });
  });

  return { edges, computed, resolvedByPath };
}
