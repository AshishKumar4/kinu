import type { ObjectPattern } from 'oxc-parser';
import { moduleEdges } from './module-edges';
import { collapsePath, IMPORT_CANDIDATES, importUses, literalString, NAMESPACE, parse, type SyntaxNode } from './syntax';

function memberName(node: SyntaxNode): string | undefined {
  const raw = node.raw;

  if (raw.type !== 'MemberExpression') return undefined;

  return !raw.computed && raw.property.type === 'Identifier' ? raw.property.name : literalString(raw.property);
}

/** Wrappers that change only a value's static type, so `env` read through them is still `env`. */
const TYPE_ONLY_WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'ParenthesizedExpression']);

function destructuredBindings(file: string, pattern: ObjectPattern): string[] {
  return pattern.properties.map((property) => {
    if (property.type === 'RestElement') throw new Error(`${file}: rest-destructuring workerd env does not name its Worker bindings`);

    const name = !property.computed && property.key.type === 'Identifier' ? property.key.name : literalString(property.key);

    if (name === undefined) throw new Error(`${file}: workerd env binding must be named`);

    return name;
  });
}

function envBindings(file: string, text: string) {
  const parsed = parse(file, text);
  const bindings = new Set<string>();

  importUses(parsed.root, (origin, reference) => {
    if (origin.specifier !== 'cloudflare:test' && origin.specifier !== 'cloudflare:workers') return;

    if (reference.parent?.raw.type === 'TSTypeQuery') return;

    let nativeEnv = reference;

    if (origin.imported === NAMESPACE) {
      const access = reference.parent;

      if (access === undefined || memberName(access) !== 'env') return;
      nativeEnv = access;
    } else if (origin.imported !== 'env') return;

    while (nativeEnv.parent !== undefined && TYPE_ONLY_WRAPPERS.has(nativeEnv.parent.raw.type)) nativeEnv = nativeEnv.parent;

    const access = nativeEnv.parent;

    if (access?.raw.type === 'MemberExpression' && access.raw.object === nativeEnv.raw) {
      const name = memberName(access);

      if (name === undefined) throw new Error(`${file}:${String(parsed.lineAt(access.start))}: workerd env binding must be named; a computed binding cannot select its Worker`);
      bindings.add(name);

      return;
    }

    if (access?.raw.type === 'VariableDeclarator' && access.raw.init === nativeEnv.raw && access.raw.id.type === 'ObjectPattern') {
      for (const name of destructuredBindings(file, access.raw.id)) bindings.add(name);

      return;
    }

    throw new Error(`${file}:${String(parsed.lineAt(reference.start))}: workerd env must name the binding it uses`);
  });

  return { bindings, imports: moduleEdges(parsed).edges.filter(edge => edge.kind === 'value' && edge.specifier.startsWith('.')).map(edge => edge.specifier) };
}

/** Requirements come from native env imports and the binding targets supplied to Miniflare. */
export function workerdRequirements(
  sources: ReadonlyMap<string, string>,
  targets: ReadonlyMap<string, string | undefined>,
  auxiliaryWorkers: ReadonlySet<string>,
  root: string,
): Map<string, string[]> {
  const modules = new Map<string, ReturnType<typeof envBindings>>();
  const requirements = new Map<string, string[]>();

  for (const file of sources.keys()) {
    if (!file.startsWith(`${root}/tests/workerd/`) || !file.endsWith('.test.ts')) continue;

    const workers = new Set<string>();
    const visited = new Set<string>();
    const pending = [file];

    while (pending.length > 0) {
      const dependency = pending.pop();

      if (dependency === undefined || visited.has(dependency)) continue;
      visited.add(dependency);

      let module = modules.get(dependency);

      if (module === undefined) {
        const text = sources.get(dependency);

        if (text === undefined) throw new Error(`${file}: workerd dependency ${dependency} has no source`);
        module = envBindings(dependency, text);
        modules.set(dependency, module);
      }

      for (const binding of module.bindings) {
        if (!targets.has(binding)) throw new Error(`${file}: workerd binding ${binding} is not declared`);
        const worker = targets.get(binding);

        if (worker === undefined) continue;

        if (!auxiliaryWorkers.has(worker)) throw new Error(`${file}: Worker ${worker} for binding ${binding} is not declared`);
        workers.add(worker);
      }

      for (const specifier of module.imports) {
        const base = collapsePath(`${dependency.slice(0, dependency.lastIndexOf('/') + 1)}${specifier}`);

        const target = IMPORT_CANDIDATES.map(suffix => base + suffix).find(candidate => sources.has(candidate));

        if (target !== undefined) pending.push(target);
      }
    }

    const selected = [...workers].sort((left, right) => left.localeCompare(right));
    
    requirements.set(file.slice(root.length + 1), selected);
  }

  return requirements;
}
