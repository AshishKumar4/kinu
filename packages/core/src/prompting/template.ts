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
 * Why `{{#if}}` is typed rather than absent. A section is only addressable if the
 * WHOLE section is one string, and nine of Kinu's are conditional — plan mode,
 * the model family, whether `hire` is wired. Building those with `lines.push` put
 * the prose back in the bundle and left GEPA a fragment to optimise. So the
 * conditional is here, and the objection it used to carry ("an untyped string
 * lookup that renders empty when it misses — the failure mode that already left
 * two mode overlays dead in the live prompt") is answered rather than avoided:
 * `{{#if flag}}` DECLARES a boolean slot exactly as `{{slot}}` declares a string
 * one. Omitting it does not compile; supplying it at runtime from a source the
 * type system never saw throws, like every other slot. There are no expressions —
 * a flag is one declared boolean and nothing else, so the branch condition is a
 * TypeScript expression at the call site where the unions are exhaustive.
 *
 * Why there is still no `{{#each}}`. Iteration stays in TypeScript: the caller
 * maps over a typed list and renders one line per item (`BUILTIN_TOOL_LINE`). A
 * loop needs a per-item scope, which needs paths, which needs an expression
 * language — and none of that can be checked against a literal type. Prose is
 * data; logic is code.
 *
 * Why a missing slot throws. A prompt section that silently renders empty is
 * invisible — the model simply behaves differently and nothing reports it. Every
 * slot must be supplied; an empty string is a legal value, an absent key is not.
 */

import * as v from 'valibot';

/**
 * Every `{{…}}` tag in a source, read off its literal type.
 *
 * Recursive over the source: each tag contributes its inner text and the tail is
 * re-matched, so the union is exact and duplicates collapse. Value slots and
 * block tags are separated from this one union below, so the two extractions
 * cannot disagree about what a tag is.
 */
type Tag<Source extends string> =
  Source extends `${string}{{${infer Name}}}${infer Rest}`
    ? Name | Tag<Rest>
    : never;

/** A tag that substitutes text. Distributes, so block tags drop out. */
type ValueTag<Name extends string> =
  Name extends `#${string}` | `/${string}` | 'else' ? never : Name;

/** A tag that opens a conditional, reduced to the boolean it declares. */
type BlockFlag<Name extends string> = Name extends `#if ${infer Flag}` ? Flag : never;

type SlotName<Source extends string> = ValueTag<Tag<Source>>;
type FlagName<Source extends string> = BlockFlag<Tag<Source>>;

/**
 * Exactly the data a template needs. The template declares its own contract:
 * `{{slot}}` requires a string, `{{#if flag}}` requires a boolean, omitting
 * either fails to compile, and an invented name is an excess property.
 * A source that is not a literal type (one loaded at runtime) yields no slots,
 * and its render is checked at runtime instead — see `renderNodes`.
 */
export type TemplateSlots<Source extends string> =
  & { readonly [Name in SlotName<Source>]: string }
  & { readonly [Name in FlagName<Source>]: boolean };

/** What a rendered template reads its values from. Two kinds, kept in one map
 *  so a call site writes one object literal against one typed contract. */
type SlotValues = Readonly<Record<string, string | boolean>>;

/** Which kind a value actually is. The compile-time contract answers this for
 *  every source the compiler can see; these answer it for the sources it
 *  cannot — a promoted candidate read out of a table. */
const TEXT_VALUE = v.string();
const FLAG_VALUE = v.boolean();

/**
 * A template as a node list. Text and slots are flat; a conditional owns its two
 * branches, so nesting costs a recursion and nothing else. Rendering walks the
 * list once, in source order, and allocates nothing beyond the output.
 */
type TemplateNode =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'slot'; readonly name: string }
  | {
      readonly kind: 'if';
      readonly flag: string;
      readonly whenTrue: readonly TemplateNode[];
      readonly whenFalse: readonly TemplateNode[];
    };

/**
 * A slot is `{{name}}` with no inner spaces.
 *
 * The strictness is load-bearing, not fussiness: `Tag` above infers whatever sits
 * between the braces, so a runtime parser that trimmed `{{ name }}` to `name`
 * would disagree with a type that inferred `" name "` — the contract and the
 * lookup would diverge silently. One grammar, checked in both places. `{{#if x}}`
 * is the one tag with an inner space, and its flag name is matched against this
 * same pattern for the same reason.
 */
const SLOT_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/** The conditional's open tag, spelled with exactly one space. */
const IF_PREFIX = '#if ';

/** One open `{{#if}}` while parsing: where its two branches collect, and which
 *  one is filling right now. */
interface OpenBlock {
  readonly flag: string;
  readonly whenTrue: TemplateNode[];
  readonly whenFalse: TemplateNode[];
  branch: 'then' | 'else';
}

function fail(id: string, message: string): never {
  throw new Error(`prompt template "${id}": ${message}`);
}

function pushText(into: TemplateNode[], text: string): void {
  if (text !== '') into.push({ kind: 'text', text });
}

function compileTemplate(id: string, source: string): TemplateNode[] {
  const root: TemplateNode[] = [];
  const open: OpenBlock[] = [];
  const top = (): TemplateNode[] => {
    const block = open.at(-1);
    if (!block) return root;
    return block.branch === 'then' ? block.whenTrue : block.whenFalse;
  };
  let pos = 0;
  for (;;) {
    const start = source.indexOf('{{', pos);
    if (start === -1) {
      pushText(top(), source.slice(pos));
      const unclosed = open.at(-1);
      if (unclosed) {
        fail(id, `unclosed {{${IF_PREFIX}${unclosed.flag}}} — every conditional needs its {{/if}}`);
      }
      return root;
    }
    const end = source.indexOf('}}', start + 2);
    if (end === -1) fail(id, `unclosed {{ at index ${start}`);
    pushText(top(), source.slice(pos, start));
    const name = source.slice(start + 2, end);
    pos = end + 2;

    if (name.startsWith(IF_PREFIX)) {
      const flag = name.slice(IF_PREFIX.length);
      if (!SLOT_PATTERN.test(flag)) {
        fail(id, `malformed flag "{{${name}}}" at index ${start} — a flag is `
          + `{{${IF_PREFIX}name}} with one space and no expression, matching ${SLOT_PATTERN.source}`);
      }
      open.push({ flag, whenTrue: [], whenFalse: [], branch: 'then' });
      continue;
    }
    if (name === 'else') {
      const block = open.at(-1);
      if (!block) fail(id, `{{else}} at index ${start} with no {{#if}} open`);
      if (block.branch === 'else') {
        fail(id, `a second {{else}} at index ${start} in {{${IF_PREFIX}${block.flag}}}`);
      }
      block.branch = 'else';
      continue;
    }
    if (name === '/if') {
      const block = open.pop();
      if (!block) fail(id, `{{/if}} at index ${start} with no {{#if}} open`);
      top().push({
        kind: 'if', flag: block.flag, whenTrue: block.whenTrue, whenFalse: block.whenFalse,
      });
      continue;
    }
    if (name.startsWith('#') || name.startsWith('/')) {
      // Named rather than swept into "malformed slot": `{{#each}}` is the tag a
      // writer reaches for next, and the answer is a design decision, not a typo.
      fail(id, `unknown block tag "{{${name}}}" at index ${start} — `
        + `{{${IF_PREFIX}flag}} / {{else}} / {{/if}} are the only blocks; iteration stays in TypeScript`);
    }
    if (!SLOT_PATTERN.test(name)) {
      fail(id, `malformed slot "{{${name}}}" at index ${start} — `
        + `a slot is {{name}} with no spaces, matching ${SLOT_PATTERN.source}`);
    }
    top().push({ kind: 'slot', name });
  }
}

function supplied(values: SlotValues): string {
  const keys = Object.keys(values);
  return keys.length === 0 ? '(none)' : keys.join(', ');
}

/**
 * Render in source order, one node at a time. Order is positional and never
 * derived from the data, so the output is byte-stable: identical data renders
 * identical bytes, and changing one slot cannot disturb anything ahead of it.
 * That is what keeps the cacheable prompt prefix intact.
 */
function renderNodes(
  id: string,
  nodes: readonly TemplateNode[],
  values: SlotValues,
  out: string,
): string {
  let acc = out;
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        acc += node.text;
        break;
      case 'slot': {
        const value = values[node.name];
        if (value === undefined) {
          fail(id, `slot {{${node.name}}} has no value. Supplied: ${supplied(values)}`);
        }
        if (!v.is(TEXT_VALUE, value)) {
          fail(id, `slot {{${node.name}}} is a text slot but was given a boolean — `
            + `write {{${IF_PREFIX}${node.name}}} to branch on it`);
        }
        acc += value;
        break;
      }
      case 'if': {
        const value = values[node.flag];
        if (value === undefined) {
          fail(id, `flag {{${IF_PREFIX}${node.flag}}} has no value. Supplied: ${supplied(values)}`);
        }
        if (!v.is(FLAG_VALUE, value)) {
          fail(id, `flag {{${IF_PREFIX}${node.flag}}} is a boolean slot but was given a string — `
            + `write {{${node.flag}}} to substitute it`);
        }
        acc = renderNodes(id, value ? node.whenTrue : node.whenFalse, values, acc);
        break;
      }
    }
  }
  return acc;
}

/**
 * One addressable piece of prompt prose.
 *
 * `id` is what an optimiser or an editor names this section by; `source` is the
 * evolvable artifact itself. `renderFrom` renders a REPLACEMENT source against
 * the same slot contract — the door a promoted candidate comes through, and the
 * reason the contract is checked at runtime as well as at compile time.
 */
export interface PromptSection<Source extends string> {
  readonly id: string;
  readonly source: Source;
  render(slots: TemplateSlots<Source>): string;
  renderFrom(source: string, slots: TemplateSlots<Source>): string;
}

/**
 * Compile a section once, at module load. A malformed template throws on import
 * rather than on the turn that happens to render it.
 *
 * `renderFrom` memoises exactly one replacement per section. A promoted override
 * is one string that changes only when the operator or the promotion gate moves
 * it, so a single slot is a hit on every turn between promotions and the cache
 * cannot grow with traffic.
 */
export function definePromptSection<const Source extends string>(
  id: string,
  source: Source,
): PromptSection<Source> {
  const compiled = compileTemplate(id, source);
  let override: { source: string; nodes: readonly TemplateNode[] } | null = null;
  return {
    id,
    source,
    render: (slots) => renderNodes(id, compiled, slots, ''),
    renderFrom: (replacement, slots) => {
      if (replacement === source) return renderNodes(id, compiled, slots, '');
      if (override?.source !== replacement) {
        override = { source: replacement, nodes: compileTemplate(id, replacement) };
      }
      return renderNodes(id, override.nodes, slots, '');
    },
  };
}

/** What a source declares it needs: the text slots and the boolean flags, each
 *  sorted and deduped so two contracts compare by value. */
export interface TemplateContract {
  readonly slots: readonly string[];
  readonly flags: readonly string[];
}

/**
 * The slot and flag names a source declares, read at RUNTIME.
 *
 * The compile-time contract covers sources the compiler can see. A promoted
 * candidate is a string from a table, so the gate that accepts it has to compare
 * contracts itself — a candidate that drops `{{workspaceRoot}}` renders a prompt
 * missing a fact, and one that invents a slot throws on the next turn.
 */
export function templateContract(id: string, source: string): TemplateContract {
  const slots = new Set<string>();
  const flags = new Set<string>();
  const walk = (nodes: readonly TemplateNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'slot') slots.add(node.name);
      else if (node.kind === 'if') {
        flags.add(node.flag);
        walk(node.whenTrue);
        walk(node.whenFalse);
      }
    }
  };
  walk(compileTemplate(id, source));
  return { slots: [...slots].sort(), flags: [...flags].sort() };
}
