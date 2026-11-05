/** Where an ES module names the modules it loads: every static import and re-export, and each `import('…')` of a literal. */
import * as acorn from 'acorn';
import { Result } from 'effect';
import * as v from 'valibot';

/** One specifier as written: its value, and the span of its string literal, quotes included. */
export interface ModuleSpecifier {
  readonly specifier: string;
  readonly start: number;
  readonly end: number;
}

const PARSE: acorn.Options = { ecmaVersion: 'latest', sourceType: 'module' };

/** A node of the parsed module, as the walk reads it: anything with a string `type`. */
const SyntaxNodeSchema = v.looseObject({ type: v.string() });

type SyntaxNode = Readonly<Pick<v.InferOutput<typeof SyntaxNodeSchema>, 'type'>>;

const Span = { start: v.number(), end: v.number() };

/** A quoted string. */
const StringSchema = v.looseObject({ type: v.literal('Literal'), value: v.string(), ...Span });

/** A template with no substitution: one string, as a quoted one is. */
const PlainTemplateSchema = v.looseObject({
  type: v.literal('TemplateLiteral'), expressions: v.strictTuple([]), quasis: v.looseTuple([v.looseObject({ value: v.looseObject({ cooked: v.string() }) })]), ...Span,
});

/** `import … from '…'`, `export … from '…'` and `export * from '…'`. */
const StaticSchema = v.looseObject({ type: v.picklist(['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration']), source: StringSchema });

/** `import('…')` or `import(`…`)`. */
const DynamicSchema = v.looseObject({ type: v.literal('ImportExpression'), source: v.union([StringSchema, PlainTemplateSchema]) });

/** Each specifier `code` loads, in source order; null where it does not parse as a module. */
export function moduleSpecifiers(code: string): ModuleSpecifier[] | null {
  const parsed = Result.try(() => acorn.parse(code, PARSE));

  if (Result.isFailure(parsed)) return null;
  const found: ModuleSpecifier[] = [];

  for (const node of nodesOf(parsed.success)) {
    const source = sourceOf(node);

    if (source !== null) found.push(source);
  }

  return found.sort((left, right) => left.start - right.start);
}

function sourceOf(node: SyntaxNode): ModuleSpecifier | null {
  if (v.is(StaticSchema, node)) return { specifier: node.source.value, start: node.source.start, end: node.source.end };

  if (!v.is(DynamicSchema, node)) return null;
  const { source } = node;

  return { specifier: source.type === 'Literal' ? source.value : source.quasis[0].value.cooked, start: source.start, end: source.end };
}

/** Every node of `root`, depth first. */
function* nodesOf(root: SyntaxNode): Generator<SyntaxNode> {
  const stack: SyntaxNode[] = [root];

  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    yield node;
    const values: readonly unknown[] = Object.values(node);

    for (const value of values) {
      const children: readonly unknown[] = Array.isArray(value) ? value : [value];

      for (const child of children) if (v.is(SyntaxNodeSchema, child)) stack.push(child);
    }
  }
}
