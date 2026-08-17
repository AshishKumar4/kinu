/**
 * Prompt-section templating: prose is data, control flow stays in TypeScript.
 *
 * Why this exists. GEPA optimises any string candidate (`evolution/gepa/types.ts`
 * names "a system-prompt section" as a target), but prose written as
 * `lines.push('...')` is not addressable — it is compiled into the bundle, so the
 * agent cannot rewrite a section without a deploy, and the only self-artifact the
 * runtime exposes as data is `identity.scaffold`. A section defined as a template
 * string is a VALUE: readable, scorable, replaceable. That is the whole point.
 *
 * Why there is no `{{#if}}` / `{{#each}}`. Branching stays in TypeScript, where
 * the tool and stance unions are exhaustive and an unreachable branch is a type
 * error. A template conditional is an untyped string lookup that renders empty
 * when it misses — the failure mode that already left two mode overlays dead in
 * the live prompt. Iteration likewise stays in TypeScript: the caller maps over a
 * typed list and renders one line per item. Prose is data; logic is code.
 *
 * Why a missing slot throws. A prompt section that silently renders empty is
 * invisible — the model simply behaves differently and nothing reports it. Every
 * slot must be supplied; an empty string is a legal value, an absent key is not.
 */

/**
 * The slot names a template source declares, read off its literal type.
 *
 * Recursive over the source: each `{{name}}` contributes `name` and the tail is
 * re-matched, so the union is exact and duplicates collapse.
 */
type SlotName<Source extends string> =
  Source extends `${string}{{${infer Name}}}${infer Rest}`
    ? Name | SlotName<Rest>
    : never;

/**
 * Exactly the data a template needs. The template declares its own contract:
 * omitting a slot fails to compile, and an invented slot is an excess property.
 * A source that is not a literal type (one loaded at runtime) yields no slots,
 * and its render is checked at runtime instead — see `renderTemplate`.
 */
export type TemplateSlots<Source extends string> = {
  readonly [Name in SlotName<Source>]: string;
};

/**
 * A template split at its slots. `literals.length === slots.length + 1`, so
 * rendering is one pass with no scanning and no allocation beyond the output.
 */
interface CompiledTemplate {
  readonly literals: readonly string[];
  readonly slots: readonly string[];
}

/**
 * A slot is `{{name}}` with no inner spaces.
 *
 * The strictness is load-bearing, not fussiness: `SlotName` above infers
 * whatever sits between the braces, so a runtime parser that trimmed `{{ name }}`
 * to `name` would disagree with a type that inferred `" name "` — the contract
 * and the lookup would diverge silently. One grammar, checked in both places.
 */
const SLOT_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

function compileTemplate(id: string, source: string): CompiledTemplate {
  const literals: string[] = [];
  const slots: string[] = [];
  let pos = 0;
  for (;;) {
    const open = source.indexOf('{{', pos);
    if (open === -1) {
      literals.push(source.slice(pos));
      return { literals, slots };
    }
    const close = source.indexOf('}}', open + 2);
    if (close === -1) {
      throw new Error(`prompt template "${id}": unclosed {{ at index ${open}`);
    }
    const name = source.slice(open + 2, close);
    if (!SLOT_PATTERN.test(name)) {
      throw new Error(
        `prompt template "${id}": malformed slot "{{${name}}}" at index ${open} — `
        + `a slot is {{name}} with no spaces, matching ${SLOT_PATTERN.source}`,
      );
    }
    literals.push(source.slice(pos, open));
    slots.push(name);
    pos = close + 2;
  }
}

/**
 * Render in source order, one slot at a time. Order is positional and never
 * derived from the data, so the output is byte-stable: identical data renders
 * identical bytes, and changing one slot cannot disturb anything ahead of it.
 * That is what keeps the cacheable prompt prefix intact.
 */
function renderTemplate(
  id: string,
  compiled: CompiledTemplate,
  values: Readonly<Record<string, string>>,
): string {
  let out = compiled.literals[0];
  for (let i = 0; i < compiled.slots.length; i += 1) {
    const name = compiled.slots[i];
    const value = values[name];
    if (value === undefined) {
      const supplied = Object.keys(values);
      throw new Error(
        `prompt template "${id}": slot {{${name}}} has no value. `
        + `Supplied: ${supplied.length === 0 ? '(none)' : supplied.join(', ')}`,
      );
    }
    out += value + compiled.literals[i + 1];
  }
  return out;
}

/**
 * One addressable piece of prompt prose.
 *
 * `id` is what an optimiser or an editor names this section by; `source` is the
 * evolvable artifact itself.
 */
export interface PromptSection<Source extends string> {
  readonly id: string;
  readonly source: Source;
  render(slots: TemplateSlots<Source>): string;
}

/**
 * Compile a section once, at module load. A malformed template throws on import
 * rather than on the turn that happens to render it.
 */
export function definePromptSection<const Source extends string>(
  id: string,
  source: Source,
): PromptSection<Source> {
  const compiled = compileTemplate(id, source);
  return {
    id,
    source,
    render: (slots) => renderTemplate(id, compiled, slots),
  };
}
